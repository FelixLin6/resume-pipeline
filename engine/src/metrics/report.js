// Markdown report over one run's event stream.
//
// Audience: Felix reading a day, and whoever is deciding whether an ATS may
// graduate a cutover gate. It therefore leads with the two things that can stop
// a graduation — Gate 2 violations and stream casualties — and only then talks
// about cost.
//
// The report never says "clean" on a stream it has not checked, and it prints
// `TBD from shadow` rather than a made-up budget (C7).

import { analyze, BUDGETS } from './harness.js';

const n = (v) => (v === null || v === undefined ? '—' : String(v));
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');
const shortKey = (k) => `${k.slice(0, 8)}…`;   // display only; the stream keeps the full uuid

export function renderMarkdown(analysis) {
  const { meta, rows, byAts, gate2, totals } = analysis;
  const out = [];

  out.push(`# Apply-engine metrics — ${meta.run ?? 'unknown run'}`);
  out.push('');
  out.push(`Generated ${meta.generated ?? new Date().toISOString()} from ${n(meta.files)} applier ` +
    `file(s), ${n(meta.events)} event(s).`);
  out.push('');

  // ---- Gate 2 first -------------------------------------------------------
  out.push('## Gate 2 — submit gate');
  out.push('');
  if (gate2.violations.length === 0) {
    out.push(`No violations. ${gate2.submits} submit(s) across ${gate2.jobs} application(s); each was ` +
      'preceded by a fresh, passing review diff, and no application was submitted twice.');
  } else {
    out.push(`**${gate2.violations.length} VIOLATION(S) — this run is not clean and no ATS may ` +
      'graduate on it.**');
    out.push('');
    out.push('| job | kind | seq | reason |');
    out.push('|---|---|---|---|');
    for (const v of gate2.violations) {
      out.push(`| \`${shortKey(v.job_key)}\` | ${v.kind} | ${v.at_seq} | ${v.reason} |`);
    }
  }
  out.push('');

  // ---- stream health ------------------------------------------------------
  if (meta.truncated?.length || meta.gaps?.length || meta.invalid?.length) {
    out.push('## Stream health');
    out.push('');
    for (const t of meta.truncated ?? []) {
      out.push(`- applier ${t.applier}: truncated final line (${t.bytes} bytes) — **dropped, not repaired**.`);
    }
    for (const g of meta.gaps ?? []) {
      out.push(`- applier ${g.applier}: seq gap after ${g.after} (next ${g.next}) — an event was LOST, ` +
        'which is worse than a truncated tail.');
    }
    for (const i of meta.invalid ?? []) {
      out.push(`- applier ${i.applier} line ${i.line}: ${i.reason}`);
    }
    out.push('');
  }

  // ---- per-ATS ------------------------------------------------------------
  out.push('## Per-ATS');
  out.push('');
  out.push('`tool_calls` = seq delta minus heartbeats (heartbeats are engine liveness, not work). ' +
    '`actions` = weighted browser round trips.');
  out.push('');
  out.push('| ATS | apps | budget | p50 | p90 | max | actions p50 | model turns | verdict |');
  out.push('|---|---:|---:|---:|---:|---:|---:|---:|---|');
  for (const a of byAts) {
    out.push(`| ${a.ats} | ${a.n} | ${a.budget === null ? '_TBD from shadow_' : a.budget} | ` +
      `${n(a.stats.p50)} | ${n(a.stats.p90)} | ${n(a.stats.max)} | ${n(a.action_stats.p50)} | ` +
      `${a.model_turns} | ${a.verdict} |`);
  }
  out.push('');

  for (const a of byAts) {
    if (!a.over_budget.length) continue;
    out.push(`**${a.ats} over budget (${a.budget}):** ` +
      a.over_budget.map((o) => `\`${shortKey(o.job_key)}\` ${o.tool_calls} (+${o.over})`).join(', '));
    out.push('');
    out.push('Per architecture.md §8 an overrun never abandons a live application — it is reported ' +
      'so the adapter gets fixed.');
    out.push('');
  }

  // ---- per-application ----------------------------------------------------
  out.push('## Per-application');
  out.push('');
  out.push('| job | ATS | outcome | calls | actions | fills | req. skipped | invent-parks | walls | review |');
  out.push('|---|---|---|---:|---:|---:|---:|---:|---|---|');
  for (const r of [...rows].sort((x, y) => y.tool_calls - x.tool_calls)) {
    out.push(`| \`${shortKey(r.job_key)}\` | ${n(r.ats)} | ${r.complete ? n(r.outcome) : '**incomplete**'} | ` +
      `${r.tool_calls} | ${r.browser_actions} | ${r.fields_filled} | ${r.skipped_required} | ` +
      `${r.would_require_invention} | ${r.walls.map((w) => w.wall_class).join(',') || '—'} | ` +
      `${n(r.review_verdict)} |`);
  }
  out.push('');

  const disagreements = rows.filter((r) => r.tool_call_disagreement);
  if (disagreements.length) {
    out.push('### Self-reported vs measured');
    out.push('');
    out.push('The engine recorded a `tool_calls` on `application_ended` that the stream does not bear out. ' +
      'The stream is the one with an audit trail.');
    out.push('');
    for (const r of disagreements) {
      out.push(`- \`${shortKey(r.job_key)}\`: reported ${r.tool_call_disagreement.reported}, ` +
        `measured ${r.tool_call_disagreement.measured}`);
    }
    out.push('');
  }

  // ---- totals -------------------------------------------------------------
  out.push('## Totals');
  out.push('');
  out.push(`- applications: **${totals.applications}** (${totals.incomplete} incomplete)`);
  out.push(`- submitted: **${totals.submitted}** (${pct(totals.submitted, totals.applications)})`);
  out.push(`- tool calls: **${totals.tool_calls}**, model turns: **${totals.model_turns}**`);
  out.push(`- walls: **${totals.walls}**`);
  out.push(`- \`would_require_invention\` parks: **${totals.would_require_invention}** — Q2's number: ` +
    'what the never-invent rule costs us, measured rather than feared.');
  out.push('');

  // ---- the honest caveat --------------------------------------------------
  out.push('## Reading this');
  out.push('');
  out.push('- Only the **iCIMS** budget is a measured target (~470 today vs <40 claimed, architecture.md §8). ' +
    'Every other row is `TBD from shadow` and is filled in from Gate 1 data by editing `BUDGETS` in ' +
    '`src/metrics/harness.js`, citing the run that produced the number.');
  out.push('- **Per-field review-diff ground truth for iCIMS must come from Mac-side runs.** The droplet has ' +
    'three submitted iCIMS rows ever, and the ledgers\' `filled:` lines are prose, not per-field values — ' +
    'so a shadow diff run there can prove the engine READS a form correctly but cannot prove it would have ' +
    'filled it the same way the current stack did.');
  out.push('- An `incomplete` row is an application whose engine died before `application_ended`. Its cost is ' +
    'a floor, not a total.');
  out.push('');

  return out.join('\n');
}

/** Convenience: analyze + render in one call. */
export function report(events, { meta = {}, budgets = BUDGETS } = {}) {
  return renderMarkdown(analyze(events, { meta, budgets }));
}
