// Per-adapter evidence: the specific findings each adapter exists to encode.
//
// The contract test (adapter-contract.test.js) checks that every adapter is
// disciplined. This one checks that each adapter actually knows the thing its
// ATS bit us with — and, for the three traps that can be reproduced locally,
// drives a real browser at a fixture to prove the encoding works rather than
// merely reads right.

import test from 'node:test';
import assert from 'node:assert/strict';

import { attach } from '../src/driver/attach.js';
import { startScratchChrome, freePort, findChromeBinary } from '../src/driver/scratch-chrome.js';
import { serveFixtures } from './helpers/serve.js';
import { discover } from '../src/engine/discovery.js';
import { planField } from '../src/engine/mapping.js';
import { EventStream } from '../src/events/emitter.js';
import { convertAll } from '../src/bank/convert.js';

import workday from '../src/adapters/workday.js';
import greenhouse from '../src/adapters/greenhouse.js';
import lever from '../src/adapters/lever.js';
import { parseProgressBar, parseRail, WORKDAY_STEP_TITLES } from '../src/adapters/workday-steps.js';

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

async function open(name) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(site.url(name));
  return { page, close: () => ctx.close() };
}

// =========================================================== WORKDAY ========

test('workday: the step rail parses, including the "N of M" sub-part', () => {
  // Both strings captured live on 2026-09-17.
  const a = parseProgressBar('current step 1 of 8 Create Account/Sign In');
  assert.deepEqual([a.index, a.total, a.stepId], [1, 8, 'account-gate']);

  const b = parseProgressBar('step 4 of 8 Application Questions 1 of 2');
  assert.equal(b.stepId, 'application-questions');
  assert.equal(b.index, 4, 'the FIRST "N of M" is the rail position');
  assert.equal(b.part, 1, 'the SECOND is the sub-part, and confusing them loses the flow');
  assert.equal(b.parts, 2);

  const c = parseProgressBar('step 4 of 7 Application Questions');
  assert.equal(c.part, null, 'Jabil does not split its questions');
  assert.equal(parseProgressBar(''), null);
  assert.equal(parseProgressBar('not a rail entry'), null);
});

test('workday: a tenant-variable rail is read, never assumed', () => {
  // Avis (8) and Jabil (7), verbatim. Smith+Nephew's 5-node rail with no Self
  // Identify is the third shape on record — an adapter with a fixed graph
  // mis-identifies the step on two of the three.
  const avis = parseRail([
    'current step 1 of 8 Create Account/Sign In', 'step 2 of 8 My Information',
    'step 3 of 8 My Experience', 'step 4 of 8 Application Questions 1 of 2',
    'step 5 of 8 Application Questions 2 of 2', 'step 6 of 8 Voluntary Disclosures',
    'step 7 of 8 Self Identify', 'step 8 of 8 Review',
  ]);
  assert.equal(avis.total, 8);
  assert.equal(avis.consistent, true);
  assert.equal(avis.hasSelfIdentify, true);
  assert.equal(avis.questionPages, 2);

  const jabil = parseRail([
    'current step 1 of 7 Create Account/Sign In', 'step 2 of 7 My Information',
    'step 3 of 7 My Experience', 'step 4 of 7 Application Questions',
    'step 5 of 7 Voluntary Disclosures', 'step 6 of 7 Self Identify', 'step 7 of 7 Review',
  ]);
  assert.equal(jabil.total, 7);
  assert.equal(jabil.questionPages, 1);

  const smithNephew = parseRail([
    'current step 1 of 5 My Information', 'step 2 of 5 My Experience',
    'step 3 of 5 Application Questions', 'step 4 of 5 Voluntary Disclosures',
    'step 5 of 5 Review',
  ]);
  assert.equal(smithNephew.hasSelfIdentify, false, 'a missing optional step is data, not an error');

  // A rail caught mid-render disagrees with itself; the caller must re-read
  // rather than act on it.
  assert.equal(parseRail(['step 1 of 8 My Information', 'step 2 of 7 My Experience']).consistent, false);
  assert.equal(WORKDAY_STEP_TITLES.length, 7);
});

test('workday: the step graph matches the rail order', () => {
  const ids = workday.steps.map((s) => s.id);
  const order = ['account-gate', 'my-information', 'my-experience', 'application-questions',
    'voluntary-disclosures', 'self-identify', 'review', 'submit'];
  let last = -1;
  for (const id of order) {
    const i = ids.indexOf(id);
    assert.ok(i > last, `${id} is out of rail order`);
    last = i;
  }
  assert.ok(ids.indexOf('chooser') < ids.indexOf('account-gate'),
    'the chooser precedes the gate: "on the next page, you will be required to create an account"');
  assert.equal(workday.steps.find((s) => s.id === 'self-identify').optional, true);
});

test('workday: Q1 — the only adapter permitted to create accounts, declaratively', () => {
  assert.equal(workday.accountCreation, true);
  assert.ok(workday.loginSpec, 'sign-in is declarative: the credential never enters adapter code');
  assert.equal(workday.loginSpec.username, '[data-automation-id="email"]');
  assert.equal(workday.loginSpec.password, '[data-automation-id="password"]');
  // Jabil renders social buttons and NO email field until this is pressed.
  assert.equal(workday.loginSpec.revealForm, '[data-automation-id="SignInWithEmailButton"]');
  // Every other adapter must be false, or the engine would hand it a credential.
  assert.equal(greenhouse.accountCreation, false);
  assert.equal(lever.accountCreation, false);
  assert.equal(greenhouse.loginSpec, undefined);
  assert.equal(lever.loginSpec, undefined);
});

test('workday: the chooser NEVER autofills from the résumé', () => {
  const c = workday.quirks.chooser;
  assert.deepEqual(c.prefer, ['useMyLastApplication', 'applyManually']);
  assert.ok(c.never.includes('autofillWithResume'), 'F15 has a button on it');
  assert.equal(c.reuseForcesFullReverify, true);
  // 09-16 Live Oak: "Use My Last Application" carried over the SIBLING
  // POSTING'S résumé, and five Application Questions plus the whole Voluntary
  // Disclosures block silently reset to blank.
  assert.equal(c.reuseForcesResumeReupload, true);
  assert.ok(workday.quirks.forbiddenControls.some((s) => /autofillWithResume/.test(s)));
});

test('workday: F5 — three spinbuttons, and the known validation bug is recorded', () => {
  assert.equal(workday.quirks.dateStrategy, 'three-spinbuttons');
  const date = workday.bindings('self-identify').find((b) => b.key === 'selfid.date');
  assert.ok(date.dateParts.month && date.dateParts.day && date.dateParts.year,
    'three bound controls, one fill each — not twelve per-digit presses');
  // Visa 09-17: the value read back correct while "Date is required" persisted
  // across ~8 attempts. More fills were never the answer.
  assert.match(date.knownBug.remedy, /hard-reload/);
});

test('workday: the Jabil empty-picklist blocker is modelled as a bounded probe', () => {
  const p = workday.quirks.picklist;
  assert.ok(p.emptyMarker.test('No Items.'));
  assert.ok(p.emptyMarker.test('No Items'));
  // Bounded: four probes, then park. The 09-16 attempt tried "", "a", "En",
  // "Linux", "Python" and concluded the tenant's list was empty.
  assert.ok(p.probes.length <= 5 && p.probes.length >= 3);
  // The keyboard sequence that DID work on the sibling hierarchical picklist,
  // where react-virtualized renders zero-height rows that mouse clicks miss.
  assert.deepEqual(p.keyboardCommit, ['ArrowDown', 'ArrowRight', 'ArrowDown', 'Enter']);
});

test('workday: the field-of-study fallbacks are in profile order', () => {
  const fos = workday.bindings('my-experience').find((b) => b.key === 'education.fieldOfStudy');
  const list = fos.optionText['artificial-intelligence'];
  // Disney's typeahead resolved to "Artificial Intelligence and Robotics";
  // Visa's picklist had neither and fell back to "Computer Science".
  assert.equal(list[0], 'Artificial Intelligence and Robotics');
  assert.equal(list.at(-1), 'Computer Science');
});

test('workday: THE HONEYPOT is declared noise and is never discovered', async (t) => {
  if (skipIfNoChrome(t)) return;
  const { page, close } = await open('workday-honeypot.html');
  try {
    // Without the noise rule, generic label discovery maps "…website…" to
    // links.website and fills it with Felix's real site — announcing to the
    // tenant that a bot is driving.
    const naive = await discover(page);
    const bee = naive.fields.find((f) => f.name === 'website');
    assert.ok(bee, 'the honeypot IS visible and IS discoverable: that is the trap');

    const guarded = await discover(page, { noiseSelectors: workday.quirks.noiseSelectors });
    assert.equal(guarded.fields.find((f) => f.name === 'website'), undefined,
      'beecatcher must never reach the mapper');
    assert.equal(guarded.noise.some((f) => f.automationId === 'beecatcher'), true,
      'suppressed, not hidden: the discovery event reports the count');

    // And the real fields are untouched.
    assert.ok(guarded.fields.some((f) => f.automationId === 'email'));
    assert.ok(guarded.fields.some((f) => f.automationId === 'password'));
  } finally { await close(); }
});

// ======================================================== GREENHOUSE ========

test('greenhouse: the react-select proxy would park every application', async (t) => {
  if (skipIfNoChrome(t)) return;
  const { page, close } = await open('greenhouse-noise.html');
  try {
    const naive = await discover(page);
    const proxies = naive.fields.filter((f) => /requiredInput/.test(f.tag === 'input' ? (f.id ?? '') : '')
      || (f.required && !f.label));
    assert.ok(proxies.length >= 3,
      'the fixture reproduces the live shape: label-less required inputs shadowing each combobox');

    // Each one maps to no FieldKey and is required -> unmapped_required -> park.
    for (const p of proxies) {
      const plan = planField(p, { binding: null, profile, bank });
      assert.equal(plan.action, 'skip');
      assert.equal(plan.reason, 'unmapped_required',
        'this is how a perfectly fillable Greenhouse form becomes an unfillable one');
    }

    const guarded = await discover(page, { noiseSelectors: greenhouse.quirks.noiseSelectors });
    const stillRequired = guarded.fields.filter((f) => f.required && !f.label);
    assert.equal(stillRequired.length, 0, 'no label-less required control survives the noise filter');
    assert.equal(guarded.noise.length >= 3, true);
    // The real fields are all still there.
    for (const id of ['first_name', 'last_name', 'email', 'gender', 'veteran_status', 'disability_status']) {
      assert.ok(guarded.fields.some((f) => f.id === id), `${id} must survive`);
    }
  } finally { await close(); }
});

test('greenhouse: the reCAPTCHA badge is on every page and is not a wall', () => {
  const marker = greenhouse.quirks.wallMarkers.find((m) => m.wallClass === 'recaptcha-interactive');
  assert.equal(marker.requireVisible, true);
  assert.match(marker.selector, /challenge/i, 'only the challenge popup counts, never the anchor');
  assert.ok(greenhouse.quirks.dormantCaptchaMarkers.some((s) => /anchor/.test(s)),
    'the always-present anchor is named so the distinction is asserted, not rediscovered');
});

test('greenhouse: uploads go to the file input, never the Attach button', () => {
  const resume = greenhouse.bindings('apply-form').find((b) => b.key === 'upload.resume');
  assert.equal(resume.selector, '#resume');
  // F19: the fill script's upload silently failed on five forms in one day and
  // every one was redone by hand through the direct input.
  assert.ok(greenhouse.quirks.forbiddenControls.some((s) => /Autofill my application/.test(s)));
  assert.ok(greenhouse.quirks.forbiddenControls.some((s) => /Dropbox/.test(s)));
});

test('greenhouse: the post-submit verification-code step is modelled', () => {
  // Observed on 7 rows across two days. On those tenants the application is NOT
  // filed until the code is entered, so a stream that stops at `submitted`
  // before this step has recorded a submission that did not happen.
  const step = greenhouse.steps.find((s) => s.id === 'verify-code');
  assert.ok(step);
  assert.equal(step.optional, true);
  const ids = greenhouse.steps.map((s) => s.id);
  assert.ok(ids.indexOf('submit') < ids.indexOf('verify-code'));
  assert.ok(ids.indexOf('verify-code') < ids.indexOf('confirmation'));
});

test('greenhouse: the two demographic blocks have different vocabularies', () => {
  // EQT 09-17 rendered BOTH: a "U.S. Standard Demographic" block offering only
  // regional sub-categories (no plain "Asian") and a "Voluntary
  // Self-Identification" block that did offer "Asian".
  const race = greenhouse.bindings('apply-form').find((b) => b.key === 'selfid.ethnicity');
  assert.ok(race.label, 'bound by label, because the id differs per board');
  assert.ok(race.optionText.asian.includes('Asian'));
  assert.ok(race.optionText.asian.includes('East Asian'));
});

// ============================================================== LEVER =======

test('lever: the submit control and its captcha wrappers are declared', () => {
  const sc = lever.quirks.submitControl;
  assert.equal(sc.selector, '#btn-submit');
  assert.equal(sc.captchaResponse, '#hcaptchaResponseInput');
  assert.ok(sc.captchaWrappers.some((s) => /enclave/.test(s)),
    'the full-viewport enclave iframe is what ate the click on 2026-09-17');
  assert.ok(sc.captchaWrappers.length >= 3);
});

test('lever: presence is not a wall, and the dormant widget is named', () => {
  const cap = lever.quirks.wallMarkers.filter((m) => m.wallClass === 'hcaptcha');
  assert.ok(cap.length >= 1);
  for (const m of cap) assert.equal(m.requireVisible, true);
  assert.ok(lever.quirks.dormantCaptchaMarkers.includes('#hcaptchaResponseInput'));
});

test('lever: eleven pronoun checkboxes are left alone, deliberately', async (t) => {
  if (skipIfNoChrome(t)) return;
  // None is required, none maps to a FieldKey, and the profile records pronouns
  // as a single string. Guessing which of eleven boxes means what is exactly
  // the invention the bank forbids — so they are declared noise and skipped
  // deliberately rather than reported as eleven unmapped fields.
  assert.ok(lever.quirks.noiseSelectors.includes('input[name="pronouns"]'));
  assert.ok(lever.quirks.noiseSelectors.includes('#customPronounsTextField'));
});

test('lever: the location typeahead commits to a HIDDEN field', () => {
  const loc = lever.bindings('apply-form').find((b) => b.key === 'loc.currentLocation');
  assert.equal(loc.selector, '#location-input');
  // Filling the visible box without committing a suggestion leaves
  // #selected-location empty — the classic "the form looked filled" failure.
  assert.equal(loc.commitsTo, '#selected-location');
  assert.equal(lever.quirks.typeaheadNeedsEnter, true);
});

test('lever: full name is ONE field, and current company stays optional', () => {
  const name = lever.bindings('apply-form').find((b) => b.key === 'identity.fullName');
  assert.equal(name.selector, 'input[name="name"]');
  assert.equal(name.required, true);
  // F15: Rippling's parser invented a "current company". A student with no
  // current employer must not have one supplied.
  const org = lever.bindings('apply-form').find((b) => b.key === 'work.employer');
  assert.equal(org.required, false);
});

test('lever: the EEO vocabulary is the tenant\'s own long-form wording', () => {
  const race = lever.bindings('apply-form').find((b) => b.key === 'selfid.ethnicity');
  assert.equal(race.control, 'radio', 'radios, not a select — verified live');
  assert.equal(race.optionText.asian[0], 'Asian (Not Hispanic or Latino)');
  const vet = lever.bindings('apply-form').find((b) => b.key === 'selfid.veteran');
  assert.equal(vet.optionText['not-a-protected-veteran'][0], 'I am not a protected veteran');
});

test('lever: the signature block only exists once a disability answer is chosen', () => {
  const sig = lever.bindings('apply-form').find((b) => b.key === 'selfid.signature');
  assert.equal(sig.revealedBy, '#disabilitySelectElement',
    'the engine must re-discover after the select, not bind once at page load');
});

test('lever: a real office choice is recognized but never guessed', () => {
  const loc = lever.bindings('apply-form').find((b) => b.key === 'loc.arrangement');
  assert.equal(loc.selector, 'select[name="opportunityLocationId"]');
  assert.equal(loc.required, false);
  assert.ok(loc.unmappable, 'declared so the control is recognized and then honestly skipped');
});
