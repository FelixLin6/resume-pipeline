// Gate 2, in code. Design: interfaces.md §5.6 (C6), architecture.md §9.
//
// The cutover plan's Gate 2 abort condition reads: "any engine submit without a
// passing review diff, any duplicate submission → stop, revert to the current
// stack for the remainder, report." C6's ruling is that this must not be a
// runbook line a supervising agent might overlook. So it exists twice, and both
// are in this file:
//
//   RUNTIME   assertProceedAllowed() — called before the engine advances past
//             a diff or clicks a submit control. Throws. There is no flag and
//             no caller-supplied bypass: "proceed anyway" is not spellable.
//
//   AUDIT     auditStream() — the same rule applied to a FINISHED event stream,
//             so a violation is caught even if it were somehow produced by a
//             code path that skipped the runtime check (a fallback adapter, a
//             resumed engine, a future refactor). The metric report runs this
//             over every stream it reads and refuses to render a clean report
//             over a stream that contains a violation.
//
// Why an audit as well as an assertion: the runtime check can only protect code
// that calls it. The audit protects the RECORD, and the record is what Gate 2
// is judged on. A day that produced a violation must be un-reportable as clean.

/** A `review_diff` emitted by the post-upload barrier is scoped; the review
 *  page's own diff is not. They are different claims and the gate must not
 *  confuse them — a passing barrier diff is not evidence that the review page
 *  matched intent. */
export const REVIEW_SCOPE = 'review';

export class Gate2Violation extends Error {
  constructor(msg, detail = {}) { super(msg); this.detail = detail; }
}

export const isReviewDiff = (e) =>
  e.type === 'review_diff' && (e.data?.scope ?? REVIEW_SCOPE) === REVIEW_SCOPE;

/** Events that change what would be submitted. Shared with submit.js. */
export const MUTATING_TYPES = Object.freeze(['field_filled', 'upload_verified', 'page_advanced']);

export function lastMutatingSeq(events) {
  const m = events.filter((e) => MUTATING_TYPES.includes(e.type));
  return m.length ? m.at(-1).seq : null;
}

/**
 * The single rule, expressed once and used by both entry points.
 *
 * @param {object[]} events  this job's events, in seq order
 * @param {number} [beforeSeq]  evaluate the stream as it stood before this seq
 * @returns {{ok:true, diff:object} | {ok:false, reason:string, detail:object}}
 */
export function evaluateGate(events, beforeSeq = Infinity) {
  const upto = events.filter((e) => e.seq < beforeSeq);
  const diffs = upto.filter((e) => e.type === 'review_diff');
  const reviews = diffs.filter(isReviewDiff);
  const rd = reviews.at(-1);

  if (!rd) return { ok: false, reason: 'no-review-diff', detail: { diffs: diffs.length } };

  if (rd.data.verdict !== 'pass') {
    const failing = rd.data.mismatches?.filter((m) => m.severity === 'fail') ?? [];
    return {
      ok: false,
      reason: 'failing-review-diff',
      detail: { seq: rd.seq, verdict: rd.data.verdict, failing_mismatches: failing.length },
    };
  }

  // A diff that passed BEFORE the last fill is not evidence about the form we
  // are about to submit.
  const mut = lastMutatingSeq(upto);
  if (typeof mut === 'number' && rd.seq < mut) {
    return { ok: false, reason: 'stale-review-diff', detail: { diff_seq: rd.seq, mutated_at: mut } };
  }

  // A FAILING barrier diff after the review diff — a résumé parser that
  // clobbered a field during the post-upload re-verify, say — does not make the
  // review diff stale (a barrier emits no mutating event), so staleness alone
  // would let it through. It is checked explicitly.
  const laterFail = diffs.find((e) => e.seq > rd.seq && e.data.verdict === 'fail');
  if (laterFail) {
    return {
      ok: false,
      reason: 'unresolved-barrier-failure',
      detail: { diff_seq: rd.seq, barrier_seq: laterFail.seq, scope: laterFail.data.scope ?? null },
    };
  }

  return { ok: true, diff: rd };
}

/** RUNTIME. Throws unless this job may proceed past its diff. */
export function assertProceedAllowed(events, { what = 'submit' } = {}) {
  const v = evaluateGate(events);
  if (!v.ok) {
    throw new Gate2Violation(
      `Gate 2: refusing to ${what} — ${explain(v.reason, v.detail)}`,
      { reason: v.reason, ...v.detail },
    );
  }
  return v.diff;
}

function explain(reason, d) {
  switch (reason) {
    case 'no-review-diff': return 'no review-page diff was produced for this application';
    case 'failing-review-diff':
      return `the review diff (seq ${d.seq}) is "${d.verdict}" with ${d.failing_mismatches} failing mismatch(es)`;
    case 'stale-review-diff':
      return `the review diff (seq ${d.diff_seq}) is stale — the form changed at seq ${d.mutated_at}`;
    case 'unresolved-barrier-failure':
      return `a barrier diff at seq ${d.barrier_seq} failed after the review diff at seq ${d.diff_seq}`;
    /* c8 ignore next */
    default: return reason;
  }
}

/**
 * AUDIT. Apply the rule to a finished stream, per job.
 *
 * @param {object[]} events  a merged, sorted stream (any number of jobs)
 * @returns {{violations: object[], jobs: number, submits: number}}
 */
export function auditStream(events) {
  const byJob = new Map();
  for (const e of events) {
    if (e.job_key === '-') continue;
    if (!byJob.has(e.job_key)) byJob.set(e.job_key, []);
    byJob.get(e.job_key).push(e);
  }

  const violations = [];
  let submits = 0;

  for (const [job, evs] of byJob) {
    const sorted = [...evs].sort((a, b) => a.seq - b.seq);
    const submitted = sorted.filter((e) => e.type === 'submitted');
    submits += submitted.length;

    for (const s of submitted) {
      const v = evaluateGate(sorted, s.seq);
      if (!v.ok) {
        violations.push({
          job_key: job, kind: 'submit-without-passing-diff', at_seq: s.seq,
          reason: v.reason, detail: v.detail, ats: s.ats ?? null, tenant: s.tenant ?? null,
        });
      }
    }

    // The cutover plan's other abort condition, and the one the record shows is
    // worse than a missed application in every case (Q4).
    if (submitted.length > 1) {
      violations.push({
        job_key: job, kind: 'duplicate-submission',
        at_seq: submitted.at(-1).seq, reason: 'more-than-one-submit',
        detail: { submits: submitted.length }, ats: submitted[0].ats ?? null,
        tenant: submitted[0].tenant ?? null,
      });
    }
  }

  return { violations, jobs: byJob.size, submits };
}

/** Throw if a finished stream contains any Gate 2 violation. This is what a
 *  report generator calls before it is allowed to describe a day as clean. */
export function assertStreamClean(events) {
  const { violations } = auditStream(events);
  if (violations.length) {
    const first = violations[0];
    throw new Gate2Violation(
      `Gate 2: ${violations.length} violation(s) in the stream — ` +
      `first: ${first.kind} on job ${first.job_key} at seq ${first.at_seq} (${first.reason})`,
      { violations },
    );
  }
  return true;
}
