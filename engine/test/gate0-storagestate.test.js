// GATE 0 — the test the whole rebuild is staked on.
//
// Claim under test (architecture.md §4, §5): after a browser DEATH, the engine
// re-attaches and rebuilds contexts from saved storageState rather than
// restarting the run or re-driving every login. If that is false on the exact
// Chrome-for-Testing build the pipeline uses, the supervisor design collapses
// and we need the --user-data-dir-per-applier fallback instead.
//
// So this test does not simulate a death. It SIGKILLs the browser process
// mid-session, with a live page and live storage, then relaunches a fresh
// browser on a fresh port and asserts the session came back.
//
// Safety: own binary (Playwright cache), own randomized port (never
// 9222/9223 — assertScratchPort enforces), own temp profile, killed by pidfile
// with a cmdline check, profile removed. The shared pipeline browser is never
// contacted.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';

import { EventStream } from '../src/events/emitter.js';
import { attach, ApplierContexts } from '../src/driver/attach.js';
import { startScratchChrome, freePort, findChromeBinary } from '../src/driver/scratch-chrome.js';
import { readCmdline } from '../src/driver/procs.js';

const JOB = '8f2c1a94-6d3e-4b77-9a10-2f5c8e1b4d90';
const TENANT = 'icims:careers-gate0.icims.com';

/** A real http origin: `data:` URLs have storage disabled, and cookie +
 *  localStorage survival is precisely what we are proving. The server also
 *  reflects the cookie it receives, so we can prove the RESTORED context
 *  actually sends it on the wire — not merely that it sits in a JSON file. */
function startOriginServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const cookie = req.headers.cookie ?? '';
    const headers = { 'content-type': 'text/html' };
    if (url.searchParams.get('setcookie') === '1') {
      // Persistent (not session) cookie: session cookies are exactly what a
      // browser death is expected to lose.
      headers['set-cookie'] = 'sess=gate0-session-token; Path=/; Max-Age=86400; SameSite=Lax';
    }
    res.writeHead(200, headers);
    res.end(`<!doctype html><title>gate0</title><h1>gate0</h1><pre id="cookie">${cookie}</pre>`);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

async function waitGone(pid, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (readCmdline(pid) === null) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return readCmdline(pid) === null;
}

test('GATE 0: storageState survives a browser DEATH on the pipeline Chrome build',
  { timeout: 180000 }, async (t) => {
    if (!findChromeBinary()) { t.skip('no Chrome for Testing binary in the Playwright cache'); return; }

    const site = await startOriginServer();
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-gate0-'));
    const events = new EventStream({ run: '2026-09-17', applier: 0 });
    events.context({ job_key: JOB, ats: 'icims', tenant: TENANT });

    let chromeA = null;
    let chromeB = null;
    let savedStatePath = null;
    let buildString = null;

    try {
      // ---- session 1: establish a session, then save it -------------------
      const portA = await freePort();
      chromeA = await startScratchChrome({ port: portA });
      assert.notEqual(chromeA.port, 9222);
      assert.notEqual(chromeA.port, 9223);

      const a = await attach({ port: portA, events });
      buildString = a.endpoint.version.Browser;
      // Pin the claim to the build. If the pipeline moves to another Chrome,
      // this assertion is the thing that tells us Gate 0 must be re-run.
      assert.match(buildString, /^Chrome\/1\d\d\./, `unexpected build: ${buildString}`);

      const ctxA = new ApplierContexts({ browser: a.browser, events, stateDir });
      const c1 = await ctxA.create(1, { tenant: TENANT });
      const p1 = await c1.newPage();
      await p1.goto(`${site.origin}/?setcookie=1`);
      await p1.evaluate(() => {
        localStorage.setItem('applicant', 'felix');
        localStorage.setItem('step', 'my-information');
        sessionStorage.setItem('ephemeral', 'not-expected-to-survive');
      });
      assert.equal(await p1.evaluate(() => localStorage.getItem('applicant')), 'felix');
      assert.equal((await c1.cookies()).find((c) => c.name === 'sess')?.value,
        'gate0-session-token', 'session 1 must actually hold the cookie');

      savedStatePath = await ctxA.saveState(1);
      assert.ok(savedStatePath && fs.existsSync(savedStatePath));
      const saved = JSON.parse(fs.readFileSync(savedStatePath, 'utf8'));
      assert.ok(saved.cookies.some((c) => c.name === 'sess'), 'saved state must carry cookies');
      const savedOrigin = saved.origins?.find((o) => o.origin === site.origin);
      assert.ok(savedOrigin, 'saved state must carry the visited origin');
      assert.ok(savedOrigin.localStorage.some((kv) => kv.name === 'applicant' && kv.value === 'felix'),
        'saved state must carry localStorage');

      // ---- the death ------------------------------------------------------
      // SIGKILL, not close(): a wedged/killed Chrome is the recorded failure
      // (2026-09-07/08), and a graceful close would not prove anything.
      // The page and context are still live at this moment, on purpose.
      const deadPid = chromeA.pid;
      process.kill(deadPid, 'SIGKILL');
      assert.ok(await waitGone(deadPid), 'scratch Chrome must actually be dead');
      fs.rmSync(chromeA.profile, { recursive: true, force: true });
      chromeA = null;

      // The Playwright handle must notice. (Bounded wait — `disconnected`
      // is what Supervisor.watch keys on.)
      const disconnected = await Promise.race([
        new Promise((r) => a.browser.on('disconnected', () => r(true))),
        new Promise((r) => setTimeout(() => r(a.browser.isConnected() === false), 10000)),
      ]);
      assert.equal(disconnected, true, 'browser death must surface as a disconnect');

      // ---- session 2: a BRAND NEW browser, new port, new profile ----------
      // Nothing carries over except the storageState JSON. This is the real
      // claim: the session is portable across a process death, not merely
      // recoverable inside one profile.
      const portB = await freePort();
      assert.notEqual(portB, portA);
      chromeB = await startScratchChrome({ port: portB });
      const b = await attach({ port: portB, events });

      const ctxB = new ApplierContexts({ browser: b.browser, events, stateDir });
      const c2 = await ctxB.create(1, { tenant: TENANT });   // loads saved state
      const p2 = await c2.newPage();
      await p2.goto(site.origin);                             // no setcookie

      // (1) the cookie is restored AND actually sent on the wire
      const echoed = await p2.textContent('#cookie');
      assert.match(echoed, /sess=gate0-session-token/,
        'restored context must SEND the cookie to the origin');

      // (2) localStorage is restored
      assert.equal(await p2.evaluate(() => localStorage.getItem('applicant')), 'felix',
        'restored context must carry localStorage across the death');
      assert.equal(await p2.evaluate(() => localStorage.getItem('step')), 'my-information');

      // (3) sessionStorage is NOT expected to survive — documented, not asserted
      //     as a capability. An adapter must never depend on it.
      const sessionSurvived = await p2.evaluate(() => sessionStorage.getItem('ephemeral'));

      // (4) isolation still holds on the restored browser: a SECOND context
      //     must NOT inherit the restored session. (F3/F17 — two tenants must
      //     never share a login.)
      const c3 = await ctxB.create(2, { tenant: 'workday:other.wd1.myworkdayjobs.com' });
      const p3 = await c3.newPage();
      await p3.goto(site.origin);
      assert.equal(await p3.evaluate(() => localStorage.getItem('applicant')), null,
        'a sibling context must not inherit the restored session');
      assert.doesNotMatch(await p3.textContent('#cookie'), /gate0-session-token/,
        'a sibling context must not inherit the restored cookie');

      // (5) the restored context can still save state forward (so a chain of
      //     deaths does not degrade).
      await p2.evaluate(() => localStorage.setItem('applicant', 'felix-2'));
      const resaved = await ctxB.saveState(1);
      const again = JSON.parse(fs.readFileSync(resaved, 'utf8'));
      assert.ok(again.origins.find((o) => o.origin === site.origin)
        .localStorage.some((kv) => kv.name === 'applicant' && kv.value === 'felix-2'),
        'a restored context must be able to re-save state');

      await ctxB.close(1);
      await ctxB.close(2);
      await b.browser.close();

      t.diagnostic(`GATE 0 PASS on ${buildString}: cookies + localStorage round-trip ` +
        `across SIGKILL, across a different port and a different profile. ` +
        `sessionStorage survived=${JSON.stringify(sessionSurvived)} (never depend on it).`);
    } finally {
      await site.close();
      if (chromeA) chromeA.stop();
      if (chromeB) chromeB.stop();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
