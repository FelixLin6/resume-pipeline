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

export class ReviewGateError extends Error {}
export class SubmitBudgetError extends Error {}

/**
 * Assert the review gate. Called by submit() before anything is clicked.
 *
 * @param {object[]} events   the emitted event list for THIS job, in order
 * @param {number} lastMutatingSeq  seq of the last event that changed the form
 */
export function assertReviewGate(events, lastMutatingSeq) {
  const diffs = events.filter((e) => e.type === 'review_diff');
  const rd = diffs.at(-1);
  if (!rd) throw new ReviewGateError('refusing to submit: no review diff was produced');
  if (rd.data.verdict !== 'pass') {
    throw new ReviewGateError(
      `refusing to submit: review diff verdict is "${rd.data.verdict}" ` +
      `(${rd.data.mismatches?.filter((m) => m.severity === 'fail').length ?? 0} failing mismatch(es))`
    );
  }
  // A diff that passed BEFORE the last fill is not evidence about the form we
  // are about to submit.
  if (typeof lastMutatingSeq === 'number' && rd.seq < lastMutatingSeq) {
    throw new ReviewGateError(
      `refusing to submit: the review diff (seq ${rd.seq}) is stale — ` +
      `the form changed at seq ${lastMutatingSeq}`
    );
  }
  return rd;
}

/** Events that change what would be submitted. */
const MUTATING = new Set(['field_filled', 'upload_verified', 'page_advanced']);

export function lastMutatingSeq(events) {
  const m = events.filter((e) => MUTATING.has(e.type));
  return m.length ? m.at(-1).seq : null;
}

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
}) {
  const emitted = stream.events.filter((e) => e.job_key === ctx.jobKey);
  assertReviewGate(emitted, lastMutatingSeq(emitted));
  assertSubmitBudget(emitted, adapter.quirks?.maxSubmitAttempts ?? 1);

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
