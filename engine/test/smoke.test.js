// WIP — Phase 1 Gate 0 smoke test.
//
// Launches its OWN scratch Chrome on a throwaway port (never 9222/9223),
// attaches over real CDP, creates two isolated contexts, emits typed events,
// and asserts the event-stream shape. The shared pipeline browser is never
// touched.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';

import { EventStream } from '../src/events/emitter.js';
import { validateEvent, EventValidationError } from '../src/events/schema.js';
import { attach } from '../src/driver/attach.js';
import { ApplierContexts } from '../src/driver/attach.js';
import { resolveEndpoint, assertScratchPort, CdpUnreachableError } from '../src/driver/endpoint.js';
import { startScratchChrome, freePort, findChromeBinary } from '../src/driver/scratch-chrome.js';
import { writePidfile, killByPidfile, readCmdline } from '../src/driver/procs.js';
import icims from '../src/adapters/icims.js';

const JOB_A = '8f2c1a94-6d3e-4b77-9a10-2f5c8e1b4d90';
const JOB_B = 'b41d77e0-1c02-4a3f-8e55-90ab3c7d6f21';

// ---------------------------------------------------------------- events ---

test('event schema rejects a truncated job key', () => {
  const s = new EventStream({ run: '2026-09-17', applier: 1 });
  s.context({ job_key: '8f2c1a94' });          // the 2026-09-10 failure
  assert.throws(() => s.emit('adapter_note', { msg: 'x' }), EventValidationError);
});

test('event schema rejects an unknown outcome label', () => {
  const s = new EventStream({ run: '2026-09-17', applier: 1 });
  s.context({ job_key: JOB_A });
  // The 2026-09-05 failure: an unknown label was silently skipped by the
  // retry census. Here it cannot be written at all.
  assert.throws(
    () => s.emit('application_ended', { outcome: 'PARKED', reason: 'x' }),
    EventValidationError,
  );
  assert.doesNotThrow(() => s.emit('application_ended', { outcome: 'wall', reason: 'hcaptcha' }));
});

test('event schema rejects unknown skip reasons and wall classes', () => {
  const s = new EventStream({ run: '2026-09-17', applier: 1 });
  s.context({ job_key: JOB_A });
  assert.throws(() => s.emit('field_skipped', { reason: 'dunno' }), EventValidationError);
  assert.throws(() => s.emit('wall_detected', { wall_class: 'puzzle' }), EventValidationError);
  assert.doesNotThrow(() => s.emit('wall_detected', { wall_class: 'hcaptcha', where: 'guest-apply' }));
});

test('event schema refuses to carry a credential', () => {
  const s = new EventStream({ run: '2026-09-17', applier: 1 });
  s.context({ job_key: JOB_A });
  // A sweep agent once pasted a created iCIMS password into a pushed file.
  assert.throws(
    () => s.emit('adapter_note', { msg: 'account made', extra: { password: 'hunter2' } }),
    EventValidationError,
  );
});

test('event envelope carries seq, run, applier, and ambient context', () => {
  const s = new EventStream({ run: '2026-09-17', applier: 2 });
  s.context({ job_key: JOB_A, tenant: 'icims:careers-acme.icims.com', ats: 'icims', step: 'guest-apply' });
  const ev = s.emit('page_advanced', { from: 'posting', to: 'guest-apply', elapsed_ms: 1200 });
  assert.equal(ev.v, 1);
  assert.equal(ev.seq, 0);
  assert.equal(ev.run, '2026-09-17');
  assert.equal(ev.applier, 2);
  assert.equal(ev.ats, 'icims');
  assert.equal(ev.step, 'guest-apply');
  assert.equal(ev.job_key, JOB_A);
  assert.ok(!Number.isNaN(Date.parse(ev.ts)));
  assert.equal(s.emit('adapter_note', { msg: 'next' }).seq, 1);
});

test('JSONL stream is append-only and line-parseable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-events-'));
  const file = path.join(dir, 'applier1.jsonl');
  const s = new EventStream({ run: '2026-09-17', applier: 1, file });
  s.context({ job_key: JOB_A, ats: 'icims' });
  s.emit('application_started', { apply_url: 'https://careers-acme.icims.com/jobs/1/login', attempt: 1, claim: 'offline' });
  s.emit('submitted', { application_id: 'R-1', confirmation_text: 'Thank you for applying', confirmation_url: 'https://x' });
  s.emit('application_ended', { outcome: 'submitted', duration_ms: 1000, tool_calls: 3 });
  s.close();

  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 3);
  const parsed = lines.map((l) => JSON.parse(l));
  parsed.forEach((e) => assert.doesNotThrow(() => validateEvent(e)));
  assert.deepEqual(parsed.map((e) => e.seq), [0, 1, 2]);
  assert.equal(parsed.at(-1).data.outcome, 'submitted');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------ port guard ---

test('reserved pipeline ports are refused for scratch use', () => {
  assert.throws(() => assertScratchPort(9222), /shared pipeline browser/);
  assert.throws(() => assertScratchPort(9223), /shared pipeline browser/);
  assert.equal(assertScratchPort(41337), 41337);
});

test('resolveEndpoint throws rather than falling back to a launch', async () => {
  const port = await freePort();                 // free => nothing listening
  await assert.rejects(() => resolveEndpoint(port, { timeoutMs: 500 }), CdpUnreachableError);
});

// --------------------------------------------------------------- procs ----

test('killByPidfile refuses a pid whose cmdline does not match', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-pid-'));
  const file = path.join(dir, 'x.pid');
  writePidfile(file, process.pid);               // this test process
  // Our own cmdline is node, not a chrome profile dir: must NOT be signalled.
  assert.equal(killByPidfile(file, '/definitely/not/our/profile'), 'mismatch');
  assert.ok(readCmdline(process.pid));           // still alive
  fs.rmSync(dir, { recursive: true, force: true });
});

test('killByPidfile reports a stale pidfile instead of widening the search', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-pid-'));
  const file = path.join(dir, 'x.pid');
  writePidfile(file, 999999);                    // almost certainly absent
  assert.equal(killByPidfile(file, 'anything'), 'stale');
  assert.equal(fs.existsSync(file), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

// -------------------------------------------------------------- adapter ---

test('iCIMS adapter stub exposes the observed flow', () => {
  assert.equal(icims.id, 'icims');
  assert.equal(icims.apiVersion, 1);
  assert.equal(icims.tenantOf(new URL('https://careers-gdms.icims.com/jobs/5573/x/job')),
    'icims:careers-gdms.icims.com');
  const ids = icims.steps.map((s) => s.id);
  // The gate is before the form: that is the whole reason an assist slot
  // spent on iCIMS buys zero filled fields.
  assert.ok(ids.indexOf('captcha-gate') < ids.indexOf('candidate-profile'));
  assert.ok(ids.includes('guest-apply'));
  assert.equal(icims.quirks.forbidDatePicker, true);
  assert.equal(icims.quirks.maxSubmitAttempts, 1);
  const review = icims.steps.find((s) => s.isReview);
  const submit = icims.steps.find((s) => s.isSubmit);
  assert.ok(review && submit, 'must declare a review step and a submit step');
  assert.ok(icims.steps.indexOf(review) < icims.steps.indexOf(submit),
    'review must precede submit — the diff gates the click');
});

// ------------------------------------------------- real CDP attach (Gate 0) --

/** Tiny local origin. `data:` URLs have storage disabled, and storage
 *  isolation is exactly what we need to prove, so the test needs a real
 *  http origin to write localStorage against. */
function startOriginServer() {
  const server = http.createServer((req, res) => {
    const who = new URL(req.url, 'http://x').searchParams.get('who') ?? 'page';
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><title>${who}</title><h1>${who}</h1>`);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ origin: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

test('attaches to a scratch Chrome over CDP and isolates two contexts', async (t) => {
  if (!findChromeBinary()) {
    t.skip('no Chrome for Testing binary in the Playwright cache');
    return;
  }

  const port = await freePort();
  const chrome = await startScratchChrome({ port });
  const site = await startOriginServer();
  const events = new EventStream({ run: '2026-09-17', applier: 0 });
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-state-'));

  try {
    assert.notEqual(chrome.port, 9222);
    assert.notEqual(chrome.port, 9223);

    const { browser, endpoint } = await attach({ port, events });
    assert.ok(endpoint.version.Browser, 'CDP /json/version must identify the browser');

    const contexts = new ApplierContexts({ browser, events, stateDir });

    // Two appliers, two isolated contexts — the structural fix for the
    // shared-tab-index drift that cross-wired two applications on 09-12.
    const c1 = await contexts.create(1, { tenant: 'icims:careers-acme.icims.com' });
    const c2 = await contexts.create(2, { tenant: 'workday:acme.wd1.myworkdayjobs.com' });
    assert.equal(contexts.size, 2);
    assert.notEqual(c1, c2);

    const p1 = await c1.newPage();
    const p2 = await c2.newPage();
    await p1.goto(`${site.origin}/?who=applier-one`);
    await p2.goto(`${site.origin}/?who=applier-two`);
    assert.equal(await p1.title(), 'applier-one');
    assert.equal(await p2.title(), 'applier-two');

    // Storage isolation: what one context writes must not be visible in the
    // other. Two Workday tenants must never share a login.
    await p1.evaluate(() => localStorage.setItem('who', 'applier1'));
    assert.equal(await p1.evaluate(() => localStorage.getItem('who')), 'applier1');
    assert.equal(await p2.evaluate(() => localStorage.getItem('who')), null,
      'contexts must not share storage');

    // Pages are addressed by HANDLE. Each context sees only its own page —
    // there is no shared tab index to drift within.
    assert.equal(c1.pages().length, 1);
    assert.equal(c2.pages().length, 1);

    // storageState round-trips to a per-tenant file, carrying the origin's
    // storage — this is what makes a post-browser-death re-attach cheap
    // instead of requiring a re-login.
    const saved = await contexts.saveState(1);
    assert.ok(saved && fs.existsSync(saved), 'storageState must be written per tenant');
    const state = JSON.parse(fs.readFileSync(saved, 'utf8'));
    const origin = state.origins?.find((o) => o.origin === site.origin);
    assert.ok(origin, 'saved state must carry the visited origin');
    assert.ok(origin.localStorage.some((kv) => kv.name === 'who' && kv.value === 'applier1'),
      'saved state must carry the context\'s own storage');

    // Close by handle, by owner — never by range.
    await contexts.close(1);
    assert.equal(contexts.size, 1);
    await contexts.close(2);
    assert.equal(contexts.size, 0);

    await browser.close();

    // ---- assert the event stream SHAPE ----
    const kinds = events.events.filter((e) => e.type === 'driver_event').map((e) => e.data.kind);
    assert.deepEqual(kinds, [
      'attached',
      'context_created', 'context_created',
      'storagestate_saved',
      'context_closed', 'context_closed',
    ]);
    events.events.forEach((e) => assert.doesNotThrow(() => validateEvent(e)));
    assert.deepEqual(events.events.map((e) => e.seq), events.events.map((_, i) => i));
    assert.ok(events.events.every((e) => e.run === '2026-09-17' && e.v === 1));
  } finally {
    await site.close();
    const result = chrome.stop();
    assert.equal(result, 'killed');
    fs.rmSync(stateDir, { recursive: true, force: true });
    assert.equal(fs.existsSync(chrome.profile), false, 'scratch profile must be removed');
  }
});
