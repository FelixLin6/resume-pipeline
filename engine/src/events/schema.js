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
  // Gate 1 fix batch: an application that stalled with NO named cause — no
  // blocked_by, no classified wall, no step change. The cesi false clean
  // (2026-09-17) ended exactly this way while an hCaptcha was on screen:
  // "no-progress with nothing to blame" is the signature of a wall the
  // classifier missed, so it must be un-reportable as a clean assist.
  'suspect',
]);

export const SKIP_REASONS = Object.freeze([
  'unmapped_required', 'unmapped_optional', 'no_such_field',
  'value_absent', 'option_not_found', 'forbidden_value',
  'would_require_invention',
  // Gate 1 fix batch:
  //   fill_failed     the write itself threw (Amperesand: locator.fill of
  //                   "01/01/2027" into input[type=number] killed the whole
  //                   application at 5.5s). A field the engine cannot write is
  //                   a PARKED FIELD, never an aborted application.
  //   already_filled  a second control resolved to a key this step already
  //                   filled (Relay: "Address Line 2" matched line1's label
  //                   pattern and received line 1's value). The duplicate is
  //                   refused and named, not silently overwritten.
  'fill_failed', 'already_filled',
  // Fleet 0918: a value that WAS on file, WAS written, and then failed the
  // read-back verification. These were filed under value_absent, which reads
  // as a bank gap — the post-fleet investigation chased "missing
  // sponsorship/self-ID keys" the bank had held since phase 2. The real
  // causes (react-select commits rendering outside the input; committed
  // option text longer than the typed candidate) were invisible because the
  // reason pointed at the wrong layer.
  'readback_mismatch',
]);

/** gate_result.kind — now validated. The droplet's probe pass showed why the
 *  vocabulary needs `observed`: icims.passGate emitted {kind:'passed'} when it
 *  merely SAW the email box, so the ledger evidence claimed a gate pass on all
 *  32 probe rows where nothing was passed at all. `passed` is reserved for a
 *  gate actually cleared; `observed` means "the gate is here, and this is what
 *  it looks like". */
export const GATE_KINDS = Object.freeze([
  'none', 'observed', 'passed', 'needs-human', 'failed',
]);

export const WALL_CLASSES = Object.freeze([
  'hcaptcha', 'recaptcha-interactive', 'recaptcha-v3-score',
  'datadome', 'cloudflare-challenge', 'spam-flag',
  'http-403', 'http-429', 'tenant-5xx', 'account-required',
  // Phase 3 additions. Both are edge/tenant conditions the pre-flight
  // classifier can now name, and a class it cannot name is a class the retry
  // policy cannot reason about — which is the whole argument for a closed set.
  //
  //   akamai        Akamai Bot Manager. Distinct from datadome/cloudflare
  //                 because its refusal is a plain "Access Denied / Reference
  //                 #..." page with no challenge widget at all: there is
  //                 nothing for an assist slot to solve, so it must not be
  //                 filed under `unknown-challenge`, which retries.
  //   tenant-broken The tenant's own application is throwing, not blocking us
  //                 (the SmartRecruiters Angular NG0908 signature). It is NOT
  //                 a bot wall, and conflating the two would teach the wall
  //                 memory that a tenant "gates" us when it is simply down.
  'akamai', 'tenant-broken',
  // Gate 1 fix batch (droplet finding A): HTTP 410 on the posting URL. Three
  // of 35 probed iCIMS tenants returned it — the posting is WITHDRAWN, which
  // is terminal: no retry, no assist slot, and above all no model-fallback
  // turn, which is what a null classification was buying. Not a bot wall,
  // but it lives in this enum because the pre-flight's job is to name what
  // stands between us and the form, and "the form no longer exists" is the
  // cheapest possible answer to discover first.
  'posting-closed',
  'unknown-challenge',
]);

/** What the engine decided to DO about a detected wall. Closed, because a
 *  policy the reader of a stream cannot name is a policy nobody can audit.
 *  `reuse-solved-session` was added in Phase 3: a challenge a human solved
 *  buys a session-length window (walls.js SOLVED_TTL_HOURS), and reusing it
 *  spends no assist slot. */
export const WALL_ACTIONS = Object.freeze([
  'retry-fresh-context', 'park', 'skip-retry-third-strike', 'reuse-solved-session',
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
      // `action` is optional (a detection may be recorded before a policy runs),
      // but an action outside the closed set is refused.
      if (d.action !== undefined && d.action !== null && !WALL_ACTIONS.includes(d.action)) {
        fail(`unknown wall action: ${d.action}`);
      }
      break;
    case 'driver_event':
      if (!DRIVER_EVENT_KINDS.includes(d.kind)) fail(`unknown driver event kind: ${d.kind}`);
      break;
    case 'review_diff':
      if (!['pass', 'fail'].includes(d.verdict)) fail(`review_diff.verdict must be pass|fail`);
      break;
    case 'gate_result':
      if (!GATE_KINDS.includes(d.kind)) fail(`unknown gate kind: ${d.kind}`);
      break;
    case 'submitted':
      // The confirmation page is the PRIMARY verification (inbox secondary).
      if (typeof d.confirmation_text !== 'string') fail('submitted requires confirmation_text');
      break;
  }
  return ev;
}
