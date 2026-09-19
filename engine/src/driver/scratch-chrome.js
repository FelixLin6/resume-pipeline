// WIP — Phase 1 scaffold. TEST-ONLY scratch Chrome.
//
// This is the ONE place in the engine allowed to launch a browser, and it is
// only ever used by the smoke test. It launches its own throwaway Chrome, on
// its own throwaway port, with its own temp --user-data-dir, and kills it by
// pidfile with a cmdline check.
//
// Hard rules:
//  - NEVER port 9222/9223 (the shared pipeline browser) — enforced by
//    assertScratchPort, not by convention.
//  - NEVER the user's Google Chrome binary or profile. We use the
//    Chrome-for-Testing binary from the Playwright cache.
//  - The temp profile is deleted on stop — unless `profileDir` names a
//    persistent one (Felix 2026-09-19: a fresh zero-history profile scores
//    maximally bot-like on hCaptcha; production runs reuse a lived-in
//    engine-owned profile so it accrues normal cookies across runs). A
//    persistent dir is still never the user's real Chrome profile —
//    enforced by assertPersistentProfileDir, not by convention.

import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { assertScratchPort, resolveEndpoint } from './endpoint.js';
import { writePidfile, killByPidfile } from './procs.js';

/**
 * Chrome for Testing, as installed for this repo's stack.
 *
 * Per-platform layouts inside a `chromium-<rev>` cache directory. The Linux
 * pair is not redundant: Playwright moved the Linux build from `chrome-linux/`
 * to `chrome-linux64/`, and looking only for the old path made the binary
 * undiscoverable on the droplet — which, before the Gate 0 skip was removed,
 * silently turned Gate 0 into a vacuous pass there (droplet shadow report,
 * item 3). Both layouts are searched so either vintage of the cache resolves.
 */
const CHROME_LAYOUTS = Object.freeze([
  'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  'chrome-linux64/chrome',
  'chrome-linux/chrome',
  'chrome-win64/chrome.exe',
]);

/** Playwright's browser cache roots, newest-installed first within each. */
function cacheRoots() {
  return [
    process.env.PLAYWRIGHT_BROWSERS_PATH || null,
    path.join(os.homedir(), 'Library/Caches/ms-playwright'),
    path.join(os.homedir(), '.cache/ms-playwright'),
  ].filter((p) => p && fs.existsSync(p));
}

export function findChromeBinary() {
  const candidates = cacheRoots().flatMap((root) =>
    fs.readdirSync(root)
      .filter((d) => d.startsWith('chromium-'))
      // Highest revision first: a box with several installs should use the one
      // the current Playwright would.
      .sort((a, b) => (Number(b.split('-')[1]) || 0) - (Number(a.split('-')[1]) || 0))
      .flatMap((d) => CHROME_LAYOUTS.map((layout) => path.join(root, d, layout))));

  return candidates.find((p) => {
    try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; }
  }) ?? null;
}

/** Ask the OS for a free port, then assert it is not a reserved one. */
export async function freePort() {
  const port = await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
  return assertScratchPort(port);
}

/**
 * Data roots of REAL browsers on this machine. A persistent engine profile
 * must never live inside any of these — pointing the engine at the user's
 * own Chrome profile is exactly what the never-touch-other-Chrome rule
 * forbids, whatever the motive.
 */
function realBrowserDataRoots() {
  const home = os.homedir();
  return [
    path.join(home, 'Library/Application Support/Google'),
    path.join(home, 'Library/Application Support/Chromium'),
    path.join(home, 'Library/Application Support/Microsoft Edge'),
    path.join(home, 'Library/Application Support/BraveSoftware'),
    path.join(home, '.config/google-chrome'),
    path.join(home, '.config/google-chrome-beta'),
    path.join(home, '.config/google-chrome-unstable'),
    path.join(home, '.config/chromium'),
    path.join(home, '.config/microsoft-edge'),
    path.join(home, '.config/BraveSoftware'),
  ];
}

/** A persistent profile dir must be absolute and outside every real-browser data root. */
export function assertPersistentProfileDir(dir) {
  if (!path.isAbsolute(dir)) {
    throw new Error(`persistent profileDir must be absolute, got: ${dir}`);
  }
  const resolved = path.resolve(dir);
  for (const root of realBrowserDataRoots()) {
    if (resolved === root || resolved.startsWith(root + path.sep)) {
      throw new Error(`persistent profileDir must not live inside a real browser's data dir: ${resolved}`);
    }
  }
  return resolved;
}

export async function startScratchChrome({ port, timeoutMs = 20000, headed = false, profileDir = null } = {}) {
  assertScratchPort(port);
  const bin = findChromeBinary();
  if (!bin) throw new Error('no Chrome for Testing binary found in the Playwright cache');

  const persistent = profileDir != null;
  const profile = persistent
    ? assertPersistentProfileDir(profileDir)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'apply-engine-scratch-'));
  if (persistent) fs.mkdirSync(profile, { recursive: true });
  const pidfile = path.join(profile, 'chrome.pid');

  const child = spawn(bin, [
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${profile}`,
    // `headed` exists for HUMAN VERIFICATION runs (Felix eyeballing staged
    // shadow fills). It is still the scratch CfT binary on a scratch profile —
    // the never-touch-other-Chrome rule is about binaries and profiles, not
    // about visibility.
    ...(headed ? [] : ['--headless=new']),
    '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-background-networking', '--disable-sync',
    '--no-sandbox',
    // Without this, CfT 149's baked-in field-trial config can leave headless
    // pages producing NO frames at all: rAF never ticks, so every Playwright
    // actionability wait that needs a frame (click/check "stable") hangs to
    // its timeout while fill()/evaluate()/timers all still work. Bisected
    // 2026-09-18 against Playwright's own launch switches; this single flag
    // is the one that revives frame production.
    '--disable-field-trial-config',
    // Playwright's standard anti-throttling set, so a backgrounded target
    // never has its timers or rendering deprioritized under parallel load.
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
  ], { stdio: 'ignore', detached: false });

  writePidfile(pidfile, child.pid);

  const deadline = Date.now() + timeoutMs;
  let endpoint = null;
  while (Date.now() < deadline) {
    try { endpoint = await resolveEndpoint(port, { timeoutMs: 1000 }); break; }
    catch { await new Promise((r) => setTimeout(r, 300)); }
  }
  if (!endpoint) {
    killByPidfile(pidfile, profile);
    if (!persistent) fs.rmSync(profile, { recursive: true, force: true });
    throw new Error(`scratch Chrome did not answer CDP on ${port} within ${timeoutMs}ms`);
  }

  return {
    port, profile, pidfile, endpoint, pid: child.pid, persistent,
    stop() {
      // cmdline check is against the profile path — unique to this
      // process, so it can never match anything else on the machine.
      const result = killByPidfile(pidfile, profile);
      // A persistent profile is the point: it survives stop() so cookies
      // and history accrue across runs.
      if (!persistent) fs.rmSync(profile, { recursive: true, force: true });
      return result;
    },
  };
}
