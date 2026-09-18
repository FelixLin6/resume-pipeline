// WIP — Phase 1 scaffold. Typed event schema for the apply engine.
// Design: engine/design/interfaces.md §4.
//
// The whole point of this file: events are validated AT EMIT TIME against
// closed enums. On the current stack, an unknown ledger status label was
// silently skipped by the retry census and a posting vanished from the day's
// report (Nokia, 2026-09-05); truncated 8-char keys produced a false 13-row
// coverage hole and 7 unmarked submissions (2026-09-10). Both were possible
// because the machine-readable layer was prose. Here, an invalid event throws
// in the producer instead of being written and misread later.

export const EVENT_TYPES = Object.freeze([
  'application_started',
  'preflight_result',
  'field_discovered',
  'field_mapped',
  'field_skipped',
  'field_filled',
  'upload_attempted',
  'upload_verified',
  'page_advanced',
  'gate_result',
  'wall_detected',
  'evidence_captured',
  'review_diff',
  'submitted',
  'application_ended',
  'adapter_note',
  'driver_event',
  // Q7: engine-owned liveness. Every 10 events or 5 minutes, whichever first.
  'heartbeat',
]);

export const OUTCOMES = Object.freeze([
  'submitted', 'retry', 'wall', 'needs-felix', 'assist',
  'drop-at-apply', 'skipped-repost',
]);

export const SKIP_REASONS = Object.freeze([
  'unmapped_required', 'unmapped_optional', 'no_such_field',
  'value_absent', 'option_not_found', 'forbidden_value',
  'would_require_invention',
]);

export const WALL_CLASSES = Object.freeze([
  'hcaptcha', 'recaptcha-interactive', 'recaptcha-v3-score',
  'datadome', 'cloudflare-challenge', 'spam-flag',
  'http-403', 'http-429', 'tenant-5xx', 'account-required',
  'unknown-challenge',
]);

export const DRIVER_EVENT_KINDS = Object.freeze([
  'attached', 'context_created', 'context_closed', 'browser_died',
  'reattached', 'storagestate_saved', 'storagestate_loaded',
]);

export const ATS_IDS = Object.freeze([
  'icims', 'workday', 'greenhouse', 'lever', 'ashby', 'fallback',
]);

/** Envelope fields required on EVERY event. */
const ENVELOPE = ['v', 'ts', 'seq', 'run', 'applier', 'job_key', 'type'];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Keys that must never appear anywhere in an event payload. A sweep agent
// once pasted a freshly created iCIMS password into a file that was then
// pushed (2026-09-17). There is no legitimate reason for a credential to be
// in the event stream, so the schema refuses one structurally.
const FORBIDDEN_KEYS = Object.freeze([
  'password', 'passwd', 'secret', 'token', 'credential', 'api_key', 'apikey',
]);

// --------------------------------------------------------------------- Q5 ---
// The stream is committed to the resume-drops repo, so the rule is an
// allowlist of what may appear at all — not "mask where convenient".

/** Identity fields whose events carry a HASH ONLY. A masked phone number is
 *  still a phone number to anyone holding a second copy, so the old
 *  "412…4821" preview is withdrawn. */
export const IDENTITY_FIELD_KEYS = Object.freeze([
  'contact.email', 'contact.phone',
  'contact.address.line1', 'contact.address.line2', 'contact.address.city',
  'contact.address.state', 'contact.address.postalCode', 'contact.address.country',
  'selfid.signature',
]);

/** Free-text preview budget: first 12 characters, plus a length. Enough to
 *  tell a garbled fill from a good one, not enough to be a copy of the data. */
export const VALUE_PREVIEW_MAX = 12;

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
// A phone-shaped run, bounded by non-alphanumerics so it cannot fire on the
// digits inside a sha256 hex digest or a build id.
const PHONE_RE = /(?<![0-9A-Za-z])(?:\+?1[-. ]?)?(?:\(\d{3}\)|\d{3})[-. ]?\d{3}[-. ]?\d{4}(?![0-9A-Za-z])/;
/** Keys whose values are URLs/paths: full of long digit runs that are ids and
 *  timestamps, never phone numbers. Still swept for email addresses. */
const URLISH_KEY = /(^|_)(url|href|path|screenshot|file)$/i;
/** Keys whose values are digests: never swept for phone shapes. */
const HASHISH_KEY = /(^|_)(hash|sha256|sha1|md5|etag)$/i;

export class EventValidationError extends Error {}

function fail(msg) { throw new EventValidationError(msg); }

function assertNoSecrets(obj, path = 'data') {
  if (obj === null || typeof obj !== 'object') return;
  for (const [k, v] of Object.entries(obj)) {
    if (FORBIDDEN_KEYS.includes(k.toLowerCase())) {
      fail(`event payload carries a forbidden key: ${path}.${k}`);
    }
    if (v && typeof v === 'object') assertNoSecrets(v, `${path}.${k}`);
  }
}

/**
 * Q5 backstop: sweep every string in the payload for PII shapes. This is what
 * catches a value arriving through a field nobody classified — including the
 * forbidden CMU address, which must never appear in the stream even as
 * evidence that we refused it (field_skipped names the REASON, not the value).
 */
function assertNoPii(obj, path = 'data') {
  if (obj === null || typeof obj !== 'object') return;
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string') {
      if (EMAIL_RE.test(v)) fail(`event payload carries an email address: ${path}.${k}`);
      if (!URLISH_KEY.test(k) && !HASHISH_KEY.test(k) && PHONE_RE.test(v)) {
        fail(`event payload carries a phone-shaped value: ${path}.${k}`);
      }
    } else if (v && typeof v === 'object') {
      assertNoPii(v, `${path}.${k}`);
    }
  }
}

/**
 * Validate one event. Throws EventValidationError on any violation.
 * Returns the event for convenient chaining.
 */
export function validateEvent(ev) {
  if (!ev || typeof ev !== 'object') fail('event must be an object');

  for (const k of ENVELOPE) {
    if (ev[k] === undefined || ev[k] === null) fail(`missing envelope field: ${k}`);
  }
  if (ev.v !== 1) fail(`unsupported event version: ${ev.v}`);
  if (!EVENT_TYPES.includes(ev.type)) fail(`unknown event type: ${ev.type}`);
  if (!Number.isInteger(ev.seq) || ev.seq < 0) fail(`seq must be a non-negative integer`);
  if (typeof ev.ts !== 'string' || Number.isNaN(Date.parse(ev.ts))) fail('ts must be an ISO timestamp');

  // Full uuid, never truncated (2026-09-10). A synthetic key is allowed only
  // for driver-level events that are not about a specific job.
  if (ev.job_key !== '-' && !UUID_RE.test(ev.job_key)) {
    fail(`job_key must be a full uuid (never truncated), got: ${ev.job_key}`);
  }
  if (ev.ats !== undefined && !ATS_IDS.includes(ev.ats)) fail(`unknown ats: ${ev.ats}`);

  const d = ev.data ?? {};
  if (typeof d !== 'object') fail('data must be an object');
  assertNoSecrets(d);
  assertNoPii(d);

  switch (ev.type) {
    case 'application_ended':
      if (!OUTCOMES.includes(d.outcome)) fail(`unknown outcome: ${d.outcome}`);
      break;
    case 'field_skipped':
      if (!SKIP_REASONS.includes(d.reason)) fail(`unknown skip reason: ${d.reason}`);
      break;
    case 'wall_detected':
      if (!WALL_CLASSES.includes(d.wall_class)) fail(`unknown wall class: ${d.wall_class}`);
      break;
    case 'driver_event':
      if (!DRIVER_EVENT_KINDS.includes(d.kind)) fail(`unknown driver event kind: ${d.kind}`);
      break;
    case 'review_diff':
      if (!['pass', 'fail'].includes(d.verdict)) fail(`review_diff.verdict must be pass|fail`);
      break;
    case 'submitted':
      // The confirmation page is the PRIMARY verification (inbox secondary).
      if (typeof d.confirmation_text !== 'string') fail('submitted requires confirmation_text');
      break;
  }
  return ev;
}
