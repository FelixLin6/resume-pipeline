// The gates: review diff, the in-code submit assertion (C6), the submit
// budget (Q4), and wall memory with decay (C4).
//
// These are the rules that stand between a filled form and a filed
// application, so each test is written as the failure it refuses to repeat.

import test from 'node:test';
import assert from 'node:assert/strict';

import { EventStream } from '../src/events/emitter.js';
import { diffReview, checkJobFacts, emitReviewDiff } from '../src/engine/review.js';
import {
  assertReviewGate, assertSubmitBudget, lastMutatingSeq,
  ReviewGateError, SubmitBudgetError, extractApplicationId,
} from '../src/engine/submit.js';
import { WallMemory, detectWall, wallKey, DECAY_DAYS } from '../src/engine/walls.js';
import { sha256 } from '../src/engine/fill.js';

const JOB = '8f2c1a94-6d3e-4b77-9a10-2f5c8e1b4d90';
const mk = () => {
  const s = new EventStream({ run: '2026-09-17', applier: 1 });
  s.context({ job_key: JOB, ats: 'icims', tenant: 'icims:careers-acme.icims.com' });
  return s;
};

// ------------------------------------------------------------ review diff --

test('a matching review page passes', () => {
  const d = diffReview(
    [{ field_key: 'education.school', intended: 'Carnegie Mellon University' }],
    { 'School or University': 'Carnegie Mellon University' },
    [{ key: 'education.school', label: 'School or University' }],
  );
  assert.equal(d.verdict, 'pass');
  assert.equal(d.checked, 1);
  assert.equal(d.matched, 1);
});

test('a mismatch on an eligibility field FAILS the diff', () => {
  const d = diffReview(
    [{ field_key: 'education.fieldOfStudy', intended: 'Artificial Intelligence' },
      { field_key: 'auth.sponsorship', intended: 'No, I do not require sponsorship' }],
    { Major: 'Computer Science', Sponsorship: 'Yes' },
    [{ key: 'education.fieldOfStudy', label: 'Major' }, { key: 'auth.sponsorship', label: 'Sponsorship' }],
  );
  assert.equal(d.verdict, 'fail');
  assert.equal(d.mismatches.length, 2);
  assert.equal(d.mismatches.find((m) => m.field_key === 'education.fieldOfStudy').severity, 'warn');
  assert.equal(d.mismatches.find((m) => m.field_key === 'auth.sponsorship').severity, 'fail');
});

test('Q5: an identity mismatch is proved by hashes, not by publishing the values', () => {
  const d = diffReview(
    [{ field_key: 'contact.email', intended: 'felixl0808@gmail.com' }],
    { Email: 'felixl@andrew.cmu.edu' },
    [{ key: 'contact.email', label: 'Email' }],
  );
  assert.equal(d.verdict, 'fail');
  const m = d.mismatches[0];
  assert.ok(m.intended_hash && m.rendered_hash);
  assert.notEqual(m.intended_hash, m.rendered_hash);
  assert.equal(JSON.stringify(d).includes('cmu.edu'), false);
  // And the whole diff can be emitted without tripping the PII guard.
  assert.doesNotThrow(() => emitReviewDiff(mk(), d));
});

test('F20: a form/joblist term contradiction is caught mechanically', () => {
  // Cyvl went out saying Summer 2027 while the joblist said 2026, on a
  // one-shot Ashby, because a human read the review page.
  const bad = checkJobFacts({ rendered: { Term: 'Summer 2026 Internship' }, jobFacts: { term: 'Summer 2027' } });
  assert.equal(bad.length, 1);
  assert.equal(bad[0].severity, 'fail');
  const good = checkJobFacts({ rendered: { Term: 'Summer 2027 Internship' }, jobFacts: { term: 'Summer 2027' } });
  assert.deepEqual(good, []);
});

// ------------------------------------------------------- C6: submit gate ---

test('C6: submitting without any review diff is refused', () => {
  const s = mk();
  s.emit('field_filled', { field_key: 'education.school', value_hash: sha256('x'), strategy: 'fill' });
  assert.throws(() => assertReviewGate(s.events, lastMutatingSeq(s.events)),
    ReviewGateError, 'no diff means no submit');
});

test('C6: a FAILING review diff cannot be passed — the abort lives in code', () => {
  const s = mk();
  s.emit('field_filled', { field_key: 'education.school', value_hash: sha256('x'), strategy: 'fill' });
  s.emit('review_diff', {
    checked: 3, matched: 2, verdict: 'fail',
    mismatches: [{ field_key: 'auth.sponsorship', intended: 'No', rendered: 'Yes', severity: 'fail' }],
  });
  assert.throws(() => assertReviewGate(s.events, lastMutatingSeq(s.events)), ReviewGateError);
});

test('C6: a STALE passing diff cannot authorize a submit', () => {
  const s = mk();
  s.emit('review_diff', { checked: 3, matched: 3, mismatches: [], verdict: 'pass' });
  // …and then the form changed.
  s.emit('field_filled', { field_key: 'education.gpa', value_hash: sha256('3.36'), strategy: 'fill' });
  assert.throws(
    () => assertReviewGate(s.events, lastMutatingSeq(s.events)),
    /stale/,
    'a diff that passed before the last fill is not evidence about this form',
  );
});

test('C6: a fresh passing diff authorizes exactly one submit', () => {
  const s = mk();
  s.emit('field_filled', { field_key: 'education.gpa', value_hash: sha256('3.36'), strategy: 'fill' });
  s.emit('review_diff', { checked: 3, matched: 3, mismatches: [], verdict: 'pass' });
  const rd = assertReviewGate(s.events, lastMutatingSeq(s.events));
  assert.equal(rd.data.verdict, 'pass');
});

// -------------------------------------------------------- Q4: submit budget --

test('Q4: the default budget is 1, and a second submit is refused', () => {
  const s = mk();
  assert.equal(assertSubmitBudget(s.events, 1), 0);
  s.emit('submitted', {
    application_id: 'R-1', confirmation_text: 'Thank you for applying',
    confirmation_url: 'https://x/done', verified_by: 'confirmation-page',
  });
  assert.throws(() => assertSubmitBudget(s.events, 1), SubmitBudgetError);
});

test('Q4: an unconfirmed click still counts as submitted and blocks a retry', () => {
  const s = mk();
  s.emit('submitted', {
    application_id: null, confirmation_text: '(confirmation not read within timeout)',
    confirmation_url: 'https://x', verified_by: 'unconfirmed-click',
  });
  assert.throws(() => assertSubmitBudget(s.events, 1), SubmitBudgetError,
    'a double submission is worse than a missed retry');
});

test('application ids are extracted by explicit pattern, or not at all', () => {
  assert.equal(extractApplicationId('Application ID: R-104882 thank you'), 'R-104882');
  assert.equal(extractApplicationId('Job ID 2026-11219'), '2026-11219');
  assert.equal(
    extractApplicationId('Your application was submitted successfully. Thank you for applying.'),
    null,
    'no plausible-looking number is scraped off the page when there is no id',
  );
});

// ------------------------------------------------------- C4: wall memory ----

test('C4: wall memory is keyed (tenant, wall_class, where)', () => {
  // iCIMS double-gates: a captcha at the guest gate costs nothing to retry, a
  // captcha at Submit Profile costs a fully filled form. Conflating them makes
  // the policy wrong in both directions.
  const w = new WallMemory();
  w.record('icims:careers-gdms.icims.com', 'hcaptcha', 'guest-apply');
  assert.equal(w.effectiveOccurrences('icims:careers-gdms.icims.com', 'hcaptcha', 'guest-apply'), 1);
  assert.equal(w.effectiveOccurrences('icims:careers-gdms.icims.com', 'hcaptcha', 'submit'), 0);
  assert.equal(wallKey('t', 'hcaptcha', 'submit'), 't|hcaptcha|submit');
});

test('C4: occurrences 1-2 retry, the third strike skips', () => {
  const w = new WallMemory();
  const t = 'icims:careers-gdms.icims.com';
  assert.equal(w.decide(t, 'hcaptcha', 'guest-apply'), 'retry-fresh-context');
  w.record(t, 'hcaptcha', 'guest-apply');
  w.record(t, 'hcaptcha', 'guest-apply');
  assert.equal(w.decide(t, 'hcaptcha', 'guest-apply'), 'retry-fresh-context',
    'the retry succeeded 3 times in 4 on the one day we measured');
  w.record(t, 'hcaptcha', 'guest-apply');
  assert.equal(w.decide(t, 'hcaptcha', 'guest-apply'), 'skip-retry-third-strike');
});

test('C4: the third-strike skip DECAYS after 14 days', () => {
  let now = new Date('2026-09-17T12:00:00Z');
  const w = new WallMemory({ now: () => now });
  const t = 'icims:careers-gdms.icims.com';
  for (let i = 0; i < 3; i++) w.record(t, 'hcaptcha', 'guest-apply');
  assert.equal(w.decide(t, 'hcaptcha', 'guest-apply'), 'skip-retry-third-strike');

  now = new Date(`2026-10-0${1}T12:00:00Z`);                  // 14 days later
  assert.equal(w.decide(t, 'hcaptcha', 'guest-apply'), 'skip-retry-third-strike',
    'exactly at the boundary the skip still stands');

  now = new Date('2026-10-05T12:00:00Z');                     // 18 days later
  assert.equal(w.decide(t, 'hcaptcha', 'guest-apply'), 'retry-fresh-context',
    'a tenant that gated in September is not thereby gated forever');
  assert.equal(w.expired().length, 1, 'the expiry is reported, not silent');
  assert.equal(DECAY_DAYS, 14);
});

test('C4: classes a retry cannot possibly help short-circuit to park', () => {
  const w = new WallMemory();
  // DataDome never renders the SPA, so there is no challenge to solve.
  assert.equal(w.decide('t', 'datadome', 'preflight'), 'park');
  assert.equal(w.decide('t', 'recaptcha-v3-score', 'submit'), 'park');
  assert.equal(w.decide('t', 'http-403', 'preflight'), 'park');
});

test('a cleared retry is counted so the policy can be re-tuned from data', () => {
  const w = new WallMemory();
  w.record('t', 'hcaptcha', 'guest-apply');
  w.recordCleared('t', 'hcaptcha', 'guest-apply');
  assert.equal(w.data[wallKey('t', 'hcaptcha', 'guest-apply')].cleared_on_retry, 1);
});

// --------------------------------------------------- wall DETECTION shape ---

test('detectWall requires VISIBILITY by default, not mere presence', async () => {
  // This is the correction recon forced: every iCIMS login page carries an
  // hCaptcha iframe whether or not a challenge fires, so a presence marker
  // would have parked 100% of iCIMS applications.
  const fakeLoc = (count, visible) => ({
    first: () => ({ count: async () => count, isVisible: async () => visible }),
  });
  const dormantRoot = { locator: () => fakeLoc(1, false) };
  const firedRoot = { locator: () => fakeLoc(1, true) };
  const markers = [{ wallClass: 'hcaptcha', selector: 'iframe[title="hCaptcha challenge"]', requireVisible: true }];

  assert.equal(await detectWall(markers, { page: dormantRoot, root: dormantRoot }), null,
    'a dormant widget is not a wall');
  const hit = await detectWall(markers, { page: firedRoot, root: firedRoot });
  assert.equal(hit.wallClass, 'hcaptcha');
});

test('detectWall maps an HTTP status to its class', async () => {
  const root = { locator: () => ({ first: () => ({ count: async () => 0, isVisible: async () => false }) }) };
  const hit = await detectWall([{ wallClass: 'http-403', status: 403 }], { page: root, root, status: 403 });
  assert.equal(hit.wallClass, 'http-403');
});
