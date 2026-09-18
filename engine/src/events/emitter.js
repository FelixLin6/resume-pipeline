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
  constructor({ run, applier, file = null }) {
    this.run = run;
    this.applier = applier;
    this.file = file;
    this.seq = 0;
    this.events = [];           // retained in-memory; the test asserts on this
    this._fd = null;
    this._ctx = { job_key: '-', tenant: null, ats: null, step: null };

    if (file) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      this._fd = fs.openSync(file, 'a');
    }
  }

  /** Set the ambient context stamped onto subsequent events. */
  context(patch) { Object.assign(this._ctx, patch); return this; }

  /**
   * Emit one event. Validates first — an invalid event throws here rather
   * than being written and silently misread downstream.
   */
  emit(type, data = {}) {
    const ev = {
      v: 1,
      ts: new Date().toISOString(),
      seq: this.seq++,
      run: this.run,
      applier: this.applier,
      job_key: this._ctx.job_key,
      ...(this._ctx.tenant ? { tenant: this._ctx.tenant } : {}),
      ...(this._ctx.ats ? { ats: this._ctx.ats } : {}),
      ...(this._ctx.step ? { step: this._ctx.step } : {}),
      type,
      data,
    };
    validateEvent(ev);
    this.events.push(ev);

    if (this._fd !== null) {
      fs.writeSync(this._fd, JSON.stringify(ev) + '\n');
      if (FSYNC_TYPES.has(type)) fs.fsyncSync(this._fd);
    }
    return ev;
  }

  /** Tool-call count for the current application = seq delta. This is the
   *  efficiency metric; it cannot be gamed because every engine action
   *  emits. */
  countSince(seq) { return this.seq - seq; }

  close() { if (this._fd !== null) { fs.closeSync(this._fd); this._fd = null; } }
}
