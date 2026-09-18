// WIP — Phase 1 scaffold. CDP attach + context-per-applier.
// Design: engine/design/architecture.md §2-§4.

import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { resolveEndpoint } from './endpoint.js';

/**
 * Attach to an ALREADY-RUNNING browser over CDP.
 *
 * There is deliberately no `launch` option and no launch fallback. On the
 * current stack the tool would silently launch a private browser after a
 * failed connect and every subsequent fill landed in it — invisible, because
 * it printed "launched browser" on success too. Here, a failed attach throws.
 */
export async function attach({ port, events = null, timeoutMs = 3000 }) {
  const ep = await resolveEndpoint(port, { timeoutMs });
  const browser = await chromium.connectOverCDP(ep.base);

  // Identity is asserted, not assumed. The Playwright handle IS the identity —
  // there is no session-name indirection that could point at another browser,
  // which is what the about:blank#<session>-handshake ritual was compensating
  // for on the current stack.
  events?.emit('driver_event', {
    kind: 'attached',
    detail: `${ep.base} ${ep.version.Browser ?? ''}`.trim(),
  });

  return { browser, endpoint: ep };
}

/**
 * One isolated BrowserContext per applier.
 *
 * Why not a shared context: on the current stack every applier shared one
 * browser and addressed pages by TAB INDEX. Session tab-pointers jumped to
 * whichever tab was newest, and on 2026-09-12 an applier's upload attached
 * the wrong company's PDF to a live application in a sibling's tab. With a
 * context per applier there is no shared index space to drift within.
 */
export class ApplierContexts {
  constructor({ browser, events = null, stateDir = null }) {
    this.browser = browser;
    this.events = events;
    this.stateDir = stateDir;
    this.byApplier = new Map();
  }

  _storagePath(tenant) {
    if (!this.stateDir || !tenant) return null;
    const slug = tenant.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    return path.join(this.stateDir, 'storage', `${slug}.json`);
  }

  /**
   * Create an isolated context for one applier, optionally seeded with a
   * saved per-tenant storageState (so a re-attach after a browser death does
   * not require re-login).
   */
  async create(applier, { tenant = null } = {}) {
    const opts = {};
    const sp = this._storagePath(tenant);
    if (sp && fs.existsSync(sp)) {
      opts.storageState = sp;
      this.events?.emit('driver_event', { kind: 'storagestate_loaded', detail: tenant });
    }

    const ctx = await this.browser.newContext(opts);
    this.byApplier.set(applier, { ctx, tenant });
    this.events?.emit('driver_event', {
      kind: 'context_created',
      detail: `applier${applier}${tenant ? ` tenant=${tenant}` : ''}`,
    });
    return ctx;
  }

  /** Persist cookies/storage for a tenant after a successful login. */
  async saveState(applier) {
    const entry = this.byApplier.get(applier);
    if (!entry?.tenant) return null;
    const sp = this._storagePath(entry.tenant);
    if (!sp) return null;
    fs.mkdirSync(path.dirname(sp), { recursive: true });
    await entry.ctx.storageState({ path: sp });
    this.events?.emit('driver_event', { kind: 'storagestate_saved', detail: entry.tenant });
    return sp;
  }

  /**
   * Close ONE context, by handle, by its owner. There is no close-by-range
   * and no end-of-run sweep: a range close over a shared tab index killed a
   * sibling's in-flight application on 2026-09-02.
   */
  async close(applier) {
    const entry = this.byApplier.get(applier);
    if (!entry) return;
    await entry.ctx.close();
    this.byApplier.delete(applier);
    this.events?.emit('driver_event', { kind: 'context_closed', detail: `applier${applier}` });
  }

  get size() { return this.byApplier.size; }
}
