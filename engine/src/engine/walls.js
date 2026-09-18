// Per-tenant wall memory with decay. Design: architecture.md §8a (C4 ruling).
//
// Today there is no per-tenant wall store at all: walls live as a coarse
// `reason` string in a day's retry-wave.json and as prose in a ledger nothing
// reads back. So the same iCIMS gate is rediscovered from scratch every day,
// at the cost of a tailored PDF and an applier slot each time.
//
// C4 ruling: the key is (tenant, wall_class, WHERE) — not merely tenant. An
// hCaptcha at the guest-apply gate and an hCaptcha at Submit Profile are
// different facts about a tenant: the first costs nothing to retry, the second
// costs a fully filled form. iCIMS double-gates, so conflating them would make
// the retry policy wrong in both directions.
//
// And the third-strike skip DECAYS after 14 days. A tenant that gated three
// times in September is not thereby gated forever — on 2026-09-17, 3 of 4
// iCIMS gates did not re-fire on a second visit, which is the same evidence
// that justifies retrying at all.

import fs from 'node:fs';
import path from 'node:path';

export const THIRD_STRIKE = 3;
export const DECAY_DAYS = 14;

/** Classes where a retry cannot possibly help, so we never spend one. */
export const NO_RETRY_CLASSES = Object.freeze([
  'datadome',            // the SPA never renders; there is no challenge to solve
  'recaptcha-v3-score',  // a score, not an interaction
  'http-403',            // the edge refused us; a second identical request will too
]);

export const wallKey = (tenant, wallClass, where) => `${tenant}|${wallClass}|${where ?? 'unknown'}`;

export class WallMemory {
  constructor({ file = null, now = () => new Date() } = {}) {
    this.file = file;
    this.now = now;
    this.data = file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  }

  save() {
    if (!this.file) return null;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2) + '\n');
    return this.file;
  }

  record(tenant, wallClass, where) {
    const k = wallKey(tenant, wallClass, where);
    const today = this.now().toISOString().slice(0, 10);
    const cur = this.data[k] ?? {
      tenant, wall_class: wallClass, where: where ?? 'unknown',
      occurrences: 0, first_seen: today, last_seen: today, cleared_on_retry: 0,
    };
    cur.occurrences += 1;
    cur.last_seen = today;
    this.data[k] = cur;
    return cur;
  }

  /** A retry that got through: recorded so the policy can be re-tuned from
   *  data rather than from a paragraph in a design doc. */
  recordCleared(tenant, wallClass, where) {
    const k = wallKey(tenant, wallClass, where);
    if (this.data[k]) this.data[k].cleared_on_retry += 1;
    return this.data[k] ?? null;
  }

  /** Age in whole CALENDAR days.
   *
   *  `last_seen` is stored as a date, not a timestamp, so measuring the decay
   *  in floating hours makes the window depend on the time of day a wall
   *  happened to be recorded — a wall seen at 00:05 would expire half a day
   *  before one seen at 23:55 on the same date. Both are "that day". Comparing
   *  calendar days makes the 14-day window mean 14 days. */
  ageDays(entry) {
    const day = (d) => Math.floor(Date.parse(`${String(d).slice(0, 10)}T00:00:00Z`) / 86400000);
    return day(this.now().toISOString()) - day(entry.last_seen);
  }

  /** Effective occurrence count, with decay applied (C4). */
  effectiveOccurrences(tenant, wallClass, where) {
    const e = this.data[wallKey(tenant, wallClass, where)];
    if (!e) return 0;
    return this.ageDays(e) > DECAY_DAYS ? 0 : e.occurrences;
  }

  /**
   * The policy.
   * @returns {'retry-fresh-context'|'park'|'skip-retry-third-strike'}
   */
  decide(tenant, wallClass, where) {
    if (NO_RETRY_CLASSES.includes(wallClass)) return 'park';
    const n = this.effectiveOccurrences(tenant, wallClass, where);
    if (n >= THIRD_STRIKE) return 'skip-retry-third-strike';
    return 'retry-fresh-context';
  }

  /** Entries whose third-strike skip has expired — reported so a tenant is
   *  visibly given another chance rather than silently re-tried. */
  expired() {
    const out = [];
    for (const [k, e] of Object.entries(this.data)) {
      const age = this.ageDays(e);
      if (e.occurrences >= THIRD_STRIKE && age > DECAY_DAYS) out.push({ key: k, ...e, ageDays: age });
    }
    return out;
  }
}

/**
 * Detect a wall on the current page from an adapter's declared markers.
 *
 * Verified against 5 live iCIMS tenants on 2026-09-17: every iCIMS login page
 * carries an hCaptcha iframe and an `h-captcha-response` textarea whether or
 * not a challenge ever fires. So PRESENCE is not the marker — VISIBILITY is.
 * A marker that matched presence would have parked 100% of iCIMS applications,
 * including all the ones that sail straight through.
 */
export async function detectWall(markers, { page, root, status = null }) {
  for (const m of markers ?? []) {
    if (m.status !== undefined && status !== null && status === m.status) {
      return { wallClass: m.wallClass, marker: `http-status:${status}` };
    }
    if (m.selector) {
      const loc = (m.inFrame === false ? page : root).locator(m.selector).first();
      const present = await loc.count();
      if (!present) continue;
      // `requireVisible` defaults to TRUE precisely because of the finding
      // above. An adapter that means "present at all" must say so explicitly.
      if (m.requireVisible === false) return { wallClass: m.wallClass, marker: m.selector };
      const visible = await loc.isVisible().catch(() => false);
      if (visible) return { wallClass: m.wallClass, marker: m.selector };
    }
    if (m.text) {
      const body = await root.locator('body').first().innerText().catch(() => '');
      if (m.text.test(body)) return { wallClass: m.wallClass, marker: String(m.text) };
    }
  }
  return null;
}
