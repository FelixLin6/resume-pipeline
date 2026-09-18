// Wall pre-flight: one fixture per wall class, plus the two negatives that
// matter more than any of them.
//
// The negatives are the point of this file. A classifier that fires on every
// captcha-shaped thing it sees is not a safety feature — it is a park machine.
// Verified on 5 live iCIMS tenants and on Lever's Kitware page: the widget is
// in the DOM on EVERY load, challenge or not, and on 2026-09-17 three of four
// iCIMS gates did not re-fire on a second visit. So `wall-hcaptcha-dormant`
// and `wall-none` must classify as NO WALL, and if they ever stop doing so the
// engine has started parking applications that would have gone through.
//
// No network: a scratch Chrome on a randomized throwaway port (9222/9223
// refused by assertScratchPort) driving fixtures served from 127.0.0.1. The
// single exception is the ip_class probe, which is explicitly marked and skips
// cleanly when offline.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { EventStream } from '../src/events/emitter.js';
import { attach } from '../src/driver/attach.js';
import { startScratchChrome, freePort, findChromeBinary } from '../src/driver/scratch-chrome.js';
import { serveFixtures } from './helpers/serve.js';
import {
  classifyPage, classifyHeaders, preflight, GENERIC_WALL_MARKERS, WHERE_PREFLIGHT,
} from '../src/engine/preflight.js';
import { probeIpClass, classifyOrg, DATACENTER_HINTS } from '../src/engine/ipclass.js';
import { WallMemory, SOLVED_TTL_HOURS } from '../src/engine/walls.js';
import { WALL_CLASSES } from '../src/events/schema.js';
import icims from '../src/adapters/icims.js';
import lever from '../src/adapters/lever.js';

const JOB = '8f2c1a94-6d3e-4b77-9a10-2f5c8e1b4d90';

let site, chrome, browser;

test.before(async () => {
  if (!findChromeBinary()) return;
  site = await serveFixtures();
  const port = await freePort();
  chrome = await startScratchChrome({ port });
  ({ browser } = await attach({ port }));
});

test.after(async () => {
  if (browser) await browser.close();
  if (chrome) chrome.stop();
  if (site) await site.close();
});

const skipIfNoChrome = (t) => {
  if (!findChromeBinary()) { t.skip('no Chrome for Testing binary in the Playwright cache'); return true; }
  return false;
};

function newStream() {
  const s = new EventStream({ run: '2026-09-17', applier: 0 });
  s.context({ job_key: JOB, tenant: 'icims:careers-test.icims.com', ats: 'icims' });
  return s;
}

async function classifyFixture(name, adapter = null) {
  const ctx = await browser.newContext();
  try {
    const page = await ctx.newPage();
    const res = await page.goto(site.url(name));
    return await classifyPage({ page, root: page, status: res?.status() ?? null, adapter });
  } finally {
    await ctx.close();
  }
}

// ---------------------------------------------------------------- classes ---

test('every wall class the pre-flight can emit is in the closed enum', () => {
  for (const m of GENERIC_WALL_MARKERS) {
    assert.ok(WALL_CLASSES.includes(m.wallClass),
      `generic marker declares ${m.wallClass}, which is not in WALL_CLASSES`);
  }
});

test('hcaptcha: a VISIBLE challenge is a wall', async (t) => {
  if (skipIfNoChrome(t)) return;
  const hit = await classifyFixture('wall-hcaptcha-visible.html');
  assert.equal(hit?.wallClass, 'hcaptcha');
});

test('hcaptcha: the DORMANT widget is NOT a wall — the 3-of-4 finding', async (t) => {
  if (skipIfNoChrome(t)) return;
  const hit = await classifyFixture('wall-hcaptcha-dormant.html');
  assert.equal(hit, null,
    'presence is not a wall: this widget is on every iCIMS and Lever page, and a marker ' +
    'keyed to presence parks 100% of applications');
});

test('hcaptcha: the iCIMS adapter agrees with the generic classifier', async (t) => {
  if (skipIfNoChrome(t)) return;
  // The adapter's own markers are consulted FIRST, so they must not be looser
  // than the generic ones.
  assert.equal((await classifyFixture('wall-hcaptcha-dormant.html', icims)), null);
  assert.equal((await classifyFixture('wall-hcaptcha-visible.html', icims))?.wallClass, 'hcaptcha');
});

test('recaptcha: a rendered challenge is interactive, a 0x0 one is a score check', async (t) => {
  if (skipIfNoChrome(t)) return;
  assert.equal((await classifyFixture('wall-recaptcha-challenge.html'))?.wallClass, 'recaptcha-interactive');
  // Aramco, B4: not interactable even by a human, so it is never worth an
  // assist slot — and recaptcha-v3-score is a no-retry class.
  assert.equal((await classifyFixture('wall-recaptcha-zerosize.html'))?.wallClass, 'recaptcha-v3-score');
});

test('edge blocks: datadome, cloudflare and akamai are distinguished', async (t) => {
  if (skipIfNoChrome(t)) return;
  assert.equal((await classifyFixture('wall-datadome.html'))?.wallClass, 'datadome');
  assert.equal((await classifyFixture('wall-cloudflare.html'))?.wallClass, 'cloudflare-challenge');
  // Akamai refuses rather than challenging: there is nothing for a human to
  // solve, so it must not land in a class that retries.
  assert.equal((await classifyFixture('wall-akamai.html'))?.wallClass, 'akamai');
});

test('spam-flag and tenant-broken are tenant conditions, not bot walls', async (t) => {
  if (skipIfNoChrome(t)) return;
  assert.equal((await classifyFixture('wall-spam-flag.html'))?.wallClass, 'spam-flag');
  // The SmartRecruiters NG0908 signature: the tenant is DOWN, not gating us.
  assert.equal((await classifyFixture('wall-tenant-broken.html'))?.wallClass, 'tenant-broken');
});

test('none: a clean form classifies as no wall', async (t) => {
  if (skipIfNoChrome(t)) return;
  assert.equal(await classifyFixture('wall-none.html'), null);
});

// ---------------------------------------------------------------- headers ---

test('classifyHeaders names the edge from headers alone, with no DOM', () => {
  assert.equal(classifyHeaders(403, { 'x-datadome': 'protected' })?.wallClass, 'datadome');
  assert.equal(classifyHeaders(403, { 'set-cookie': '_abck=ABC; bm_sz=X', server: 'AkamaiGHost' })?.wallClass, 'akamai');
  assert.equal(classifyHeaders(403, { 'cf-mitigated': 'challenge' })?.wallClass, 'cloudflare-challenge');
  assert.equal(classifyHeaders(429, {})?.wallClass, 'http-429');
  assert.equal(classifyHeaders(403, {})?.wallClass, 'http-403');
  assert.equal(classifyHeaders(503, {})?.wallClass, 'tenant-5xx');
  assert.equal(classifyHeaders(200, {}), null);
});

test('header classification is case-insensitive about header names', () => {
  assert.equal(classifyHeaders(403, { 'X-DataDome': 'protected' })?.wallClass, 'datadome');
});

// -------------------------------------------------------------- preflight ---

test('preflight runs in a THROWAWAY context and emits a typed result', async (t) => {
  if (skipIfNoChrome(t)) return;
  const stream = newStream();
  const before = browser.contexts().length;

  const r = await preflight({
    browser, url: site.url('wall-none.html'), events: stream,
    adapter: null, ipClass: 'residential', tenant: 'greenhouse:covar',
  });

  assert.equal(r.wall_class, null);
  assert.equal(r.reachable, true);
  assert.equal(r.http_status, 200);

  const ev = stream.events.find((e) => e.type === 'preflight_result');
  assert.equal(ev.data.context, 'throwaway');
  assert.equal(ev.data.ip_class, 'residential', 'C5: stamped onto every preflight');
  assert.equal(ev.data.wall_class, null);

  // The probe context must be gone: a challenge cookie picked up here must
  // never reach an applier's context.
  assert.equal(browser.contexts().length, before, 'the throwaway context was not discarded');
});

test('preflight records a detected wall in memory and emits the policy action', async (t) => {
  if (skipIfNoChrome(t)) return;
  const stream = newStream();
  const mem = new WallMemory();

  const r = await preflight({
    browser, url: site.url('wall-hcaptcha-visible.html'), events: stream,
    adapter: lever, wallMemory: mem, ipClass: 'datacenter', tenant: 'lever:kitware',
  });

  assert.equal(r.wall_class, 'hcaptcha');
  assert.equal(r.action, 'retry-fresh-context', 'first occurrence: the retry is worth it');

  const wall = stream.events.find((e) => e.type === 'wall_detected');
  assert.equal(wall.data.where, WHERE_PREFLIGHT);
  assert.equal(wall.data.tenant_prior_walls, 0);
  assert.equal(mem.effectiveOccurrences('lever:kitware', 'hcaptcha', WHERE_PREFLIGHT), 1);
});

test('preflight survives an unreachable URL without taking the run down', async (t) => {
  if (skipIfNoChrome(t)) return;
  const stream = newStream();
  // A port nothing is listening on. Pre-flight is telemetry plus a gate; it
  // must report unreachability, not throw it.
  const r = await preflight({
    browser, url: 'http://127.0.0.1:9/nothing', events: stream, timeoutMs: 5000,
    tenant: 'greenhouse:nobody',
  });
  assert.equal(r.reachable, false);
  const ev = stream.events.find((e) => e.type === 'preflight_result');
  assert.equal(ev.data.reachable, false);
  assert.ok(ev.data.error, 'the failure is recorded, not swallowed');
});

// ------------------------------------------------------------- ip_class -----

test('classifyOrg reads hosting ASNs as datacenter and everything else as residential', () => {
  assert.equal(classifyOrg('AS14061 DigitalOcean, LLC'), 'datacenter');
  assert.equal(classifyOrg('AS16509 Amazon.com, Inc.'), 'datacenter');
  assert.equal(classifyOrg('AS7922 Comcast Cable Communications, LLC'), 'residential');
  assert.equal(classifyOrg('AS7018 AT&T Services, Inc.'), 'residential');
  // Conservative by design: an unrecognized org is residential, because a false
  // "datacenter" blames the egress for walls that were really the tenant's.
  assert.equal(classifyOrg('Some Regional Telco'), 'residential');
  assert.equal(classifyOrg(''), 'residential');
  assert.ok(DATACENTER_HINTS.length > 10);
});

test('ip_class probe is CACHED per run — one probe per run, not per job', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-ip-'));
  const cacheFile = path.join(dir, 'ip-class.json');
  let calls = 0;
  const fake = async () => { calls++; return { ok: true, json: async () => ({ org: 'AS14061 DigitalOcean, LLC', ip: '1.2.3.4' }) }; };

  const a = await probeIpClass({ run: '2026-09-17', cacheFile, fetchImpl: fake });
  const b = await probeIpClass({ run: '2026-09-17', cacheFile, fetchImpl: fake });
  assert.equal(a.ip_class, 'datacenter');
  assert.equal(b.ip_class, 'datacenter');
  assert.equal(b.cached, true);
  assert.equal(calls, 1, 'the second call must be served from cache');

  // A NEW run re-probes: the laptop may have moved networks overnight.
  const c = await probeIpClass({ run: '2026-09-18', cacheFile, fetchImpl: fake });
  assert.equal(calls, 2);
  assert.equal(c.cached, false);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('ip_class probe treats OFFLINE as telemetry, never as a run failure', async () => {
  const offline = async () => { throw new Error('getaddrinfo ENOTFOUND ipinfo.io'); };
  const r = await probeIpClass({ run: '2026-09-17', fetchImpl: offline });
  assert.equal(r.ip_class, null, 'null, not a throw — a metadata outage is not our outage');
  assert.equal(r.probed, true);
  assert.match(r.reason, /ENOTFOUND/);
});

test('ip_class probe handles an HTTP error from the endpoint', async () => {
  const bad = async () => ({ ok: false, status: 429 });
  const r = await probeIpClass({ run: '2026-09-17', fetchImpl: bad });
  assert.equal(r.ip_class, null);
  assert.match(r.reason, /429/);
});

test('the IP address itself never leaves the state cache', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-ip-'));
  const cacheFile = path.join(dir, 'ip-class.json');
  const fake = async () => ({ ok: true, json: async () => ({ org: 'AS7922 Comcast', ip: '212.345.6789' }) });
  const r = await probeIpClass({ run: '2026-09-17', cacheFile, fetchImpl: fake });

  // The returned object — the only thing that reaches the emitter — carries the
  // class and nothing else. A dotted quad like this one would trip the Q5
  // phone-shape guard, which is precisely why it must not be emitted.
  assert.deepEqual(Object.keys(r).sort(), ['cached', 'ip_class', 'probed', 'source']);
  assert.equal(r.ip_class, 'residential');

  const stream = new EventStream({ run: '2026-09-17', applier: 0 });
  stream.context({ job_key: JOB });
  assert.doesNotThrow(() => stream.emit('preflight_result', {
    reachable: true, http_status: 200, wall_class: null, elapsed_ms: 1,
    context: 'throwaway', ip_class: r.ip_class,
  }));

  fs.rmSync(dir, { recursive: true, force: true });
});

// REAL NETWORK. The only test in the suite that touches the internet, and it
// must skip cleanly rather than fail when there is none.
test('ip_class probe against the real endpoint (skips offline)', { timeout: 15000 }, async (t) => {
  const r = await probeIpClass({ run: `live-${Date.now()}`, timeoutMs: 5000 });
  if (r.ip_class === null) {
    t.skip(`no network for the ip_class probe: ${r.reason ?? 'unknown'}`);
    return;
  }
  assert.ok(['residential', 'datacenter'].includes(r.ip_class));
  assert.equal(r.probed, true);
});
