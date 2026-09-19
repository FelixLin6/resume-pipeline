// The iCIMS adapter's contract and its EVIDENCE DISCIPLINE.
//
// The point of the confidence labels is that they are checkable. An adapter
// whose selectors are half-verified and half-guessed, with no way to tell
// which is which, is how a tenant drift becomes a silent wrong fill. So every
// step and every binding must declare where its selector came from.

import test from 'node:test';
import assert from 'node:assert/strict';

import icims from '../src/adapters/icims.js';
import { isFieldKey } from '../src/schema/fieldkeys.js';
import { ENUM_FOR_KEY } from '../src/schema/enums.js';

const CONFIDENCE = ['verified-shadow', 'observed-from-run'];

test('adapter identity and tenant derivation', () => {
  assert.equal(icims.id, 'icims');
  assert.equal(icims.apiVersion, 1);
  assert.equal(
    icims.tenantOf(new URL('https://careers-gdms.icims.com/jobs/74785/x/login')),
    'icims:careers-gdms.icims.com',
  );
  // Every tenant recon actually visited resolves.
  for (const host of ['jobs-cesi', 'careers-decisionpointcorp', 'studentcareers-jhuapl',
    'careers-gdms', 'careers-cotiviti']) {
    assert.equal(
      icims.tenantOf(new URL(`https://${host}.icims.com/jobs/1/login`)),
      `icims:${host}.icims.com`,
    );
  }
});

test('every step declares where its selectors came from', () => {
  for (const s of icims.steps) {
    assert.ok(CONFIDENCE.includes(s.selectorConfidence),
      `step ${s.id} has no usable selectorConfidence (${s.selectorConfidence})`);
  }
  // The steps recon actually reached are the verified ones; everything behind
  // the gate is observed-from-run, because we never entered an email.
  const verified = icims.steps.filter((s) => s.selectorConfidence === 'verified-shadow').map((s) => s.id);
  assert.deepEqual(verified.sort(), ['captcha-gate', 'guest-apply', 'posting']);
});

test('the flow keeps the gate BEFORE the form, and review before submit', () => {
  const ids = icims.steps.map((s) => s.id);
  assert.ok(ids.indexOf('captcha-gate') < ids.indexOf('candidate-profile'),
    'the gate fires before the form loads — an assist slot spent here buys zero fields');
  const review = icims.steps.findIndex((s) => s.isReview);
  const submit = icims.steps.findIndex((s) => s.isSubmit);
  assert.ok(review >= 0 && submit >= 0);
  assert.ok(review < submit, 'the diff gates the click');
});

test('the SECOND captcha gate is modelled — iCIMS double-gates', () => {
  const ids = icims.steps.map((s) => s.id);
  assert.ok(ids.includes('captcha-gate-2'));
  assert.ok(ids.indexOf('candidate-profile') < ids.indexOf('captcha-gate-2'),
    'the second puzzle fires on Submit Profile, after the form is already filled');
});

test('the frame chain is ONE level, as recon verified on 5/5 tenants', async () => {
  const spec = await icims.formRoot();
  assert.deepEqual(spec.frames, ['iframe#icims_content_iframe']);
});

test('hCaptcha markers require VISIBILITY, and the dormant widget is named', () => {
  const cap = icims.quirks.wallMarkers.find((m) => m.wallClass === 'hcaptcha');
  assert.equal(cap.requireVisible, true,
    'presence is not a wall: the widget is on every iCIMS page, challenge or not');
  assert.equal(cap.selector, 'iframe[title="hCaptcha challenge"]');
  // The always-present markers are declared so the engine can assert the
  // distinction rather than rediscover it.
  assert.ok(icims.quirks.dormantCaptchaMarkers.includes('textarea[name="h-captcha-response"]'));
});

test('Q4: maxSubmitAttempts is 1 and raising it would need a cited observation', () => {
  assert.equal(icims.quirks.maxSubmitAttempts, 1);
});

test('dates are Month/Day/Year controls, and no picker may be opened', () => {
  // Corrected from the Phase 1 guess of 'mm/dd/yyyy-text' by the JHU APL
  // prefill screenshots, which show three separate controls.
  assert.equal(icims.quirks.dateStrategy, 'month-day-year-selects');
  assert.equal(icims.quirks.forbidDatePicker, true);
});

test('Q1: this adapter may not create accounts, so it gets no credential', () => {
  assert.equal(icims.accountCreation, false);
  assert.equal(icims.loginSpec, undefined,
    'guest-apply involves no credential; there is nothing to sign in to');
});

test('every binding uses a real FieldKey and declares its confidence', () => {
  for (const step of icims.steps) {
    for (const b of icims.bindings(step.id)) {
      assert.ok(isFieldKey(b.key), `binding key ${b.key} is not in the closed FieldKey set`);
      assert.ok(CONFIDENCE.includes(b.selectorConfidence),
        `binding ${b.key} on ${step.id} has no selectorConfidence`);
      assert.ok(b.selector || b.label, `binding ${b.key} has neither a selector nor a label`);
    }
  }
});

test('every optionText vocabulary maps a REAL canonical value', () => {
  // A vocabulary keyed on a value outside the canonical enum can never match,
  // and would fail silently as an option_not_found forever.
  for (const step of icims.steps) {
    for (const b of icims.bindings(step.id)) {
      const allowed = ENUM_FOR_KEY[b.key];
      if (!b.optionText || !allowed) continue;
      for (const canonical of Object.keys(b.optionText)) {
        assert.ok(allowed.includes(canonical),
          `${b.key}: optionText key "${canonical}" is not in its canonical enum`);
      }
    }
  }
});

test('the guest-apply binding covers the per-tenant consent id variance', () => {
  // Gate 1 fix batch re-keyed this binding: the entry-gate checkbox is what
  // consent.privacy names; the profile answer behind it is unchanged.
  const consent = icims.bindings('guest-apply').find((b) => b.key === 'consent.privacy');
  // Observed live: #accept_gdpr (DecisionPoint, GDMS), #accept_privacy
  // (JHU APL), and ABSENT entirely on CESI and Cotiviti.
  assert.match(consent.selector, /accept_gdpr/);
  assert.match(consent.selector, /accept_privacy/);
  assert.match(consent.selector, /\[id\^="accept_"\]/, 'a prefix fallback for tenants we have not seen');
  assert.equal(consent.required, false, 'two of five tenants render no consent box at all');

  const email = icims.bindings('guest-apply').find((b) => b.key === 'contact.email');
  assert.equal(email.selector, '#email');
  assert.equal(email.required, true,
    'the DOM does not mark it required, but it is — the adapter says so');
});

test('the candidate-profile step expects the fields the parser is known to clobber', () => {
  const step = icims.steps.find((s) => s.id === 'candidate-profile');
  for (const k of ['upload.resume', 'contact.email', 'account.login']) {
    assert.ok(step.expects.includes(k), `expects should include ${k}`);
  }
});
