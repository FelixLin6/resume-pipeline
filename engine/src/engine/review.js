// Review-page diff — the pre-submit gate. Design: interfaces.md §5.6.
//
// What this replaces: "the applier eyeballs one review snapshot". That is how
// Cyvl went out with a term mismatch (form said Summer 2027, joblist said
// 2026) on a one-shot Ashby, and reading comprehension is not a control.
//
// The diff compares INTENDED values (what the engine emitted as field_mapped /
// field_filled) against RENDERED values (what the review page shows). It is
// mechanical, and its verdict gates the submit in code.

import { normalize } from './match.js';
import { isIdentityKey } from '../schema/fieldkeys.js';
import { sha256 } from './fill.js';

/** Severity policy. A mismatch on an identity or eligibility field is a FAIL;
 *  a cosmetic difference in a free-text field is a WARN. */
const FAIL_KEYS = new Set([
  'contact.email', 'contact.phone',
  'auth.workAuthorized', 'auth.sponsorship', 'auth.over18',
  'education.school', 'education.gpa', 'education.degreeLevel',
  'avail.term', 'avail.earliestStart',
  'selfid.gender', 'selfid.ethnicity', 'selfid.veteran', 'selfid.disability',
  'upload.resume',
]);

function severityFor(key) { return FAIL_KEYS.has(key) ? 'fail' : 'warn'; }

/**
 * Parse a rendered date string into parts. Understands the shapes review
 * pages actually print: "05/01/2027", "2027-05-01", "May 2027", "05/2027".
 * Returns null for anything it cannot parse — a null is "not a date", never
 * a guess.
 */
export function parseRenderedDate(s) {
  const str = String(s ?? '').trim();
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(str);
  if (m) return { year: +m[3], month: +m[1], day: +m[2] };
  m = /^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/.exec(str);
  if (m) return { year: +m[1], month: +m[2], day: m[3] ? +m[3] : null };
  m = /^(\d{1,2})\/(\d{4})$/.exec(str);
  if (m) return { year: +m[2], month: +m[1], day: null };
  m = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s+(\d{4})$/i.exec(str);
  if (m) {
    const month = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
      .indexOf(m[1].slice(0, 3).toLowerCase()) + 1;
    return { year: +m[2], month, day: null };
  }
  return null;
}

/**
 * Semantic comparison of a rendered date against the BANK'S SOURCE DateValue.
 *
 * Why not string equality with the engine's own write: the engine wrote
 * "01/01/2027" on Relay, the page rendered "01/01/2027", and the old diff
 * called that 12/12 pass — while the ledger's answer for that posting was
 * "May 2027". A diff that compares the write against itself can only ever
 * verify the WRITE. This compares against the source:
 *
 *   - every part the source SPECIFIES must match the rendered part;
 *   - a rendered part the source does NOT specify is checked against the
 *     declared fill-in rule (dayRule 'first-of-month' licenses day=1) and is
 *     otherwise an INVENTION — a month the bank never stated, asserted to a
 *     tenant — which fails.
 */
export function dateMatchesSource(rendered, sourceDate) {
  const r = parseRenderedDate(rendered);
  if (!r) return { ok: false, why: 'rendered value does not parse as a date' };
  if (sourceDate.year != null && r.year !== sourceDate.year) {
    return { ok: false, why: `year: source ${sourceDate.year}, rendered ${r.year}` };
  }
  if (sourceDate.month != null) {
    if (r.month != null && r.month !== sourceDate.month) {
      return { ok: false, why: `month: source ${sourceDate.month}, rendered ${r.month}` };
    }
  } else if (r.month != null && r.month !== 1) {
    // No month on file and the form asserts one that no fill-in rule
    // produces: that is a fabricated month.
    return { ok: false, why: `month ${r.month} rendered but no month is on file` };
  }
  if (sourceDate.day != null && r.day != null && r.day !== sourceDate.day) {
    return { ok: false, why: `day: source ${sourceDate.day}, rendered ${r.day}` };
  }
  if (sourceDate.day == null && r.day != null && r.day !== 1
      && sourceDate.dayRule === 'first-of-month') {
    return { ok: false, why: `day ${r.day} rendered but the declared rule is first-of-month` };
  }
  return { ok: true };
}

/**
 * @param {Array<{field_key:string, intended:string, sourceDate?:object}>} intended
 *        `sourceDate` (the bank's DateValue) makes the comparison SEMANTIC:
 *        rendered is checked against the source of truth, not against the
 *        engine's own formatted write.
 * @param {Record<string,string>} rendered  label -> rendered value, from the
 *        adapter's readReview()
 * @param {Array<{key:string, label:string}>} labelMap  how a FieldKey maps to
 *        the review page's own wording
 */
export function diffReview(intended, rendered, labelMap = []) {
  const byKey = new Map(labelMap.map((m) => [m.key, m.label]));
  const mismatches = [];
  let checked = 0;
  let matched = 0;
  let unlocated = 0;

  for (const item of intended) {
    const label = byKey.get(item.field_key);
    const shown = label !== undefined ? rendered[label] : findByFuzzyLabel(rendered, item.field_key);
    if (shown === undefined) {
      // Mac finding D4: silently `continue`-ing here made an unlocatable field
      // invisible to the verdict. It is now COUNTED and warned — the review
      // page not showing a value we filled is a verification gap, not nothing.
      unlocated++;
      mismatches.push({
        field_key: item.field_key,
        reason: 'not_found_on_review',
        severity: 'warn',
      });
      continue;
    }
    checked++;

    // Dates are compared against the SOURCE, not against our own write.
    if (item.sourceDate) {
      const sem = dateMatchesSource(shown, item.sourceDate);
      if (sem.ok) { matched++; continue; }
      mismatches.push({
        field_key: item.field_key,
        intended: String(item.intended).slice(0, 80),
        rendered: String(shown).slice(0, 80),
        reason: `date_semantic: ${sem.why}`,
        severity: severityFor(item.field_key),
      });
      continue;
    }

    if (normalize(shown) === normalize(item.intended)) { matched++; continue; }

    mismatches.push({
      field_key: item.field_key,
      // Q5: an identity field's values never enter the stream, not even to
      // show a mismatch. The hashes prove they differ without publishing them.
      ...(isIdentityKey(item.field_key)
        ? { intended_hash: sha256(item.intended), rendered_hash: sha256(shown) }
        : { intended: String(item.intended).slice(0, 80), rendered: String(shown).slice(0, 80) }),
      severity: severityFor(item.field_key),
    });
  }

  const verdict = mismatches.some((m) => m.severity === 'fail') ? 'fail' : 'pass';
  return { checked, matched, unlocated, mismatches, verdict };
}

/**
 * The other half of the Mac D4 fix: the diff must look at the QUESTIONS, not
 * only at the answers the engine happens to have written. Clockwork returned
 * 6/6 pass with "Can you legally work in the United States?*" — a REQUIRED
 * question — unanswered, because the old diff iterated only `filledBefore`.
 *
 * This audits the review-page controls themselves: every required, visible
 * control that holds no value is a FAIL mismatch. An application with a
 * required question unanswered is not "clean"; it is unsubmittable, and the
 * verdict must say so before the submit gate is ever consulted.
 *
 * @param {object[]} fields  discovered controls on the review page
 * @returns {object[]} mismatch entries to fold into the diff
 */
export function auditUnanswered(fields) {
  const out = [];
  for (const f of fields ?? []) {
    if (!f.required) continue;
    if (f.control === 'file') continue;          // uploads are verified by C3, not by value
    const empty = f.control === 'checkbox' || f.control === 'radio'
      ? f.checked === false || f.checked === undefined
      : !String(f.value ?? '').trim();
    if (!empty) continue;
    // Radio groups render as several controls; one unchecked member of an
    // answered group is not unanswered. The caller's discovery marks a group
    // answered if ANY member is checked — approximate that here by name.
    if (f.control === 'radio' && f.name
        && (fields.some((g) => g.control === 'radio' && g.name === f.name && g.checked))) continue;
    out.push({
      field_key: f.boundKey ?? null,
      label: String(f.label ?? f.name ?? f.id ?? '').slice(0, 80),
      reason: 'unanswered_required',
      severity: 'fail',
    });
  }
  // De-duplicate radio groups (one entry per name/label, not per option).
  const seen = new Set();
  return out.filter((m) => {
    const k = m.label || m.field_key || Math.random();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function findByFuzzyLabel(rendered, key) {
  const leaf = key.split('.').pop().replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  for (const [label, value] of Object.entries(rendered)) {
    if (normalize(label).includes(leaf)) return value;
  }
  return undefined;
}

/**
 * The form-vs-joblist contradiction check (F20). This is an engine gate, not
 * an applier's reading comprehension: if the posting we triaged says one term
 * and the form we are about to submit says another, that is a FAIL regardless
 * of how tidy the rest of the diff is.
 */
/** When a posting's term starts, by season. The profile's own note authorizes
 *  this entailment ("If a specific posting is only for a later term (e.g.
 *  Summer 2027), give that term's start instead") — the table exists so the
 *  DIFF can enforce the rule the profile states in prose. */
export const TERM_START_MONTH = Object.freeze({
  spring: 1, winter: 1, summer: 5, fall: 8, autumn: 8,
});

export function checkJobFacts({ rendered, jobFacts }) {
  const out = [];
  if (jobFacts?.term) {
    const all = Object.values(rendered).join(' ');
    const years = [...all.matchAll(/\b20\d{2}\b/g)].map((m) => m[0]);
    const wantYear = (jobFacts.term.match(/20\d{2}/) ?? [])[0];
    if (wantYear && years.length && !years.includes(wantYear)) {
      out.push({
        field_key: 'avail.term',
        intended: jobFacts.term,
        rendered: years.join(','),
        severity: 'fail',
      });
    }

    // The Relay case, made mechanical: a Summer 2027 posting whose start-date
    // answer reads January 2027 contradicts the posting's own term. The
    // profile's earliest-start note makes this posting-CONDITIONAL ("give
    // that term's start instead"), so a base-date answer on a later-term
    // posting is wrong even though it faithfully reproduces the bank.
    const season = /\b(spring|summer|fall|autumn|winter)\b/i.exec(jobFacts.term)?.[1]?.toLowerCase();
    const termMonth = season ? TERM_START_MONTH[season] : null;
    if (termMonth && wantYear) {
      for (const [label, value] of Object.entries(rendered)) {
        if (!/start\s*date|desired\s*start|available.*(start|begin)|earliest/i.test(label)) continue;
        const d = parseRenderedDate(value);
        if (!d) continue;
        if (d.year === +wantYear && d.month != null && d.month < termMonth) {
          out.push({
            field_key: 'avail.earliestStart',
            intended: `${jobFacts.term} (term starts month ${termMonth})`,
            rendered: String(value).slice(0, 40),
            reason: 'start_date_precedes_posting_term',
            severity: 'fail',
          });
        }
      }
    }
  }
  return out;
}

export function emitReviewDiff(events, diff) {
  return events.emit('review_diff', {
    checked: diff.checked,
    matched: diff.matched,
    mismatches: diff.mismatches,
    verdict: diff.verdict,
  });
}
