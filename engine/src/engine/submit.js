// Submit — the only code path permitted to click a submit-labelled control,
// and only after a passing, FRESH review diff. Design: interfaces.md §5.6 (C6).
//
// Three recorded failures converge here:
//  F21 An invisible-size hCaptcha sat over SUBMIT; a click meant to park on
//      the widget passed through and filed an application unreviewed.
//  F20 A term mismatch was submitted because a human read the review page.
//  Q4  A submit whose click landed but whose confirmation read timed out was
//      historically ambiguous. It is now SUBMITTED, unconfirmed, never retried.
//
// The gate is an assertion in this file, not a line in a runbook. There is no
// flag, no override parameter, and no caller-supplied bypass: "submit anyway"
// is not spellable in this API.

import { evaluateGate, lastMutatingSeq as gate2LastMutatingSeq, Gate2Violation } from './gate2.js';
import { assertSubmitClickable } from './overlay.js';

export class ReviewGateError extends Error {}
export class SubmitBudgetError extends Error {}

/**
 * Assert the review gate. Called by submit() before anything is clicked.
 *
 * The rule itself lives in gate2.js, because Phase 3 needs the identical rule
 * in two places — here at runtime, and as a post-hoc audit over a finished
 * stream that a metric report must run before it may call a day clean. Two
 * copies of a safety rule is one copy too many.
 *
 * @param {object[]} events   the emitted event list for THIS job, in order
 * @param {number} lastMutatingSeq  seq of the last event that changed the form
 */
export function assertReviewGate(events, lastMutatingSeq) {
  const v = evaluateGate(events);

  if (!v.ok) {
    switch (v.reason) {
      case 'no-review-diff':
        throw new ReviewGateError('refusing to submit: no review diff was produced');
      case 'failing-review-diff':
        throw new ReviewGateError(
          `refusing to submit: review diff verdict is "${v.detail.verdict}" ` +
          `(${v.detail.failing_mismatches} failing mismatch(es))`);
      case 'stale-review-diff':
        throw new ReviewGateError(
          `refusing to submit: the review diff (seq ${v.detail.diff_seq}) is stale — ` +
          `the form changed at seq ${v.detail.mutated_at}`);
      case 'unresolved-barrier-failure':
        throw new ReviewGateError(
          `refusing to submit: a post-upload barrier diff at seq ${v.detail.barrier_seq} FAILED ` +
          `after the review diff at seq ${v.detail.diff_seq}. A barrier emits no mutating event, ` +
          'so staleness alone would have let this through — the parser overwrite is unresolved.');
      /* c8 ignore next 2 */
      default:
        throw new ReviewGateError(`refusing to submit: ${v.reason}`);
    }
  }

  // An explicitly supplied lastMutatingSeq that is newer than the stream's own
  // still invalidates the diff.
  if (typeof lastMutatingSeq === 'number' && v.diff.seq < lastMutatingSeq) {
    throw new ReviewGateError(
      `refusing to submit: the review diff (seq ${v.diff.seq}) is stale — ` +
      `the form changed at seq ${lastMutatingSeq}`);
  }
  return v.diff;
}

export { Gate2Violation };
export const lastMutatingSeq = gate2LastMutatingSeq;

/**
 * Count prior submit attempts for this (tenant, job) from the stream.
 * Q4: the default budget is 1 for every ATS.
 */
export function assertSubmitBudget(events, maxAttempts) {
  const prior = events.filter((e) => e.type === 'submitted').length;
  if (prior >= (maxAttempts ?? 1)) {
    throw new SubmitBudgetError(
      `refusing to submit: ${prior} submit(s) already recorded and the budget is ${maxAttempts ?? 1}. ` +
      `A double submission is worse than a missed retry.`
    );
  }
  return prior;
}

/**
 * Submit, then capture evidence.
 *
 * The confirmation read is wrapped so a timeout does NOT become a retry: the
 * click either happened or it did not, and we cannot tell from here, so the
 * only safe record is "submitted, unconfirmed".
 */
export async function submit(adapter, ctx, {
  events, page, stream, screenshotPath = null, confirmTimeoutMs = 45000,
  wallMemory = null,
}) {
  const emitted = stream.events.filter((e) => e.job_key === ctx.jobKey);
  assertReviewGate(emitted, lastMutatingSeq(emitted));
  assertSubmitBudget(emitted, adapter.quirks?.maxSubmitAttempts ?? 1);

  // F21 / Kitware: the diff having passed says the FORM is right. It says
  // nothing about whether the click will reach the button. An adapter that
  // declares its submit control gets a hit test before anything is clicked;
  // one that does not is recorded as unguarded, so the gap is visible in the
  // stream rather than invisible in the code.
  const spec = adapter.quirks?.submitControl;
  if (spec?.selector) {
    await assertSubmitClickable({
      root: ctx.frame ?? page,
      events: stream,
      submitSelector: spec.selector,
      captcha: {
        wrapperSelectors: spec.captchaWrappers ?? [],
        responseSelector: spec.captchaResponse ?? null,
      },
      wallMemory,
      tenant: ctx.tenant ?? null,
    });
  } else {
    stream.emit('adapter_note', {
      msg: 'submit click-target NOT verified: this adapter declares no submitControl selector',
      extra: { ats: adapter.id },
    });
  }

  // The adapter's advance() to the submit step is what clicks. The engine
  // holds the gate; the adapter holds the selector.
  const t0 = Date.now();
  let clicked = false;
  try {
    await adapter.advance(ctx, 'submit');
    clicked = true;
  } catch (e) {
    throw new Error(`submit click failed before any application was filed: ${e.message}`);
  }

  let evidence = null;
  let verified_by = 'unconfirmed-click';
  try {
    evidence = await withTimeout(adapter.readConfirmation(ctx), confirmTimeoutMs);
    verified_by = evidence?.applicationId ? 'application-id' : 'confirmation-page';
  } catch {
    // Q4: NEVER retried. The click succeeded; we simply could not read the
    // page in time. Recording this as "retry" is how a duplicate gets filed.
    stream.emit('adapter_note', {
      msg: 'confirmation read timed out after a successful submit click; recording as unconfirmed-click, not retrying',
      extra: { elapsed_ms: Date.now() - t0 },
    });
  }

  if (screenshotPath && clicked) {
    try {
      await page.screenshot({ path: screenshotPath, fullPage: true });
      stream.emit('evidence_captured', { kind: 'confirmation', path: screenshotPath });
    } catch { /* evidence is best-effort; the submit record is not */ }
  }

  const ev = stream.emit('submitted', {
    application_id: evidence?.applicationId ?? null,
    confirmation_url: evidence?.url ?? page.url(),
    confirmation_text: (evidence?.text ?? '').slice(0, 400) || '(confirmation not read within timeout)',
    screenshot: screenshotPath,
    verified_by,
  });
  return { event: ev, verified_by, evidence };
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('confirmation read timeout')), ms)),
  ]);
}

/**
 * Extract an application id from confirmation text. Ordered, explicit
 * patterns — an id we cannot find is null, never a plausible-looking number
 * scraped off the page.
 */
export const APPLICATION_ID_PATTERNS = Object.freeze([
  /\b(?:application|confirmation|reference|requisition)\s*(?:id|number|#)\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{3,20})\b/i,
  /\bJob\s*ID\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{3,20})\b/i,
  /\b(R-\d{4,})\b/,
  /\b(REQ-?\d{4,})\b/i,
]);

export function extractApplicationId(text) {
  const t = String(text ?? '');
  for (const re of APPLICATION_ID_PATTERNS) {
    const m = re.exec(t);
    if (m) return m[1];
  }
  return null;
}
