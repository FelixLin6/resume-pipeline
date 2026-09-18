// The Kitware trap, reproduced and refused.
//
// 2026-09-17: a Lever hCaptcha rendered at invisible size, a click aimed at the
// widget passed THROUGH to SUBMIT APPLICATION, and an application went out with
// nobody having reviewed the essays. The engine's exposure is the mirror image
// — a click aimed at the button landing on the captcha — and both are the same
// defect: nobody asked what was actually on top.
//
// The load-bearing assertion in this file is that `isVisible()` returns TRUE on
// the trapped button. That is why a visibility check is not a defence and a hit
// test is.

import test from 'node:test';
import assert from 'node:assert/strict';

import { EventStream } from '../src/events/emitter.js';
import { attach } from '../src/driver/attach.js';
import { startScratchChrome, freePort, findChromeBinary } from '../src/driver/scratch-chrome.js';
import { serveFixtures } from './helpers/serve.js';
import {
  assertSubmitClickable, probeClickTarget, readCaptchaState, classifyTopmost, SubmitObstructed,
} from '../src/engine/overlay.js';
import { WallMemory } from '../src/engine/walls.js';
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
  const s = new EventStream({ run: '2026-09-17', applier: 3 });
  s.context({ job_key: JOB, tenant: 'lever:kitware', ats: 'lever', step: 'submit' });
  return s;
}

async function open(name) {
  const ctx = await browser.newContext({ viewport: { width: 1350, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(site.url(name));
  return { ctx, page, close: () => ctx.close() };
}

test('classifyTopmost names an hCaptcha overlay and ignores an ordinary one', () => {
  assert.deepEqual(
    classifyTopmost({ tag: 'iframe', title: 'Widget containing checkbox for hCaptcha security challenge', className: '', src: '', id: '' }).wallClass,
    'hcaptcha');
  assert.equal(classifyTopmost({ tag: 'iframe', src: 'https://www.recaptcha.net/recaptcha/enterprise/anchor', title: '', className: '', id: '' }).wallClass,
    'recaptcha-interactive');
  assert.equal(classifyTopmost({ tag: 'div', className: 'cookie-banner', title: '', src: '', id: '' }).captcha, false);
  assert.equal(classifyTopmost(null).captcha, false);
});

test('THE TRAP: the button is "visible" while a click would hit the captcha', async (t) => {
  if (skipIfNoChrome(t)) return;
  const { page, close } = await open('lever-submit-trapped.html');
  try {
    // This is the whole argument for the hit test, asserted rather than
    // asserted-about: Playwright reports the button as visible, and it is —
    // it is simply not what a click would reach.
    assert.equal(await page.locator('#btn-submit').isVisible(), true,
      'the trapped button IS visible: a visibility check is not a defence');

    const probe = await probeClickTarget(page, '#btn-submit');
    assert.equal(probe.hits, false, 'the click does NOT land on the submit control');
    assert.equal(probe.topmost.tag, 'iframe');
    assert.match(probe.topmost.title, /hCaptcha/i);
    // Full-viewport, exactly as recon found on the live tenant (1350x900).
    assert.ok(probe.topmost.rect.w >= 1000 && probe.topmost.rect.h >= 800,
      `overlay should be viewport-sized, got ${JSON.stringify(probe.topmost.rect)}`);
  } finally { await close(); }
});

test('THE REFUSAL: assertSubmitClickable throws and emits wall_detected{where:submit}', async (t) => {
  if (skipIfNoChrome(t)) return;
  const { page, close } = await open('lever-submit-trapped.html');
  const stream = newStream();
  const mem = new WallMemory();
  try {
    await assert.rejects(
      () => assertSubmitClickable({
        root: page, events: stream, submitSelector: '#btn-submit',
        captcha: {
          wrapperSelectors: lever.quirks.submitControl.captchaWrappers,
          responseSelector: lever.quirks.submitControl.captchaResponse,
        },
        wallMemory: mem, tenant: 'lever:kitware',
      }),
      (e) => {
        assert.ok(e instanceof SubmitObstructed);
        assert.match(e.message, /would land on the captcha/i);
        assert.equal(e.detail.wallClass, 'hcaptcha');
        return true;
      });

    const wall = stream.events.find((e) => e.type === 'wall_detected');
    assert.ok(wall, 'the refusal must be in the stream, not only in a thrown error');
    assert.equal(wall.data.wall_class, 'hcaptcha');
    assert.equal(wall.data.where, 'submit');
    assert.match(wall.data.marker, /elementFromPoint/);
    // The evidence a human needs to review this later.
    assert.equal(wall.data.detail.captcha_token_present, false,
      'an empty token with a present widget is an UNANSWERED challenge');
    assert.equal(mem.effectiveOccurrences('lever:kitware', 'hcaptcha', 'submit'), 1);
  } finally { await close(); }
});

test('the clear page passes, and records that the guard actually ran', async (t) => {
  if (skipIfNoChrome(t)) return;
  const { page, close } = await open('lever-submit-clear.html');
  const stream = newStream();
  try {
    const r = await assertSubmitClickable({
      root: page, events: stream, submitSelector: '#btn-submit',
      captcha: {
        wrapperSelectors: lever.quirks.submitControl.captchaWrappers,
        responseSelector: lever.quirks.submitControl.captchaResponse,
      },
    });
    assert.equal(r.ok, true);
    assert.equal(stream.events.some((e) => e.type === 'wall_detected'), false);
    // "We checked and it was fine" must be distinguishable from "nobody
    // checked" when this stream is read back.
    const note = stream.events.find((e) => e.type === 'adapter_note');
    assert.match(note.data.msg, /click-target verified/);
  } finally { await close(); }
});

test('an absent submit control is a refusal, not a pass', async (t) => {
  if (skipIfNoChrome(t)) return;
  const { page, close } = await open('wall-none.html');
  const stream = newStream();
  try {
    await assert.rejects(
      () => assertSubmitClickable({ root: page, events: stream, submitSelector: '#btn-submit' }),
      /not present/);
  } finally { await close(); }
});

test('a non-captcha overlay refuses WITHOUT poisoning the tenant wall memory', async (t) => {
  if (skipIfNoChrome(t)) return;
  const { page, close } = await open('overlay-cookie-banner.html');
  const stream = newStream();
  const mem = new WallMemory();
  try {
    await assert.rejects(
      () => assertSubmitClickable({
        root: page, events: stream, submitSelector: '#btn-submit',
        wallMemory: mem, tenant: 'lever:kitware',
      }),
      /never clicks through an overlay/);

    assert.equal(stream.events.some((e) => e.type === 'wall_detected'), false,
      'an obstruction is not a bot wall, and recording one would corrupt the retry policy');
    assert.equal(Object.keys(mem.data).length, 0);
  } finally { await close(); }
});

test('readCaptchaState reports the wrapper geometry and never the token itself', async (t) => {
  if (skipIfNoChrome(t)) return;
  const { page, close } = await open('lever-submit-trapped.html');
  try {
    await page.locator('#hcaptchaResponseInput').evaluate((el) => { el.value = 'P0_eyJ0eXAiOiJKV1Qi-secret-token'; });
    const state = await readCaptchaState(page, {
      wrapperSelectors: ['iframe[title*="hCaptcha" i]'],
      responseSelector: '#hcaptchaResponseInput',
    });
    assert.equal(state.token_present, true);
    assert.equal(state.token_len, 'P0_eyJ0eXAiOiJKV1Qi-secret-token'.length);
    // The token is a bearer credential for the challenge. It is counted, never
    // carried.
    assert.equal(JSON.stringify(state).includes('eyJ0eXAi'), false);
    assert.ok(state.wrappers[0].w >= 1000);
  } finally { await close(); }
});
