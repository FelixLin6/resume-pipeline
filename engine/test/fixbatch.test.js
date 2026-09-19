// Gate 1 fix batch — one regression test per structural defect.
//
// Sources: the droplet's negative-fixture report (the cesi FALSE CLEAN:
// Next clicked, hCaptcha fired, stream recorded wall:null outcome:assist) and
// the Mac shadow-run report (15 runs, defects D1–D10). Every test here is a
// defect that actually happened, reproduced against a local fixture, and each
// must FAIL on the pre-fix code.
//
// No network: scratch Chrome, randomized throwaway port, fixtures on 127.0.0.1.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { EventStream } from '../src/events/emitter.js';
import { EventValidationError } from '../src/events/schema.js';
import { attach } from '../src/driver/attach.js';
import { startScratchChrome, freePort, findChromeBinary } from '../src/driver/scratch-chrome.js';
import { serveFixtures } from './helpers/serve.js';
import { identifyStep, advanceStep } from '../src/engine/advance.js';
import { discover, resolveRoot } from '../src/engine/discovery.js';
import { planField } from '../src/engine/mapping.js';
import { applyPlan, formatDate, ParkRequired } from '../src/engine/fill.js';
import { keyForLabel } from '../src/engine/match.js';
import {
  dateMatchesSource, parseRenderedDate, auditUnanswered, diffReview, checkJobFacts,
} from '../src/engine/review.js';
import { classifyHeaders } from '../src/engine/preflight.js';
import { WallMemory, NO_RETRY_CLASSES } from '../src/engine/walls.js';
import { isFieldKey } from '../src/schema/fieldkeys.js';
import { convertAll } from '../src/bank/convert.js';
import { shadowRun, loadAllowlist } from '../tools/shadow.js';
import { perApplication, aggregateByAts, BUDGETS, MEASURED } from '../src/metrics/harness.js';
import icims from '../src/adapters/icims.js';
import greenhouse from '../src/adapters/greenhouse.js';

const JOB = '8f2c1a94-6d3e-4b77-9a10-2f5c8e1b4d90';
const { profile, bank } = convertAll();

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
  s.context({ job_key: JOB, tenant: 'icims:jobs-cesi.icims.com', ats: 'icims', step: 'guest-apply' });
  return s;
}

async function openIcims(query = '') {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(site.url(`icims-guest-apply.html${query}`));
  const root = resolveRoot(page, { frames: ['iframe#icims_content_iframe'] });
  // Wait for the CONTENT of the inner frame, not for a timer: the outer
  // fixture rewrites the iframe src to propagate the query (as the real page
  // propagates in_iframe=1), so the frame loads twice and a sleep is a race.
  await root.locator('#enterEmailSubmitButton').waitFor({ state: 'attached', timeout: 5000 });
  return { ctx, page, root, close: () => ctx.close() };
}

function allowlisted(urls) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-fixb-'));
  const file = path.join(dir, 'allow.json');
  fs.writeFileSync(file, JSON.stringify(urls));
  return { list: loadAllowlist(file), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// ===========================================================================
// A — THE FALSE-CLEAN CLASS
// ===========================================================================

test('A: a FIRED challenge outranks guest-apply, whose 3 markers all still match', async (t) => {
  if (skipIfNoChrome(t)) return;
  const { page, root, close } = await openIcims('?captcha=fired');
  try {
    // The arithmetic of the cesi false clean, asserted directly: every
    // guest-apply marker is still true under the overlay…
    assert.ok(await root.locator('#enterEmailSubmitButton').count());
    assert.match(await root.locator('body').innerText(), /Enter Your Information/i);
    // …and the wall step must win anyway.
    assert.equal(await identifyStep(icims, { page, root }), 'captcha-gate',
      'a page with a live challenge on it IS the challenge (Rule 1)');
  } finally { await close(); }
});

test('A: the DORMANT widget still identifies as guest-apply — presence is not a wall', async (t) => {
  if (skipIfNoChrome(t)) return;
  const { page, root, close } = await openIcims();
  try {
    assert.equal(await identifyStep(icims, { page, root }), 'guest-apply');
    // The adapter-level identifyStep checks the wall FIRST too. Its
    // guest-apply branch needs the real /jobs/N/login URL (which a flat
    // fixture cannot have), so the claim it can make here is the one that
    // matters: a dormant widget is never called a captcha-gate.
    const shim = { page, frame: root, url: new URL(page.url()), log: () => {} };
    assert.notEqual(await icims.identifyStep(shim), 'captcha-gate');
  } finally { await close(); }
});

test('A: THE TRANSITION — dormant at load, fired 800ms after Next, classified hcaptcha', async (t) => {
  if (skipIfNoChrome(t)) return;
  const { page, root, close } = await openIcims('?captcha=on-next');
  const stream = newStream();
  const mem = new WallMemory();
  try {
    assert.equal(await identifyStep(icims, { page, root }), 'guest-apply', 'dormant at load');
    await root.locator('#accept_gdpr').check();   // enable Next, as the engine would

    const t0 = Date.now();
    const adv = await advanceStep(icims, { page, frame: root, log: () => {} }, 'guest-apply', {
      events: stream, page, root, wallMemory: mem, tenant: 'icims:jobs-cesi.icims.com',
    });

    // The old code concluded "no-progress" in ~70ms — before the challenge
    // frame existed. The settle loop must wait it out and NAME it.
    assert.ok(adv.wall, 'the settle loop must observe the challenge fire');
    assert.equal(adv.wall.wallClass, 'hcaptcha');
    assert.equal(adv.to, 'captcha-gate', 'the wall STEP is the destination');
    assert.ok(Date.now() - t0 >= 700, 'the classification happened after the fire, not before');

    const wallEv = stream.events.find((e) => e.type === 'wall_detected');
    assert.ok(wallEv, 'the wall is in the stream');
    assert.equal(wallEv.data.where, 'advance:guest-apply');
    assert.ok(wallEv.data.action, 'the policy ran');
    assert.equal(mem.effectiveOccurrences('icims:jobs-cesi.icims.com', 'hcaptcha', 'advance:guest-apply'), 1);

    const pa = stream.events.find((e) => e.type === 'page_advanced');
    assert.equal(pa.data.settled, true);
    assert.equal(pa.data.wall_class, 'hcaptcha');
  } finally { await close(); }
});

test('A: a stall with no wall and no blocker ends the shadow run as SUSPECT, never a clean assist', async (t) => {
  if (skipIfNoChrome(t)) return;
  const url = site.url('icims-guest-apply.html?stall=1');
  const { list, cleanup } = allowlisted([url]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-fixb-ev-'));
  const eventsFile = path.join(dir, 'events', 'applier0.jsonl');

  const { summary, events } = await shadowRun({
    url, allowlist: list, jobKey: JOB, profile, bank, adapter: icims, eventsFile,
  });

  assert.equal(summary.suspect, true);
  assert.equal(summary.stopped_at, 'no-progress');
  const ended = events.find((e) => e.type === 'application_ended');
  assert.equal(ended.data.outcome, 'suspect',
    'the cesi shape — no step change, no blocker, no wall — must be un-reportable as assist');

  // D9: the park captured evidence, so the next person does not need a
  // separate probe run to see what the page looked like.
  const shot = events.find((e) => e.type === 'evidence_captured' && e.data.kind === 'parked');
  assert.ok(shot, 'a park screenshot is recorded in the stream');
  assert.ok(fs.existsSync(shot.data.path), 'and the file exists');

  // Droplet finding: the adapter telemetry reaches the stream (ctx.log was
  // previously swallowed by `log: () => {}`).
  const gateNote = events.find((e) => e.type === 'adapter_note' && /gate observed/.test(e.data.msg));
  assert.ok(gateNote, 'passGate telemetry is in the stream');
  assert.equal(gateNote.data.extra.has_consent_checkbox, true);

  // The gate result claims an OBSERVATION, not a pass nothing passed.
  const gate = events.find((e) => e.type === 'gate_result');
  assert.equal(gate.data.kind, 'observed');

  // D8: real timing, not hardcoded zeros.
  assert.ok(ended.data.duration_ms > 0);
  const pre = events.find((e) => e.type === 'preflight_result');
  assert.ok(pre.data.elapsed_ms > 0);

  // D10: the self-reported cost equals what the harness re-derives.
  const [row] = perApplication(events);
  assert.equal(row.tool_call_disagreement, null,
    `self-reported ${ended.data.tool_calls} must equal measured ${row.tool_calls}`);

  fs.rmSync(dir, { recursive: true, force: true });
  cleanup();
});

test('A: the full cesi acceptance shape — shadow-fill sees the challenge fire on Next and classifies it', async (t) => {
  if (skipIfNoChrome(t)) return;
  const url = site.url('icims-guest-apply.html?captcha=on-next');
  const { list, cleanup } = allowlisted([url]);

  const { summary, events } = await shadowRun({
    url, allowlist: list, jobKey: JOB, profile, bank, adapter: icims,
  });

  // What the droplet will re-run for: classification flips to hcaptcha.
  assert.equal(summary.wall?.wall_class, 'hcaptcha');
  assert.equal(summary.stopped_at, 'wall:hcaptcha');
  assert.equal(summary.suspect, false);
  const wallEv = events.find((e) => e.type === 'wall_detected' && e.data.where === 'advance:guest-apply');
  assert.ok(wallEv, 'wall_detected{where:"advance:guest-apply"} is in the stream');
  const ended = events.find((e) => e.type === 'application_ended');
  assert.equal(ended.data.outcome, 'wall', 'never again a clean assist over a fired challenge');
  cleanup();
});

// ===========================================================================
// B — THE REVIEW DIFF VERIFIES THE VALUE, NOT THE WRITE
// ===========================================================================

test('B: semantic dates — rendered is checked against the SOURCE, not our own write', () => {
  // The Relay shape: intended === rendered (the write verified), source month
  // differs (the value was wrong).
  assert.equal(dateMatchesSource('01/01/2027', { year: 2027, month: 5, day: null, dayRule: 'first-of-month' }).ok, false);
  assert.equal(dateMatchesSource('May 2027', { year: 2027, month: 5, day: null }).ok, true);
  assert.equal(dateMatchesSource('05/01/2027', { year: 2027, month: 5, day: null, dayRule: 'first-of-month' }).ok, true);
  // A month the bank never stated, asserted to a tenant, is an invention.
  assert.equal(dateMatchesSource('05/01/2027', { year: 2027, month: null, day: null }).ok, false);
  assert.equal(dateMatchesSource('2027', { year: 2027, month: 5 }).ok, false, 'unparseable rendered is not a pass');

  assert.deepEqual(parseRenderedDate('May 2027'), { year: 2027, month: 5, day: null });
  assert.deepEqual(parseRenderedDate('05/2027'), { year: 2027, month: 5, day: null });
  assert.equal(parseRenderedDate('Negotiable'), null);
});

test('B: diffReview fails the Relay date even though intended === rendered', () => {
  const diff = diffReview(
    [{ field_key: 'avail.earliestStart', intended: '01/01/2027', sourceDate: { year: 2027, month: 5, day: null } }],
    { 'When is your desired start date?': '01/01/2027' },
    [{ key: 'avail.earliestStart', label: 'When is your desired start date?' }],
  );
  assert.equal(diff.verdict, 'fail');
  assert.match(diff.mismatches[0].reason, /date_semantic/);
});

test('B: a start date before the posting term is a FAIL (the profile makes it conditional)', () => {
  // Relay is a Summer 2027 posting; the profile's own note says "give that
  // term's start instead". January on a Summer posting contradicts the term.
  const out = checkJobFacts({
    rendered: { 'When is your desired start date?': '01/01/2027' },
    jobFacts: { term: 'Summer 2027' },
  });
  assert.ok(out.some((m) => m.reason === 'start_date_precedes_posting_term' && m.severity === 'fail'));

  // And a compliant answer passes both checks.
  assert.deepEqual(checkJobFacts({
    rendered: { 'When is your desired start date?': '05/01/2027' },
    jobFacts: { term: 'Summer 2027' },
  }), []);
});

test('B: unanswered REQUIRED questions on the review page are failures', () => {
  const fields = [
    { control: 'text', label: 'Can you legally work in the United States?*', required: true, value: '', visible: true },
    { control: 'text', label: 'What is your desired salary?*', required: true, value: '', visible: true },
    { control: 'text', label: 'LinkedIn Profile', required: false, value: '', visible: true },       // optional: fine
    { control: 'text', label: 'Email*', required: true, value: 'x@y.com', visible: true },           // answered: fine
    { control: 'radio', name: 'wa', label: 'Yes', required: true, checked: true, visible: true },    // answered group
    { control: 'file', label: 'Resume*', required: true, value: '', visible: true },                 // uploads: C3's job
  ];
  const out = auditUnanswered(fields);
  assert.equal(out.length, 2, JSON.stringify(out));
  assert.ok(out.every((m) => m.severity === 'fail' && m.reason === 'unanswered_required'));
  assert.ok(out.some((m) => /legally work/.test(m.label)), 'the Clockwork question is named');
  assert.ok(out.some((m) => /desired salary/.test(m.label)), 'the Relay miss is named');
});

test('B: a filled field the review page does not show is COUNTED, not silently skipped', () => {
  const diff = diffReview(
    [{ field_key: 'education.gpa', intended: '3.36' }],
    { 'Something else': 'x' },
  );
  assert.equal(diff.unlocated, 1);
  assert.ok(diff.mismatches.some((m) => m.reason === 'not_found_on_review' && m.severity === 'warn'));
});

// ===========================================================================
// C — ONE BAD CONTROL PARKS ONE FIELD, NEVER THE APPLICATION
// ===========================================================================

test('C: a date string aimed at input[type=number] parks the FIELD, and the run survives (D1+D2)', async (t) => {
  if (skipIfNoChrome(t)) return;
  const url = site.url('greenhouse-splitdate.html');
  const { list, cleanup } = allowlisted([url]);

  // The Amperesand shape. Pre-fix: uncaught locator.fill error, application
  // dead at 5.5s with no application_ended at all.
  const { summary, events } = await shadowRun({
    url, allowlist: list, jobKey: JOB, profile, bank, adapter: greenhouse,
  });

  const ended = events.find((e) => e.type === 'application_ended');
  assert.ok(ended, 'the application ENDED — it did not die mid-fill');
  assert.ok(summary.filled >= 3, 'fields before and after the bad control were still filled');

  const parked = events.filter((e) => e.type === 'field_skipped' && e.data.reason === 'fill_failed');
  assert.ok(parked.length >= 1, 'the unwritable control is a parked field, by name');
  assert.ok(parked.some((e) => /number/.test(e.data.detail ?? '')), 'and the reason says why');

  // The review audit keeps the parked-but-required questions visible as
  // failures — parking a field is not forgetting it.
  const rd = events.find((e) => e.type === 'review_diff');
  assert.ok(rd);
  assert.equal(rd.data.verdict, 'fail');
  assert.ok(rd.data.mismatches.some((m) => m.reason === 'unanswered_required'));
  cleanup();
});

test('C: formatDate refuses to fabricate a month that is not on file', () => {
  assert.throws(
    () => formatDate({ year: 2027, month: null, day: null, dayRule: 'first-of-month' }, 'mm/dd/yyyy-text'),
    (e) => e instanceof ParkRequired && e.reason === 'would_require_invention');
  // With a month, the dayRule fill-in stays licensed.
  assert.equal(formatDate({ year: 2027, month: 5, day: null, dayRule: 'first-of-month' }, 'mm/dd/yyyy-text'), '05/01/2027');
});

test('C: radio GROUPS are one question with options, and the matched member gets checked (D6)', async (t) => {
  if (skipIfNoChrome(t)) return;
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(site.url('greenhouse-splitdate.html'));
  const stream = newStream();
  try {
    const d = await discover(page);
    const group = d.fields.find((f) => f.control === 'radio' && f.name === 'work_auth');
    assert.ok(group, 'one logical control for the group');
    assert.deepEqual(group.options, ['Yes', 'No'], 'the member labels ARE the options');
    assert.match(group.label, /legally work/i, 'the fieldset legend is the question');
    assert.equal(d.fields.filter((f) => f.control === 'radio' && f.name === 'work_auth').length, 1,
      'not N separate option-less controls');

    // Plan + fill end to end: the bank's work-auth answer lands on "Yes".
    const plan = planField(group, {
      binding: {
        key: 'auth.workAuthorized', control: 'radio', required: true,
        optionText: { 'us-citizen': ['Yes'], 'authorized-no-sponsorship': ['Yes'] },
      },
      profile, bank,
    });
    assert.equal(plan.action, 'select', `pre-fix this skipped option_not_found: ${JSON.stringify(plan)}`);
    const r = await applyPlan(page, group, plan, { events: stream, profile });
    assert.equal(r.ok, true);
    assert.equal(await page.locator('#wa-yes').isChecked(), true, 'the RIGHT member is checked');
    assert.equal(await page.locator('#wa-no').isChecked(), false);
  } finally { await ctx.close(); }
});

test('C: an option-less combobox is typed and committed, verified by read-back', () => {
  // Hermeus lost links.linkedin / links.website / education.school to
  // option_not_found on typeaheads whose options never exist in the DOM.
  const plan = planField(
    { control: 'combobox', label: 'School*', options: [], required: true },
    { binding: { key: 'education.school', control: 'combobox', required: true }, profile, bank },
  );
  assert.equal(plan.action, 'fill');
  assert.equal(plan.commit, 'enter');
  assert.equal(plan.match, 'typed-commit');
  assert.ok(plan.value.length > 3, 'the bank value is what gets typed');

  // An enum with no declared tenant wording still cannot be typed: the
  // canonical slug must never reach a form.
  const enumPlan = planField(
    { control: 'combobox', label: 'Do you require sponsorship?*', options: [], required: true },
    { binding: { key: 'auth.sponsorship', control: 'combobox', required: true }, profile, bank },
  );
  assert.equal(enumPlan.action, 'skip');
  assert.equal(enumPlan.reason, 'option_not_found');
});

// ===========================================================================
// D — ENUM AND STREAM FIXES
// ===========================================================================

test('D: HTTP 410 classifies as posting-closed, which is terminal', () => {
  assert.deepEqual(classifyHeaders(410, {}), { wallClass: 'posting-closed', marker: 'http-status:410' });
  assert.ok(NO_RETRY_CLASSES.includes('posting-closed'));
  const m = new WallMemory();
  assert.equal(m.decide('icims:careers-sig.icims.com', 'posting-closed', 'preflight'), 'park',
    'a withdrawn posting buys no retry and no model-fallback turn');
});

test('D: gate_result kinds are a closed vocabulary, and "observed" is not "passed"', () => {
  const s = newStream();
  assert.doesNotThrow(() => s.emit('gate_result', { kind: 'observed', via: 'guest' }));
  assert.doesNotThrow(() => s.emit('gate_result', { kind: 'passed', via: 'login' }));
  assert.throws(() => s.emit('gate_result', { kind: 'looked-at-it', via: 'guest' }), EventValidationError);
});

test('D: outcome "suspect" and the new skip reasons are in the closed enums', () => {
  const s = newStream();
  assert.doesNotThrow(() => s.emit('application_ended', {
    outcome: 'suspect', reason: 'no-progress with nothing to blame', duration_ms: 5, tool_calls: 3, model_turns: 0,
  }));
  assert.doesNotThrow(() => s.emit('field_skipped', { field_key: null, label: 'x', required: true, reason: 'fill_failed' }));
  assert.doesNotThrow(() => s.emit('field_skipped', { field_key: 'contact.email', label: 'x', required: false, reason: 'already_filled' }));
  assert.doesNotThrow(() => s.emit('wall_detected', { wall_class: 'posting-closed', where: 'preflight' }));
});

test('D: consent.privacy exists, resolves to yes, and the gate label maps to it', () => {
  assert.ok(isFieldKey('consent.privacy'));
  assert.equal(bank.facts['consent.privacy']?.value, 'yes',
    'drawn from the same profile answer as consent.terms (agree_to_terms_and_privacy)');
  assert.equal(keyForLabel('I have read and accept the privacy policy'), 'consent.privacy');
  assert.equal(keyForLabel('Privacy Policy'), 'consent.privacy');
  assert.notEqual(keyForLabel('Privacy Officer job description'), 'consent.privacy',
    'a bare /privacy/ would steal unrelated fields');
});

// ===========================================================================
// E — THE REMAINING MAC DEFECTS
// ===========================================================================

test('E/D7: address line 2 no longer matches line 1\'s pattern', () => {
  assert.equal(keyForLabel('Address Line 1'), 'contact.address.line1');
  assert.equal(keyForLabel('Address Line 2'), 'contact.address.line2');
  assert.equal(keyForLabel('Address'), 'contact.address.line1');
  assert.equal(keyForLabel('Street Address'), 'contact.address.line1');
});

test('E/D7: a second control resolving to an already-filled key is refused', async (t) => {
  if (skipIfNoChrome(t)) return;
  const url = site.url('greenhouse-splitdate.html');
  const { list, cleanup } = allowlisted([url]);
  const { events } = await shadowRun({
    url, allowlist: list, jobKey: JOB, profile, bank, adapter: greenhouse,
  });
  const dup = events.find((e) => e.type === 'field_skipped' && e.data.reason === 'already_filled');
  assert.ok(dup, 'the confirm-email control is refused, not given the first value');
  assert.equal(dup.data.field_key, 'contact.email');
  assert.equal(events.filter((e) => e.type === 'field_filled'
    && e.data.field_key === 'contact.email').length, 1, 'one key, one fill');
  cleanup();
});

test('E/D5: a budget verdict cannot be earned by doing nothing', () => {
  const s = newStream();
  // Six pre-gate iCIMS rows, faithfully: 2 fills, no review, parked.
  s.emit('application_started', { apply_url: 'u', attempt: 1, claim: 'none' });
  s.emit('field_filled', { field_key: 'contact.email', value_hash: 'sha256:a', value_preview: null, value_len: 9, strategy: 'fill' });
  s.emit('field_filled', { field_key: 'consent.privacy', canonical: 'yes', value_hash: 'sha256:b', strategy: 'check' });
  s.emit('application_ended', { outcome: 'suspect', reason: 'no-progress', duration_ms: 7000, tool_calls: 3, model_turns: 0 });

  const rows = perApplication(s.events);
  assert.equal(rows[0].reached_review, false);
  assert.equal(rows[0].suspect, true);
  const [agg] = aggregateByAts(rows);
  assert.match(agg.verdict, /not measurable — 0\/1 runs reached review/,
    'p50 8 vs budget 40 for six runs that filled two fields must not read "within budget"');
  assert.equal(agg.suspects, 1);
});

test('E: measured budget rows carry their sources; workday stays unmeasured', () => {
  // The measured Gate 1 numbers, recorded with citations (Mac RESULTS.md).
  assert.equal(MEASURED.greenhouse.p50, 32);
  assert.equal(MEASURED.lever.p50, 23);
  assert.equal(MEASURED.icims.pregate_probe_calls, 6);
  assert.equal(MEASURED.icims.pregate_fill_calls, 11);
  assert.match(MEASURED.icims.source, /NOT a full-application cost/);
  // Budgets set from the measured p90s; workday has no measurement and no budget.
  assert.equal(BUDGETS.greenhouse, 50);
  assert.equal(BUDGETS.lever, 75);
  assert.equal(BUDGETS.workday, null);
  assert.equal(BUDGETS.icims, 40);
});
