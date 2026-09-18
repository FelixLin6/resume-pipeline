// Option matching — engine-owned, shared, and deliberately strict.
// Design: interfaces.md §5.3.
//
// F8, the failure this file exists to abolish: on 2026-09-07 the canonical
// value "male" matched the rendered option "Female" by bare substring, and
// the wrong EEO answer was submitted. The fix is not a better substring test;
// it is that a substring test is never used. Matching goes:
//
//   exact normalized equality
//     -> candidate normalized equality
//       -> WORD-BOUNDARY equality on the candidate
//         -> no match => field_skipped{option_not_found}, and if required, park
//
// There is deliberately no "closest option" tier. Picking the nearest-looking
// option is how a form gets a confidently wrong answer, which is worse than a
// park in every case in the record.

import { DEFAULT_OPTION_TEXT } from '../schema/enums.js';

/** Fold case, strip punctuation and markers, collapse whitespace. */
export function normalize(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/’/g, "'")
    .replace(/[*†‡]+/g, ' ')        // required markers
    .replace(/\((?:required|optional)\)/g, ' ')
    .replace(/[^a-z0-9'+/.-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Word-boundary equality: every word of the candidate appears in the option,
 *  in order, on word boundaries, AND the option adds no *contradicting* head.
 *  "male" vs "female" fails here because "female" does not contain "male" on a
 *  word boundary — the `fe` prefix is part of the same token. */
export function wordBoundaryMatch(candidate, option) {
  const c = normalize(candidate);
  const o = normalize(option);
  if (!c || !o) return false;
  const escaped = c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|\\s)${escaped}(\\s|$)`).test(o);
}

/**
 * Match a canonical value against the options a form actually rendered.
 *
 * @param {string} canonical         canonical enum value, e.g. "male"
 * @param {string[]} renderedOptions option texts read off the control
 * @param {Record<string,string[]>} [optionText] adapter vocabulary:
 *        canonical -> candidate option texts for THIS tenant
 * @returns {{matched:true, option:string, index:number, via:string, candidate:string}
 *          |{matched:false, candidatesTried:string[], optionsSeen:string[]}}
 */
export function matchOption(canonical, renderedOptions, optionText = {}) {
  const candidates = optionText?.[canonical] ?? DEFAULT_OPTION_TEXT[canonical] ?? [canonical];
  const opts = renderedOptions ?? [];

  // Tier 1 & 2: normalized equality, canonical first then each candidate.
  for (const [via, list] of [['exact', [canonical]], ['candidate', candidates]]) {
    for (const cand of list) {
      const n = normalize(cand);
      if (!n) continue;
      const i = opts.findIndex((o) => normalize(o) === n);
      if (i >= 0) return { matched: true, option: opts[i], index: i, via, candidate: cand };
    }
  }

  // Tier 3: word-boundary containment, candidates only. The canonical token
  // itself is NOT used here — canonical slugs like "no" would word-match
  // "No, I do not require sponsorship" but also "No Preference", and that
  // ambiguity is resolved by adapter vocabulary, not by the engine guessing.
  const wordHits = [];
  for (const cand of candidates) {
    opts.forEach((o, i) => {
      if (wordBoundaryMatch(cand, o)) wordHits.push({ option: o, index: i, candidate: cand });
    });
  }
  // An AMBIGUOUS word-boundary match is not a match. Two plausible options
  // means the tenant vocabulary is incomplete, and the honest outcome is a
  // skip that names both, not a coin flip.
  const distinct = [...new Set(wordHits.map((h) => h.index))];
  if (distinct.length === 1) {
    const hit = wordHits[0];
    return { matched: true, option: hit.option, index: hit.index, via: 'normalized-word', candidate: hit.candidate };
  }

  return {
    matched: false,
    ambiguous: distinct.length > 1,
    candidatesTried: candidates,
    optionsSeen: opts.slice(0, 25),
  };
}

/**
 * Label-based field identification for generic discovery. Adapter bindings
 * take precedence; this is the fallback when a form's control has no declared
 * binding. Patterns are explicit and ordered — never a model call (F11).
 */
export const LABEL_PATTERNS = Object.freeze([
  ['identity.firstName', /^(first|given)\s*name/i],
  ['identity.lastName', /^(last|family|sur)\s*name/i],
  ['identity.middleName', /^middle\s*(name|initial)/i],
  ['identity.fullName', /^(full\s*name|name)\s*\*?$/i],
  ['contact.email', /e-?mail/i],
  ['contact.phone', /phone|mobile|cell/i],
  ['contact.address.line1', /address(\s*line)?\s*1|street\s*address|^address\b/i],
  ['contact.address.line2', /address(\s*line)?\s*2|apt|suite/i],
  ['contact.address.city', /^city/i],
  ['contact.address.state', /^state|province|region/i],
  ['contact.address.postalCode', /zip|postal/i],
  ['contact.address.country', /^country/i],
  ['links.linkedin', /linked\s*in/i],
  ['links.github', /git\s*hub/i],
  ['links.website', /website|portfolio|personal\s*(site|url)/i],
  ['education.school', /school|university|college|institution/i],
  ['education.degreeLevel', /degree(\s*level)?|education\s*level/i],
  ['education.fieldOfStudy', /major|field\s*of\s*study|discipline|concentration/i],
  ['education.gpa', /gpa|grade\s*point|qpa/i],
  ['education.graduated', /did\s*you\s*graduate|graduated\?/i],
  ['auth.workAuthorized', /authoriz|legally.*work|eligible to work|citizenship status/i],
  ['auth.sponsorship', /sponsor/i],
  ['auth.over18', /18\s*(years|or older)|age\s*of\s*majority/i],
  ['auth.clearance', /clearance/i],
  ['auth.previouslyEmployed', /previously\s*(employed|worked)|former\s*employee/i],
  ['selfid.gender', /gender/i],
  ['selfid.ethnicity', /ethnic|race/i],
  ['selfid.hispanic', /hispanic|latino/i],
  ['selfid.veteran', /veteran|vevraa/i],
  ['selfid.disability', /disabilit/i],
  ['selfid.signature', /signature|please\s*sign|electronic\s*sign/i],
  ['selfid.date', /today'?s?\s*date|date\s*(signed|of\s*signature)/i],
  ['avail.earliestStart', /start\s*date|available.*(start|begin)|earliest/i],
  ['loc.relocation', /relocat/i],
  ['source.howDidYouHear', /how\s*did\s*you\s*(hear|find)|referral\s*source|source/i],
  ['work.title', /job\s*title|^title/i],
  ['work.employer', /employer|company\s*name/i],
  ['work.description', /description|responsibilit/i],
  ['work.reasonForLeaving', /reason\s*for\s*leaving/i],
  ['work.isCurrent', /current\s*job|currently\s*(work|employed)/i],
  ['account.login', /^login|user\s*name|username/i],
]);

/** Best-effort key for a label. Returns null rather than a guess. */
export function keyForLabel(label) {
  if (!label) return null;
  for (const [key, re] of LABEL_PATTERNS) if (re.test(label)) return key;
  return null;
}
