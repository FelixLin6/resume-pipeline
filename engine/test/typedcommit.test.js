// Fleet 0918 regression batch — the sponsorship/self-ID "bank gap" that
// wasn't one. The bank had held auth.sponsorship and every selfid.* key since
// phase 2; the fields went unfilled because:
//
//   1. locate() built `#<all-digit-id>` selectors, a CSS parse error
//      (selfid.ethnicity died as fill_failed on EquipmentShare/American
//      Equity's Greenhouse boards);
//   2. a react-select commit renders the chosen option OUTSIDE the input and
//      clears it, so readBack()'s inputValue() returned '' and the verifier
//      reverted every committed answer;
//   3. the committed option text is longer than the typed candidate ("No" →
//      "No, I do not require sponsorship for employment visa status"), so
//      exact-equality verification failed even when the input kept a value;
//   4. all of it was filed under `value_absent`, which pointed the
//      investigation at the bank instead of the fill layer.
//
// Each test here fails on the pre-fix code. No network: scratch Chrome on a
// throwaway port, fixture on 127.0.0.1.

import test from 'node:test';
import assert from 'node:assert/strict';

import { EventStream } from '../src/events/emitter.js';
import { attach } from '../src/driver/attach.js';
import { startScratchChrome, freePort, findChromeBinary } from '../src/driver/scratch-chrome.js';
import { serveFixtures } from './helpers/serve.js';
import { discover, locate } from '../src/engine/discovery.js';
import { planField } from '../src/engine/mapping.js';
import { applyPlan, verifyMatches } from '../src/engine/fill.js';
import { convertAll } from '../src/bank/convert.js';

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

async function openPage(name) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(site.url(name));
  return { page, close: () => ctx.close() };
}

function newStream() {
  const s = new EventStream({ run: '2026-09-18', applier: 1 });
  s.context({ job_key: JOB, ats: 'greenhouse', tenant: 'greenhouse:boards.greenhouse.io/acme', step: 'application' });
  return s;
}

// The greenhouse adapter's real vocabulary for the two bound questions.
const SPONSOR_BINDING = {
  key: 'auth.sponsorship', control: 'combobox', required: true,
  optionText: { 'none-now-or-future': ['No'], now: ['Yes'], 'future-only': ['Yes'] },
};
const GENDER_BINDING = {
  key: 'selfid.gender', control: 'combobox', required: false,
  optionText: { male: ['Male', 'Man'], female: ['Female', 'Woman'] },
};

test('an all-digit id re-locates by attribute, not by a broken # selector', async (t) => {
  if (skipIfNoChrome(t)) return;
  const { page, close } = await openPage('greenhouse-react-select.html');
  try {
    const d = await discover(page);
    const field = d.fields.find((f) => f.id === '4462546003');
    assert.ok(field, 'the numeric-id control is discovered');
    // Pre-fix: locate() built `#4462546003` and every interaction threw
    // "'#4462546003' is not a valid selector".
    assert.equal(await locate(page, field).count(), 1);
  } finally { await close(); }
});

test('a react-select commit that renders outside the input still verifies', async (t) => {
  if (skipIfNoChrome(t)) return;
  const { page, close } = await openPage('greenhouse-react-select.html');
  try {
    const events = newStream();
    const d = await discover(page);
    const field = d.fields.find((f) => f.id === '4462546003');
    assert.equal(field.control, 'combobox');
    assert.equal((field.options ?? []).length, 0, 'a typeahead renders no options');

    const plan = planField(field, { binding: SPONSOR_BINDING, profile, bank });
    assert.equal(plan.action, 'fill');
    assert.equal(plan.commit, 'enter');
    assert.equal(plan.value, 'No', 'the adapter candidate is what gets typed');

    const res = await applyPlan(page, field, plan, { events, profile });

    // The widget really did commit-and-clear: the value lives in the
    // single-value node, the input is empty.
    assert.equal(await page.locator('[id="4462546003"]').inputValue(), '');
    assert.equal(
      await page.locator('.question:first-child .select__single-value').innerText(),
      'No, I do not require sponsorship for employment visa status');

    // Pre-fix: res.ok === false and a field_skipped{value_absent} — the
    // committed answer was reverted as a mismatch and the miss was blamed on
    // the bank.
    assert.equal(res.ok, true);
    assert.ok(events.events.some((e) => e.type === 'field_filled'
      && e.data.field_key === 'auth.sponsorship'
      && e.data.canonical === 'none-now-or-future'));
  } finally { await close(); }
});

test('F8 holds on the commit path: typing "Male" into a widget that commits "Female" is refused', async (t) => {
  if (skipIfNoChrome(t)) return;
  const { page, close } = await openPage('greenhouse-react-select.html');
  try {
    const events = newStream();
    const d = await discover(page);
    const field = d.fields.find((f) => f.id === '4462546007');
    const plan = planField(field, { binding: GENDER_BINDING, profile, bank });
    assert.equal(plan.value, 'Male');

    const res = await applyPlan(page, field, plan, { events, profile });

    // The fixture's substring filter commits the wrong option, like a real
    // react-select highlight can.
    assert.equal(
      await page.locator('.question:nth-child(2) .select__single-value').innerText(),
      'Female');

    // The verifier must refuse it — word-boundary, never substring — and the
    // reason must name the layer that failed, not the bank.
    assert.equal(res.ok, false);
    const skip = events.events.find((e) => e.type === 'field_skipped');
    assert.equal(skip.data.reason, 'readback_mismatch');
  } finally { await close(); }
});

test('typed-commit verification is the option matcher, not substring or bare equality', () => {
  const base = { action: 'fill', field_key: 'auth.sponsorship', commit: 'enter' };

  // The committed option text is longer than the typed candidate: accepted
  // via word-boundary containment of the candidate.
  assert.equal(verifyMatches(
    { ...base, value: 'No', option_text: 'No', canonical: 'none-now-or-future' },
    'No, I do not require sponsorship for employment visa status'), true);

  // A contradicting commit is refused (F8: "male" never claims "Female").
  assert.equal(verifyMatches(
    { action: 'fill', field_key: 'selfid.gender', commit: 'enter', value: 'Male', option_text: 'Male', canonical: 'male' },
    'Female'), false);

  // "No" does not word-claim an unrelated "no"-adjacent commit.
  assert.equal(verifyMatches(
    { ...base, value: 'No', option_text: 'No', canonical: 'none-now-or-future' },
    'Nokia Careers'), false);

  // A non-enum typeahead (school names): the committed text may decorate the
  // typed value, but must still contain it on word boundaries.
  assert.equal(verifyMatches(
    { action: 'fill', field_key: 'education.school', commit: 'enter', value: 'Carnegie Mellon University' },
    'Carnegie Mellon University (Pittsburgh, PA)'), true);
  assert.equal(verifyMatches(
    { action: 'fill', field_key: 'education.school', commit: 'enter', value: 'Carnegie Mellon University' },
    'Carnegie Mellon Universityville College'), false);

  // WITHOUT commit:'enter', exact loose equality still governs — a plain
  // text field that mangles the value (Workday stripping "23.50" to "2350")
  // is still a mismatch.
  assert.equal(verifyMatches(
    { action: 'fill', field_key: 'comp.expected', value: '23.50' }, '2350'), false);
});
