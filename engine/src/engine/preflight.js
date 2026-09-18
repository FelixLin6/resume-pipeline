// Wall pre-flight — the throwaway-context check that runs BEFORE tailoring.
// Design: architecture.md §8a, interfaces.md §4.3 (`preflight_result`), C4, C5.
//
// What it is for. Today a wall is discovered by an applier, after a tailored
// PDF has been produced and an applier slot has been spent, and the discovery
// is written down as prose nothing reads back — so the same iCIMS gate is
// rediscovered from scratch every day at full price. Pre-flight moves the
// discovery to before the spend, and the wall memory (walls.js) makes the
// discovery cumulative.
//
// Three properties the implementation must have, each from a recorded failure:
//
//  1. THROWAWAY CONTEXT. The probe gets its own BrowserContext, discarded
//     immediately. A challenge cookie picked up here must never end up in the
//     applier's context — it is exactly the kind of cross-contamination that
//     made the 2026-09-12 Tesla/Cone Health mix-up possible, and a DataDome or
//     Akamai cookie set during a probe would change what the real attempt sees.
//
//  2. PRESENCE IS NOT A WALL. Verified on 5 live iCIMS tenants: every iCIMS
//     login page carries an hCaptcha iframe whether or not a challenge ever
//     fires. A classifier keyed to presence would have parked 100% of iCIMS
//     applications, including the three of four that sailed straight through on
//     2026-09-17. Every widget marker here is visibility-gated (and sized —
//     a 0×0 challenge frame is a v3 score check, not something a human could
//     solve even if we handed it to one: the Aramco case).
//
//  3. A CLASS IT CANNOT NAME IS A CLASS THE POLICY CANNOT REASON ABOUT. The
//     classifier returns a member of the closed WALL_CLASSES set or null.
//     `unknown-challenge` is the honest answer for "something is in the way and
//     we do not know what", and it is deliberately NOT the answer for Akamai or
//     for a broken tenant, because those two must not be retried like a gate.
//
// The five families the pre-flight distinguishes, and how they map onto the
// closed event enum:
//
//   hcaptcha-challenge-visible  -> 'hcaptcha'
//   recaptcha                   -> 'recaptcha-interactive' | 'recaptcha-v3-score'
//   akamai/datadome/cloudflare/403
//                               -> 'akamai' | 'datadome' | 'cloudflare-challenge' | 'http-403'
//   spam-flag banner            -> 'spam-flag'
//   tenant-broken (NG0908)      -> 'tenant-broken'
//   none                        -> null

import { detectWall, WallMemory } from './walls.js';

/**
 * Engine-owned markers, checked after the adapter's own.
 *
 * These live in the ENGINE, not in an adapter, because an edge block is a
 * property of the CDN in front of a tenant, not of the ATS behind it: the same
 * DataDome interstitial appears in front of Workday, Greenhouse and a bespoke
 * careers page alike. An adapter may still declare a tenant-specific marker,
 * and it is consulted first — tenant knowledge beats generic knowledge.
 */
export const GENERIC_WALL_MARKERS = Object.freeze([
  // --- interactive challenges -------------------------------------------
  {
    wallClass: 'hcaptcha',
    selector: 'iframe[title="hCaptcha challenge"]',
    requireVisible: true,
  },
  {
    wallClass: 'recaptcha-interactive',
    // The challenge popup, not the badge. reCAPTCHA's checkbox frame is on the
    // page continuously; only this one means a human is being asked something.
    selector: 'iframe[title*="recaptcha challenge" i]',
    requireVisible: true,
  },
  // --- edge blocks -------------------------------------------------------
  {
    wallClass: 'datadome',
    // The SPA never renders behind this one, so there is no form to fill and
    // no challenge to hand to a human: park, never retry (B6).
    selector: 'iframe[src*="geo.captcha-delivery.com"], iframe[src*="captcha-delivery"]',
    requireVisible: false,
  },
  { wallClass: 'datadome', text: /datadome|please enable js and disable any ad ?blocker/i },
  {
    wallClass: 'cloudflare-challenge',
    selector: '#cf-challenge-running, #challenge-running, [data-translate="checking_browser"]',
    requireVisible: false,
  },
  { wallClass: 'cloudflare-challenge', text: /checking your browser before accessing|just a moment\.\.\.|cf-?ray/i },
  {
    wallClass: 'akamai',
    // Akamai Bot Manager does not challenge — it refuses, with a reference
    // number and no widget. Retrying it is pure cost.
    text: /access denied.{0,400}reference\s*#|you don'?t have permission to access .* on this server/is,
  },
  // --- tenant conditions --------------------------------------------------
  {
    wallClass: 'spam-flag',
    text: /flagged as spam|marked as spam|submission (?:was|has been) flagged|unusual activity from your|too many (?:applications|requests) from/i,
  },
  {
    wallClass: 'tenant-broken',
    // SmartRecruiters' Angular app throws NG0908 and renders nothing usable.
    // This is the tenant being broken, not the tenant blocking us, and the two
    // must not be merged: a wall memory that records "SmartRecruiters gates us"
    // would skip the retry on a tenant whose only problem was a bad deploy.
    text: /\bNG0908\b|RuntimeError:\s*NG0\d{3}|core\.mjs.*NG0908/i,
  },
]);

/**
 * Header/status classification — pure, no browser needed.
 *
 * Kept separate from the DOM markers because the most decisive evidence often
 * never reaches the DOM: a DataDome or Akamai refusal is a 403 with a vendor
 * header and a body that may not even parse as a page.
 *
 * @param {number|null} status
 * @param {Record<string,string>} headers   lower-cased header map
 * @returns {{wallClass:string, marker:string}|null}
 */
export function classifyHeaders(status, headers = {}) {
  const h = {};
  for (const [k, v] of Object.entries(headers ?? {})) h[String(k).toLowerCase()] = String(v ?? '');
  const cookie = h['set-cookie'] ?? '';

  if (h['x-datadome'] || /\bdatadome=/i.test(cookie) || /datadome/i.test(h.server ?? '')) {
    return { wallClass: 'datadome', marker: 'header:x-datadome' };
  }
  if (/\b_abck=|\bak_bmsc=|\bbm_sz=/i.test(cookie) && (status === 403 || h['server']?.includes('AkamaiGHost'))) {
    return { wallClass: 'akamai', marker: 'header:akamai-bot-manager-cookie' };
  }
  if (h['cf-mitigated'] === 'challenge' || (status === 403 && /cloudflare/i.test(h.server ?? ''))) {
    return { wallClass: 'cloudflare-challenge', marker: 'header:cf-mitigated' };
  }
  if (status === 429) return { wallClass: 'http-429', marker: 'http-status:429' };
  if (status === 403) return { wallClass: 'http-403', marker: 'http-status:403' };
  if (typeof status === 'number' && status >= 500) {
    return { wallClass: 'tenant-5xx', marker: `http-status:${status}` };
  }
  return null;
}

/**
 * Is a rendered captcha frame actually solvable?
 *
 * Aramco rendered a reCAPTCHA at 0×0: not interactable even by a human, so
 * handing it to an assist slot burns the slot and solves nothing. A zero-sized
 * challenge is reported as a SCORE check, which is a park class.
 */
export async function sizeCaptchaClass(root, selector) {
  const loc = root.locator(selector).first();
  if (!(await loc.count())) return null;
  const box = await loc.boundingBox().catch(() => null);
  if (!box || box.width < 40 || box.height < 40) return 'recaptcha-v3-score';
  return 'recaptcha-interactive';
}

/**
 * Classify the landed page. Adapter markers first, then generic, then headers.
 *
 * @returns {Promise<{wallClass:string, marker:string}|null>}
 */
export async function classifyPage({ page, root = page, status = null, headers = {}, adapter = null }) {
  const adapterHit = await detectWall(adapter?.quirks?.wallMarkers, { page, root, status });
  if (adapterHit) return adapterHit;

  const generic = await detectWall(GENERIC_WALL_MARKERS, { page, root, status });
  if (generic) {
    if (generic.wallClass === 'recaptcha-interactive') {
      const sized = await sizeCaptchaClass(root, 'iframe[title*="recaptcha challenge" i]');
      if (sized) return { wallClass: sized, marker: generic.marker };
    }
    return generic;
  }

  return classifyHeaders(status, headers);
}

/** Where a wall was found. Part of the wall-memory key (C4). */
export const WHERE_PREFLIGHT = 'preflight';

/**
 * Run the pre-flight for one apply URL.
 *
 * The context is created and destroyed inside this function — the caller never
 * receives it, so there is no way for a probe context to be reused by mistake.
 *
 * @param {object} o
 * @param {import('playwright-core').Browser} o.browser
 * @param {string} o.url                  apply URL
 * @param {object} o.events               EventStream
 * @param {object} [o.adapter]            resolved adapter, or null for unknown ATS
 * @param {WallMemory} [o.wallMemory]
 * @param {'residential'|'datacenter'|null} [o.ipClass]  from the once-per-run probe
 * @returns {Promise<{wall_class:string|null, action:string|null, http_status:number|null,
 *                    reachable:boolean, elapsed_ms:number, marker:string|null}>}
 */
export async function preflight({
  browser, url, events, adapter = null, wallMemory = null, ipClass = null,
  tenant = null, timeoutMs = 45000, contextOptions = {}, hasStorageState = false,
}) {
  const t0 = Date.now();
  let ctx = null;
  let status = null;
  let headers = {};
  let reachable = false;
  let hit = null;
  let error = null;

  try {
    // Rule 1: throwaway. Own context, discarded in `finally`, never handed out.
    ctx = await browser.newContext({ viewport: { width: 1350, height: 900 }, locale: 'en-US', ...contextOptions });
    const page = await ctx.newPage();
    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    status = res?.status() ?? null;
    headers = (await res?.allHeaders?.().catch(() => ({}))) ?? {};
    reachable = true;

    // A challenge widget can take a beat to render after DOMContentLoaded;
    // waiting for network idle is the bounded, non-sleep way to give it one.
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});

    // Classify at the TOP LEVEL first: every edge block (DataDome, Akamai,
    // Cloudflare, a 403) replaces the whole document, so there is no adapter
    // frame to descend into — asking for one would throw where the answer is
    // already known.
    hit = await classifyPage({ page, root: page, status, headers, adapter });

    // Then, if the ATS nests its form, look again INSIDE the frame: iCIMS's
    // hCaptcha widget lives in the content iframe, so its challenge iframe is
    // appended to that document and is invisible from the top. Guarded,
    // because a frame that never rendered must degrade to "no wall found in a
    // frame that is not there", not to a pre-flight crash.
    if (!hit && adapter?.formRoot) {
      try {
        const spec = await adapter.formRoot({ url: new URL(url) }, null);
        if (spec?.frames?.length) {
          const root = resolveAdapterRoot(page, spec);
          hit = await classifyPage({ page, root, status: null, headers: {}, adapter });
        }
      } catch { /* no frame, no in-frame wall */ }
    }
  } catch (e) {
    error = String(e?.message ?? e).slice(0, 200);
  } finally {
    // By handle, by owner. Never a range close (F4).
    if (ctx) await ctx.close().catch(() => {});
  }

  const elapsed_ms = Date.now() - t0;

  events.emit('preflight_result', {
    reachable,
    http_status: status,
    wall_class: hit?.wallClass ?? null,
    elapsed_ms,
    context: 'throwaway',
    // C5: stamped onto EVERY preflight from the one-per-run probe, so a day's
    // wall rate is interpretable when it is read back weeks later.
    ip_class: ipClass,
    ...(error ? { error } : {}),
  });

  if (!hit) return { wall_class: null, action: null, http_status: status, reachable, elapsed_ms, marker: null };

  const t = tenant ?? (adapter?.tenantOf ? adapter.tenantOf(new URL(url)) : new URL(url).hostname);
  const memory = wallMemory ?? new WallMemory();
  const entry = memory.record(t, hit.wallClass, WHERE_PREFLIGHT);
  // `hasStorageState` is what turns a solved-challenge WINDOW into a usable
  // decision: without a saved session for this tenant there is nothing to
  // reuse, and the policy must fall through to the ordinary retry/park ladder.
  const action = memory.decide(t, hit.wallClass, WHERE_PREFLIGHT, { hasStorageState });
  memory.save();

  events.emit('wall_detected', {
    wall_class: hit.wallClass,
    where: WHERE_PREFLIGHT,
    marker: String(hit.marker).slice(0, 120),
    tenant_prior_walls: entry.occurrences - 1,
    action,
  });

  return {
    wall_class: hit.wallClass, action, http_status: status, reachable, elapsed_ms,
    marker: hit.marker,
  };
}

/** Resolve an adapter FrameRootSpec without importing the whole discovery
 *  module's DOM-side code path. Mirrors discovery.resolveRoot. */
function resolveAdapterRoot(page, spec) {
  let root = page;
  for (const sel of spec?.frames ?? []) root = root.frameLocator(sel);
  return root;
}
