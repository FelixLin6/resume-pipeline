// The shadow runner's refusals.
//
// Gate 1 runs the engine against ALREADY-SUBMITTED postings and stops before
// submit. Everything that makes that safe is a refusal in code, so every
// refusal is tested — including end to end against a local fixture, because a
// hard stop that has only been read is not a hard stop.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { findChromeBinary } from '../src/driver/scratch-chrome.js';
import { serveFixtures } from './helpers/serve.js';
import {
  shadowRun, loadAllowlist, canonicalUrl, isAllowlisted, matchesSelector, ShadowRefusal,
} from '../tools/shadow.js';
import { convertAll } from '../src/bank/convert.js';
import greenhouse from '../src/adapters/greenhouse.js';

const JOB = '8f2c1a94-6d3e-4b77-9a10-2f5c8e1b4d90';
const { profile, bank } = convertAll();

let site;
test.before(async () => { site = await serveFixtures(); });
test.after(async () => { if (site) await site.close(); });

const skipIfNoChrome = (t) => {
  if (!findChromeBinary()) { t.skip('no Chrome for Testing binary in the Playwright cache'); return true; }
  return false;
};

function allowlistFile(urls) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-allow-'));
  const file = path.join(dir, 'allowlist.json');
  fs.writeFileSync(file, JSON.stringify(urls, null, 2));
  return { file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// ------------------------------------------------------------ allowlist ----

test('the allowlist ignores tracking parameters', () => {
  // The ledger's copy of a URL and the one handed to the runner differ by
  // Simplify's tracking parameters. An allowlist that missed because of
  // `?gh_src=Simplify` would push an operator toward disabling it.
  const a = 'https://job-boards.greenhouse.io/covar/jobs/5240360007?gh_src=Simplify';
  const b = 'https://job-boards.greenhouse.io/covar/jobs/5240360007';
  assert.equal(canonicalUrl(a), canonicalUrl(b));
  assert.equal(canonicalUrl('https://x.com/a/b/'), canonicalUrl('https://x.com/a/b'));
  // It does NOT ignore the path: a different posting is a different posting.
  assert.notEqual(canonicalUrl(b), canonicalUrl('https://job-boards.greenhouse.io/covar/jobs/999'));
});

test('the allowlist accepts bare strings and objects', () => {
  const { file, cleanup } = allowlistFile([
    'https://job-boards.greenhouse.io/covar/jobs/5240360007?gh_src=Simplify',
    { url: 'https://jobs.lever.co/kitware/abc/apply', job_key: JOB, note: 'submitted 09-17' },
  ]);
  const list = loadAllowlist(file);
  assert.equal(list.length, 2);
  assert.ok(isAllowlisted('https://job-boards.greenhouse.io/covar/jobs/5240360007', list));
  assert.ok(isAllowlisted('https://jobs.lever.co/kitware/abc/apply?x=1', list));
  assert.equal(isAllowlisted('https://job-boards.greenhouse.io/other/jobs/1', list), false);
  cleanup();
});

test('matchesSelector resolves ids, names and automation ids — and nothing exotic', () => {
  assert.equal(matchesSelector({ id: 'first_name' }, '#first_name'), true);
  assert.equal(matchesSelector({ name: 'email' }, 'input[name="email"]'), true);
  assert.equal(matchesSelector({ automationId: 'email' }, '[data-automation-id="email"]'), true);
  assert.equal(matchesSelector({ id: 'a' }, '#b, #a'), true, 'selector lists resolve');
  // A binding that does not resolve here falls through to label matching rather
  // than binding the wrong control.
  assert.equal(matchesSelector({ id: 'x' }, 'button:has-text("Submit")'), false);
  assert.equal(matchesSelector({ id: 'x' }, 'input[class*="requiredInput"]'), false);
});

// ------------------------------------------------------------- refusals ----

test('an unknown ATS is refused, never driven by the nearest adapter', async () => {
  await assert.rejects(
    () => shadowRun({
      url: 'https://careers.tranetechnologies.com/en/jobs/12345',
      allowlist: [], jobKey: JOB, profile, bank,
    }),
    (e) => {
      assert.ok(e instanceof ShadowRefusal);
      assert.match(e.message, /no adapter matches/);
      return true;
    });
});

test('PROBE MODE: a posting that is not on the allowlist gets zero writes', async (t) => {
  if (skipIfNoChrome(t)) return;
  const url = site.url('greenhouse-noise.html');

  const { summary, events } = await shadowRun({
    url, allowlist: [], jobKey: JOB, profile, bank, adapter: greenhouse,
  });

  assert.equal(summary.permitted, false);
  assert.equal(summary.filled, 0, 'probe mode writes NOTHING');
  assert.equal(events.some((e) => e.type === 'field_filled'), false);

  // The mapping is still the deliverable: we learn what the engine WOULD do.
  assert.ok(events.some((e) => e.type === 'field_mapped'));
  assert.ok(events.some((e) => e.type === 'field_discovered'));

  // And the email refusal is explicit and named.
  assert.ok(summary.refused.some((r) => /contact\.email \(application-starting\)/.test(r)),
    `expected an application-starting refusal, got ${JSON.stringify(summary.refused)}`);
});

test('HARD STOP: the shadow runner never reaches a submit, and says so', async (t) => {
  if (skipIfNoChrome(t)) return;
  const url = site.url('greenhouse-noise.html');
  const { file, cleanup } = allowlistFile([url]);

  const { summary, events } = await shadowRun({
    url, allowlist: loadAllowlist(file), jobKey: JOB, profile, bank, adapter: greenhouse,
  });

  assert.equal(summary.permitted, true);
  assert.ok(summary.filled > 0, 'an allowlisted posting IS filled');
  assert.equal(summary.stopped_at, 'after-review-diff');

  // The two events that must never exist in a shadow stream.
  assert.equal(events.some((e) => e.type === 'submitted'), false);
  assert.equal(events.some((e) => e.type === 'application_ended' && e.data.outcome === 'submitted'), false);

  // The review diff — Gate 1's actual deliverable — IS produced.
  const rd = events.find((e) => e.type === 'review_diff');
  assert.ok(rd, 'Gate 1 succeeds or fails on this diff');
  assert.ok(summary.review);

  const stop = events.find((e) => e.type === 'adapter_note' && /HARD STOP/.test(e.data.msg));
  assert.ok(stop, 'the stop must be in the stream, not only in the return value');

  const ended = events.find((e) => e.type === 'application_ended');
  assert.equal(ended.data.outcome, 'assist');
  cleanup();
});

test('the shadow stream is production-shaped, so the metric harness reads it', async (t) => {
  if (skipIfNoChrome(t)) return;
  const url = site.url('greenhouse-noise.html');
  const { file, cleanup } = allowlistFile([url]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-shadow-out-'));
  const eventsFile = path.join(dir, 'events', 'applier0.jsonl');

  await shadowRun({
    url, allowlist: loadAllowlist(file), jobKey: JOB, profile, bank,
    adapter: greenhouse, eventsFile,
  });

  // The whole point of emitting the production shape: the budget numbers that
  // fill in the "TBD from shadow" rows are produced by the same accounting that
  // will later police them.
  const { buildReport } = await import('../tools/metrics-report.js');
  const { analysis, markdown } = buildReport(path.join(dir, 'events'));
  assert.equal(analysis.totals.applications, 1);
  assert.equal(analysis.totals.submitted, 0);
  assert.equal(analysis.gate2.violations.length, 0, 'a run that never submits cannot violate Gate 2');
  assert.match(markdown, /greenhouse/);

  fs.rmSync(dir, { recursive: true, force: true });
  cleanup();
});

test('the runner refuses an account gate it has no credential for', async (t) => {
  if (skipIfNoChrome(t)) return;
  // The shadow context carries NO secrets — not forTenant, not
  // verificationCode — so Workday's gate is the end of the road by
  // construction rather than by policy.
  const url = site.url('workday-honeypot.html');
  const workday = (await import('../src/adapters/workday.js')).default;
  const { file, cleanup } = allowlistFile([url]);

  const { summary, events } = await shadowRun({
    url, allowlist: loadAllowlist(file), jobKey: JOB, profile, bank, adapter: workday,
  });

  assert.equal(summary.steps[0], 'account-gate');
  assert.match(summary.stopped_at, /gate-needs-credential|gate-not-allowlisted/);
  assert.equal(events.some((e) => e.type === 'field_filled'), false,
    'nothing is typed into a sign-in form');
  cleanup();
});

test('the honeypot is never filled, even on an allowlisted posting', async (t) => {
  if (skipIfNoChrome(t)) return;
  const url = site.url('workday-honeypot.html');
  const workday = (await import('../src/adapters/workday.js')).default;
  const { file, cleanup } = allowlistFile([url]);

  const { events } = await shadowRun({
    url, allowlist: loadAllowlist(file), jobKey: JOB, profile, bank, adapter: workday,
  });

  const touchedWebsite = events.some((e) => (e.type === 'field_filled' || e.type === 'field_mapped')
    && e.data.field_key === 'links.website');
  assert.equal(touchedWebsite, false,
    'beecatcher must never be mapped: filling it announces a bot to the tenant');
  cleanup();
});
