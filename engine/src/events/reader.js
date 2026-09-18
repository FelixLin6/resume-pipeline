// Reading the stream back: per-applier files, merged on (applier, seq).
// Design: interfaces.md §4.1 (Q3 ruling).
//
// The rule that matters: A TRUNCATED FINAL LINE IS DROPPED AND REPORTED,
// NEVER REPAIRED. A half-written event is an absence of information, and
// inventing its contents — "it was probably an application_ended" — is exactly
// the class of error the typed stream exists to abolish. So the reader
// discards the unparseable tail, counts it, and surfaces it.

import fs from 'node:fs';
import path from 'node:path';
import { validateEvent } from './schema.js';

/**
 * Read one applier's JSONL file.
 * @returns {{events:object[], truncated:null|{bytes:number,line:number}, invalid:object[]}}
 */
export function readApplierFile(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const lines = raw.split('\n');

  // A trailing newline means the last record was fully written.
  const endsClean = raw.endsWith('\n');
  const candidates = endsClean ? lines.slice(0, -1) : lines;

  const events = [];
  const invalid = [];
  let truncated = null;

  candidates.forEach((line, i) => {
    const isLast = i === candidates.length - 1;
    if (!line.length) return;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      if (isLast && !endsClean) {
        // The crash-safe case: the process died mid-write.
        truncated = { bytes: Buffer.byteLength(line), line: i + 1 };
      } else {
        // A corrupt line in the MIDDLE is a different problem — not a crash,
        // so it is reported as invalid rather than as truncation.
        invalid.push({ line: i + 1, reason: 'unparseable json' });
      }
      return;
    }
    try {
      validateEvent(obj);
      events.push(obj);
    } catch (e) {
      invalid.push({ line: i + 1, reason: e.message });
    }
  });

  return { events, truncated, invalid };
}

/**
 * Merge every applier file in a run's events directory.
 *
 * Merge key is the PAIR (applier, seq): globally unique because seq is
 * per-applier monotonic, and stable under re-ordering, so the merge is a sort
 * rather than a reconciliation.
 */
export function mergeRun(eventsDir) {
  const files = fs.existsSync(eventsDir)
    ? fs.readdirSync(eventsDir).filter((f) => /^applier\d+\.jsonl$/.test(f)).sort()
    : [];

  const all = [];
  const casualties = [];
  const invalid = [];

  for (const f of files) {
    const { events, truncated, invalid: bad } = readApplierFile(path.join(eventsDir, f));
    const applier = Number(/applier(\d+)/.exec(f)[1]);
    all.push(...events);
    if (truncated) casualties.push({ applier, file: f, ...truncated });
    for (const b of bad) invalid.push({ applier, file: f, ...b });
  }

  all.sort((a, b) => (a.applier - b.applier) || (a.seq - b.seq));

  // Gap detection: seq is monotonic per applier, so a hole means an event was
  // lost, which is a different and worse condition than a truncated tail.
  const gaps = [];
  const bySeq = new Map();
  for (const e of all) {
    const prev = bySeq.get(e.applier);
    if (prev !== undefined && e.seq !== prev + 1) {
      gaps.push({ applier: e.applier, after: prev, next: e.seq });
    }
    bySeq.set(e.applier, e.seq);
  }

  return { events: all, truncated: casualties, invalid, gaps, files: files.length };
}

/** The ledger's view: one row per application, built from typed events only. */
export function summarize(events) {
  const byJob = new Map();
  for (const e of events) {
    if (e.job_key === '-') continue;
    if (!byJob.has(e.job_key)) {
      byJob.set(e.job_key, {
        job_key: e.job_key, tenant: e.tenant ?? null, ats: e.ats ?? null,
        outcome: null, application_id: null, verified_by: null,
        skipped_required: [], would_require_invention: 0, walls: [],
        tool_calls: null, duration_ms: null,
      });
    }
    const row = byJob.get(e.job_key);
    switch (e.type) {
      case 'application_ended':
        row.outcome = e.data.outcome;
        row.reason = e.data.reason ?? null;
        row.tool_calls = e.data.tool_calls ?? null;
        row.duration_ms = e.data.duration_ms ?? null;
        break;
      case 'submitted':
        row.application_id = e.data.application_id;
        row.verified_by = e.data.verified_by;
        break;
      case 'field_skipped':
        if (e.data.reason === 'would_require_invention') row.would_require_invention++;
        else if (e.data.required) row.skipped_required.push(e.data.field_key ?? e.data.label);
        break;
      case 'wall_detected':
        row.walls.push({ wall_class: e.data.wall_class, where: e.data.where });
        break;
    }
  }
  const rows = [...byJob.values()];
  return {
    rows,
    // Q2: the number that decides whether parking novel essays is costing us
    // applications. It did not exist before the typed stream.
    would_require_invention_total: rows.reduce((n, r) => n + r.would_require_invention, 0),
  };
}
