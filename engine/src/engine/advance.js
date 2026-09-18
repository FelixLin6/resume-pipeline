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
// filed an application unreviewed on 2026-09-17).

export class StepUnknown extends Error {}

/** Match one declarative marker against the current page/frame. */
async function markerHits(marker, { page, root }) {
  if (marker.urlPattern) {
    if (!marker.urlPattern.test(page.url())) return false;
  }
  if (marker.selector) {
    const n = await root.locator(marker.selector).count();
    if (n === 0) return false;
  }
  if (marker.text) {
    const body = await root.locator('body').first().innerText().catch(() => '');
    if (!marker.text.test(body)) return false;
  }
  return !!(marker.urlPattern || marker.selector || marker.text);
}

/**
 * Identify the current step from the adapter's declarative markers.
 * Returns null for an unknown page — which hands control to the model-driven
 * fallback (architecture.md §7) rather than guessing a step.
 */
export async function identifyStep(adapter, { page, root }) {
  const scored = [];
  for (const step of adapter.steps) {
    let hits = 0;
    for (const m of step.markers ?? []) {
      // eslint-disable-next-line no-await-in-loop
      if (await markerHits(m, { page, root })) hits++;
    }
    if (hits) scored.push({ step, hits });
  }
  if (!scored.length) return null;
  scored.sort((a, b) => b.hits - a.hits
    || adapter.steps.indexOf(a.step) - adapter.steps.indexOf(b.step));
  return scored[0].step.id;
}

/**
 * Advance from the current step, then re-identify. The adapter performs the
 * transition; the engine decides what the result MEANS.
 */
export async function advanceStep(adapter, ctx, from, { events, page, root }) {
  const t0 = Date.now();
  const result = await adapter.advance(ctx, from);
  const to = result?.to ?? await identifyStep(adapter, { page, root });

  const blocked = result?.blockedBy ?? [];
  events.emit('page_advanced', {
    from,
    to: to ?? null,
    url: page.url(),
    elapsed_ms: Date.now() - t0,
    blocked_by: blocked.map((b) => ({ field: b.field ?? null, message: String(b.message).slice(0, 200) })),
  });

  return { to: to ?? null, blockedBy: blocked };
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
