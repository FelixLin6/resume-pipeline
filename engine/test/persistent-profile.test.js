// Persistent engine profile (Felix 2026-09-19): production runs reuse a
// lived-in profile so hCaptcha sees accrued cookies/history instead of a
// maximally bot-like fresh dir. Two properties matter and are pinned here:
//  1. the guard NEVER accepts a real browser's data dir;
//  2. a persistent profile survives stop() (a scratch one still does not).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  startScratchChrome, freePort, findChromeBinary, assertPersistentProfileDir,
} from '../src/driver/scratch-chrome.js';

test('assertPersistentProfileDir rejects real browser data dirs', () => {
  const home = os.homedir();
  const forbidden = [
    path.join(home, 'Library/Application Support/Google/Chrome'),
    path.join(home, 'Library/Application Support/Google/Chrome/Default'),
    path.join(home, '.config/google-chrome'),
    path.join(home, '.config/chromium/Profile 1'),
  ];
  for (const dir of forbidden) {
    assert.throws(() => assertPersistentProfileDir(dir), /real browser/, dir);
  }
  assert.throws(() => assertPersistentProfileDir('relative/profile'), /absolute/);
});

test('assertPersistentProfileDir accepts an engine-owned dir', () => {
  const dir = path.join(os.tmpdir(), 'apply-engine-profile-guard-test');
  assert.equal(assertPersistentProfileDir(dir), path.resolve(dir));
});

test('persistent profile survives stop(); scratch profile does not', async (t) => {
  if (!findChromeBinary()) return t.skip('no Chrome for Testing in the Playwright cache');

  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-engine-persist-'));
  try {
    const chrome = await startScratchChrome({ port: await freePort(), profileDir });
    assert.equal(chrome.persistent, true);
    assert.equal(chrome.profile, path.resolve(profileDir));
    chrome.stop();
    assert.ok(fs.existsSync(profileDir), 'persistent profile dir was deleted by stop()');
    // The profile is genuinely lived-in: Chrome wrote its state into it.
    assert.ok(fs.readdirSync(profileDir).some((f) => f !== 'chrome.pid'),
      'persistent profile dir has no browser state in it');

    const scratch = await startScratchChrome({ port: await freePort() });
    assert.equal(scratch.persistent, false);
    const scratchProfile = scratch.profile;
    scratch.stop();
    assert.ok(!fs.existsSync(scratchProfile), 'scratch profile dir survived stop()');
  } finally {
    fs.rmSync(profileDir, { recursive: true, force: true });
  }
});
