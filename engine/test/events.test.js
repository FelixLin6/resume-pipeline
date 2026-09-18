// The Q5 masking rules, the Q1 redaction, the Q7 heartbeat, and the Q3 reader.
// These are the guards that decide what ends up committed to a public repo,
// so each one is tested against the shape of the failure it prevents.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { EventStream } from '../src/events/emitter.js';
import { EventValidationError, validateEvent } from '../src/events/schema.js';
import { readApplierFile, mergeRun, summarize } from '../src/events/reader.js';
import { fillEventData, sha256 } from '../src/engine/fill.js';

const JOB = '8f2c1a94-6d3e-4b77-9a10-2f5c8e1b4d90';
const JOB_B = 'b41d77e0-1c02-4a3f-8e55-90ab3c7d6f21';

const mk = (o = {}) => {
  const s = new EventStream({ run: '2026-09-17', applier: 1, ...o });
  s.context({ job_key: JOB, ats: 'icims', tenant: 'icims:careers-acme.icims.com' });
  return s;
};

// -------------------------------------------------------------- Q5 guards --

test('Q5: an email address can never enter the stream', () => {
  const s = mk();
  assert.throws(() => s.emit('adapter_note', { msg: 'set login to felixl@andrew.cmu.edu' }),
    EventValidationError);
  // Not even as evidence that we REFUSED it: field_skipped names the reason.
  assert.doesNotThrow(() => s.emit('field_skipped', {
    field_key: 'contact.email', required: true, reason: 'forbidden_value',
    detail: 'CMU address: no IMAP access',
  }));
});

test('Q5: a phone-shaped value can never enter the stream', () => {
  const s = mk();
  assert.throws(() => s.emit('adapter_note', { msg: 'phone (949) 981-0389 accepted' }),
    EventValidationError);
  assert.throws(() => s.emit('adapter_note', { msg: 'dialed 9499810389' }), EventValidationError);
});

test('Q5: the PII sweep does not fire on hashes or URLs', () => {
  const s = mk();
  // A sha256 digest is full of long digit runs; a URL carries millisecond
  // timestamps. Neither is a phone number, and a guard that cried wolf here
  // would be turned off.
  assert.doesNotThrow(() => s.emit('field_filled', {
    field_key: 'education.school',
    value_hash: 'sha256:1234567890123456789012345678901234567890123456789012345678901234',
    value_preview: 'Carnegie Mel', value_len: 25, strategy: 'fill',
  }));
  assert.doesNotThrow(() => s.emit('application_started', {
    apply_url: 'https://careers-gov2x.icims.com/jobs/62843/login?_sp=x.1789597165217&jan1offset=-480',
    attempt: 1, claim: 'offline',
  }));
});

test('Q5: identity fields carry a hash and NO preview', () => {
  const d = fillEventData({ field_key: 'contact.phone' }, '(949) 981-0389', { strategy: 'fill' });
  assert.equal(d.value_preview, null, 'a masked phone number is still a phone number');
  assert.equal(d.value_len, 14);
  assert.ok(d.value_hash.startsWith('sha256:'));
  assert.equal(JSON.stringify(d).includes('949'), false);
});

test('Q5: free text is previewed at 12 chars plus a length', () => {
  const d = fillEventData({ field_key: 'education.school' }, 'Carnegie Mellon University', { strategy: 'fill' });
  assert.equal(d.value_preview, 'Carnegie Mel');
  assert.equal(d.value_preview.length, 12);
  assert.equal(d.value_len, 26);
});

test('Q5: prose is recorded by identity, never as rendered text', () => {
  const d = fillEventData(
    { field_key: 'prose.a-a', answer_id: 'A-a', variant: 180, slots: { team: 'Autonomy' } },
    'I build infrastructure for AI agents: this summer at OpenMax I shipped six…',
    { strategy: 'fill' },
  );
  assert.equal(d.answer_id, 'A-a');
  assert.equal(d.variant, 180);
  assert.deepEqual(d.slots, { team: 'Autonomy' });
  assert.equal(d.value_preview, undefined, 'the essay text must not be in the stream');
  assert.ok(d.value_hash);
});

test('a credential key is still structurally refused (F22)', () => {
  const s = mk();
  assert.throws(() => s.emit('adapter_note', { msg: 'made account', extra: { password: 'hunter2' } }),
    EventValidationError);
});

// ----------------------------------------------------------- Q1 redaction --

test('Q1: secret VALUES are redacted by value-match before emit', () => {
  const s = mk();
  // The 2026-09-17 leak had exactly this shape: a password in prose, not in a
  // field called "password". The key guard cannot see it; this can.
  s.registerSecret('Tr0ub4dor&3');
  const ev = s.emit('adapter_note', { msg: 'created the account with Tr0ub4dor&3 as the password' });
  assert.equal(ev.data.msg.includes('Tr0ub4dor&3'), false);
  assert.match(ev.data.msg, /\[redacted:secret\]/);
});

test('Q1: redaction reaches nested structures', () => {
  const s = mk();
  s.registerSecret('sup3rsecret');
  const ev = s.emit('adapter_note', { msg: 'ok', extra: { steps: ['typed sup3rsecret', 'clicked next'] } });
  assert.equal(JSON.stringify(ev).includes('sup3rsecret'), false);
});

// ----------------------------------------------------------- Q7 heartbeat --

test('Q7: a heartbeat lands every 10 events', () => {
  const s = mk();
  for (let i = 0; i < 9; i++) s.emit('field_filled', { field_key: 'education.school', value_hash: sha256(i), strategy: 'fill' });
  assert.equal(s.events.filter((e) => e.type === 'heartbeat').length, 0);
  s.emit('field_filled', { field_key: 'education.school', value_hash: sha256('x'), strategy: 'fill' });
  const beats = s.events.filter((e) => e.type === 'heartbeat');
  assert.equal(beats.length, 1, 'ten fills is a heartbeat — not only page transitions');
  assert.equal(beats[0].data.last_event_type, 'field_filled');
});

test('Q7: a heartbeat lands after 5 minutes even with few events', () => {
  let t = 1_000_000;
  const s = mk({ now: () => t });
  s.emit('adapter_note', { msg: 'slow page' });
  t += 5 * 60 * 1000 + 1;
  s.emit('adapter_note', { msg: 'still here' });
  assert.equal(s.events.filter((e) => e.type === 'heartbeat').length, 1);
});

// ------------------------------------------------- Q3 reader / truncation --

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'engine-reader-')); }

test('Q3: a truncated final line is DROPPED and REPORTED, never repaired', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'applier1.jsonl');
  const s = new EventStream({ run: '2026-09-17', applier: 1, file });
  s.context({ job_key: JOB, ats: 'icims' });
  s.emit('application_started', { apply_url: 'https://x/jobs/1/login', attempt: 1, claim: 'offline' });
  s.emit('field_discovered', { count: 12, required: 5 });
  s.close();
  // The crash: a half-written record with no trailing newline.
  const tail = '{"v":1,"ts":"2026-09-17T20:14:03.221Z","seq":2,"ru';
  fs.appendFileSync(file, tail);

  const { events, truncated, invalid } = readApplierFile(file);
  assert.equal(events.length, 2, 'the valid prefix survives');
  assert.ok(truncated, 'the casualty is reported');
  assert.equal(truncated.bytes, Buffer.byteLength(tail));
  assert.deepEqual(invalid, [], 'a crash tail is not an "invalid" record');
  // And crucially: nothing invented a type for it.
  assert.equal(events.some((e) => e.seq === 2), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Q3: a corrupt line in the MIDDLE is invalid, not truncation', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'applier1.jsonl');
  const s = new EventStream({ run: '2026-09-17', applier: 1, file });
  s.context({ job_key: JOB });
  s.emit('adapter_note', { msg: 'one' });
  s.close();
  fs.appendFileSync(file, 'NOT JSON\n');
  fs.appendFileSync(file, JSON.stringify({
    v: 1, ts: new Date().toISOString(), seq: 2, run: '2026-09-17', applier: 1,
    job_key: JOB, type: 'adapter_note', data: { msg: 'three' },
  }) + '\n');

  const { events, truncated, invalid } = readApplierFile(file);
  assert.equal(truncated, null);
  assert.equal(invalid.length, 1);
  assert.equal(events.length, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Q3: per-applier files merge on (applier, seq), and a dying applier cannot damage a sibling', () => {
  const dir = tmpdir();
  const a = new EventStream({ run: '2026-09-17', applier: 1, file: path.join(dir, 'applier1.jsonl') });
  const b = new EventStream({ run: '2026-09-17', applier: 2, file: path.join(dir, 'applier2.jsonl') });
  a.context({ job_key: JOB, ats: 'icims' });
  b.context({ job_key: JOB_B, ats: 'workday' });
  a.emit('application_started', { apply_url: 'https://a/jobs/1/login', attempt: 1, claim: 'offline' });
  b.emit('application_started', { apply_url: 'https://b/jobs/2/login', attempt: 1, claim: 'offline' });
  b.emit('submitted', { application_id: 'R-104882', confirmation_text: 'Thank you for applying', confirmation_url: 'https://b/done', verified_by: 'application-id' });
  b.emit('application_ended', { outcome: 'submitted', duration_ms: 1000, tool_calls: 3 });
  a.close(); b.close();
  // applier 1 dies mid-write.
  fs.appendFileSync(path.join(dir, 'applier1.jsonl'), '{"v":1,"seq":1,"ty');

  const merged = mergeRun(dir);
  assert.equal(merged.files, 2);
  assert.equal(merged.truncated.length, 1);
  assert.equal(merged.truncated[0].applier, 1);
  assert.deepEqual(merged.gaps, [], 'no gaps: the tail was dropped, not mis-sequenced');
  // applier 2's submission is intact despite applier 1's crash.
  const sum = summarize(merged.events);
  const bRow = sum.rows.find((r) => r.job_key === JOB_B);
  assert.equal(bRow.outcome, 'submitted');
  assert.equal(bRow.application_id, 'R-104882');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Q2: the reader counts would_require_invention per day', () => {
  const s = mk();
  s.emit('field_skipped', { field_key: null, label: 'Describe a time you failed', required: true, reason: 'would_require_invention' });
  s.emit('field_skipped', { field_key: null, label: 'Years of experience with Go', required: true, reason: 'would_require_invention' });
  s.emit('field_skipped', { field_key: 'education.gpa', required: true, reason: 'unmapped_required' });
  s.emit('application_ended', { outcome: 'needs-felix', reason: 'novel essay', duration_ms: 10, tool_calls: 4 });
  const sum = summarize(s.events);
  assert.equal(sum.would_require_invention_total, 2);
  assert.deepEqual(sum.rows[0].skipped_required, ['education.gpa'],
    'an invention-park is counted separately from a bank gap');
});

test('every emitted event still validates', () => {
  const s = mk();
  s.emit('preflight_result', { reachable: true, http_status: 200, wall_class: null, elapsed_ms: 2140, context: 'throwaway', ip_class: 'residential' });
  s.emit('wall_detected', { wall_class: 'hcaptcha', where: 'guest-apply', tenant_prior_walls: 2, action: 'retry-fresh-context' });
  s.events.forEach((e) => assert.doesNotThrow(() => validateEvent(e)));
});
