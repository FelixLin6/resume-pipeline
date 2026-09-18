// Unit tests for the mapping layer: option matching, plan building, and the
// park rules. No browser, no network — these are the rules that decide what a
// form gets told, so they are tested in isolation from how it gets typed.

import test from 'node:test';
import assert from 'node:assert/strict';

import { matchOption, wordBoundaryMatch, normalize, keyForLabel } from '../src/engine/match.js';
import { planField, resolveValue } from '../src/engine/mapping.js';
import { convertAll } from '../src/bank/convert.js';

const { profile, bank } = convertAll();

// ---------------------------------------------------------------- matching --

test('F8: "male" never matches "Female"', () => {
  const m = matchOption('male', ['Female', 'Decline to self-identify']);
  assert.equal(m.matched, false, '"male" must not match anything here');
  assert.equal(wordBoundaryMatch('male', 'Female'), false);
  assert.equal(wordBoundaryMatch('male', 'Male'), true);
});

test('exact normalized equality wins first', () => {
  const m = matchOption('male', ['Female', 'Male', 'Non-Binary']);
  assert.equal(m.matched, true);
  assert.equal(m.option, 'Male');
  assert.equal(m.index, 1);
  assert.equal(m.via, 'exact');
});

test('adapter vocabulary resolves wording the canonical cannot', () => {
  const rendered = ['Yes', 'No, I do not require sponsorship'];
  const bare = matchOption('none-now-or-future', rendered);
  assert.equal(bare.matched, true, 'the default vocabulary covers this common wording');
  assert.equal(bare.option, 'No, I do not require sponsorship');

  const viaAdapter = matchOption('none-now-or-future', rendered, {
    'none-now-or-future': ['No, I do not require sponsorship'],
  });
  assert.equal(viaAdapter.via, 'candidate');
});

test('an AMBIGUOUS word-boundary match is not a match', () => {
  // Two plausible options means the tenant vocabulary is incomplete. A coin
  // flip here is how a form gets a confidently wrong answer.
  const m = matchOption('no', ['No', 'No Preference'], { no: ['No'] });
  assert.equal(m.matched, true, 'exact equality still resolves "No" cleanly');

  const amb = matchOption('remote', ['Fully Remote Option', 'Remote Hybrid Option'], { remote: ['Remote'] });
  assert.equal(amb.matched, false);
  assert.equal(amb.ambiguous, true);
});

test('no match reports the options it actually saw', () => {
  const m = matchOption('ts-sci', ['None', 'Secret', 'Top Secret']);
  assert.equal(m.matched, false);
  assert.deepEqual(m.optionsSeen, ['None', 'Secret', 'Top Secret']);
});

test('normalize folds required markers and punctuation, not meaning', () => {
  assert.equal(normalize('  First Name *  '), 'first name');
  assert.equal(normalize("Bachelor’s Degree"), "bachelor's degree");
  assert.notEqual(normalize('Male'), normalize('Female'));
});

// ------------------------------------------------------------------ labels --

test('label patterns map page wording to canonical keys', () => {
  assert.equal(keyForLabel('First Name*'), 'identity.firstName');
  assert.equal(keyForLabel('Email Address'), 'contact.email');
  assert.equal(keyForLabel('What is your citizenship status?*'), 'auth.workAuthorized');
  assert.equal(keyForLabel('Did you graduate?'), 'education.graduated');
  assert.equal(keyForLabel('Cumulative GPA'), 'education.gpa');
  assert.equal(keyForLabel('Tell us your favourite colour'), null,
    'an unrecognized label must return null, never a nearest guess');
});

// ---------------------------------------------------------------- planning --

const ctx = { profile, bank };

test('an enum field plans a select against the rendered options', () => {
  const field = {
    control: 'select', label: 'What is your citizenship status?*', required: true,
    options: ['', 'U.S. Citizen', 'Permanent Resident', 'Other'],
  };
  const plan = planField(field, {
    ...ctx,
    binding: { key: 'auth.workAuthorized', required: true, optionText: { 'authorized-no-sponsorship': ['U.S. Citizen'] } },
  });
  assert.equal(plan.action, 'select');
  assert.equal(plan.option_text, 'U.S. Citizen');
  assert.equal(plan.canonical, 'authorized-no-sponsorship');
});

test('an unmapped REQUIRED field is a park, not a guess', () => {
  const plan = planField(
    { control: 'text', label: 'Your mother’s maiden name', required: true },
    ctx,
  );
  assert.equal(plan.action, 'skip');
  assert.equal(plan.reason, 'unmapped_required');
});

test('an unmapped OPTIONAL field is skipped quietly', () => {
  const plan = planField({ control: 'text', label: 'Nickname on the team', required: false }, ctx);
  assert.equal(plan.action, 'skip');
  assert.equal(plan.reason, 'unmapped_optional');
});

test('an always-park question parks even when a value exists for its key', () => {
  // "Years of experience with Python" hits the no-durations rule. The rule is
  // about the QUESTION; holding a value would not make answering it honest.
  const plan = planField(
    { control: 'text', label: 'Years of experience with Python*', required: true },
    ctx,
  );
  assert.equal(plan.action, 'skip');
  assert.equal(plan.reason, 'would_require_invention');
});

test('date of birth parks — never on file', () => {
  const plan = planField({ control: 'text', label: 'Date of Birth', required: true }, ctx);
  assert.equal(plan.action, 'skip');
  assert.equal(plan.reason, 'would_require_invention');
});

test('an option the form does not offer is option_not_found, never the closest', () => {
  const field = {
    control: 'select', label: 'Gender', required: true,
    options: ['', 'Female', 'Prefer not to say'],   // no "Male" on offer
  };
  const plan = planField(field, { ...ctx, binding: { key: 'selfid.gender', required: true } });
  assert.equal(plan.action, 'skip');
  assert.equal(plan.reason, 'option_not_found');
  assert.ok(plan.candidates_seen.includes('Female'));
});

test('a canonical slug never reaches a free-text box', () => {
  // "none-now-or-future" is our vocabulary, not English. Without adapter
  // wording for a text control, the honest move is a skip.
  const plan = planField(
    { control: 'text', label: 'Do you require sponsorship?', required: true },
    { ...ctx, binding: { key: 'auth.sponsorship', required: true } },
  );
  assert.equal(plan.action, 'skip');
  assert.equal(plan.reason, 'option_not_found');
});

test('a value genuinely absent from the profile is value_absent', () => {
  const plan = planField(
    { control: 'text', label: 'Preferred Name', required: true },
    { ...ctx, binding: { key: 'identity.preferredName', required: true } },
  );
  assert.equal(plan.action, 'skip');
  assert.equal(plan.reason, 'value_absent');
});

test('resolveValue reads typed facts from the bank and text from the profile', () => {
  assert.deepEqual(resolveValue('selfid.gender', ctx), { kind: 'enum', value: 'male', source: 'profile' });
  const school = resolveValue('education.school', ctx);
  assert.equal(school.kind, 'text');
  assert.equal(school.value, 'Carnegie Mellon University');
});

test('the typed bank refuses a contradiction rather than resolving it', () => {
  // The live profile sets willing_to_travel true AND lists it under "missing".
  assert.equal(bank.facts['misc.willingToTravel'], undefined);
  assert.equal(bank.facts['auth.clearance'], undefined);
  // But the uncontradicted facts are all present.
  assert.equal(bank.facts['selfid.veteran'].value, 'not-a-protected-veteran');
  assert.equal(bank.facts['auth.sponsorship'].value, 'none-now-or-future');
});
