// Fill primitives + mandatory read-back verification + the forbidden-value
// scan. Design: interfaces.md §5, §5.5.
//
// Two hard rules live here, both from recorded failures:
//
//  F9  Only REAL INPUT EVENTS. Blue Origin's Workday rendered values set by
//      DOM assignment and then failed validation on submit, because the
//      framework never saw an input event. There is deliberately no
//      evaluate-assignment path in this module's API — `fill`, `selectOption`,
//      `check` and `setInputFiles` are the entire vocabulary.
//
//  F16 The forbidden list is checked on WRITE **and on READ-BACK**. The
//      stale-profile trap does not put a bad value in through us: Eightfold,
//      Taleo, Rippling and at least three iCIMS tenants put the CMU address
//      into the form THEMSELVES, via résumé autofill. A value we never wrote
//      is still a value we would submit, so the scan runs over what the form
//      currently holds, not over what we intended.

import crypto from 'node:crypto';
import { isIdentityKey, isProseKey } from '../schema/fieldkeys.js';
import { VALUE_PREVIEW_MAX } from '../events/schema.js';
import { locate } from './discovery.js';

export class ParkRequired extends Error {
  constructor(reason, detail) { super(`${reason}: ${detail ?? ''}`); this.reason = reason; this.detail = detail; }
}

export const sha256 = (s) => 'sha256:' + crypto.createHash('sha256').update(String(s)).digest('hex');

/**
 * Patterns that may never appear in a form field, whoever put them there.
 *
 * The CMU address is a PATTERN, not a literal: `felixl@andrew.cmu.edu` is the
 * one on file, but any `@andrew.cmu.edu` address is equally unreachable by the
 * pipeline's IMAP, which is what made the 2026-09-01 rows UNVERIFIED. Matching
 * the domain rather than the exact string means a variant spelling cannot slip
 * through.
 */
export const FORBIDDEN_PATTERNS = Object.freeze([
  { id: 'cmu-email', re: /@andrew\.cmu\.edu\b/i, why: 'CMU address: no IMAP access, so confirmations are unreachable' },
  { id: 'cmu-email-alt', re: /@(?:cmu|alumni\.cmu)\.edu\b/i, why: 'CMU address family: not the pipeline inbox' },
]);

/** Build the full scanner for a run from the typed profile. */
export function forbiddenScanner(profile) {
  const literals = [
    ...(profile?.constraints?.forbiddenIdentities ?? []),
    ...(profile?.constraints?.forbiddenLiterals ?? []),
  ].filter(Boolean).map((s) => String(s).toLowerCase());

  return function scan(value) {
    const v = String(value ?? '');
    if (!v.trim()) return null;
    const lower = v.toLowerCase();
    for (const p of FORBIDDEN_PATTERNS) {
      if (p.re.test(v)) return { hit: p.id, why: p.why };
    }
    for (const lit of literals) {
      if (lit.length >= 4 && lower.includes(lit)) {
        return { hit: 'forbidden-literal', why: 'value is on the forbidden list' };
      }
    }
    return null;
  };
}

/** Format a DateValue for a control, per the adapter's declared strategy.
 *  The engine decides the format; the adapter only declares its strategy, so
 *  no format string is ever guessed from a placeholder (F5). */
export function formatDate(dv, strategy) {
  const y = dv.year;
  // A missing month is NOT January. Every strategy below prints a month, so a
  // DateValue without one cannot be formatted without fabricating a fact —
  // "01" asserted to a tenant where the bank says "month unknown" is an
  // invention (the same class as the Relay start-date finding). The day is
  // different: `dayRule: 'first-of-month'` is a DECLARED fill-in policy, so
  // day=1 under that rule is licensed, not invented.
  if (dv.month == null) {
    throw new ParkRequired('would_require_invention',
      'the date on file has no month; formatting one would fabricate it');
  }
  const m = dv.month;
  const d = dv.day ?? (dv.dayRule === 'first-of-month' ? 1 : 1);
  const pad = (n) => String(n).padStart(2, '0');
  switch (strategy) {
    case 'iso-text': return `${y}-${pad(m)}-${pad(d)}`;
    case 'mm/dd/yyyy-text': return `${pad(m)}/${pad(d)}/${y}`;
    case 'month-day-year-selects':
    case 'three-spinbuttons': return { month: m, day: d, year: y };
    case 'single-text': return `${pad(m)}/${y}`;
    default: return `${pad(m)}/${pad(d)}/${y}`;
  }
}

/** Q5-compliant payload for a field_filled event. */
export function fillEventData(plan, actualValue, { strategy, retries = 0 }) {
  const base = { field_key: plan.field_key, strategy, retries };

  if (isProseKey(plan.field_key)) {
    // Prose is recorded by IDENTITY, never rendered into the stream.
    return { ...base, answer_id: plan.answer_id, variant: plan.variant, slots: plan.slots ?? {}, value_hash: sha256(actualValue) };
  }
  if (isIdentityKey(plan.field_key)) {
    // Hash only. A masked phone number is still a phone number.
    return { ...base, value_hash: sha256(actualValue), value_preview: null, value_len: String(actualValue).length };
  }
  if (plan.canonical) {
    return { ...base, canonical: plan.canonical, option_text: plan.option_text ?? null, value_hash: sha256(actualValue) };
  }
  const s = String(actualValue);
  return {
    ...base,
    value_hash: sha256(s),
    value_preview: s.slice(0, VALUE_PREVIEW_MAX),
    value_len: s.length,
  };
}

/** Read back what the control now holds. This is the verification step; a
 *  fill that is not read back is not a fill. */
export async function readBack(loc, field) {
  if (field.control === 'checkbox' || field.control === 'radio') return await loc.isChecked();
  if (field.control === 'select') {
    return await loc.evaluate((el) => el.options[el.selectedIndex]?.text ?? '');
  }
  return await loc.inputValue();
}

/**
 * Execute one plan against one control, then verify it.
 *
 * @returns {Promise<{ok:boolean, actual:any, event?:object}>}
 */
export async function applyPlan(root, field, plan, { events, profile, dateStrategy = 'mm/dd/yyyy-text' }) {
  const loc = locate(root, field);
  const scan = forbiddenScanner(profile);

  // ---- pre-write guard: never WRITE a forbidden value -------------------
  const intended = plan.action === 'prose' ? plan.text
    : plan.action === 'select' ? plan.option_text
      : plan.action === 'date' ? JSON.stringify(formatDate(plan.value, dateStrategy))
        : plan.value;
  if (plan.action !== 'check') {
    const bad = scan(intended);
    if (bad) {
      events.emit('field_skipped', {
        field_key: plan.field_key, label: field.label, required: !!plan.required,
        reason: 'forbidden_value', detail: bad.why,
      });
      throw new ParkRequired('forbidden_value', `refused to write a forbidden value into ${plan.field_key}`);
    }
  }

  let strategy = 'fill';
  // For radio groups the element written and read back is the MEMBER at the
  // matched index, not the group's representative control.
  let effLoc = loc;
  let radioPick = false;

  switch (plan.action) {
    case 'select':
      if (field.control === 'radio') {
        // Mac finding D6, root cause: radio groups were discovered as N
        // separate controls with EMPTY option lists, so every radio question
        // (Lever's EEO race block, the yes/no eligibility cards) skipped as
        // option_not_found — and the old selectOption() call would have thrown
        // on a radio anyway. Discovery now collapses a group to one control
        // carrying `options` + `members`; the fill checks the matched member.
        strategy = 'check';
        radioPick = true;
        const member = field.members?.[plan.option_index];
        effLoc = member?.id
          ? root.locator(`[id="${String(member.id).replace(/"/g, '\\"')}"]`)
          : root.locator(`input[type=radio][name="${String(field.name).replace(/"/g, '\\"')}"]`)
            .nth(plan.option_index);
        await effLoc.setChecked(true);
        break;
      }
      strategy = 'select';
      // Match by the option TEXT we resolved, never by index into a list that
      // may have re-rendered between discovery and now.
      await loc.selectOption({ label: plan.option_text });
      break;
    case 'check':
      strategy = 'check';
      await loc.setChecked(plan.checked);
      break;
    case 'prose':
      strategy = 'fill';
      await loc.fill(plan.text);
      break;
    case 'date': {
      strategy = 'fill';
      const f = formatDate(plan.value, dateStrategy);
      if (typeof f === 'object') {
        // Three controls, ONE fill each. This is the direct replacement for
        // the per-digit `press` bursts that crashed Chrome reproducibly and
        // garbled 2026 into 2006 (F5).
        throw new ParkRequired('split_date_needs_binding',
          'a split date needs three bound controls; bind them in the adapter');
      }
      if ((field.type ?? '') === 'number') {
        // Mac finding D1: Greenhouse renders education dates as three
        // input[type=number] controls; a 'mm/dd/yyyy-text' strategy then
        // hands a STRING to a number box and Playwright's locator.fill throws
        // — which killed the whole Amperesand application at 5.5s. A date
        // string can never be typed into a number input; this field needs its
        // parts bound (dateParts) or it parks, alone.
        throw new ParkRequired('fill_failed',
          `a formatted date string cannot be written into input[type=number] ` +
          `("${field.label ?? field.id ?? field.name}"); bind the date parts in the adapter`);
      }
      await loc.fill(f);
      break;
    }
    default: {
      strategy = 'fill';
      const s = String(plan.value);
      if ((field.type ?? '') === 'number' && !/^-?\d+([.,]\d+)?$/.test(s.trim())) {
        // The general form of D1: any non-numeric write into a number input
        // throws in Playwright. Refuse it as a FIELD park before it becomes
        // an application abort.
        throw new ParkRequired('fill_failed',
          `non-numeric value for input[type=number] ("${field.label ?? field.id ?? field.name}")`);
      }
      await loc.fill(s);
      // A typeahead/combobox with no rendered options commits by Enter; the
      // read-back below is what verifies the control accepted it.
      if (plan.commit === 'enter') await loc.press('Enter').catch(() => {});
    }
  }

  // ---- read-back --------------------------------------------------------
  const actual = radioPick
    ? await effLoc.isChecked()
    : await readBack(loc, field);

  // ---- post-write guard: the form may now hold something we did not write
  if (typeof actual === 'string') {
    const bad = scan(actual);
    if (bad) {
      events.emit('field_skipped', {
        field_key: plan.field_key, label: field.label, required: !!plan.required,
        reason: 'forbidden_value', detail: `${bad.why} (found on read-back)`,
      });
      throw new ParkRequired('forbidden_value', `forbidden value present after writing ${plan.field_key}`);
    }
  }

  // ---- did it actually take? -------------------------------------------
  const ok = radioPick ? actual === true : verifyMatches(plan, actual, dateStrategy);
  if (!ok) {
    events.emit('field_skipped', {
      field_key: plan.field_key, label: field.label, required: !!plan.required,
      reason: 'value_absent', detail: 'read-back did not match the intended value',
    });
    return { ok: false, actual };
  }

  const event = events.emit('field_filled', fillEventData(plan, actual, { strategy }));
  return { ok: true, actual, event };
}

function verifyMatches(plan, actual, dateStrategy) {
  if (plan.action === 'check') return actual === plan.checked;
  if (plan.action === 'select') return normalizeLoose(actual) === normalizeLoose(plan.option_text);
  if (plan.action === 'date') {
    const f = formatDate(plan.value, dateStrategy);
    return typeof f === 'string' ? normalizeLoose(actual) === normalizeLoose(f) : false;
  }
  const want = plan.action === 'prose' ? plan.text : String(plan.value);
  return normalizeLoose(actual) === normalizeLoose(want);
}

const normalizeLoose = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Scan an ENTIRE form for forbidden values, regardless of what we wrote.
 * This is the F16 barrier: run it after every upload and before every advance.
 */
export async function scanFormForForbidden(discovered, profile) {
  const scan = forbiddenScanner(profile);
  const hits = [];
  for (const f of discovered.all) {
    if (!f.value) continue;
    const bad = scan(f.value);
    if (bad) hits.push({ field: f.label ?? f.name ?? f.id, control: f.control, why: bad.why, hit: bad.hit });
  }
  return hits;
}
