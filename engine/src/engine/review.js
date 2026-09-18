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
 * @param {Array<{field_key:string, intended:string}>} intended
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

  for (const item of intended) {
    const label = byKey.get(item.field_key);
    const shown = label !== undefined ? rendered[label] : findByFuzzyLabel(rendered, item.field_key);
    if (shown === undefined) continue;          // not on the review page
    checked++;
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
  return { checked, matched, mismatches, verdict };
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
