// The efficiency metric. Design: architecture.md §8 (budgets), C7.
//
// This is the consumer that did not exist before the typed stream. The current
// stack CANNOT COUNT ITS OWN TOOL CALLS — the ~470-call iCIMS figure in §8 was
// reconstructed by hand from one posting's transcript, which is why every other
// row in that table says "TBD from shadow" rather than pretending to a number.
// `seq` exists in the envelope precisely so this file can be written.
//
// Three accounting numbers per application, deliberately kept separate rather
// than merged into one headline:
//
//   seq_span        the raw envelope delta, application_started -> ended. This
//                   is §8's literal definition.
//   tool_calls      seq_span minus heartbeats. A heartbeat is engine liveness
//                   (Q7: one per 10 events), not work — leaving them in would
//                   inflate every application by ~10% and would make the budget
//                   a measure of how long we spent rather than what we did.
//                   THIS is the number compared against the budget.
//   browser_actions a weighted estimate of actual browser round trips, from the
//                   table below. This is the diagnostic number: it says where
//                   the calls went, which is what an adapter author needs.
//
// Publishing all three is the honest move. They disagree, and the shape of the
// disagreement is itself information — an application whose seq_span is far
// above its browser_actions spent its budget on computation (mapping, skips),
// and one where they converge spent it on the browser.

import { auditStream } from '../engine/gate2.js';

/**
 * Per-ATS soft budgets, per application.
 *
 * C7: only iCIMS carries a line-item target, because it is the only row with a
 * measured baseline on BOTH sides (~470 today, <40 claimed). The others are
 * null — not because a number could not be invented, but because publishing an
 * estimate in the same typography as a measurement is how a target nobody
 * measured becomes a target nobody can be held to. They are filled in from
 * Gate 1 shadow data, by editing this table, with the run that produced the
 * number cited.
 */
export const BUDGETS = Object.freeze({
  icims: 40,
  workday: null,      // TBD from shadow — nothing behind the account gate measured yet
  // Filled in from Gate 1 shadow data (Mac, 2026-09-17, RESULTS.md), per the
  // process this table prescribes: measured p50/p90 for GREENHOUSE was 32/49
  // over 5 runs and for LEVER 23/73 over 4, all reaching the review page. The
  // budget is set at the measured p90, rounded — a soft per-application
  // ceiling the P50 clears comfortably, tripped only by an outlier worth
  // reading. CAVEAT carried from the run report: these runs cover the
  // automatable subset of each form (essays and unmatched controls sit in the
  // skipped columns), so the numbers are honest costs for reaching review,
  // not for a complete application.
  greenhouse: 50,
  lever: 75,
  ashby: null,        // TBD from shadow
  fallback: null,     // model-driven; measured, never budgeted
});

/**
 * MEASURED data points, kept apart from BUDGETS on purpose: a measurement is
 * a fact with a source; a budget is a policy. Each row cites the run that
 * produced it.
 */
export const MEASURED = Object.freeze({
  icims: {
    // Droplet, 2026-09-17 (Gate 1 negative-fixture report): pre-gate only —
    // nothing behind the email gate is reachable from that egress.
    pregate_probe_calls: 6,
    pregate_fill_calls: 11,
    source: 'droplet shadow 2026-09-17; Mac p50 8 covers the same pre-gate stall (D3) and is NOT a full-application cost',
  },
  greenhouse: { p50: 32, p90: 49, n: 5, source: 'Mac shadow 2026-09-17 (RESULTS.md), runs reached review' },
  lever: { p50: 23, p90: 73, n: 4, source: 'Mac shadow 2026-09-17 (RESULTS.md), runs reached review' },
});

/**
 * How many browser round trips each event type implies.
 *
 * Explicit and auditable rather than "count the events": a `field_mapped` costs
 * nothing (it is computation over options already read), while a `field_filled`
 * costs two (the write plus the mandatory read-back — a fill that is not read
 * back is not a fill). Anyone who disagrees with a weight can see it and argue
 * with it, which is not true of a number baked into a reducer.
 */
export const ACTION_WEIGHTS = Object.freeze({
  preflight_result: 1,     // one goto in a throwaway context
  field_discovered: 1,     // ONE evaluateAll over the whole control set
  field_mapped: 0,         // pure computation
  field_skipped: 0,        // pure computation
  field_filled: 2,         // the write + the read-back
  upload_attempted: 1,     // setInputFiles
  upload_verified: 1,      // the adapter's read-back
  page_advanced: 2,        // the click + the wait/re-identify
  gate_result: 1,
  wall_detected: 1,
  review_diff: 1,          // the readReview scrape (see scope note below)
  evidence_captured: 1,    // a screenshot
  submitted: 2,            // the click + the confirmation read
  application_started: 0,
  application_ended: 0,
  adapter_note: 0,
  driver_event: 0,
  heartbeat: 0,
});

/** A barrier diff rides on a discovery pass that is already counted as
 *  `field_discovered`, so counting it again would double-charge the barrier. */
function weightFor(e) {
  if (e.type === 'review_diff' && e.data?.scope === 'post_upload_reverify') return 0;
  return ACTION_WEIGHTS[e.type] ?? 0;
}

const PERCENTILE = (sorted, p) => {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, i)];
};

/**
 * Per-application accounting over a merged stream.
 *
 * @param {object[]} events  merged, sorted (applier, seq)
 * @returns {object[]} one row per job_key
 */
export function perApplication(events) {
  const byJob = new Map();

  for (const e of events) {
    if (e.job_key === '-') continue;
    if (!byJob.has(e.job_key)) {
      byJob.set(e.job_key, {
        job_key: e.job_key, ats: e.ats ?? null, tenant: e.tenant ?? null,
        applier: e.applier, events: [],
      });
    }
    const row = byJob.get(e.job_key);
    row.events.push(e);
    // The envelope's ats/tenant are stamped from ambient context, which is set
    // after the first event on some paths; last non-null wins.
    if (e.ats) row.ats = e.ats;
    if (e.tenant) row.tenant = e.tenant;
  }

  return [...byJob.values()].map((row) => {
    const evs = row.events;
    const byType = {};
    let browser_actions = 0;
    let heartbeats = 0;

    for (const e of evs) {
      byType[e.type] = (byType[e.type] ?? 0) + 1;
      browser_actions += weightFor(e);
      if (e.type === 'heartbeat') heartbeats++;
    }

    const started = evs.find((e) => e.type === 'application_started') ?? evs[0];
    const ended = [...evs].reverse().find((e) => e.type === 'application_ended') ?? evs.at(-1);
    const submittedEv = evs.find((e) => e.type === 'submitted');
    const seq_span = ended.seq - started.seq;

    const reported = ended.type === 'application_ended' ? ended.data.tool_calls ?? null : null;
    const tool_calls = seq_span - heartbeats;

    const steps = [];
    for (const e of evs) {
      if (e.step && steps.at(-1) !== e.step) steps.push(e.step);
    }

    return {
      job_key: row.job_key,
      ats: row.ats,
      tenant: row.tenant,
      applier: row.applier,
      outcome: ended.type === 'application_ended' ? ended.data.outcome : null,
      reason: ended.type === 'application_ended' ? ended.data.reason ?? null : null,
      // An application with no application_ended is INCOMPLETE, not zero-cost:
      // the engine died, and the row must say so rather than quietly reporting
      // whatever the last event happened to be.
      complete: ended.type === 'application_ended',
      seq_start: started.seq,
      seq_end: ended.seq,
      seq_span,
      heartbeats,
      tool_calls,
      browser_actions,
      model_turns: ended.type === 'application_ended' ? ended.data.model_turns ?? 0 : null,
      reported_tool_calls: reported,
      // A disagreement between what the engine SAID it spent and what the
      // stream SHOWS it spent means one of the two is wrong, and the stream is
      // the one with an audit trail.
      tool_call_disagreement: reported !== null && reported !== tool_calls
        ? { reported, measured: tool_calls } : null,
      duration_ms: ended.type === 'application_ended' ? ended.data.duration_ms ?? null : null,
      steps,
      counts: byType,
      fields_filled: byType.field_filled ?? 0,
      skipped_required: evs.filter((e) => e.type === 'field_skipped' && e.data.required
        && e.data.reason !== 'would_require_invention').length,
      would_require_invention: evs.filter((e) => e.type === 'field_skipped'
        && e.data.reason === 'would_require_invention').length,
      walls: evs.filter((e) => e.type === 'wall_detected')
        .map((e) => ({ wall_class: e.data.wall_class, where: e.data.where, action: e.data.action ?? null })),
      submitted: !!submittedEv,
      verified_by: submittedEv?.data?.verified_by ?? null,
      review_verdict: [...evs].reverse()
        .find((e) => e.type === 'review_diff' && (e.data.scope ?? 'review') === 'review')?.data.verdict ?? null,
      // Mac finding D5: whether this run got anywhere. A run that parked at
      // the first gate having filled two fields is not evidence about the
      // budget — six such iCIMS runs read "within budget" while performing
      // 2 of ~40 fields across 1 of 6 steps. Budget verdicts are computed
      // over rows that actually reached a review diff (or submitted).
      reached_review: evs.some((e) => e.type === 'review_diff'
        && (e.data.scope ?? 'review') === 'review') || !!submittedEv,
      suspect: ended.type === 'application_ended' && ended.data.outcome === 'suspect',
    };
  });
}

/** Aggregate rows by ATS, against the budget table. */
export function aggregateByAts(rows, budgets = BUDGETS) {
  const out = new Map();

  for (const r of rows) {
    const ats = r.ats ?? 'unknown';
    if (!out.has(ats)) {
      out.set(ats, {
        ats, n: 0, budget: budgets[ats] ?? null, tool_calls: [], browser_actions: [],
        model_turns: 0, submitted: 0, walls: 0, over_budget: [],
        outcomes: {}, would_require_invention: 0, incomplete: 0,
        reached_review: 0, suspects: 0,
      });
    }
    const a = out.get(ats);
    a.n++;
    a.tool_calls.push(r.tool_calls);
    a.browser_actions.push(r.browser_actions);
    a.model_turns += r.model_turns ?? 0;
    a.would_require_invention += r.would_require_invention;
    if (r.submitted) a.submitted++;
    if (!r.complete) a.incomplete++;
    if (r.reached_review) a.reached_review = (a.reached_review ?? 0) + 1;
    if (r.suspect) a.suspects = (a.suspects ?? 0) + 1;
    a.walls += r.walls.length;
    a.outcomes[r.outcome ?? 'incomplete'] = (a.outcomes[r.outcome ?? 'incomplete'] ?? 0) + 1;
    // D5: only a run that reached review can be over OR under budget in any
    // meaningful sense.
    if (a.budget !== null && r.reached_review && r.tool_calls > a.budget) {
      a.over_budget.push({ job_key: r.job_key, tool_calls: r.tool_calls, over: r.tool_calls - a.budget });
    }
  }

  for (const a of out.values()) {
    const s = [...a.tool_calls].sort((x, y) => x - y);
    a.stats = {
      min: s[0] ?? null,
      p50: PERCENTILE(s, 50),
      p90: PERCENTILE(s, 90),
      max: s.at(-1) ?? null,
      mean: s.length ? Math.round((s.reduce((n, v) => n + v, 0) / s.length) * 10) / 10 : null,
    };
    const b = [...a.browser_actions].sort((x, y) => x - y);
    a.action_stats = { p50: PERCENTILE(b, 50), max: b.at(-1) ?? null };
    // The status a human reads first. D5's rule: a budget verdict earned by
    // doing nothing must not read like a real one — six iCIMS runs that
    // parked at the first gate with two fields filled previously reported
    // "within budget", which was true and meaningless. A row with no
    // review-reaching runs says so instead of claiming a pass.
    const eligible = a.reached_review ?? 0;
    a.verdict = a.budget === null ? 'TBD from shadow'
      : eligible === 0 ? `not measurable — 0/${a.n} runs reached review`
        : a.over_budget.length ? `OVER on ${a.over_budget.length}/${eligible}`
          : `within budget (${eligible}/${a.n} reached review)`;
  }

  return [...out.values()].sort((x, y) => y.n - x.n);
}

/**
 * The whole metric pass over one merged stream.
 *
 * Gate 2 is run here, not bolted on by the caller: a report that describes a
 * day without checking whether that day submitted anything past a failing
 * review diff would be exactly the kind of clean-looking artifact the gate
 * exists to prevent.
 */
export function analyze(events, { budgets = BUDGETS, meta = {} } = {}) {
  const rows = perApplication(events);
  const byAts = aggregateByAts(rows, budgets);
  const gate2 = auditStream(events);

  return {
    meta,
    rows,
    byAts,
    gate2,
    totals: {
      applications: rows.length,
      submitted: rows.filter((r) => r.submitted).length,
      incomplete: rows.filter((r) => !r.complete).length,
      tool_calls: rows.reduce((n, r) => n + r.tool_calls, 0),
      model_turns: rows.reduce((n, r) => n + (r.model_turns ?? 0), 0),
      // Q2: the number that decides whether parking novel essays costs us
      // applications. It did not exist before the typed stream.
      would_require_invention: rows.reduce((n, r) => n + r.would_require_invention, 0),
      walls: rows.reduce((n, r) => n + r.walls.length, 0),
    },
  };
}
