// The Lennox posting-page-entry gap (staging batch, 2026-09-19): the fleet
// URL `.../jobs/54888/job?mobile=true&needsRedirect=false` landed on a
// frameless mobile layout with zero form fields, the posting step could not
// identify (its marker demanded a slug the canonical URL does not have), and
// the entry "click" fell through to a submit-button selector on a page whose
// entry control is an ANCHOR — so it timed out.
//
// Three fixes, one test each, plus the end-to-end posting → guest-apply walk
// against a fixture shaped like the live tenant (recon 2026-09-21):
//   1. icims.entryUrl strips `mobile` / `needsRedirect` so navigation always
//      lands on the desktop iframe shape;
//   2. the posting marker accepts the slug-less canonical URL, and the Apply
//      anchor itself is a marker;
//   3. advance('posting') clicks `a.iCIMS_ApplyOnlineButton`.

import test from 'node:test';
import assert from 'node:assert/strict';

import { EventStream } from '../src/events/emitter.js';
import { attach } from '../src/driver/attach.js';
import { startScratchChrome, freePort, findChromeBinary } from '../src/driver/scratch-chrome.js';
import { serveFixtures } from './helpers/serve.js';
import { identifyStep, advanceStep } from '../src/engine/advance.js';
import { resolveRoot } from '../src/engine/discovery.js';
import icims from '../src/adapters/icims.js';

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

test('entryUrl strips the mobile-layout params and nothing else', () => {
  const fleet = new URL('https://uscareers-lennox.icims.com/jobs/54888/job?mobile=true&needsRedirect=false&utm_source=Simplify');
  const out = icims.entryUrl(fleet);
  assert.equal(out.searchParams.has('mobile'), false);
  assert.equal(out.searchParams.has('needsRedirect'), false);
  assert.equal(out.searchParams.get('utm_source'), 'Simplify', 'unrelated params survive');
  assert.equal(out.pathname, '/jobs/54888/job', 'the path is untouched');
  // A URL with nothing to strip round-trips unchanged.
  const clean = new URL('https://jobs-cesi.icims.com/jobs/9999/systems-intern/job');
  assert.equal(String(icims.entryUrl(clean)), String(clean));
});

test('the posting marker accepts BOTH the slug-less canonical and the slugged URL', () => {
  const posting = icims.steps.find((s) => s.id === 'posting');
  const re = posting.markers.find((m) => m.urlPattern).urlPattern;
  assert.ok(re.test('https://uscareers-lennox.icims.com/jobs/54888/job'),
    'pre-fix: the slug-less fleet URL never identified as a posting');
  assert.ok(re.test('https://uscareers-lennox.icims.com/jobs/54888/ai-enabled-full-stack-software-engineering-intern/job'));
  assert.ok(!re.test('https://uscareers-lennox.icims.com/jobs/54888/login'),
    'the login page is not a posting');
});

test('posting → guest-apply: the Apply ANCHOR is the entry control', async (t) => {
  if (skipIfNoChrome(t)) return;
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const stream = new EventStream({ run: '2026-09-18', applier: 1 });
  stream.context({ job_key: JOB, ats: 'icims', tenant: 'icims:uscareers-lennox.icims.com', step: 'posting' });
  try {
    await page.goto(site.url('icims-posting.html'));
    const spec = await icims.formRoot();
    const root = resolveRoot(page, spec);

    // The posting identifies by its Apply anchor (the fixture URL carries no
    // /jobs/ path, exactly like a decorated live URL can carry extra junk).
    assert.equal(await identifyStep(icims, { page, root }), 'posting');

    // Pre-fix: advance('posting') fell through to `input[type=submit]`,
    // which a posting page does not have, and the click timed out.
    const adv = await advanceStep(icims, { page, frame: root, log: () => {} }, 'posting', {
      events: stream, page, root, tenant: 'icims:uscareers-lennox.icims.com',
    });
    assert.equal(adv.wall, null);
    assert.equal(adv.to, 'guest-apply', 'the in-frame navigation lands on the email gate');
    assert.equal(await identifyStep(icims, { page, root }), 'guest-apply');
  } finally { await ctx.close(); }
});
