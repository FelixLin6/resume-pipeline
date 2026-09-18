#!/usr/bin/env node
// SHADOW RUNNER — Gate 1. Drives a real posting to the edge of submit and stops.
//
//   node tools/shadow.js --url <apply-url> --allowlist <file.json> [options]
//
// Gate 1 (architecture.md §9): "The engine runs against ALREADY-SUBMITTED
// postings from a previous day, in a throwaway context, and stops BEFORE
// submit. It emits a full event stream and a review diff. Success = the diff
// matches what the current stack actually filled that day, per-field, for ≥ 3
// postings per ATS. Nothing is submitted; no risk to Felix's standing with any
// tenant."
//
// ---------------------------------------------------------------------------
// THE FOUR HARD STOPS
// ---------------------------------------------------------------------------
// Each is a refusal in code, not a flag a caller may unset. A shadow run that
// could be talked into submitting is not a shadow run.
//
//  1. NEVER SUBMITS. The loop stops when `identifyStep` returns a step whose
//     spec is `isSubmit`, or when the adapter's own advance would click a
//     submit control. `submit()` is not imported by this file, and there is no
//     code path from here to it.
//
//  2. NEVER ENTERS AN EMAIL ON A POSTING THAT IS NOT ON THE ALLOWLIST. An
//     email is how a real application begins — on iCIMS it is the guest-apply
//     gate itself, and entering one creates a candidate record. So the
//     allowlist gates identity fields specifically, and a posting that is not
//     on it runs in PROBE mode: discovery, mapping and the would-fill report,
//     with zero writes.
//
//  3. NEVER CREATES OR USES AN ACCOUNT. The context this runner builds has NO
//     `secrets` at all — not `forTenant`, not `verificationCode`. Workday's
//     `passGate` therefore reports `needs-human` and the run stops at the
//     account gate, which is exactly the pre-gate coverage Gate 1 asks for.
//
//  4. NEVER TOUCHES THE PIPELINE BROWSER. Own scratch Chrome, own randomized
//     free port (9222/9223 refused by `assertScratchPort`, not by convention),
//     own temp profile, killed by pidfile with a cmdline check.
//
// ---------------------------------------------------------------------------
// WHAT IT PRODUCES
// ---------------------------------------------------------------------------
// A per-applier JSONL event stream in exactly the production shape, so the
// metric harness (`tools/metrics-report.js`) reads a shadow run and a real run
// with the same code. That is the point: the budget numbers that fill in the
// "TBD from shadow" rows must be produced by the same accounting that will
// later police them.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { EventStream } from '../src/events/emitter.js';
import { attach, ApplierContexts } from '../src/driver/attach.js';
import { startScratchChrome, freePort, findChromeBinary } from '../src/driver/scratch-chrome.js';
import { resolveAdapter } from '../src/adapters/registry.js';
import { discover, resolveRoot, emitDiscovery } from '../src/engine/discovery.js';
import { planField } from '../src/engine/mapping.js';
import { applyPlan, scanFormForForbidden, ParkRequired } from '../src/engine/fill.js';
import { identifyStep, advanceStep, stepSpec } from '../src/engine/advance.js';
import { diffReview, emitReviewDiff, checkJobFacts } from '../src/engine/review.js';
import { classifyPage } from '../src/engine/preflight.js';
import { probeIpClass } from '../src/engine/ipclass.js';
import { WallMemory } from '../src/engine/walls.js';
import { convertAll } from '../src/bank/convert.js';
import { isIdentityKey } from '../src/schema/fieldkeys.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Fields whose value STARTS an application with a tenant. Gated by the
 *  allowlist even in otherwise-permitted runs. */
const APPLICATION_STARTING_KEYS = new Set(['contact.email', 'account.login', 'account.password']);

export class ShadowRefusal extends Error {}

// ---------------------------------------------------------------------------
// Allowlist
// ---------------------------------------------------------------------------

/**
 * Load the explicit posting allowlist.
 *
 * The file is a JSON array of entries, each `{url, job_key, note?}` or a bare
 * URL string. An entry means: "this exact posting was already applied to by the
 * current stack, so re-driving its form costs the tenant nothing new."
 *
 * Matching is on ORIGIN + PATHNAME, ignoring query. Simplify's tracking
 * parameters (`?gh_src=Simplify`, `?utm_source=Simplify`) vary between the
 * ledger's copy of a URL and the one handed to the runner, and an allowlist
 * that misses because of a tracking parameter would push an operator toward
 * disabling it.
 */
export function loadAllowlist(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const entries = Array.isArray(raw) ? raw : raw.postings ?? [];
  return entries.map((e) => (typeof e === 'string' ? { url: e } : e))
    .filter((e) => e?.url)
    .map((e) => ({ ...e, key: canonicalUrl(e.url) }));
}

export function canonicalUrl(u) {
  const url = u instanceof URL ? u : new URL(String(u));
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`.toLowerCase();
}

export function isAllowlisted(url, allowlist) {
  const key = canonicalUrl(url);
  return allowlist.some((e) => e.key === key);
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/**
 * @param {object} o
 * @param {string} o.url
 * @param {object[]} o.allowlist
 * @param {string} o.jobKey     full uuid (never truncated)
 * @param {object} [o.profile]
 * @param {object} [o.bank]
 * @param {number} [o.maxSteps]
 */
export async function shadowRun({
  url, allowlist, jobKey, profile, bank,
  maxSteps = 12, run = new Date().toISOString().slice(0, 10), applier = 0,
  eventsFile = null, wallsFile = null, ipClass = null, jobFacts = null,
  // Injectable ONLY so the hard stops can be exercised against a local fixture
  // by the test suite. The CLI never passes it, and passing one changes nothing
  // about the refusals below — the allowlist and the submit stop do not consult
  // the adapter.
  adapter = resolveAdapter(url),
}) {
  if (!adapter) {
    throw new ShadowRefusal(
      `no adapter matches ${url}. The shadow runner drives ADAPTERS; an unknown ATS is the ` +
      'model-driven fallback\'s job and is not exercised here.');
  }

  const permitted = isAllowlisted(url, allowlist);
  const tenant = adapter.tenantOf(new URL(url));

  const stream = new EventStream({ run, applier, file: eventsFile });
  stream.context({ job_key: jobKey, tenant, ats: adapter.id });

  const wallMemory = new WallMemory({ file: wallsFile });

  if (!findChromeBinary()) {
    throw new ShadowRefusal('no Chrome for Testing binary in the Playwright cache');
  }

  const port = await freePort();                 // never 9222/9223
  const chrome = await startScratchChrome({ port });
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-shadow-'));
  let browser = null;
  let contexts = null;

  const summary = {
    url, ats: adapter.id, tenant, permitted, steps: [], filled: 0, skipped: 0,
    refused: [], wall: null, stopped_at: null, review: null,
  };

  try {
    ({ browser } = await attach({ port, events: stream }));
    contexts = new ApplierContexts({ browser, events: stream, stateDir });
    const ctx = await contexts.create(applier, { tenant });
    const page = await ctx.newPage();

    stream.emit('application_started', {
      apply_url: url, pdf: null, pdf_sha256: null, attempt: 1, claim: 'none',
      mode: permitted ? 'shadow-fill' : 'shadow-probe',
    });

    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    const status = res?.status() ?? null;
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});

    // Wall path — the droplet's other Gate 1 target.
    const hit = await classifyPage({ page, root: page, status, headers: {}, adapter });
    stream.emit('preflight_result', {
      reachable: true, http_status: status, wall_class: hit?.wallClass ?? null,
      elapsed_ms: 0, context: 'shadow', ip_class: ipClass,
    });
    if (hit) {
      const entry = wallMemory.record(tenant, hit.wallClass, 'preflight');
      const action = wallMemory.decide(tenant, hit.wallClass, 'preflight');
      wallMemory.save();
      stream.emit('wall_detected', {
        wall_class: hit.wallClass, where: 'preflight',
        marker: String(hit.marker).slice(0, 120),
        tenant_prior_walls: entry.occurrences - 1, action,
      });
      summary.wall = { wall_class: hit.wallClass, action };
    }

    // ---- the loop ---------------------------------------------------------
    const filledBefore = new Map();
    let steps = 0;
    let current = null;

    while (steps < maxSteps) {
      steps++;
      const rootSpec = await adapter.formRoot({ url: new URL(page.url()) }, current);
      const root = resolveRoot(page, rootSpec);
      const shim = { page, frame: root, url: new URL(page.url()), jobKey, tenant, log: () => {} };

      current = await identifyStep(adapter, { page, root });
      stream.context({ step: current ?? 'unknown' });
      summary.steps.push(current);

      if (!current) {
        stream.emit('adapter_note', {
          msg: 'identifyStep returned null — in production this hands off to the model-driven fallback; the shadow runner stops here',
          extra: { url: page.url() },
        });
        summary.stopped_at = 'unknown-step';
        break;
      }

      const spec = stepSpec(adapter, current);

      // HARD STOP 1.
      if (spec?.isSubmit) {
        stream.emit('adapter_note', {
          msg: 'HARD STOP: reached the submit step. The shadow runner never submits.',
          extra: { step: current },
        });
        summary.stopped_at = 'submit-step';
        break;
      }

      // HARD STOP 3.
      if (current === 'account-gate' || current === 'guest-apply') {
        // `secrets: {}` — no forTenant, no verificationCode. The adapter cannot
        // obtain a credential even by asking, which is the same capability rule
        // the engine uses (Q1), applied here with the capability withheld from
        // everyone.
        const gate = await adapter.passGate?.({ ...shim, secrets: {} });
        stream.emit('gate_result', { kind: gate?.kind ?? 'none', via: gate?.via ?? null });

        if (!permitted) {
          stream.emit('adapter_note', {
            msg: 'HARD STOP: this gate needs an email and the posting is not on the allowlist',
            extra: { step: current },
          });
          summary.stopped_at = 'gate-not-allowlisted';
          summary.refused.push('gate-email');
          break;
        }

        // An ACCOUNT gate is the end of the road on any posting, allowlisted or
        // not. Signing in needs a credential this runner deliberately does not
        // carry, and creating an account is a real, lasting mutation on a real
        // employer's system — the one thing a shadow run must never leave
        // behind. Note this does not depend on what `passGate` reported: an
        // adapter that answered "passed, via login" is describing what a
        // credentialled engine COULD do, not what this runner may.
        if (current === 'account-gate' || adapter.loginSpec) {
          stream.emit('adapter_note', {
            msg: 'HARD STOP: an account gate needs a credential, and the shadow context carries none',
            extra: { step: current, gate_kind: gate?.kind ?? 'none', unlock: gate?.unlock ?? null },
          });
          summary.stopped_at = 'gate-needs-credential';
          break;
        }

        if (gate?.kind === 'needs-human') {
          stream.emit('adapter_note', {
            msg: 'HARD STOP: the gate reports it needs a human',
            extra: { step: current, unlock: gate.unlock },
          });
          summary.stopped_at = 'gate-needs-human';
          break;
        }
      }

      // ---- discovery ------------------------------------------------------
      const discovered = await discover(root, {
        noiseSelectors: adapter.quirks?.noiseSelectors ?? [],
      });
      emitDiscovery(stream, {
        fields: discovered.fields, rootFrames: rootSpec.frames ?? [], noise: discovered.noise,
      });

      const bindings = adapter.bindings(current) ?? [];

      // ---- plan + (maybe) fill --------------------------------------------
      for (const field of discovered.fields) {
        const binding = bindings.find((b) => (b.selector && matchesSelector(field, b.selector))
          || (b.label && b.label.test(field.label ?? '')));
        const plan = planField(field, { binding, profile, bank });

        if (plan.action === 'skip') {
          summary.skipped++;
          stream.emit('field_skipped', {
            field_key: plan.field_key, label: field.label, required: !!plan.required,
            reason: plan.reason,
            ...(plan.candidates_seen ? { candidates_seen: plan.candidates_seen.slice(0, 10) } : {}),
          });
          continue;
        }

        if (plan.action === 'upload') {
          // Shadow never attaches a file: an upload is a real mutation on a
          // real tenant, and on several ATSes it triggers the résumé parser
          // that F15 is about.
          stream.emit('adapter_note', {
            msg: 'shadow: upload target identified but NOT attached',
            extra: { field_key: plan.field_key },
          });
          continue;
        }

        stream.emit('field_mapped', {
          field_key: plan.field_key,
          control: field.control,
          canonical: plan.canonical ?? null,
          option_text: plan.option_text ?? null,
          match: plan.match ?? null,
          source: plan.source ?? null,
          required: !!plan.required,
        });

        // HARD STOP 2. In probe mode NOTHING is written — the mapping is the
        // deliverable, and an application-starting key (an email, a login) is
        // the specific thing that must never reach a tenant we were not told
        // we had already applied to.
        if (!permitted) {
          summary.refused.push(
            APPLICATION_STARTING_KEYS.has(plan.field_key)
              ? `${plan.field_key} (application-starting)`
              : plan.field_key,
          );
          continue;
        }

        try {
          const r = await applyPlan(root, field, plan, {
            events: stream, profile,
            dateStrategy: adapter.quirks?.dateStrategy,
          });
          if (r.ok) {
            summary.filled++;
            filledBefore.set(plan.field_key, String(r.actual));
          }
        } catch (e) {
          if (e instanceof ParkRequired) {
            stream.emit('adapter_note', { msg: `park: ${e.reason}`, extra: { field_key: plan.field_key } });
            summary.stopped_at = `park:${e.reason}`;
          } else throw e;
        }
      }

      // F16: the whole-form forbidden scan runs whether or not we wrote.
      const hits = await scanFormForForbidden(discovered, profile);
      for (const h of hits) {
        stream.emit('field_skipped', {
          field_key: null, label: String(h.field ?? '').slice(0, 80), required: false,
          reason: 'forbidden_value', detail: h.why,
        });
      }

      // ---- the review diff -------------------------------------------------
      if (spec?.isReview && adapter.readReview) {
        const rendered = await adapter.readReview(shim);
        const intended = [...filledBefore.entries()].map(([field_key, intendedValue]) => ({
          field_key, intended: intendedValue,
        }));
        const diff = diffReview(intended, rendered);
        for (const extra of checkJobFacts({ rendered, jobFacts })) diff.mismatches.push(extra);
        if (diff.mismatches.some((m) => m.severity === 'fail')) diff.verdict = 'fail';
        emitReviewDiff(stream, diff);
        summary.review = { checked: diff.checked, matched: diff.matched, verdict: diff.verdict };

        stream.emit('adapter_note', {
          msg: 'HARD STOP: review diff produced. The shadow runner stops here, before submit.',
          extra: { verdict: diff.verdict },
        });
        summary.stopped_at = 'after-review-diff';
        break;
      }

      if (!permitted) {
        stream.emit('adapter_note', {
          msg: 'HARD STOP: probe mode does not advance — advancing a real form is a mutation',
          extra: { step: current },
        });
        summary.stopped_at = 'probe-no-advance';
        break;
      }

      const adv = await advanceStep(adapter, shim, current, { events: stream, page, root });
      if (adv.blockedBy?.length) {
        summary.stopped_at = 'blocked';
        break;
      }
      if (adv.to === current) { summary.stopped_at = 'no-progress'; break; }
    }

    stream.emit('application_ended', {
      outcome: 'assist',
      reason: `shadow run stopped at: ${summary.stopped_at ?? 'max-steps'}`,
      unlock: null,
      duration_ms: 0,
      tool_calls: stream.seq,
      model_turns: 0,
    });
  } finally {
    if (contexts) await contexts.close(applier).catch(() => {});
    if (browser) await browser.close().catch(() => {});
    chrome.stop();
    fs.rmSync(stateDir, { recursive: true, force: true });
    stream.close();
  }

  return { summary, events: stream.events };
}

/** Cheap structural match of a discovered field against a binding selector.
 *  Deliberately conservative: an id or name selector resolves, anything more
 *  exotic does not, and a binding that does not resolve here simply falls
 *  through to label matching rather than binding the wrong control. */
export function matchesSelector(field, selector) {
  for (const part of String(selector).split(',').map((s) => s.trim())) {
    const id = /^#([\w-]+)$/.exec(part);
    if (id && field.id === id[1]) return true;
    const name = /\[name=["']?([^"'\]]+)["']?\]/.exec(part);
    if (name && field.name === name[1]) return true;
    const auto = /\[data-automation-id=["']?([^"'\]]+)["']?\]/.exec(part);
    if (auto && field.automationId === auto[1]) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) out[a.slice(2)] = (argv[i + 1]?.startsWith('--') ?? true) ? true : argv[++i];
  }
  return out;
}

async function main(argv) {
  const args = parseArgs(argv);
  if (!args.url || !args.allowlist) {
    console.error('usage: node tools/shadow.js --url <apply-url> --allowlist <file.json> ' +
      '[--job-key <uuid>] [--out <events.jsonl>] [--walls <walls.json>] [--no-ip-probe]');
    process.exit(2);
  }

  const allowlist = loadAllowlist(args.allowlist);
  const { profile, bank } = convertAll();

  // C5: one probe per RUN, and offline is not an error.
  const ip = args['no-ip-probe'] ? { ip_class: null } : await probeIpClass({ run: new Date().toISOString().slice(0, 10) });

  const jobKey = args['job-key'] ?? '00000000-0000-4000-8000-000000000000';

  const { summary } = await shadowRun({
    url: args.url,
    allowlist,
    jobKey,
    profile,
    bank,
    eventsFile: args.out ?? path.join(HERE, '..', 'state', 'shadow', `applier0.jsonl`),
    wallsFile: args.walls ?? path.join(HERE, '..', 'state', 'walls.json'),
    ipClass: ip.ip_class,
  });

  console.log(JSON.stringify(summary, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).catch((e) => { console.error(e); process.exit(1); });
}
