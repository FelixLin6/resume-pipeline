// The contract every adapter must satisfy, applied to all four at once.
//
// The point of a shared contract test is that a NEW adapter cannot be added
// with half the discipline of the existing ones. Every rule here is a rule some
// recorded failure forced, and each is checked against every adapter rather
// than against the one whose author remembered it.

import test from 'node:test';
import assert from 'node:assert/strict';

import { ADAPTERS, resolveAdapter, BY_ID } from '../src/adapters/registry.js';
import { isFieldKey } from '../src/schema/fieldkeys.js';
import { ENUM_FOR_KEY } from '../src/schema/enums.js';
import { WALL_CLASSES, ATS_IDS } from '../src/events/schema.js';

const CONFIDENCE = ['verified-shadow', 'observed-from-run'];

for (const adapter of ADAPTERS) {
  const d = (name) => `${adapter.id}: ${name}`;

  test(d('declares a known id and the engine\'s api version'), () => {
    assert.ok(ATS_IDS.includes(adapter.id), `${adapter.id} is not in the ATS_IDS enum`);
    assert.equal(adapter.apiVersion, 1);
    assert.equal(typeof adapter.tenantOf, 'function');
  });

  test(d('every step declares where its selectors came from'), () => {
    for (const s of adapter.steps) {
      assert.ok(CONFIDENCE.includes(s.selectorConfidence),
        `step ${s.id} has no usable selectorConfidence (${s.selectorConfidence})`);
      assert.ok(s.markers?.length, `step ${s.id} has no markers, so identifyStep can never find it`);
    }
  });

  test(d('the review step precedes the submit step'), () => {
    const review = adapter.steps.findIndex((s) => s.isReview);
    const submit = adapter.steps.findIndex((s) => s.isSubmit);
    assert.ok(review >= 0, 'no review step: the diff has nothing to gate');
    assert.ok(submit >= 0, 'no submit step');
    assert.ok(review < submit, 'the diff must gate the click, not follow it');
  });

  test(d('Q4: maxSubmitAttempts is 1 unless an observation is cited'), () => {
    // Raising this requires an inline comment citing OBSERVED TENANT
    // IDEMPOTENCY — a specific run where a re-submit was seen to be
    // de-duplicated. "Probably fine" is not a citation, and a double
    // submission is worse than a missed retry in every case in the record.
    assert.equal(adapter.quirks.maxSubmitAttempts, 1);
  });

  test(d('F5: no adapter may open a date picker'), () => {
    assert.equal(adapter.quirks.forbidDatePicker, true);
    assert.ok(adapter.quirks.dateStrategy, 'an adapter must declare how dates are entered');
  });

  test(d('every wall marker names a class in the closed enum'), () => {
    for (const m of adapter.quirks.wallMarkers ?? []) {
      assert.ok(WALL_CLASSES.includes(m.wallClass), `unknown wall class ${m.wallClass}`);
      assert.ok(m.selector || m.text || m.status !== undefined,
        `wall marker for ${m.wallClass} matches on nothing`);
    }
  });

  test(d('a captcha SELECTOR marker requires visibility'), () => {
    // Presence is not a wall. The widget is in the DOM on every load for both
    // iCIMS and Lever, and a presence-keyed marker parks 100% of applications
    // — including the 3-of-4 that sail straight through.
    for (const m of adapter.quirks.wallMarkers ?? []) {
      if (!m.selector) continue;
      if (!/captcha/i.test(m.wallClass)) continue;
      assert.notEqual(m.requireVisible, false,
        `${adapter.id} marker for ${m.wallClass} matches mere presence`);
    }
  });

  test(d('every binding uses a real FieldKey and declares its confidence'), () => {
    for (const step of adapter.steps) {
      for (const b of adapter.bindings(step.id) ?? []) {
        assert.ok(isFieldKey(b.key), `binding key ${b.key} is not in the closed FieldKey set`);
        assert.ok(CONFIDENCE.includes(b.selectorConfidence),
          `binding ${b.key} on ${step.id} has no selectorConfidence`);
        assert.ok(b.selector || b.label,
          `binding ${b.key} on ${step.id} has neither a selector nor a label`);
        assert.ok(b.control, `binding ${b.key} on ${step.id} declares no control type`);
      }
    }
  });

  test(d('every optionText vocabulary maps a REAL canonical value'), () => {
    // A vocabulary keyed on a value outside the canonical enum can never match
    // and would fail silently as option_not_found forever.
    for (const step of adapter.steps) {
      for (const b of adapter.bindings(step.id) ?? []) {
        const allowed = ENUM_FOR_KEY[b.key];
        if (!b.optionText || !allowed) continue;
        for (const canonical of Object.keys(b.optionText)) {
          assert.ok(allowed.includes(canonical),
            `${adapter.id}/${b.key}: optionText key "${canonical}" is not in its canonical enum`);
        }
      }
    }
  });

  test(d('implements every method the engine will call'), () => {
    for (const m of ['formRoot', 'bindings', 'identifyStep', 'advance', 'upload', 'verifyUpload', 'readConfirmation']) {
      assert.equal(typeof adapter[m], 'function', `missing ${m}()`);
    }
  });

  test(d('Q1: only an account-creating adapter may be handed a credential'), () => {
    // `accountCreation` is what decides whether `secrets.forTenant` is attached
    // to the context at all — capability, not convention.
    assert.equal(typeof adapter.accountCreation, 'boolean');
    if (adapter.loginSpec) {
      for (const k of ['at', 'username', 'password', 'submit', 'success']) {
        assert.ok(adapter.loginSpec[k], `loginSpec is missing ${k}`);
      }
    }
  });

  test(d('never names the forbidden autofill control as something to click'), () => {
    // F15: résumé-parse autofill overwrote already-filled contact fields on at
    // least eight tenants, including setting the email to the forbidden CMU
    // address. Any adapter that HAS such a control must list it as forbidden.
    const forbidden = (adapter.quirks.forbiddenControls ?? []).join(' ');
    const src = String(adapter.advance);
    if (/autofill/i.test(forbidden)) {
      assert.equal(/autofill/i.test(src), false,
        `${adapter.id}.advance() references an autofill control it declared forbidden`);
    }
  });
}

// ------------------------------------------------------------- registry ----

test('the registry resolves each ATS from a real URL seen in a ledger', () => {
  const cases = [
    ['https://careers-gdms.icims.com/jobs/74785/x/login', 'icims'],
    ['https://visa.wd5.myworkdayjobs.com/en-US/Visa/job/US---Denver%2C-CO/x_REF088597W-1/apply', 'workday'],
    ['https://jobs.lever.co/kitware/7b6ff8f9-34c6-4338-845d-4e1bbc142906/apply', 'lever'],
    ['https://job-boards.greenhouse.io/covar/jobs/5240360007?gh_src=Simplify', 'greenhouse'],
  ];
  for (const [url, id] of cases) {
    assert.equal(resolveAdapter(url)?.id, id, `${url} should resolve to ${id}`);
  }
});

test('an employer-hosted Greenhouse board resolves by its query hint', () => {
  // Both observed 09-16/09-17: Greenhouse embedded on the employer's own domain.
  assert.equal(resolveAdapter('https://careers.withwaymo.com/jobs/2027-summer-intern?gh_jid=8203200')?.id, 'greenhouse');
  assert.equal(resolveAdapter('https://careers.duolingo.com/jobs/8805925002?gh_jid=8805925002&gh_src=Simplify')?.id, 'greenhouse');
});

test('a hostname match always outranks a path hint', () => {
  // `gh_src=Simplify` is appended by the job source to URLs on EVERY ATS, so a
  // single-pass matcher would let it steal iCIMS and Workday URLs.
  assert.equal(resolveAdapter('https://careers-gdms.icims.com/jobs/74785/x/login?gh_src=Simplify')?.id, 'icims');
  assert.equal(resolveAdapter('https://jabil.wd5.myworkdayjobs.com/en-US/Jabil_Careers/job/x/apply?gh_src=Simplify')?.id, 'workday');
});

test('an unknown ATS resolves to null — the fallback, never a guess', () => {
  assert.equal(resolveAdapter('https://careers.tranetechnologies.com/en/jobs/12345'), null);
  assert.equal(resolveAdapter('https://jobs.jobvite.com/tylertech/job/abc'), null);
});

test('tenant derivation separates what must not share a session', () => {
  // One Workday host serves several career sites with different accounts.
  const wd = BY_ID.workday;
  assert.equal(
    wd.tenantOf(new URL('https://vanguard.wd5.myworkdayjobs.com/en-US/contractors_restricted/job/x')),
    'workday:vanguard.wd5.myworkdayjobs.com/contractors_restricted');
  assert.notEqual(
    wd.tenantOf(new URL('https://vanguard.wd5.myworkdayjobs.com/en-US/External/job/x')),
    wd.tenantOf(new URL('https://vanguard.wd5.myworkdayjobs.com/en-US/contractors_restricted/job/x')));
  // A site path with no locale prefix still resolves (Smith+Nephew's shape).
  assert.equal(
    wd.tenantOf(new URL('https://smithnephew.wd5.myworkdayjobs.com/External/job/x_R92482')),
    'workday:smithnephew.wd5.myworkdayjobs.com/external');

  // Lever and Greenhouse share one hostname across every customer, so the
  // tenant is the path segment.
  assert.equal(BY_ID.lever.tenantOf(new URL('https://jobs.lever.co/kitware/abc/apply')), 'lever:kitware');
  assert.equal(BY_ID.greenhouse.tenantOf(new URL('https://job-boards.greenhouse.io/covar/jobs/1')), 'greenhouse:covar');
  // An embedded board's tenant is the employer host: two employers embedding
  // Greenhouse are two tenants whose wall memory must not be shared.
  assert.equal(BY_ID.greenhouse.tenantOf(new URL('https://careers.withwaymo.com/jobs/x?gh_jid=1')),
    'greenhouse:careers.withwaymo.com');
});
