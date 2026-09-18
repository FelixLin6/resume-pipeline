// Engine core against local HTML fixtures shaped like the real forms.
//
// No network: a scratch Chrome on a randomized throwaway port (never
// 9222/9223) driving pages served from 127.0.0.1. The fixtures reproduce the
// shapes that actually bite — iCIMS's nested content iframe, its
// Month/Day/Year triples, its always-present-but-dormant hCaptcha, and its
// résumé parser overwriting already-correct fields with the CMU address.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { EventStream } from '../src/events/emitter.js';
import { attach, ApplierContexts } from '../src/driver/attach.js';
import { startScratchChrome, freePort, findChromeBinary } from '../src/driver/scratch-chrome.js';
import { serveFixtures } from './helpers/serve.js';
import { discover, resolveRoot, locate, emitDiscovery } from '../src/engine/discovery.js';
import { planField } from '../src/engine/mapping.js';
import { applyPlan, scanFormForForbidden, forbiddenScanner, ParkRequired, formatDate } from '../src/engine/fill.js';
import { detectWall } from '../src/engine/walls.js';
import { convertAll } from '../src/bank/convert.js';
import icims from '../src/adapters/icims.js';

const JOB = '8f2c1a94-6d3e-4b77-9a10-2f5c8e1b4d90';
const { profile, bank } = convertAll();

let site, chrome, browser, contexts, stateDir;

test.before(async () => {
  if (!findChromeBinary()) return;
  site = await serveFixtures();
  const port = await freePort();
  chrome = await startScratchChrome({ port });
  ({ browser } = await attach({ port }));
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-fx-'));
  contexts = new ApplierContexts({ browser, stateDir });
});

test.after(async () => {
  if (browser) await browser.close();
  if (chrome) chrome.stop();
  if (site) await site.close();
  if (stateDir) fs.rmSync(stateDir, { recursive: true, force: true });
});

const skipIfNoChrome = (t) => {
  if (!findChromeBinary()) { t.skip('no Chrome for Testing binary in the Playwright cache'); return true; }
  return false;
};

async function openPage(name, applier) {
  const ctx = await contexts.create(applier, { tenant: `fixture:${applier}` });
  const page = await ctx.newPage();
  await page.goto(site.url(name));
  return { ctx, page, close: () => contexts.close(applier) };
}

function newStream(step = 'guest-apply') {
  const s = new EventStream({ run: '2026-09-17', applier: 1 });
  s.context({ job_key: JOB, ats: 'icims', tenant: 'icims:careers-acme.icims.com', step });
  return s;
}

// ------------------------------------------------------- frame traversal ---

test('descends the iCIMS content iframe BY SELECTOR, past the tracking frames', async (t) => {
  if (skipIfNoChrome(t)) return;
  const { page, close } = await openPage('icims-guest-apply.html', 11);
  try {
    // The real Cotiviti page carries 8 frames and the tracking ones come
    // FIRST, so an index-based chain resolves to the wrong document. The
    // fixture reproduces that ordering deliberately.
    assert.ok(page.frames().length >= 5, 'fixture must have decoy frames');

    const spec = await icims.formRoot();
    assert.deepEqual(spec.frames, ['iframe#icims_content_iframe'],
      'recon verified a ONE-level chain on 5/5 tenants');

    const root = resolveRoot(page, spec);
    const heading = await root.locator('h2.iCIMS_InfoMsg').nth(1).innerText();
    assert.equal(heading, 'Enter Your Information');

    const { fields } = await discover(root);
    const byId = Object.fromEntries(fields.map((f) => [f.id, f]));
    assert.ok(byId.email, 'the guest email input is discovered inside the frame');
    assert.equal(byId.email.label, 'Email');
    assert.ok(byId.accept_gdpr, 'the consent checkbox is discovered');
    assert.equal(byId.accept_gdpr.control, 'checkbox');
  } finally { await close(); }
});

test('one discovery pass is ONE round trip and reports required counts', async (t) => {
  if (skipIfNoChrome(t)) return;
  const { page, close } = await openPage('icims-candidate-profile.html', 12);
  try {
    const root = resolveRoot(page, await icims.formRoot());
    const events = newStream('candidate-profile');
    const d = await discover(root);
    emitDiscovery(events, { fields: d.fields, rootFrames: ['iframe#icims_content_iframe'] });
    const ev = events.events.at(-1);
    assert.equal(ev.type, 'field_discovered');
    assert.ok(ev.data.count > 15, `expected a full form, saw ${ev.data.count}`);
    assert.ok(ev.data.required >= 5);
    assert.deepEqual(ev.data.root_frames, ['iframe#icims_content_iframe']);
  } finally { await close(); }
});

// ---------------------------------------------------- wall discrimination ---

test('a DORMANT hCaptcha widget is not a wall; a fired one is', async (t) => {
  if (skipIfNoChrome(t)) return;
  const dormant = await openPage('icims-guest-apply.html', 13);
  try {
    const root = resolveRoot(dormant.page, await icims.formRoot());
    // The widget IS present — response textarea and challenge iframe both.
    assert.equal(await root.locator('textarea[name="h-captcha-response"]').count(), 1);
    assert.equal(await root.locator('iframe[title="hCaptcha challenge"]').count(), 1);
    // …and it is still not a wall.
    const hit = await detectWall(icims.quirks.wallMarkers, { page: dormant.page, root });
    assert.equal(hit, null,
      'a presence-based marker would have parked 100% of iCIMS applications');
  } finally { await dormant.close(); }

  const fired = await openPage('icims-guest-apply.html?captcha=fired', 14);
  try {
    const root = resolveRoot(fired.page, await icims.formRoot());
    const hit = await detectWall(icims.quirks.wallMarkers, { page: fired.page, root });
    assert.ok(hit, 'a visible challenge IS a wall');
    assert.equal(hit.wallClass, 'hcaptcha');
  } finally { await fired.close(); }
});

// ------------------------------------------------------------- fill/verify --

test('fills the guest gate and reads the value back', async (t) => {
  if (skipIfNoChrome(t)) return;
  const { page, close } = await openPage('icims-guest-apply.html', 15);
  try {
    const root = resolveRoot(page, await icims.formRoot());
    const events = newStream();
    const { fields } = await discover(root);
    const emailField = fields.find((f) => f.id === 'email');
    const binding = icims.bindings('guest-apply').find((b) => b.key === 'contact.email');

    const plan = planField(emailField, { binding, profile, bank });
    assert.equal(plan.action, 'fill');
    const res = await applyPlan(root, emailField, plan, { events, profile });
    assert.equal(res.ok, true);
    assert.equal(res.actual, profile.contact.email);

    const ev = events.events.find((e) => e.type === 'field_filled');
    assert.equal(ev.data.field_key, 'contact.email');
    // Q5: an identity field carries a hash and NO preview.
    assert.equal(ev.data.value_preview, null);
    assert.equal(JSON.stringify(ev).includes('@'), false);
  } finally { await close(); }
});

test('the disabled Next is reported as blocked, not clicked around', async (t) => {
  if (skipIfNoChrome(t)) return;
  const { page, close } = await openPage('icims-guest-apply.html', 16);
  try {
    const root = resolveRoot(page, await icims.formRoot());
    const ctx = { page, frame: root, url: new URL(page.url()), jobKey: JOB, log: () => {} };
    const r = await icims.advance(ctx, 'guest-apply');
    assert.equal(r.to, 'guest-apply');
    assert.match(r.blockedBy[0].message, /disabled/);

    // Checking consent enables it — a disabled Next here is an unchecked box.
    const consentField = (await discover(root)).fields.find((f) => f.id === 'accept_gdpr');
    const events = newStream();
    await applyPlan(root, consentField, {
      action: 'check', field_key: 'consent.terms', checked: true, canonical: 'yes', required: false,
    }, { events, profile });
    assert.equal(await root.locator('#enterEmailSubmitButton').isDisabled(), false);
  } finally { await close(); }
});

test('gate observation reports the per-tenant consent shape', async (t) => {
  if (skipIfNoChrome(t)) return;
  const { page, close } = await openPage('icims-guest-apply.html', 17);
  try {
    const root = resolveRoot(page, await icims.formRoot());
    const notes = [];
    const ctx = { page, frame: root, url: new URL(page.url()), jobKey: JOB, log: (m, d) => notes.push({ m, d }) };
    const gate = await icims.passGate(ctx);
    assert.equal(gate.kind, 'passed');
    assert.equal(gate.via, 'guest');
    assert.equal(notes[0].d.has_consent_checkbox, true);
    assert.equal(notes[0].d.next_disabled, true);
  } finally { await close(); }
});

// ------------------------------------------- F16: the parser overwrite -----

test('F16: the résumé parser writing the CMU address is caught on read-back', async (t) => {
  if (skipIfNoChrome(t)) return;
  const { page, close } = await openPage('icims-candidate-profile.html', 18);
  try {
    const root = resolveRoot(page, await icims.formRoot());
    const events = newStream('candidate-profile');

    // 1. Fill the login with the CORRECT address first.
    let d = await discover(root);
    const loginField = d.fields.find((f) => f.id === 'login');
    await applyPlan(root, loginField, {
      action: 'fill', field_key: 'account.login', value: profile.contact.email, required: true,
    }, { events, profile });
    assert.equal(await root.locator('#login').inputValue(), profile.contact.email);

    // 2. Attach a résumé. The fixture's parser then does what the real ones
    //    did on Cole, SimVentions and Cotiviti: rewrites the login to the
    //    forbidden CMU address. We never typed it.
    const tmp = path.join(stateDir, 'Felix-Lin-Acme-8f2c1a94.pdf');
    fs.writeFileSync(tmp, '%PDF-1.4 fixture');
    await root.locator('#resume_file').setInputFiles(tmp);
    await page.waitForFunction(
      () => document.querySelector('#icims_content_iframe')
        .contentDocument.querySelector('#login').value.includes('cmu.edu'),
      null, { timeout: 5000 },
    );

    // 3. The post-upload barrier re-discovers and scans the WHOLE form —
    //    a value we never wrote is still a value we would submit.
    d = await discover(root);
    const hits = await scanFormForForbidden(d, profile);
    assert.ok(hits.length >= 2, `expected the parser's CMU writes to be caught, saw ${hits.length}`);
    assert.ok(hits.every((h) => h.hit === 'cmu-email'));

    // 4. And the scan is a PATTERN, so a variant spelling cannot slip past.
    const scan = forbiddenScanner(profile);
    assert.ok(scan('someone.else@andrew.cmu.edu'), 'the whole domain is forbidden, not one literal');
    assert.equal(scan('felixl0808@gmail.com'), null, 'the pipeline address is fine');
  } finally { await close(); }
});

test('F16: writing a forbidden value is refused before it reaches the form', async (t) => {
  if (skipIfNoChrome(t)) return;
  const { page, close } = await openPage('icims-candidate-profile.html', 19);
  try {
    const root = resolveRoot(page, await icims.formRoot());
    const events = newStream('candidate-profile');
    const field = (await discover(root)).fields.find((f) => f.id === 'login');
    await assert.rejects(
      () => applyPlan(root, field, {
        action: 'fill', field_key: 'account.login', value: 'felixl@andrew.cmu.edu', required: true,
      }, { events, profile }),
      ParkRequired,
    );
    const skip = events.events.find((e) => e.type === 'field_skipped');
    assert.equal(skip.data.reason, 'forbidden_value');
    assert.equal(await root.locator('#login').inputValue(), '', 'nothing was written');
  } finally { await close(); }
});

// -------------------------------------------------- enum fills on real DOM --

test('selects resolve through adapter vocabulary on the real control', async (t) => {
  if (skipIfNoChrome(t)) return;
  const { page, close } = await openPage('icims-candidate-profile.html', 20);
  try {
    const root = resolveRoot(page, await icims.formRoot());
    const events = newStream('candidate-profile');
    const d = await discover(root);
    const bindings = icims.bindings('candidate-profile');

    for (const id of ['citizenship', 'veteran', 'disability', 'graduated']) {
      const field = d.fields.find((f) => f.id === id);
      const binding = bindings.find((b) => b.label?.test(field.label ?? ''));
      const plan = planField(field, { binding, profile, bank });
      assert.equal(plan.action, 'select', `${id}: expected a select plan, got ${plan.reason ?? plan.action}`);
      const res = await applyPlan(root, field, plan, { events, profile });
      assert.equal(res.ok, true, `${id} did not verify`);
    }

    assert.equal(await root.locator('#citizenship').inputValue(), 'U.S. Citizen');
    assert.equal(await root.locator('#veteran').inputValue(), 'I am NOT a protected veteran');
    assert.equal(await root.locator('#graduated').inputValue(), 'No');
    // Gender is NOT bound by the adapter, but the generic label mapping and
    // the default vocabulary resolve it — and it must not pick "Female".
    const gender = d.fields.find((f) => f.id === 'gender');
    const gPlan = planField(gender, { profile, bank });
    assert.equal(gPlan.option_text, 'Male');
  } finally { await close(); }
});

test('an option the tenant does not offer is skipped, never approximated', async (t) => {
  if (skipIfNoChrome(t)) return;
  const { page, close } = await openPage('icims-candidate-profile.html', 21);
  try {
    const root = resolveRoot(page, await icims.formRoot());
    const events = newStream('candidate-profile');
    const field = (await discover(root)).fields.find((f) => f.id === 'citizenship');
    // Pretend we needed a clearance level this form has no option for.
    const plan = planField({ ...field, label: 'Security Clearance' }, {
      binding: { key: 'auth.clearance', required: true }, profile, bank,
    });
    assert.equal(plan.action, 'skip');
    // auth.clearance was refused by the converter as self-contradictory, so
    // the honest reason is that we hold no value at all.
    assert.equal(plan.reason, 'value_absent');
    events.emit('field_skipped', {
      field_key: plan.field_key, label: plan.label, required: true, reason: plan.reason,
    });
    assert.equal(await root.locator('#citizenship').inputValue(), '', 'nothing was guessed into it');
  } finally { await close(); }
});

// ------------------------------------------------------------ Workday shape --

test('Workday: three date spinbuttons, one fill each (F5)', async (t) => {
  if (skipIfNoChrome(t)) return;
  const { page, close } = await openPage('workday-my-information.html', 22);
  try {
    const root = page;                       // Workday is top-level, no iframe
    const events = newStream('my-information');
    events.context({ ats: 'workday' });

    const parts = formatDate(profile.availability.earliestStart, 'three-spinbuttons');
    assert.deepEqual(parts, { month: 1, day: 1, year: 2027 },
      'the 1st-of-month rule is applied by the engine, not guessed from a placeholder');

    const d = await discover(root);
    for (const [id, value] of [['dateMonth', parts.month], ['dateDay', parts.day], ['dateYear', parts.year]]) {
      const field = d.fields.find((f) => f.id === id);
      const res = await applyPlan(root, field, {
        action: 'fill', field_key: 'avail.earliestStart', value: String(value), required: true,
      }, { events, profile });
      assert.equal(res.ok, true);
    }
    // 3 fills, not the ~12 per-digit presses that garbled 2026 into 2006.
    assert.equal(events.events.filter((e) => e.type === 'field_filled').length, 3);
    assert.equal(await page.locator('#dateYear').inputValue(), '2027');
  } finally { await close(); }
});

test('the SAME canonical resolves against Workday wording without new engine code', async (t) => {
  if (skipIfNoChrome(t)) return;
  const { page, close } = await openPage('workday-my-information.html', 23);
  try {
    const events = newStream('my-information');
    const d = await discover(page);
    const field = d.fields.find((f) => f.id === 'sponsorship');
    const plan = planField(field, {
      binding: { key: 'auth.sponsorship', required: true },
      profile, bank,
    });
    assert.equal(plan.action, 'select');
    // iCIMS would render this differently; the engine matched the tenant's own
    // wording from the shared default vocabulary.
    assert.equal(plan.option_text, 'No, I do not require sponsorship');
    const res = await applyPlan(page, field, plan, { events, profile });
    assert.equal(res.ok, true);

    // And the EEO select still refuses the wrong neighbour.
    const gender = d.fields.find((f) => f.id === 'gender');
    const gPlan = planField(gender, { profile, bank });
    assert.equal(gPlan.option_text, 'Male');
    assert.notEqual(gPlan.option_text, 'Female');
  } finally { await close(); }
});

test('a read-back that does not match is reported, not assumed', async (t) => {
  if (skipIfNoChrome(t)) return;
  const { page, close } = await openPage('workday-my-information.html', 24);
  try {
    const events = newStream('my-information');
    const d = await discover(page);
    const field = d.fields.find((f) => f.id === 'compensation');
    // Workday strips non-digits: "23.50" is silently stored as "2350", so the
    // form now says the candidate wants $2,350/hour. No error is raised. A
    // write that "succeeded" is not a write that landed, which is precisely
    // why the read-back is mandatory rather than an optimization.
    const res = await applyPlan(page, field, {
      action: 'fill', field_key: 'comp.expected', value: '23.50', required: true,
    }, { events, profile });
    assert.equal(await page.locator('#compensation').inputValue(), '2350',
      'the fixture reproduces the recorded stripping behaviour');
    assert.equal(res.ok, false);
    const skip = events.events.find((e) => e.type === 'field_skipped');
    assert.equal(skip.data.reason, 'value_absent');
    assert.match(skip.data.detail, /read-back/);
  } finally { await close(); }
});

// ----------------------------------------------------------- upload verify --

test('verifyUpload reads the DOM the way the tenant renders an attachment', async (t) => {
  if (skipIfNoChrome(t)) return;
  const { page, close } = await openPage('icims-candidate-profile.html', 25);
  try {
    const root = resolveRoot(page, await icims.formRoot());
    const ctx = { page, frame: root, url: new URL(page.url()), jobKey: JOB, log: () => {} };
    const file = path.join(stateDir, 'Felix-Lin-Acme-8f2c1a94.pdf');
    fs.writeFileSync(file, '%PDF-1.4 fixture');

    const before = await icims.verifyUpload(ctx, { name: 'resume' }, { path: file });
    assert.equal(before.attached, false, 'nothing attached yet');

    await icims.upload(ctx, { name: 'resume' }, { path: file });
    await page.waitForTimeout(200);
    const after = await icims.verifyUpload(ctx, { name: 'resume' }, { path: file });
    assert.equal(after.attached, true);
    assert.equal(after.observedName, 'Felix-Lin-Acme-8f2c1a94.pdf');
    assert.equal(after.how, 'filename-in-dom');
  } finally { await close(); }
});

test('locate() re-resolves a field without a stale reference', async (t) => {
  if (skipIfNoChrome(t)) return;
  const { page, close } = await openPage('icims-candidate-profile.html', 26);
  try {
    const root = resolveRoot(page, await icims.formRoot());
    const d = await discover(root);
    const field = d.fields.find((f) => f.id === 'work_title');
    const loc = locate(root, field);
    await loc.fill('Software Engineer Intern');
    // Mutate the DOM around it, the way an iCIMS re-render would.
    await root.locator('#work_desc').fill('x');
    // The SAME locator still resolves — no @ref to go stale, which is what
    // forced coordinate-click recovery on the current stack.
    assert.equal(await loc.inputValue(), 'Software Engineer Intern');
  } finally { await close(); }
});
