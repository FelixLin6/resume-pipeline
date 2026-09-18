// WIP — Phase 1 scaffold. The single event stream.
// Design: engine/design/interfaces.md §4.
//
// One stream, three consumers (ledger, efficiency metric, review diff). No
// consumer parses a log line, ever.

import fs from 'node:fs';
import path from 'node:path';
import { validateEvent } from './schema.js';

/** Events that must be durable before we proceed — losing one of these
 *  could mean re-submitting an application after a crash. */
const FSYNC_TYPES = new Set(['submitted', 'application_ended', 'upload_verified']);

export class EventStream {
  /**
   * @param {object} o
   * @param {string} o.run          run date, "2026-09-17"
   * @param {number} o.applier      applier index
   * @param {string} [o.file]       JSONL path; omit for in-memory only (tests)
   */
  constructor({ run, applier, file = null, now = () => Date.now() }) {
    this.run = run;
    this.applier = applier;
    this.file = file;
    this.seq = 0;
    this.events = [];           // retained in-memory; the test asserts on this
    this._fd = null;
    this._ctx = { job_key: '-', tenant: null, ats: null, step: null };
    this._now = now;

    // Q1: literal secret values registered for this run. Redacted from every
    // payload by VALUE match before emit. The forbidden-KEY check catches
    // {password: "x"}; this catches log("created the account with hunter2"),
    // which is the shape the 2026-09-17 leak actually had.
    this._secrets = [];

    // Q7: heartbeat is an engine constant — every 10 events or 5 minutes,
    // whichever comes first. Not adapter-configurable, so "this applier has
    // gone quiet" means the same thing on every ATS.
    this.heartbeatEvery = 10;
    this.heartbeatMs = 5 * 60 * 1000;
    this._lastBeatSeq = 0;
    this._lastBeatAt = now();
    this._lastType = null;

    if (file) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      this._fd = fs.openSync(file, 'a');
    }
  }

  /** Set the ambient context stamped onto subsequent events. */
  context(patch) { Object.assign(this._ctx, patch); return this; }

  /** Register a literal secret value for redaction. The VALUE is held only in
   *  memory and is never itself written anywhere. */
  registerSecret(value) {
    const v = String(value ?? '');
    if (v.length >= 4 && !this._secrets.includes(v)) this._secrets.push(v);
    return this;
  }

  _redact(obj) {
    if (!this._secrets.length) return obj;
    const walk = (v) => {
      if (typeof v === 'string') {
        let out = v;
        for (const s of this._secrets) {
          if (out.includes(s)) out = out.split(s).join('[redacted:secret]');
        }
        return out;
      }
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === 'object') {
        return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
      }
      return v;
    };
    return walk(obj);
  }

  /**
   * Emit one event. Validates first — an invalid event throws here rather
   * than being written and silently misread downstream.
   */
  emit(type, data = {}) {
    const ev = {
      v: 1,
      ts: new Date(this._now()).toISOString(),
      seq: this.seq++,
      run: this.run,
      applier: this.applier,
      job_key: this._ctx.job_key,
      ...(this._ctx.tenant ? { tenant: this._ctx.tenant } : {}),
      ...(this._ctx.ats ? { ats: this._ctx.ats } : {}),
      ...(this._ctx.step ? { step: this._ctx.step } : {}),
      type,
      data: this._redact(data),
    };
    validateEvent(ev);
    this.events.push(ev);
    this._lastType = type;

    if (this._fd !== null) {
      fs.writeSync(this._fd, JSON.stringify(ev) + '\n');
      if (FSYNC_TYPES.has(type)) fs.fsyncSync(this._fd);
    }

    // Q7: a heartbeat is tied to field_filled as well as page_advanced. Keyed
    // only to page transitions it would go silent for the whole length of a
    // 25-field page — precisely the window in which the current stack wedges.
    if (type !== 'heartbeat') this.maybeHeartbeat();
    return ev;
  }

  /** Emit a heartbeat if the engine constant says one is due. */
  maybeHeartbeat() {
    const dueBySeq = this.seq - this._lastBeatSeq >= this.heartbeatEvery;
    const dueByTime = this._now() - this._lastBeatAt >= this.heartbeatMs;
    if (!dueBySeq && !dueByTime) return null;
    const since = this._now() - this._lastBeatAt;
    const events_since = this.seq - this._lastBeatSeq;
    this._lastBeatSeq = this.seq;
    this._lastBeatAt = this._now();
    return this.emit('heartbeat', {
      since_ms: since,
      events_since,
      step: this._ctx.step ?? null,
      last_event_type: this._lastType,
    });
  }

  /** Tool-call count for the current application = seq delta. This is the
   *  efficiency metric; it cannot be gamed because every engine action
   *  emits. */
  countSince(seq) { return this.seq - seq; }

  close() { if (this._fd !== null) { fs.closeSync(this._fd); this._fd = null; } }
}
