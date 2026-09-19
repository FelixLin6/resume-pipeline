// Mapping: discovered control + typed bank -> a concrete fill plan, or a skip.
// Design: interfaces.md §5.
//
// The rule that governs every branch below: an absent or unmatchable value
// produces a SKIP with a named reason, and a skip on a REQUIRED field parks
// the application. There is no branch that produces an approximation, and the
// adapter cannot call the model (F11).

import { matchOption, keyForLabel } from './match.js';
import { ENUM_FOR_KEY } from '../schema/enums.js';
import { isProseKey } from '../schema/fieldkeys.js';

/** Resolve a FieldKey to a canonical value from the typed profile + bank. */
export function resolveValue(key, { profile, bank }) {
  if (bank?.facts?.[key]) {
    return { kind: 'enum', value: bank.facts[key].value, source: bank.facts[key].source };
  }
  if (isProseKey(key)) {
    const id = key.slice('prose.'.length);
    const answer = bank?.prose?.find((p) => p.id === id || p.section === id);
    return answer
      ? { kind: 'prose', answer, source: 'answer-bank' }
      : { kind: 'absent', source: 'answer-bank' };
  }

  const p = profile ?? {};
  const edu = p.education?.[0] ?? {};
  const table = {
    'identity.firstName': p.identity?.firstName,
    'identity.lastName': p.identity?.lastName,
    'identity.fullName': p.identity?.fullName,
    'identity.middleName': p.identity?.middleName,
    'identity.preferredName': p.identity?.preferredName,
    'contact.email': p.contact?.email,
    'contact.phone': p.contact?.phone?.formatted,
    'contact.address.line1': p.contact?.address?.line1,
    'contact.address.line2': p.contact?.address?.line2,
    'contact.address.city': p.contact?.address?.city,
    'contact.address.state': p.contact?.address?.state,
    'contact.address.postalCode': p.contact?.address?.postalCode,
    'contact.address.country': p.contact?.address?.countryFull,
    'links.linkedin': p.links?.linkedin,
    'links.github': p.links?.github,
    'links.website': p.links?.website,
    'education.school': edu.school,
    'education.degreeText': edu.degreeText,
    'education.fieldOfStudy': edu.fieldOfStudy,
    'education.classStanding': edu.classStanding,
    'education.gpa': edu.gpa,
    'auth.citizenship': p.authorization?.citizenship,
    'avail.term': p.availability?.primaryTerm,
    'avail.hoursPerWeek': p.availability?.hoursPerWeek,
    'loc.currentLocation': p.locationPolicy?.currentLocation,
    'selfid.signature': p.selfId?.signatureName,
    'source.howDidYouHear': p.source?.freeText,
  };
  const dates = {
    'education.startDate': edu.start,
    'education.endDate': edu.end,
    'avail.earliestStart': p.availability?.earliestStart,
  };

  if (key in dates) {
    return dates[key] ? { kind: 'date', value: dates[key], source: 'profile' } : { kind: 'absent' };
  }
  if (key in table) {
    const v = table[key];
    return v === null || v === undefined || v === ''
      ? { kind: 'absent' }
      : { kind: 'text', value: String(v), source: 'profile' };
  }
  return { kind: 'absent' };
}

/** Does this label hit an always-park rule? Checked BEFORE any value lookup,
 *  so a banked value can never satisfy a question Felix ruled unanswerable. */
export function alwaysParkReason(label, bank) {
  if (!label) return null;
  for (const rule of bank?.alwaysPark ?? []) {
    if (new RegExp(rule.pattern, 'i').test(label)) return rule.reason;
  }
  return null;
}

/**
 * Plan one discovered control.
 *
 * @returns {{action:'fill'|'select'|'check'|'upload'|'date'|'prose', ...}
 *          |{action:'skip', reason:string, ...}}
 */
export function planField(field, { binding = null, profile, bank }) {
  const key = binding?.key ?? keyForLabel(field.label);
  const required = binding?.required ?? field.required;

  // The always-park check runs FIRST, before the key lookup.
  //
  // Order is load-bearing, not stylistic. "Date of Birth" and "Years of
  // experience with Python" map to no FieldKey, so a key-first order reports
  // them as `unmapped_required` — which reads as "a bank gap we could close by
  // adding a fact". They are not that: they are questions no bank entry could
  // ever answer honestly. Q2 counts `would_require_invention` per day
  // precisely to measure what the never-invent rule costs us, and filing these
  // under the wrong reason would corrupt the only number that can tell us
  // whether the rule is too strict.
  const parked = alwaysParkReason(field.label, bank);
  if (parked) {
    return {
      action: 'skip', field_key: key ?? null, label: field.label, required,
      reason: 'would_require_invention', detail: parked,
    };
  }

  if (!key) {
    return {
      action: 'skip',
      field_key: null,
      label: field.label,
      required,
      reason: required ? 'unmapped_required' : 'unmapped_optional',
    };
  }

  // ---- uploads ----------------------------------------------------------
  // BEFORE the value lookup, and the order is load-bearing (2026-09-18 fleet
  // run). An upload target has no value in the bank BY DESIGN: the artifact is
  // the day's tailored PDF, handed in by the caller, not a fact on file. With
  // the file check sitting after the lookup, `upload.resume` resolved `absent`
  // and every résumé field on every ATS skipped as `value_absent` — so the
  // engine never attached a résumé to anything, and the skip reason blamed a
  // missing bank entry for a field the bank is not supposed to hold. Same
  // failure shape as the alwaysPark ordering note above: a key-first order
  // reports the wrong cause and hides the real one.
  if (field.control === 'file') {
    return { action: 'upload', field_key: key, required };
  }

  const resolved = resolveValue(key, { profile, bank });
  if (resolved.kind === 'absent') {
    return { action: 'skip', field_key: key, label: field.label, required, reason: 'value_absent' };
  }

  // ---- prose ------------------------------------------------------------
  if (resolved.kind === 'prose') {
    const ans = resolved.answer;
    // Q2: a slot the JD cannot fill is an invention, not a gap to paper over.
    const unfilled = ans.slots?.filter((s) => s.required && !(binding?.slots?.[s.name])) ?? [];
    if (unfilled.length) {
      return {
        action: 'skip', field_key: key, label: field.label, required,
        reason: 'would_require_invention',
        detail: `prose answer ${ans.id} has ${unfilled.length} unfilled JD slot(s)`,
      };
    }
    return {
      action: 'prose', field_key: key, required,
      answer_id: ans.id, variant: ans.variants[0].maxWords,
      slots: binding?.slots ?? {},
      text: ans.variants[0].text,
    };
  }

  // ---- dates ------------------------------------------------------------
  if (resolved.kind === 'date') {
    return { action: 'date', field_key: key, required, value: resolved.value, source: resolved.source };
  }

  // ---- option controls --------------------------------------------------
  if (field.control === 'select' || field.control === 'radio' || field.control === 'combobox') {
    // A combobox that has rendered NO options is a typeahead: its choices do
    // not exist in the DOM until someone types (react-select on every
    // Greenhouse demographic; Lever's location box; Workday's picklists).
    // Matching against the empty list skipped all of them as
    // `option_not_found` — Hermeus lost links.website / links.linkedin /
    // education.school and Clockwork left "Can you legally work in the United
    // States?*" unanswered this way (Mac finding D6). The honest move is to
    // TYPE the value and commit with Enter, and let the mandatory read-back
    // verify the control accepted it: no option is guessed — the text written
    // is the bank's own value (or the adapter's declared wording for the
    // canonical), and a rejection comes back as an unfilled field, not as a
    // wrong one.
    if (field.control === 'combobox' && !(field.options ?? []).length) {
      const text = resolved.kind === 'enum'
        ? (binding?.optionText?.[resolved.value]?.[0] ?? null)
        : String(resolved.value);
      if (text) {
        return {
          action: 'fill', field_key: key, required,
          value: text,
          ...(resolved.kind === 'enum' ? { canonical: resolved.value, option_text: text } : {}),
          source: resolved.source,
          commit: 'enter',
          match: 'typed-commit',
        };
      }
      // An enum with no declared wording still cannot be typed: the canonical
      // slug must never reach a form.
      return { action: 'skip', field_key: key, label: field.label, required, reason: 'option_not_found', candidates_seen: [] };
    }

    const canonical = resolved.kind === 'enum' ? resolved.value : String(resolved.value);
    const m = matchOption(canonical, field.options ?? [], binding?.optionText);
    if (!m.matched) {
      return {
        action: 'skip', field_key: key, label: field.label, required,
        reason: 'option_not_found',
        candidates_seen: m.optionsSeen ?? [],
        ambiguous: !!m.ambiguous,
      };
    }
    return {
      action: 'select', field_key: key, required,
      canonical, option_text: m.option, option_index: m.index,
      match: m.via, source: resolved.source,
    };
  }

  if (field.control === 'checkbox') {
    // A checkbox only ever encodes yes/no. Anything else is a mapping bug,
    // not something to coerce.
    if (resolved.kind !== 'enum' || !['yes', 'no'].includes(resolved.value)) {
      return { action: 'skip', field_key: key, label: field.label, required, reason: 'option_not_found' };
    }
    return { action: 'check', field_key: key, required, checked: resolved.value === 'yes', canonical: resolved.value, source: resolved.source };
  }

  // ---- text / textarea / spinbutton -------------------------------------
  if (resolved.kind === 'enum') {
    // An enum landing on a free-text box: write the canonical's plain wording
    // only if the adapter supplied one for this tenant. Otherwise skip — the
    // canonical slug ("none-now-or-future") must never reach a form.
    const candidates = binding?.optionText?.[resolved.value];
    if (!candidates?.length) {
      return { action: 'skip', field_key: key, label: field.label, required, reason: 'option_not_found' };
    }
    return { action: 'fill', field_key: key, required, value: candidates[0], canonical: resolved.value, source: resolved.source };
  }

  return { action: 'fill', field_key: key, required, value: String(resolved.value), source: resolved.source };
}

/** Which enum governs a key — exported so tests can assert the bank is typed
 *  against the same table the mapper uses. */
export function enumFor(key) { return ENUM_FOR_KEY[key] ?? null; }
