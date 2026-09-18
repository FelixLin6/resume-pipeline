// Adapter resolution. Design: architecture.md §7.
//
// "First match wins; order is defined by the REGISTRY, not by the adapter"
// (interfaces.md §2). Order matters because hostnames overlap: an employer's
// careers page can embed Greenhouse while living on its own domain, and an
// iCIMS tenant can be reached through an employer CNAME. The specific matchers
// are therefore consulted before the general ones.
//
// A URL that matches nothing resolves to null, and null means the model-driven
// fallback — never a guess at the closest adapter. An adapter driving the wrong
// ATS would fill a form it does not understand, which is strictly worse than
// handing the page to a model that knows it is reading something unfamiliar.

import icims from './icims.js';
import workday from './workday.js';
import greenhouse from './greenhouse.js';
import lever from './lever.js';

/** Ordered. Do not sort this list alphabetically. */
export const ADAPTERS = Object.freeze([
  workday,      // *.myworkdayjobs.com — unambiguous
  icims,        // *.icims.com + employer CNAMEs carrying ?icims=1
  lever,        // jobs.lever.co/<tenant>
  greenhouse,   // job-boards.greenhouse.io, plus ?gh_jid= on employer domains
]);

/**
 * @param {string|URL} url
 * @returns {object|null} the adapter, or null for the model-driven fallback
 */
export function resolveAdapter(url, adapters = ADAPTERS) {
  const u = url instanceof URL ? url : new URL(String(url));

  for (const a of adapters) {
    const hostHit = a.match.hostnames.some((re) => re.test(u.hostname));
    if (hostHit) return a;
  }

  // Second pass: employer-hosted boards, which are identified by a path or
  // query hint rather than by hostname. Kept as a SEPARATE pass so a hint can
  // never outrank a hostname match — `gh_src=Simplify` appears on iCIMS URLs
  // too, and a single-pass loop would let it steal them.
  for (const a of adapters) {
    const hintHit = (a.match.pathHints ?? []).some((re) => re.test(u.pathname + u.search));
    if (hintHit) return a;
  }

  return null;
}

/** Every adapter, by id — for tests and tooling. */
export const BY_ID = Object.freeze(Object.fromEntries(ADAPTERS.map((a) => [a.id, a])));
