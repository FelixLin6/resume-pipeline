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
//  - The temp profile is deleted on stop.

import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { assertScratchPort, resolveEndpoint } from './endpoint.js';
import { writePidfile, killByPidfile } from './procs.js';

/** Chrome for Testing, as installed for this repo's stack. */
export function findChromeBinary() {
  const candidates = [
    // macOS — Playwright cache (the pipeline's own binary, per
    // skill/scripts/pipeline-browser.sh).
    ...fs.existsSync(path.join(os.homedir(), 'Library/Caches/ms-playwright'))
      ? fs.readdirSync(path.join(os.homedir(), 'Library/Caches/ms-playwright'))
          .filter((d) => d.startsWith('chromium-'))
          .map((d) => path.join(os.homedir(), 'Library/Caches/ms-playwright', d,
            'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'))
      : [],
    ...fs.existsSync(path.join(os.homedir(), '.cache/ms-playwright'))
      ? fs.readdirSync(path.join(os.homedir(), '.cache/ms-playwright'))
          .filter((d) => d.startsWith('chromium-'))
          .map((d) => path.join(os.homedir(), '.cache/ms-playwright', d, 'chrome-linux/chrome'))
      : [],
  ];
  return candidates.find((p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } }) ?? null;
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

export async function startScratchChrome({ port, timeoutMs = 20000 } = {}) {
  assertScratchPort(port);
  const bin = findChromeBinary();
  if (!bin) throw new Error('no Chrome for Testing binary found in the Playwright cache');

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-engine-scratch-'));
  const pidfile = path.join(profile, 'chrome.pid');

  const child = spawn(bin, [
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${profile}`,
    '--headless=new',
    '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-background-networking', '--disable-sync',
    '--no-sandbox',
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
    fs.rmSync(profile, { recursive: true, force: true });
    throw new Error(`scratch Chrome did not answer CDP on ${port} within ${timeoutMs}ms`);
  }

  return {
    port, profile, pidfile, endpoint, pid: child.pid,
    stop() {
      // cmdline check is against the temp profile path — unique to this
      // process, so it can never match anything else on the machine.
      const result = killByPidfile(pidfile, profile);
      fs.rmSync(profile, { recursive: true, force: true });
      return result;
    },
  };
}
