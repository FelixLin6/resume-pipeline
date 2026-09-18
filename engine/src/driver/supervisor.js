// WIP — Phase 1 scaffold. Browser-death supervisor.
// Design: engine/design/architecture.md §5.
//
// The recorded lesson this exists for: a wedged Chrome (process ALIVE at
// ~100% CPU, CDP dead) is NOT the same condition as a dead Chrome, and the
// two need different responses. Restarting a wedged one re-wedges it, because
// exit_type=Crashed makes the profile restore the dead tabs (2026-09-08, 3x).
//
// And in every case: re-attach, do NOT restart the run. On 2026-09-07 three
// CDP deaths burned all permitted restarts and 7 keys were never attempted.

import { resolveEndpoint } from './endpoint.js';

export const DEATH = Object.freeze({
  WEDGED: 'wedged',        // process alive, CDP unresponsive
  GONE: 'gone',            // process absent, connection refused
  PAGE_CRASH: 'page-crash',// renderer died, browser fine
});

const BACKOFF_MS = [2000, 8000, 30000];

export class Supervisor {
  /**
   * @param {object} o
   * @param {number} o.port
   * @param {import('./attach.js').ApplierContexts} o.contexts
   * @param {import('../events/emitter.js').EventStream} o.events
   * @param {(port:number)=>Promise<object>} o.reattach  attach() injected
   */
  constructor({ port, contexts, events, reattach }) {
    this.port = port;
    this.contexts = contexts;
    this.events = events;
    this.reattach = reattach;
    this.attempts = 0;
    this.watching = false;
  }

  watch(browser) {
    if (this.watching) return;
    this.watching = true;
    browser.on('disconnected', () => {
      this.events?.emit('driver_event', { kind: 'browser_died', detail: 'cdp disconnected' });
    });
  }

  /**
   * Distinguish the two deaths. A wedged browser still has a listening socket
   * but stops answering; a dead one refuses the connection outright.
   */
  async classify() {
    try {
      await resolveEndpoint(this.port, { timeoutMs: 3000 });
      return null;                 // healthy
    } catch {
      // Phase 1 stub: both surface as unreachable over HTTP. Phase 2 checks
      // the pidfile — a live pid whose CDP is dead is WEDGED (needs a
      // profile-clean restart by the orchestrator, NOT a plain restart);
      // an absent pid is GONE (wait for restart, then re-attach).
      return DEATH.GONE;
    }
  }

  /**
   * Re-attach and rebuild contexts from saved storageState. Bounded: 3 tries,
   * then give up and let every in-flight job be emitted as outcome "retry",
   * which the existing retry-queue already re-waves.
   */
  async recover(applierTenants = new Map()) {
    while (this.attempts < BACKOFF_MS.length) {
      const wait = BACKOFF_MS[this.attempts++];
      await new Promise((r) => setTimeout(r, wait));
      try {
        const { browser } = await this.reattach(this.port);
        this.contexts.browser = browser;
        for (const [applier, tenant] of applierTenants) {
          await this.contexts.create(applier, { tenant });
        }
        this.events?.emit('driver_event', {
          kind: 'reattached',
          detail: `after ${this.attempts} attempt(s), ${applierTenants.size} context(s) rebuilt`,
        });
        this.attempts = 0;
        this.watch(browser);
        return browser;
      } catch {
        // keep backing off
      }
    }
    return null;   // caller emits application_ended{outcome:"retry"} per job
  }
}
