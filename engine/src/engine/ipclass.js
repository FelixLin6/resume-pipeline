// preflight_result.ip_class — the ONE-TIME-PER-RUN egress probe (C5).
//
// Why it exists: a day's wall rate is uninterpretable without knowing what the
// tenants saw us as. A datacenter egress is itself a wall risk factor — the
// same iCIMS gate that waves a residential IP through will challenge a VPS all
// day — so when a day goes badly, "were we coming out of a datacenter?" must be
// answerable from the stream rather than reconstructed from memory.
//
// Three rules, each deliberate:
//
//  1. ONCE PER RUN, not per job. The answer cannot change between two jobs of
//     the same run, and probing per job would put ~50 identical requests to a
//     third party on the wire, which is itself a fingerprint.
//  2. OFFLINE IS NOT AN ERROR. The probe is telemetry. If the network is down
//     or the endpoint is unreachable, `ip_class` is null and the run proceeds;
//     a pre-flight that fails because a metadata service was down would be a
//     self-inflicted outage.
//  3. THE IP ITSELF NEVER ENTERS THE EVENT STREAM. Only the class does. A
//     dotted quad is identity-adjacent, and one like `212.345.6789` would trip
//     the emitter's own phone-shape guard (Q5) — so the address is held in the
//     gitignored state cache and never emitted.

import fs from 'node:fs';
import path from 'node:path';

export const PROBE_URL = 'https://ipinfo.io/json';

/**
 * Org/ASN substrings that mean "this is hosting infrastructure, not a home
 * connection". Matched case-insensitively against the `org` field.
 *
 * Conservative by design: an org we do not recognize is reported as
 * `residential`, because the failure mode of a false `datacenter` (blaming the
 * egress for walls that were really the tenant's) is worse than the failure
 * mode of a false `residential` (a wall day that looks unexplained).
 */
export const DATACENTER_HINTS = Object.freeze([
  'amazon', 'aws', 'google llc', 'google cloud', 'microsoft', 'azure',
  'digitalocean', 'linode', 'akamai connected cloud', 'vultr', 'choopa',
  'ovh', 'hetzner', 'scaleway', 'contabo', 'oracle cloud', 'oracle corp',
  'cloudflare', 'fastly', 'leaseweb', 'm247', 'datacamp', 'packet host',
  'equinix', 'colocation', 'colocrossing', 'data center', 'datacenter',
  'hosting', 'server', 'vps', 'cloud', 'dedicated',
]);

/** @returns {'datacenter'|'residential'} */
export function classifyOrg(org) {
  const s = String(org ?? '').toLowerCase();
  if (!s) return 'residential';
  return DATACENTER_HINTS.some((h) => s.includes(h)) ? 'datacenter' : 'residential';
}

function readCache(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/**
 * Probe the run's egress class, at most once per run.
 *
 * @param {object} o
 * @param {string} o.run             run date, "2026-09-17" — the cache key
 * @param {string} [o.cacheFile]     gitignored state file; omit to skip caching
 * @param {Function} [o.fetchImpl]   injectable for tests
 * @param {number} [o.timeoutMs]
 * @returns {Promise<{ip_class: 'residential'|'datacenter'|null, probed: boolean,
 *                    cached: boolean, source: string, reason?: string}>}
 */
export async function probeIpClass({
  run,
  cacheFile = null,
  fetchImpl = globalThis.fetch,
  timeoutMs = 4000,
  url = PROBE_URL,
} = {}) {
  if (cacheFile) {
    const cached = readCache(cacheFile);
    // The cache is keyed by RUN: a new day re-probes (the laptop may have moved
    // networks), the same day never does.
    if (cached && cached.run === run) {
      return { ip_class: cached.ip_class ?? null, probed: false, cached: true, source: 'cache' };
    }
  }

  if (typeof fetchImpl !== 'function') {
    return { ip_class: null, probed: false, cached: false, source: 'none', reason: 'no fetch implementation' };
  }

  let payload = null;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ac.signal, headers: { accept: 'application/json' } });
    if (!res?.ok) {
      return { ip_class: null, probed: true, cached: false, source: url, reason: `http ${res?.status ?? '?'}` };
    }
    payload = await res.json();
  } catch (e) {
    // Rule 2: offline is not an error. This is the branch a machine with no
    // network takes, and it must be indistinguishable from a normal run
    // everywhere except the value of ip_class.
    return { ip_class: null, probed: true, cached: false, source: url, reason: String(e?.message ?? e).slice(0, 120) };
  } finally {
    clearTimeout(timer);
  }

  const ip_class = classifyOrg(payload?.org);

  if (cacheFile) {
    try {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      // state/ is gitignored. The address is kept HERE for auditing a
      // surprising classification, and is never handed to the emitter.
      fs.writeFileSync(cacheFile, JSON.stringify({
        run, ip_class, org: payload?.org ?? null, ip: payload?.ip ?? null,
        probed_at: new Date().toISOString(),
      }, null, 2) + '\n');
    } catch { /* telemetry cache is best-effort */ }
  }

  return { ip_class, probed: true, cached: false, source: url };
}
