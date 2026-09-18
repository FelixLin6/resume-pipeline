// Workday's progress bar, parsed rather than enumerated.
//
// The rail is read VERBATIM from `[data-automation-id="progressBarActiveStep"]`
// and looks like this (both strings captured live on 2026-09-17):
//
//   "current step 1 of 8 Create Account/Sign In"          (avisbudget.wd1)
//   "step 4 of 8 Application Questions 1 of 2"            (avisbudget.wd1)
//   "step 4 of 7 Application Questions"                   (jabil.wd5)
//
// Why parse instead of hard-coding a step list: the rail length is a TENANT
// SETTING, not a property of Workday. Three lengths are on record —
//
//   8  avisbudget  Create Account/Sign In · My Information · My Experience ·
//                  Application Questions 1 of 2 · Application Questions 2 of 2 ·
//                  Voluntary Disclosures · Self Identify · Review
//   7  jabil       …with a single undivided Application Questions
//   5  smithnephew …and no Self Identify node at all
//
// — so an adapter with a fixed graph would mis-identify the current step on two
// of the three. The page tells us where we are on every render; believing it is
// both cheaper and more honest than maintaining a table of tenant flows.

/** Canonical rail titles, in canonical order, mapped to our StepIds. */
export const WORKDAY_STEP_TITLES = Object.freeze([
  { title: /create account|sign in/i, stepId: 'account-gate' },
  { title: /my information/i, stepId: 'my-information' },
  { title: /my experience/i, stepId: 'my-experience' },
  { title: /application questions/i, stepId: 'application-questions' },
  { title: /voluntary disclosures/i, stepId: 'voluntary-disclosures' },
  { title: /self identify/i, stepId: 'self-identify' },
  { title: /^review/i, stepId: 'review' },
]);

/**
 * Parse one rail entry.
 *
 * @param {string} text  e.g. "current step 4 of 8 Application Questions 1 of 2"
 * @returns {{index:number,total:number,title:string,stepId:string|null,
 *            part:number|null,parts:number|null}|null}
 */
export function parseProgressBar(text) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return null;

  const m = /(?:current\s+)?step\s+(\d+)\s+of\s+(\d+)\s*(.*)$/i.exec(s);
  if (!m) return null;

  const index = Number(m[1]);
  const total = Number(m[2]);
  let title = m[3].trim();

  // "Application Questions 1 of 2" — the SECOND "N of M" is the sub-part, and
  // it must not be mistaken for the rail position. Avis splits its questions
  // across two pages and Jabil does not, so both shapes have to parse.
  let part = null;
  let parts = null;
  const sub = /^(.*?)\s+(\d+)\s+of\s+(\d+)$/i.exec(title);
  if (sub) {
    title = sub[1].trim();
    part = Number(sub[2]);
    parts = Number(sub[3]);
  }

  const hit = WORKDAY_STEP_TITLES.find((t) => t.title.test(title));
  return { index, total, title, stepId: hit?.stepId ?? null, part, parts };
}

/**
 * Parse the whole rail (every `progressBar*Step` entry's text).
 *
 * Used to sanity-check a tenant's flow before starting: an application that
 * believes it is on step 6 of 8 when the rail says 5 of 7 has lost the flow,
 * and the engine would rather hand that to the model-driven fallback than
 * guess.
 */
export function parseRail(entries) {
  const steps = (entries ?? []).map(parseProgressBar).filter(Boolean);
  const total = steps[0]?.total ?? steps.length;
  return {
    total,
    steps,
    // A rail whose entries disagree about the total is a page mid-render; the
    // caller should re-read rather than act on it.
    consistent: steps.every((s) => s.total === total),
    hasSelfIdentify: steps.some((s) => s.stepId === 'self-identify'),
    questionPages: steps.filter((s) => s.stepId === 'application-questions').length,
  };
}
