// Wall memory: the C4 key, the 14-day decay, and the Phase 3 solved-session
// reuse window.
//
// The reuse window's evidence, from the droplet's Gate 1 shadow report: on
// 2026-09-17, after Felix solved the JHU APL challenge once by relay, the same
// session's later staging pass went straight through with no re-fire. A solved
// challenge therefore buys a WINDOW, and the right response to a wall on a
// tenant solved an hour ago is to reuse the session, not to park a second time.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  WallMemory, wallKey, THIRD_STRIKE, DECAY_DAYS, SOLVED_TTL_HOURS,
  NO_RETRY_CLASSES, WALL_ACTIONS,
} from '../src/engine/walls.js';
import { EventStream } from '../src/events/emitter.js';
import { EventValidationError } from '../src/events/schema.js';

const JOB = '8f2c1a94-6d3e-4b77-9a10-2f5c8e1b4d90';
const T = 'icims:studentcareers-jhuapl.icims.com';

/** A clock we control: every policy here is time-dependent, and a test that
 *  waits for real time to pass is a test nobody runs. */
function at(iso) { return () => new Date(iso); }

test('C4: the key is (tenant, wall_class, WHERE), not merely tenant', () => {
  const m = new WallMemory({ now: at('2026-09-17T12:00:00Z') });
  m.record(T, 'hcaptcha', 'guest-apply');
  m.record(T, 'hcaptcha', 'submit');
  // iCIMS double-gates. An hCaptcha at the guest gate costs nothing to retry;
  // one at Submit Profile costs a fully filled form. Conflating them would make
  // the retry policy wrong in both directions.
  assert.equal(Object.keys(m.data).length, 2);
  assert.equal(m.effectiveOccurrences(T, 'hcaptcha', 'guest-apply'), 1);
  assert.equal(m.effectiveOccurrences(T, 'hcaptcha', 'submit'), 1);
  assert.equal(wallKey(T, 'hcaptcha', 'submit'), `${T}|hcaptcha|submit`);
});

test('the ladder: retry twice, skip on the third strike', () => {
  const m = new WallMemory({ now: at('2026-09-17T12:00:00Z') });
  assert.equal(m.decide(T, 'hcaptcha', 'guest-apply'), 'retry-fresh-context');
  m.record(T, 'hcaptcha', 'guest-apply');
  assert.equal(m.decide(T, 'hcaptcha', 'guest-apply'), 'retry-fresh-context');
  m.record(T, 'hcaptcha', 'guest-apply');
  assert.equal(m.decide(T, 'hcaptcha', 'guest-apply'), 'retry-fresh-context');
  m.record(T, 'hcaptcha', 'guest-apply');
  assert.equal(m.effectiveOccurrences(T, 'hcaptcha', 'guest-apply'), THIRD_STRIKE);
  assert.equal(m.decide(T, 'hcaptcha', 'guest-apply'), 'skip-retry-third-strike');
});

test('C4: the third-strike skip DECAYS after 14 days', () => {
  const m = new WallMemory({ now: at('2026-09-17T12:00:00Z') });
  for (let i = 0; i < 3; i++) m.record(T, 'hcaptcha', 'guest-apply');
  assert.equal(m.decide(T, 'hcaptcha', 'guest-apply'), 'skip-retry-third-strike');

  // Exactly 14 days later: still inside the window.
  m.now = at('2026-10-01T12:00:00Z');
  assert.equal(m.ageDays(m.data[wallKey(T, 'hcaptcha', 'guest-apply')]), DECAY_DAYS);
  assert.equal(m.decide(T, 'hcaptcha', 'guest-apply'), 'skip-retry-third-strike');

  // Day 15: the tenant gets another chance, and it is REPORTED rather than
  // silently retried.
  m.now = at('2026-10-02T12:00:00Z');
  assert.equal(m.effectiveOccurrences(T, 'hcaptcha', 'guest-apply'), 0);
  assert.equal(m.decide(T, 'hcaptcha', 'guest-apply'), 'retry-fresh-context');
  assert.equal(m.expired().length, 1);
});

test('decay is measured in CALENDAR days, not floating hours', () => {
  // A wall seen at 00:05 must not expire half a day before one seen at 23:55
  // on the same date. Both are "that day" — and "day" means PIPELINE day
  // (America/Los_Angeles), so the edge instants here are the PT day edges:
  // 23:55 PDT on 09-17 and 00:05 PDT on 10-01, fourteen pipeline days apart.
  const m = new WallMemory({ now: at('2026-09-18T06:55:00Z') });
  for (let i = 0; i < 3; i++) m.record(T, 'hcaptcha', 'guest-apply');
  m.now = at('2026-10-01T07:05:00Z');
  assert.equal(m.ageDays(m.data[wallKey(T, 'hcaptcha', 'guest-apply')]), 14);
  assert.equal(m.decide(T, 'hcaptcha', 'guest-apply'), 'skip-retry-third-strike');
});

test('classes a retry cannot possibly help go straight to park', () => {
  const m = new WallMemory({ now: at('2026-09-17T12:00:00Z') });
  for (const cls of NO_RETRY_CLASSES) {
    assert.equal(m.decide('x:y', cls, 'preflight'), 'park', `${cls} must not be retried`);
  }
  // DataDome: the SPA never renders, so there is no challenge to solve.
  assert.ok(NO_RETRY_CLASSES.includes('datadome'));
});

// ------------------------------------------------- solved-session reuse -----

test('a SOLVED challenge opens a reuse window for the tenant', () => {
  const m = new WallMemory({ now: at('2026-09-17T16:27:00Z') });
  for (let i = 0; i < 3; i++) m.record(T, 'hcaptcha', 'guest-apply');
  assert.equal(m.decide(T, 'hcaptcha', 'guest-apply'), 'skip-retry-third-strike');

  m.recordSolved(T, 'hcaptcha', 'guest-apply');

  // The measured gap from the JHU APL observation: 16:27 -> 18:05.
  m.now = at('2026-09-17T18:05:00Z');
  assert.ok(m.hoursSinceSolved(T, 'hcaptcha') < 2);
  assert.equal(
    m.decide(T, 'hcaptcha', 'guest-apply', { hasStorageState: true }),
    'reuse-solved-session',
    'a tenant solved 100 minutes ago should reuse the session, not park on an old strike count');
});

test('a reuse window with NO saved session is worth nothing', () => {
  const m = new WallMemory({ now: at('2026-09-17T16:27:00Z') });
  m.record(T, 'hcaptcha', 'guest-apply');
  m.recordSolved(T, 'hcaptcha', 'guest-apply');
  m.now = at('2026-09-17T17:00:00Z');
  // The window is evidence about a SESSION. With nothing to reuse it must fall
  // through to the ordinary ladder rather than promising a reuse that cannot
  // happen.
  assert.equal(m.decide(T, 'hcaptcha', 'guest-apply', { hasStorageState: false }), 'retry-fresh-context');
});

test('the reuse window EXPIRES', () => {
  const m = new WallMemory({ now: at('2026-09-17T08:00:00Z') });
  m.record(T, 'hcaptcha', 'guest-apply');
  m.recordSolved(T, 'hcaptcha', 'guest-apply');

  m.now = at(`2026-09-17T${String(8 + SOLVED_TTL_HOURS - 1).padStart(2, '0')}:00:00Z`);
  assert.equal(m.decide(T, 'hcaptcha', 'guest-apply', { hasStorageState: true }), 'reuse-solved-session');

  m.now = at('2026-09-18T08:01:00Z');   // 24h + 1m later, past any TTL we would set
  assert.ok(m.hoursSinceSolved(T, 'hcaptcha') > SOLVED_TTL_HOURS);
  assert.equal(m.decide(T, 'hcaptcha', 'guest-apply', { hasStorageState: true }), 'retry-fresh-context');
});

test('a solve is recorded across every WHERE for that tenant and class', () => {
  // Solving the guest-apply puzzle is what earns the trusted session, and that
  // session is equally good at the Submit-Profile gate. This is the one place
  // the C4 key is deliberately widened, because the evidence is about the
  // session rather than the widget's location.
  const m = new WallMemory({ now: at('2026-09-17T16:27:00Z') });
  m.record(T, 'hcaptcha', 'guest-apply');
  m.record(T, 'hcaptcha', 'submit');
  m.recordSolved(T, 'hcaptcha', 'guest-apply');

  m.now = at('2026-09-17T17:30:00Z');
  assert.equal(m.decide(T, 'hcaptcha', 'submit', { hasStorageState: true }), 'reuse-solved-session');
});

test('reuse outcomes are counted so the TTL can be re-tuned from data', () => {
  const m = new WallMemory({ now: at('2026-09-17T16:27:00Z') });
  m.record(T, 'hcaptcha', 'guest-apply');
  m.recordSolved(T, 'hcaptcha', 'guest-apply');
  m.recordReuse(T, 'hcaptcha', 'guest-apply', true);
  m.recordReuse(T, 'hcaptcha', 'guest-apply', false);
  const e = m.data[wallKey(T, 'hcaptcha', 'guest-apply')];
  assert.equal(e.solved_reused, 1);
  assert.equal(e.solved_reuse_failed, 1);
  assert.equal(e.solved_count, 1);
  // SOLVED_TTL_HOURS is a POLICY number extrapolated from a ~1.6h observation.
  // These counters are what should replace it.
  assert.equal(SOLVED_TTL_HOURS, 12);
});

test('walls.json round-trips through disk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-walls-'));
  const file = path.join(dir, 'walls.json');
  const a = new WallMemory({ file, now: at('2026-09-17T12:00:00Z') });
  a.record(T, 'hcaptcha', 'guest-apply');
  a.recordSolved(T, 'hcaptcha', 'guest-apply');
  a.save();

  const b = new WallMemory({ file, now: at('2026-09-17T13:00:00Z') });
  assert.equal(b.effectiveOccurrences(T, 'hcaptcha', 'guest-apply'), 1);
  assert.equal(b.decide(T, 'hcaptcha', 'guest-apply', { hasStorageState: true }), 'reuse-solved-session');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the action vocabulary is closed at emit time', () => {
  const s = new EventStream({ run: '2026-09-17', applier: 0 });
  s.context({ job_key: JOB, ats: 'icims' });
  for (const action of WALL_ACTIONS) {
    assert.doesNotThrow(() => s.emit('wall_detected', { wall_class: 'hcaptcha', where: 'submit', action }));
  }
  assert.throws(
    () => s.emit('wall_detected', { wall_class: 'hcaptcha', where: 'submit', action: 'try-again-later' }),
    EventValidationError,
    'a policy the reader of a stream cannot name is a policy nobody can audit');
  // Optional: a detection may be recorded before any policy runs.
  assert.doesNotThrow(() => s.emit('wall_detected', { wall_class: 'hcaptcha', where: 'submit' }));
});
