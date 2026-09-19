// Step-graph navigation. Design: interfaces.md §2 (steps/identifyStep/advance).
//
// The adapter DESCRIBES the graph; the engine walks it. The adapter's
// `advance` implements the click and the wait, but it may never decide an
// outcome — a step that will not advance is a blocked step, and what to do
// about it is the engine's call.
//
// Never a bare sleep and never a coordinate click: both are compensations for
// not knowing what you are waiting for, and both are in the recorded failure
// list (a coordinate click is what passed THROUGH an invisible hCaptcha and
// filed an application unreviewed on 2026-09-17). The settle loop below is a
// bounded poll on two NAMED conditions — a step change, or a wall marker
// becoming visible — which is the non-sleep way to wait.
//
// ---------------------------------------------------------------------------
// THE CESI FALSE CLEAN (2026-09-17), and the two rules it forced
// ---------------------------------------------------------------------------
// Shadow-fill on jobs-cesi.icims.com/jobs/11219: Next was clicked, the ledger
// says the hCaptcha fired on this tenant that day, and the stream recorded
// wall: null, outcome: assist. Confirmed independently on both sides of Gate 1.
// Two structural causes, both in this file's old code:
//
//  RULE 1 — WALL STEPS ARE EVALUATED FIRST, AND SHORT-CIRCUIT.
//    identifyStep ranked steps by COUNT of matching markers. guest-apply
//    carries 3 markers (login URL, #enterEmailSubmitButton, "Enter Your
//    Information") and ALL THREE stay true while the challenge overlays the
//    same page; captcha-gate carries 1. So guest-apply won 3–1 every time the
//    challenge was visible, and captcha-gate was unreachable BY CONSTRUCTION.
//    A wall is not one candidate among steps — it preempts them: a page with a
//    live challenge on it IS the challenge, whatever else is still rendered
//    underneath. Non-wall steps are ranked by marker SPECIFICITY (a selector
//    outranks a text probe outranks a URL shape), not by count.
//
//  RULE 2 — AN ADVANCE IS NOT OVER WHEN THE CLICK RETURNS.
//    icims.advance() awaited domcontentloaded on the TOP-LEVEL page while the
//    form lives in iframe#icims_content_iframe, so it resolved in 66–74 ms
//    (measured across six tenants) — before either the in-frame transition or
//    the challenge frame could render. advanceStep now SETTLES: it polls, up
//    to a bounded window, for a step change or a wall marker inside the
//    correct frame, and classifies the wall with where:'advance:<step>' BEFORE
//    concluding anything. A "no progress" that follows a full settle with no
//    wall and no blocker is reported as exactly that — and the caller must
//    treat it as SUSPECT, never as a clean stop.

import { classifyPage } from './preflight.js';

export class StepUnknown extends Error {}

/** Match one declarative marker against the current page/frame.
 *
 *  `requireVisible` is honoured here for the same reason detectWall honours
 *  it: the iCIMS challenge iframe is in the DOM, DORMANT, on every page of
 *  the flow. A wall step keyed to its presence would identify every page as
 *  the captcha gate; keyed to visibility it identifies only a fired one. */
async function markerHits(marker, { page, root }) {
  if (marker.urlPattern) {
    if (!marker.urlPattern.test(page.url())) return false;
  }
  if (marker.selector) {
    const loc = root.locator(marker.selector).first();
    const n = await loc.count();
    if (n === 0) return false;
    if (marker.requireVisible && !(await loc.isVisible().catch(() => false))) return false;
  }
  if (marker.text) {
    const body = await root.locator('body').first().innerText().catch(() => '');
    if (!marker.text.test(body)) return false;
  }
  return !!(marker.urlPattern || marker.selector || marker.text);
}

/** Marker specificity. A selector names one element; a text probe names a
 *  phrase that survives overlays and re-renders; a URL shape names a whole
 *  route. Ranking by the sum of these is what stops three weak markers from
 *  outvoting one precise one — the exact arithmetic of the cesi false clean. */
function markerWeight(marker) {
  let w = 0;
  if (marker.selector) w += 4;
  if (marker.text) w += 2;
  if (marker.urlPattern) w += 1;
  return w;
}

/**
 * Identify the current step from the adapter's declarative markers.
 *
 * Wall steps (`isWall: true` in the step spec) are evaluated FIRST and
 * short-circuit on any hit (Rule 1). Everything else is scored by specificity.
 * Returns null for an unknown page — which hands control to the model-driven
 * fallback (architecture.md §7) rather than guessing a step.
 */
export async function identifyStep(adapter, { page, root }) {
  // Rule 1: a live wall preempts every form step.
  for (const step of adapter.steps.filter((s) => s.isWall)) {
    for (const m of step.markers ?? []) {
      // eslint-disable-next-line no-await-in-loop
      if (await markerHits(m, { page, root })) return step.id;
    }
  }

  const scored = [];
  for (const step of adapter.steps) {
    if (step.isWall) continue;
    let score = 0;
    for (const m of step.markers ?? []) {
      // eslint-disable-next-line no-await-in-loop
      if (await markerHits(m, { page, root })) score += markerWeight(m);
    }
    if (score) scored.push({ step, score });
  }
  if (!scored.length) return null;
  scored.sort((a, b) => b.score - a.score
    || adapter.steps.indexOf(a.step) - adapter.steps.indexOf(b.step));
  return scored[0].step.id;
}

/**
 * Advance from the current step, then SETTLE, then re-identify (Rule 2).
 *
 * The adapter performs the transition; the engine decides what the result
 * MEANS — including whether a wall fired while the adapter's own wait was
 * already satisfied.
 *
 * @returns {Promise<{to:string|null, blockedBy:object[],
 *                    wall:{wallClass:string, marker:string}|null,
 *                    settled:boolean}>}
 *   `settled` is true when the loop observed a definite outcome (a step
 *   change or a wall) rather than running out its window.
 */
export async function advanceStep(adapter, ctx, from, {
  events, page, root, settleMs = 8000, pollMs = 250,
  wallMemory = null, tenant = null,
}) {
  const t0 = Date.now();
  const result = await adapter.advance(ctx, from);
  const blocked = result?.blockedBy ?? [];

  let to = result?.to ?? null;
  let wall = null;
  let settled = false;

  // The settle loop. Bounded, and polling on two NAMED conditions — never a
  // bare sleep. The measured gap is small — the adapter's own wait resolved in
  // 66–74 ms while the in-frame transition (and the challenge frame's render)
  // takes on the order of a second — but the window is sized for the SLOW
  // tail, not the median: hCaptcha's execute() round-trip goes out to
  // hcaptcha.com before either passing silently or raising the challenge
  // (the VM's caution), and a loaded machine stretches both the page's own
  // timers and each poll iteration (a 3s window missed an 800ms fire under
  // parallel test load). The window is only ever run OUT on the stall path,
  // so its width costs nothing on the fired or advanced paths.
  const deadline = t0 + settleMs;
  for (;;) {
    // Wall first. A challenge that fired must be NAMED before any step guess:
    // classifying after identifying is how a wall gets recorded as a step that
    // merely failed to change.
    // eslint-disable-next-line no-await-in-loop
    wall = await classifyPage({ page, root, status: null, headers: {}, adapter }).catch(() => null);
    if (wall) { settled = true; break; }

    // eslint-disable-next-line no-await-in-loop
    const now = await identifyStep(adapter, { page, root });
    if (now && now !== from) { to = now; settled = true; break; }

    if (Date.now() >= deadline) {
      // Window exhausted with no wall and no step change. Believe the
      // adapter's asserted `to` if it gave one; otherwise report what we see.
      to = (to && to !== from) ? to : (now ?? to);
      break;
    }
    // eslint-disable-next-line no-await-in-loop
    await page.waitForTimeout(pollMs);
  }

  if (wall) {
    const where = `advance:${from}`;
    let action = null;
    if (wallMemory && tenant) {
      const entry = wallMemory.record(tenant, wall.wallClass, where);
      action = wallMemory.decide(tenant, wall.wallClass, where);
      wallMemory.save();
      events.emit('wall_detected', {
        wall_class: wall.wallClass, where,
        marker: String(wall.marker).slice(0, 120),
        tenant_prior_walls: entry.occurrences - 1,
        action,
      });
    } else {
      events.emit('wall_detected', {
        wall_class: wall.wallClass, where,
        marker: String(wall.marker).slice(0, 120),
        tenant_prior_walls: 0,
      });
    }
    // Re-identify so a declared wall STEP (iCIMS captcha-gate) is named as the
    // destination; an ATS with no wall step stays on `from`, with the wall
    // object carrying what happened.
    to = await identifyStep(adapter, { page, root }) ?? from;
  }

  events.emit('page_advanced', {
    from,
    to: to ?? null,
    url: page.url(),
    elapsed_ms: Date.now() - t0,
    blocked_by: blocked.map((b) => ({ field: b.field ?? null, message: String(b.message).slice(0, 200) })),
    ...(wall ? { wall_class: wall.wallClass } : {}),
    settled,
  });

  return { to: to ?? null, blockedBy: blocked, wall, settled };
}

/** Steps that may legitimately not appear on a given tenant. iCIMS tenants
 *  run 3-5 profile steps depending on configuration, so a missing optional
 *  step is data, not an error. */
export function isOptional(adapter, stepId) {
  return !!adapter.steps.find((s) => s.id === stepId)?.optional;
}

export function stepSpec(adapter, stepId) {
  return adapter.steps.find((s) => s.id === stepId) ?? null;
}
