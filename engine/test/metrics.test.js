// The metric harness and the Gate 2 assertion.
//
// Gate 2's abort condition (architecture.md §9) is "any engine submit without a
// passing review diff, any duplicate submission". C6 ruled that this must live
// in CODE, not in a runbook. It now lives in code twice — as a runtime refusal
// in submit(), and as an audit over a finished stream — and this file tests
// both, because the runtime check can only protect code that calls it while the
// audit protects the RECORD, and the record is what Gate 2 is judged on.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { EventStream } from '../src/events/emitter.js';
import {
  evaluateGate, assertProceedAllowed, auditStream, assertStreamClean,
  Gate2Violation, isReviewDiff,
} from '../src/engine/gate2.js';
import { assertReviewGate, ReviewGateError, lastMutatingSeq } from '../src/engine/submit.js';
import { perApplication, aggregateByAts, analyze, ACTION_WEIGHTS, BUDGETS } from '../src/metrics/harness.js';
import { renderMarkdown } from '../src/metrics/report.js';
import { buildReport } from '../tools/metrics-report.js';

const JOB_A = '8f2c1a94-6d3e-4b77-9a10-2f5c8e1b4d90';
const JOB_B = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

function stream({ applier = 0 } = {}) {
  const s = new EventStream({ run: '2026-09-17', applier });
  s.context({ job_key: JOB_A, tenant: 'icims:careers-gdms.icims.com', ats: 'icims', step: 'review' });
  return s;
}

/** A complete, clean application. */
function cleanApplication(s, job = JOB_A, ats = 'icims') {
  s.context({ job_key: job, ats });
  s.emit('application_started', { apply_url: 'https://x/apply', attempt: 1, claim: 'none' });
  s.emit('field_discovered', { count: 12, required: 6, root_frames: [] });
  for (let i = 0; i < 4; i++) {
    s.emit('field_filled', { field_key: 'education.school', value_hash: 'sha256:a', strategy: 'fill', retries: 0 });
  }
  s.emit('review_diff', { checked: 8, matched: 8, mismatches: [], verdict: 'pass' });
  s.emit('submitted', {
    application_id: 'R-104882', confirmation_url: 'https://x/done',
    confirmation_text: 'Thank you for applying', verified_by: 'application-id',
  });
  s.emit('application_ended', { outcome: 'submitted', reason: 'ok', duration_ms: 1000, tool_calls: null, model_turns: 0 });
  return s;
}

// -------------------------------------------------------------- the gate ---

test('a passing, fresh review diff lets the submit through', () => {
  const s = stream();
  s.emit('field_filled', { field_key: 'education.school', value_hash: 'sha256:a', strategy: 'fill' });
  s.emit('review_diff', { checked: 4, matched: 4, mismatches: [], verdict: 'pass' });
  const v = evaluateGate(s.events);
  assert.equal(v.ok, true);
  assert.doesNotThrow(() => assertProceedAllowed(s.events));
});

test('no diff at all is a refusal', () => {
  const s = stream();
  s.emit('field_filled', { field_key: 'education.school', value_hash: 'sha256:a', strategy: 'fill' });
  assert.equal(evaluateGate(s.events).reason, 'no-review-diff');
  assert.throws(() => assertProceedAllowed(s.events), Gate2Violation);
  assert.throws(() => assertReviewGate(s.events, lastMutatingSeq(s.events)), ReviewGateError);
});

test('a FAILING diff is a refusal — the Gate 2 abort condition itself', () => {
  const s = stream();
  s.emit('field_filled', { field_key: 'avail.term', value_hash: 'sha256:a', strategy: 'fill' });
  s.emit('review_diff', {
    checked: 6, matched: 5,
    mismatches: [{ field_key: 'avail.term', intended: 'Summer 2027', rendered: 'Summer 2026', severity: 'fail' }],
    verdict: 'fail',
  });
  const v = evaluateGate(s.events);
  assert.equal(v.reason, 'failing-review-diff');
  assert.equal(v.detail.failing_mismatches, 1);
  // F20, Cyvl: a term mismatch went out because a human read the review page.
  assert.throws(() => assertProceedAllowed(s.events), Gate2Violation);
  assert.throws(() => assertReviewGate(s.events, lastMutatingSeq(s.events)), /verdict is "fail"/);
});

test('a diff that predates the last fill is STALE', () => {
  const s = stream();
  s.emit('review_diff', { checked: 4, matched: 4, mismatches: [], verdict: 'pass' });
  s.emit('field_filled', { field_key: 'education.gpa', value_hash: 'sha256:b', strategy: 'fill' });
  assert.equal(evaluateGate(s.events).reason, 'stale-review-diff');
  assert.throws(() => assertReviewGate(s.events, lastMutatingSeq(s.events)), /stale/);
});

test('a post-upload BARRIER diff is not the review diff, and a failing one blocks', () => {
  const s = stream();
  s.emit('field_filled', { field_key: 'contact.email', value_hash: 'sha256:a', value_preview: null, value_len: 20, strategy: 'fill' });
  s.emit('review_diff', { checked: 6, matched: 6, mismatches: [], verdict: 'pass' });
  // The résumé parser clobbered a field during the post-upload re-verify. A
  // barrier emits NO mutating event, so staleness alone would let this through.
  s.emit('review_diff', {
    checked: 3, matched: 2,
    mismatches: [{ field_key: 'contact.email', severity: 'fail' }],
    verdict: 'fail', scope: 'post_upload_reverify',
  });
  assert.equal(evaluateGate(s.events).reason, 'unresolved-barrier-failure');
  assert.throws(() => assertReviewGate(s.events, lastMutatingSeq(s.events)), /barrier diff/);

  // And a PASSING barrier diff must not be mistaken FOR the review diff.
  const s2 = stream();
  s2.emit('field_filled', { field_key: 'education.school', value_hash: 'sha256:a', strategy: 'fill' });
  s2.emit('review_diff', { checked: 3, matched: 3, mismatches: [], verdict: 'pass', scope: 'post_upload_reverify' });
  assert.equal(evaluateGate(s2.events).reason, 'no-review-diff',
    'a barrier pass is not evidence that the review page matched intent');
  assert.equal(isReviewDiff(s2.events.at(-1)), false);
});

test('there is no way to spell "submit anyway"', () => {
  const s = stream();
  s.emit('review_diff', { checked: 1, matched: 0, mismatches: [{ field_key: 'contact.email', severity: 'fail' }], verdict: 'fail' });
  // The second parameter is a LABEL for the error message, not a policy input,
  // so anything a caller invents alongside it is inert. `force` is the obvious
  // thing a future caller would reach for; it does nothing.
  assert.throws(() => assertProceedAllowed(s.events, { what: 'submit', force: true }), Gate2Violation);
  assert.throws(() => assertProceedAllowed(s.events, { override: true, bypass: true }), Gate2Violation);
  // And the same refusal reaches the caller through submit()'s own gate.
  assert.throws(() => assertReviewGate(s.events, lastMutatingSeq(s.events)), ReviewGateError);
});

// ----------------------------------------------------------- the audit -----

test('the audit catches a submit that was proceeded past a failing diff', () => {
  const s = stream();
  s.emit('field_filled', { field_key: 'avail.term', value_hash: 'sha256:a', strategy: 'fill' });
  s.emit('review_diff', { checked: 2, matched: 1, mismatches: [{ field_key: 'avail.term', severity: 'fail' }], verdict: 'fail' });
  s.emit('submitted', {
    application_id: null, confirmation_url: 'https://x', confirmation_text: 'Thanks',
    verified_by: 'unconfirmed-click',
  });

  const { violations } = auditStream(s.events);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].kind, 'submit-without-passing-diff');
  assert.equal(violations[0].reason, 'failing-review-diff');
  assert.throws(() => assertStreamClean(s.events), Gate2Violation);
});

test('the audit catches a DUPLICATE submission', () => {
  const s = stream();
  s.emit('field_filled', { field_key: 'education.school', value_hash: 'sha256:a', strategy: 'fill' });
  s.emit('review_diff', { checked: 2, matched: 2, mismatches: [], verdict: 'pass' });
  s.emit('submitted', { application_id: 'R-1', confirmation_url: 'u', confirmation_text: 'Thanks', verified_by: 'application-id' });
  s.emit('submitted', { application_id: 'R-1', confirmation_url: 'u', confirmation_text: 'Thanks', verified_by: 'application-id' });

  const kinds = auditStream(s.events).violations.map((v) => v.kind);
  assert.ok(kinds.includes('duplicate-submission'),
    'a double submission is worse than a missed retry in every case in the record');
});

test('a clean stream audits clean', () => {
  const s = cleanApplication(stream());
  const a = auditStream(s.events);
  assert.deepEqual(a.violations, []);
  assert.equal(a.submits, 1);
  assert.equal(a.jobs, 1);
  assert.equal(assertStreamClean(s.events), true);
});

test('the audit evaluates each submit AS OF ITS OWN SEQ', () => {
  // A later passing diff must not retroactively bless an earlier bad submit.
  const s = stream();
  s.emit('field_filled', { field_key: 'education.school', value_hash: 'sha256:a', strategy: 'fill' });
  s.emit('submitted', { application_id: 'R-1', confirmation_url: 'u', confirmation_text: 'T', verified_by: 'application-id' });
  s.emit('review_diff', { checked: 2, matched: 2, mismatches: [], verdict: 'pass' });

  const { violations } = auditStream(s.events);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].reason, 'no-review-diff');
});

// --------------------------------------------------------- the accounting --

test('per-application accounting separates seq span, tool calls and actions', () => {
  const s = cleanApplication(stream());
  const [row] = perApplication(s.events);

  assert.equal(row.job_key, JOB_A);
  assert.equal(row.ats, 'icims');
  assert.equal(row.outcome, 'submitted');
  assert.equal(row.complete, true);
  assert.equal(row.submitted, true);
  assert.equal(row.review_verdict, 'pass');
  assert.equal(row.fields_filled, 4);

  // Heartbeats are engine liveness (Q7: one per 10 events), not work. Leaving
  // them in would inflate every application by ~10% and make the budget a
  // measure of how long we spent rather than what we did.
  assert.ok(row.heartbeats >= 0);
  assert.equal(row.tool_calls, row.seq_span - row.heartbeats);

  // The weighted estimate is computed from an explicit, auditable table.
  const expected = 1 /* discovered */ + 4 * 2 /* fills incl. read-back */
    + 1 /* review_diff */ + 2 /* submitted */;
  assert.equal(row.browser_actions, expected);
  assert.equal(ACTION_WEIGHTS.field_filled, 2, 'a fill that is not read back is not a fill');
  assert.equal(ACTION_WEIGHTS.field_mapped, 0, 'mapping is computation, not a round trip');
});

test('a barrier diff is not double-charged', () => {
  const s = stream();
  s.emit('application_started', { apply_url: 'u', attempt: 1, claim: 'none' });
  s.emit('field_discovered', { count: 3, required: 1, root_frames: [] });
  s.emit('review_diff', { checked: 1, matched: 1, mismatches: [], verdict: 'pass', scope: 'post_upload_reverify' });
  s.emit('application_ended', { outcome: 'assist', reason: 'x', duration_ms: 1, tool_calls: null, model_turns: 0 });
  const [row] = perApplication(s.events);
  // The barrier rides on a discovery pass that is already counted.
  assert.equal(row.browser_actions, 1);
});

test('an application with no application_ended is INCOMPLETE, not zero-cost', () => {
  const s = stream();
  s.emit('application_started', { apply_url: 'u', attempt: 1, claim: 'none' });
  s.emit('field_discovered', { count: 3, required: 1, root_frames: [] });
  const [row] = perApplication(s.events);
  assert.equal(row.complete, false);
  assert.equal(row.outcome, null);
  assert.ok(row.tool_calls > 0);
});

test('a self-reported tool_calls that the stream does not bear out is flagged', () => {
  const s = stream();
  s.emit('application_started', { apply_url: 'u', attempt: 1, claim: 'none' });
  s.emit('field_discovered', { count: 3, required: 1, root_frames: [] });
  s.emit('application_ended', { outcome: 'wall', reason: 'x', duration_ms: 1, tool_calls: 999, model_turns: 0 });
  const [row] = perApplication(s.events);
  assert.ok(row.tool_call_disagreement);
  assert.equal(row.tool_call_disagreement.reported, 999);
  assert.notEqual(row.tool_call_disagreement.measured, 999);
});

test('per-ATS aggregation reports the budget honestly', () => {
  const s = stream();
  cleanApplication(s, JOB_A, 'icims');
  cleanApplication(s, JOB_B, 'greenhouse');

  const rows = perApplication(s.events);
  const byAts = aggregateByAts(rows);
  const icims = byAts.find((a) => a.ats === 'icims');
  const gh = byAts.find((a) => a.ats === 'greenhouse');

  // C7: only iCIMS carries a line-item target, because it is the only row with
  // a measured baseline on both sides.
  assert.equal(icims.budget, 40);
  assert.equal(icims.verdict, 'within budget');
  assert.equal(gh.budget, null);
  assert.equal(gh.verdict, 'TBD from shadow',
    'publishing an estimate in the same typography as a measurement is how a target ' +
    'nobody measured becomes a target nobody can be held to');
  assert.equal(BUDGETS.workday, null);
  assert.equal(BUDGETS.lever, null);
});

test('an over-budget application is REPORTED, never abandoned', () => {
  const s = stream();
  s.context({ job_key: JOB_A, ats: 'icims' });
  s.emit('application_started', { apply_url: 'u', attempt: 1, claim: 'none' });
  for (let i = 0; i < 60; i++) {
    s.emit('field_filled', { field_key: 'education.school', value_hash: 'sha256:a', strategy: 'fill' });
  }
  s.emit('application_ended', { outcome: 'submitted', reason: 'ok', duration_ms: 1, tool_calls: null, model_turns: 0 });

  const a = aggregateByAts(perApplication(s.events));
  const icims = a.find((x) => x.ats === 'icims');
  assert.equal(icims.over_budget.length, 1);
  assert.match(icims.verdict, /^OVER on 1\/1$/);
});

// --------------------------------------------------------------- report ----

test('the report leads with Gate 2 and refuses to call a violating run clean', () => {
  const s = stream();
  s.emit('field_filled', { field_key: 'avail.term', value_hash: 'sha256:a', strategy: 'fill' });
  s.emit('review_diff', { checked: 1, matched: 0, mismatches: [{ field_key: 'avail.term', severity: 'fail' }], verdict: 'fail' });
  s.emit('submitted', { application_id: null, confirmation_url: 'u', confirmation_text: 'T', verified_by: 'unconfirmed-click' });
  s.emit('application_ended', { outcome: 'submitted', reason: 'x', duration_ms: 1, tool_calls: null, model_turns: 0 });

  const md = renderMarkdown(analyze(s.events, { meta: { run: '2026-09-17' } }));
  assert.match(md, /## Gate 2/);
  assert.match(md, /VIOLATION\(S\)/);
  assert.match(md, /no ATS may graduate/);
  assert.equal(/No violations/.test(md), false);
});

test('a clean report names the numbers and the caveats', () => {
  const s = stream();
  cleanApplication(s, JOB_A, 'icims');
  // A second ATS with no measured budget, which is the case the "TBD from
  // shadow" typography exists for.
  cleanApplication(s, JOB_B, 'lever');
  const md = renderMarkdown(analyze(s.events, { meta: { run: '2026-09-17', files: 1 } }));
  assert.match(md, /No violations/);
  assert.match(md, /_TBD from shadow_/);
  assert.match(md, /would_require_invention/);
  // The honest caveat the droplet asked for.
  assert.match(md, /ground truth for iCIMS must come from Mac-side runs/);
  // Q5: a full job key never appears in a rendered report either.
  assert.equal(md.includes(JOB_A), false);
});

test('the report reads a real JSONL run directory end to end', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-metrics-'));
  const eventsDir = path.join(dir, 'events');

  const s0 = new EventStream({ run: '2026-09-17', applier: 0, file: path.join(eventsDir, 'applier0.jsonl') });
  s0.context({ tenant: 'icims:careers-gdms.icims.com', ats: 'icims' });
  cleanApplication(s0, JOB_A, 'icims');
  s0.close();

  const s1 = new EventStream({ run: '2026-09-17', applier: 1, file: path.join(eventsDir, 'applier1.jsonl') });
  s1.context({ tenant: 'lever:kitware', ats: 'lever' });
  cleanApplication(s1, JOB_B, 'lever');
  s1.close();

  const { analysis, markdown } = buildReport(eventsDir);
  assert.equal(analysis.totals.applications, 2);
  assert.equal(analysis.totals.submitted, 2);
  assert.equal(analysis.gate2.violations.length, 0);
  assert.equal(analysis.meta.files, 2);
  assert.match(markdown, /Apply-engine metrics/);
  assert.match(markdown, /\| lever \|/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('a truncated final line is reported in the metric report, never repaired', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-metrics-'));
  const eventsDir = path.join(dir, 'events');
  const file = path.join(eventsDir, 'applier0.jsonl');

  const s = new EventStream({ run: '2026-09-17', applier: 0, file });
  cleanApplication(s, JOB_A, 'icims');
  s.close();
  fs.appendFileSync(file, '{"v":1,"ts":"2026-09-17T20:00:00Z","seq":99,"run":"2026');

  const { analysis, markdown } = buildReport(eventsDir);
  assert.equal(analysis.meta.truncated.length, 1);
  assert.match(markdown, /truncated final line/);
  assert.match(markdown, /dropped, not repaired/);

  fs.rmSync(dir, { recursive: true, force: true });
});
