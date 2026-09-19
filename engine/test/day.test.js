// Droplet Gate 1 artefact finding: day keys must be PIPELINE days, not UTC
// days. The cesi acceptance run at ~19:00 PT on 09-18 was stamped
// run:2026-09-19 — a different day bucket from the PT-keyed ledger, day
// folders and hub claim record it belongs with.

import test from 'node:test';
import assert from 'node:assert/strict';

import { pipelineDay, PIPELINE_TZ } from '../src/util/day.js';
import { WallMemory } from '../src/engine/walls.js';

// The exact incident instant: 2026-09-19T02:30Z is 19:30 PDT on the 18th.
const EVENING = new Date('2026-09-19T02:30:00Z');

test('an evening-PT instant is the PT day, not the UTC day', () => {
  assert.equal(PIPELINE_TZ, 'America/Los_Angeles');
  assert.equal(pipelineDay(EVENING), '2026-09-18',
    'a 19:30 PT run must land in the 09-18 bucket its ledger lives in');
  // And the shape stays a bare date key, zero-padded.
  assert.match(pipelineDay(new Date('2026-03-05T12:00:00Z')), /^\d{4}-\d{2}-\d{2}$/);
});

test('wall memory stamps first_seen/last_seen with the pipeline day', () => {
  const mem = new WallMemory({ now: () => EVENING });
  const e = mem.record('icims:jobs-cesi.icims.com', 'hcaptcha', 'advance:guest-apply');
  assert.equal(e.first_seen, '2026-09-18');
  assert.equal(e.last_seen, '2026-09-18');
});

test('decay arithmetic compares pipeline days with pipeline days', () => {
  const mem = new WallMemory({ now: () => EVENING });
  const e = mem.record('t', 'hcaptcha', 'w');
  // Same PT evening: a wall recorded minutes ago is 0 days old — the UTC-day
  // now-side made this 1 and started the 14-day decay clock half a day early.
  assert.equal(mem.ageDays(e), 0);
  assert.equal(mem.effectiveOccurrences('t', 'hcaptcha', 'w'), 1);
});
