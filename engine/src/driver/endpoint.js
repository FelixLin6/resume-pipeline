// WIP — Phase 1 scaffold. CDP endpoint resolution.
// Design: engine/design/architecture.md §2.
//
// Chrome 149 for Testing binds the DevTools server to ::1 ONLY, even when
// given --remote-debugging-address=127.0.0.1. On the current stack that made
// agent-browser's IPv4 connect fail, and its failure path silently LAUNCHED
// an isolated private browser — the 2026-09-02 crash storm, and the origin of
// the .engine pin trap. The existing workaround is a node TCP shim process
// (pipeline-browser.sh:43-57).
//
// We do not need a shim: we probe both families and hand Playwright the URL
// that actually answers. And we never, ever fall back to launching.

const FAMILIES = [
  (port) => `http://127.0.0.1:${port}`,
  (port) => `http://[::1]:${port}`,
];

export class CdpUnreachableError extends Error {}

async function probe(base, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/json/version`, { signal: ac.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve a live CDP endpoint on `port`, trying IPv4 then IPv6.
 * @returns {Promise<{base:string, wsEndpoint:string, version:object}>}
 * @throws  {CdpUnreachableError} when neither family answers. The caller must
 *          treat this as fatal — there is no launch fallback by design.
 */
export async function resolveEndpoint(port, { timeoutMs = 3000 } = {}) {
  const tried = [];
  for (const mk of FAMILIES) {
    const base = mk(port);
    tried.push(base);
    const version = await probe(base, timeoutMs);
    if (version) {
      return {
        base,
        // Playwright's connectOverCDP accepts the HTTP base and discovers the
        // ws endpoint itself; we keep the ws URL for identity assertion.
        wsEndpoint: version.webSocketDebuggerUrl ?? null,
        version,
      };
    }
  }
  throw new CdpUnreachableError(
    `no CDP endpoint answered on port ${port} (tried: ${tried.join(', ')}). ` +
    `Refusing to launch a browser — a silent private launch is the ` +
    `2026-09-02 crash-storm failure mode.`
  );
}

/** Ports that belong to the shared pipeline browser. The engine's own
 *  scratch/test paths must never bind or attach to these. */
export const RESERVED_PORTS = Object.freeze([9222, 9223]);

export function assertScratchPort(port) {
  if (RESERVED_PORTS.includes(Number(port))) {
    throw new Error(
      `port ${port} is the shared pipeline browser's — scratch/test Chrome ` +
      `must use a throwaway port`
    );
  }
  return port;
}
