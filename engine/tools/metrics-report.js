#!/usr/bin/env node
// Render the metric report for a run.
//
//   node tools/metrics-report.js <events-dir|file.jsonl> [--out report.md]
//
// <events-dir> is a run's `events/` directory holding applier<i>.jsonl files;
// they are merged on (applier, seq), a truncated final line is dropped and
// REPORTED, and the report leads with Gate 2 (interfaces.md §4.1, §5.6).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { mergeRun, readApplierFile } from '../src/events/reader.js';
import { analyze } from '../src/metrics/harness.js';
import { renderMarkdown } from '../src/metrics/report.js';

export function loadStream(target) {
  const stat = fs.statSync(target);
  if (stat.isDirectory()) {
    const m = mergeRun(target);
    return {
      events: m.events,
      meta: { files: m.files, truncated: m.truncated, invalid: m.invalid, gaps: m.gaps },
    };
  }
  const r = readApplierFile(target);
  return {
    events: r.events,
    meta: {
      files: 1,
      truncated: r.truncated ? [{ applier: r.events[0]?.applier ?? 0, ...r.truncated }] : [],
      invalid: r.invalid, gaps: [],
    },
  };
}

export function buildReport(target, { run = null } = {}) {
  const { events, meta } = loadStream(target);
  const full = {
    ...meta,
    run: run ?? events[0]?.run ?? path.basename(path.dirname(path.resolve(target))),
    events: events.length,
    generated: new Date().toISOString(),
  };
  const analysis = analyze(events, { meta: full });
  return { analysis, markdown: renderMarkdown(analysis) };
}

function main(argv) {
  const target = argv[0];
  if (!target) {
    console.error('usage: node tools/metrics-report.js <events-dir|file.jsonl> [--out report.md]');
    process.exit(2);
  }
  const outIdx = argv.indexOf('--out');
  const { analysis, markdown } = buildReport(target);

  if (outIdx >= 0 && argv[outIdx + 1]) {
    fs.mkdirSync(path.dirname(path.resolve(argv[outIdx + 1])), { recursive: true });
    fs.writeFileSync(argv[outIdx + 1], markdown + '\n');
    console.error(`wrote ${argv[outIdx + 1]}`);
  } else {
    console.log(markdown);
  }

  // A Gate 2 violation is not a report detail — it is an exit code, so a
  // supervising script cannot treat a violating run as a successful one.
  if (analysis.gate2.violations.length) {
    console.error(`GATE 2: ${analysis.gate2.violations.length} violation(s)`);
    process.exit(3);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2));
}
