// The click-lands-where-you-think-it-does guard.
//
// F21, and the reason this file exists, verbatim from the 2026-09-17 ledger:
//
//   "Kitware was submitted by accident during the Stage 4 staging pass. Its
//    Lever hCaptcha was rendered at invisible size, so the click intended to
//    land ON the widget (to park the tab on it for Felix) passed through to the
//    SUBMIT APPLICATION button underneath and filed the application …
//    Unintended: no human reviewed the essays before they went out. … Lesson:
//    an invisible-size captcha widget is not a safe parking target — park on a
//    neighbouring element, never on the overlay itself."
//
// Note what actually happened: the click was aimed at the CAPTCHA and hit the
// BUTTON. The engine's exposure is the mirror image — a click aimed at the
// button that lands on a captcha, or a click aimed at the button that lands on
// the button while a solved-looking captcha is in fact unsolved. Both are the
// same defect: nobody asked what is actually on top at that point.
//
// So this is a HIT TEST, not a visibility check. `isVisible()` was the check
// that would have missed Kitware entirely: recon on the same Lever tenant shows
// the hCaptcha enclave iframe present at 1350×900 — a FULL-VIEWPORT overlay —
// while the form underneath looks perfectly clickable. Whether that overlay
// swallows a click is a question about hit-testing, and `document
// .elementFromPoint` is the only thing that answers it honestly.
//
// Ownership: the ENGINE performs the test and decides (interfaces.md §1 — wall
// detection dispatch is engine-owned); the ADAPTER only declares which
// selectors are its submit control and which are its captcha wrappers.

/** Does this element look like a captcha overlay? Matched page-side. */
/* c8 ignore start — serialized into the page */
function describeTopmost(el) {
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  const cx = Math.round(r.left + r.width / 2);
  const cy = Math.round(r.top + r.height / 2);
  const doc = el.ownerDocument;
  const top = doc.elementFromPoint(cx, cy);

  const describe = (n) => {
    if (!n) return null;
    const s = getComputedStyle(n);
    const nr = n.getBoundingClientRect();
    return {
      tag: n.tagName.toLowerCase(),
      id: n.id || null,
      className: typeof n.className === 'string' ? n.className.slice(0, 120) : null,
      title: n.getAttribute?.('title') ?? null,
      src: (n.getAttribute?.('src') ?? '').slice(0, 200) || null,
      visibility: s.visibility,
      opacity: s.opacity,
      pointerEvents: s.pointerEvents,
      zIndex: s.zIndex,
      rect: { w: Math.round(nr.width), h: Math.round(nr.height) },
    };
  };

  return {
    target: describe(el),
    targetRect: { x: cx, y: cy, w: Math.round(r.width), h: Math.round(r.height) },
    topmost: describe(top),
    // The three ways "the click reaches the button" can be true.
    hits: top === el || el.contains(top) || (top ? top.contains(el) : false),
    inViewport: r.width > 0 && r.height > 0
      && cy >= 0 && cy <= (doc.defaultView?.innerHeight ?? 0)
      && cx >= 0 && cx <= (doc.defaultView?.innerWidth ?? 0),
  };
}
/* c8 ignore stop */

const CAPTCHA_SRC = /hcaptcha|recaptcha|turnstile|captcha-delivery|arkoselabs|funcaptcha/i;
const CAPTCHA_TITLE = /captcha|security challenge|widget containing checkbox/i;
const CAPTCHA_CLASS = /captcha|challenge/i;

/** Classify what is sitting on top of the submit control. */
export function classifyTopmost(top, extraSelectorsHit = false) {
  if (!top) return { captcha: false, wallClass: null, why: 'nothing hit-tested at that point' };
  const hay = `${top.src ?? ''} ${top.title ?? ''} ${top.className ?? ''} ${top.id ?? ''}`;
  const looksCaptcha = CAPTCHA_SRC.test(hay) || CAPTCHA_TITLE.test(hay)
    || CAPTCHA_CLASS.test(top.className ?? '') || extraSelectorsHit;
  if (!looksCaptcha) return { captcha: false, wallClass: null, why: `covered by <${top.tag}>` };
  const wallClass = /hcaptcha/i.test(hay) ? 'hcaptcha'
    : /recaptcha/i.test(hay) ? 'recaptcha-interactive'
      : /captcha-delivery/i.test(hay) ? 'datadome'
        : 'unknown-challenge';
  return { captcha: true, wallClass, why: `covered by a captcha overlay (<${top.tag}>)` };
}

/**
 * Probe what a click on `selector` would actually hit.
 *
 * @param {object} root    page or FrameLocator holding the control
 * @param {string} selector
 * @returns {Promise<object|null>} null when the control is not present
 */
export async function probeClickTarget(root, selector) {
  const loc = root.locator(selector).first();
  if (!(await loc.count())) return null;
  return loc.evaluate(describeTopmost);
}

/**
 * Read the captcha wrapper's own state, so the record says WHY a submit was
 * refused in terms of the widget rather than only in terms of geometry.
 *
 * `responseSelector` is the hidden input the ATS posts the token in — on Lever
 * that is `#hcaptchaResponseInput`, observed live. An EMPTY token with a
 * present widget is the signature of "the challenge has not been answered",
 * which is precisely the state in which a submit must not be attempted.
 */
export async function readCaptchaState(root, { wrapperSelectors = [], responseSelector = null } = {}) {
  const wrappers = [];
  for (const sel of wrapperSelectors) {
    const loc = root.locator(sel).first();
    // eslint-disable-next-line no-await-in-loop
    if (!(await loc.count())) continue;
    // eslint-disable-next-line no-await-in-loop
    const info = await loc.evaluate((el) => {
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return {
        visibility: s.visibility, opacity: s.opacity, display: s.display,
        pointerEvents: s.pointerEvents,
        w: Math.round(r.width), h: Math.round(r.height),
      };
    }).catch(() => null);
    if (info) wrappers.push({ selector: sel, ...info });
  }

  let token = null;
  if (responseSelector) {
    const loc = root.locator(responseSelector).first();
    if (await loc.count()) {
      token = await loc.inputValue().catch(() => null);
    }
  }

  return {
    wrappers,
    token_present: typeof token === 'string' ? token.length > 0 : null,
    // Never the token itself: it is a bearer credential for the challenge.
    token_len: typeof token === 'string' ? token.length : null,
  };
}

export class SubmitObstructed extends Error {
  constructor(msg, detail) { super(msg); this.detail = detail; }
}

/**
 * THE GATE. Called by the engine immediately before any submit-labelled
 * control is clicked, on every ATS — this is not a Lever quirk, it is a
 * property of clicking things on the internet.
 *
 * Emits `wall_detected{where:"submit"}` when a captcha would eat the click, and
 * throws. A caller cannot proceed past it, by construction: there is no return
 * value that means "obstructed but go ahead".
 *
 * @param {object} o
 * @param {object} o.root       page or FrameLocator
 * @param {object} o.events     EventStream
 * @param {string} o.submitSelector
 * @param {object} [o.captcha]  adapter's declared wrapper/response selectors
 * @param {object} [o.wallMemory]
 * @param {string} [o.tenant]
 */
export async function assertSubmitClickable({
  root, events, submitSelector, captcha = {}, wallMemory = null, tenant = null,
}) {
  const probe = await probeClickTarget(root, submitSelector);
  if (!probe) {
    throw new SubmitObstructed(
      `refusing to submit: the submit control (${submitSelector}) is not present`,
      { selector: submitSelector },
    );
  }

  const state = await readCaptchaState(root, captcha);

  if (probe.hits) {
    // The click lands on the button. Record the widget state anyway: a stream
    // that shows the guard ran is the difference between "we checked" and "it
    // happened to work", and the Kitware incident is what that distinction
    // costs when it is missing.
    events.emit('adapter_note', {
      msg: 'submit click-target verified: the click lands on the submit control',
      extra: {
        selector: submitSelector,
        topmost: probe.topmost?.tag ?? null,
        captcha_wrappers: state.wrappers.length,
        captcha_token_present: state.token_present,
      },
    });
    return { ok: true, probe, state };
  }

  const cls = classifyTopmost(probe.topmost);

  if (cls.captcha) {
    const where = 'submit';
    let action = null;
    if (wallMemory && tenant) {
      wallMemory.record(tenant, cls.wallClass, where);
      action = wallMemory.decide(tenant, cls.wallClass, where);
      wallMemory.save();
    }
    events.emit('wall_detected', {
      wall_class: cls.wallClass,
      where,
      marker: `elementFromPoint:<${probe.topmost.tag}${probe.topmost.title ? ` title="${probe.topmost.title}"` : ''}>`,
      tenant_prior_walls: wallMemory && tenant
        ? Math.max(0, wallMemory.effectiveOccurrences(tenant, cls.wallClass, where) - 1) : 0,
      ...(action ? { action } : {}),
      // The evidence that makes this reviewable later: the overlay was
      // full-viewport and invisible, or zero-sized, or pointer-events:none.
      detail: {
        overlay: probe.topmost,
        captcha_token_present: state.token_present,
        wrappers: state.wrappers,
      },
    });
    throw new SubmitObstructed(
      `refusing to submit: ${cls.why}. A click here would land on the captcha, not the button ` +
      '(F21: the mirror of this is how Kitware was filed unreviewed on 2026-09-17).',
      { wallClass: cls.wallClass, probe, state },
    );
  }

  // Obstructed by something that is NOT a captcha — a cookie banner, a modal.
  // Not a wall, so no wall event: calling it one would poison the tenant's wall
  // memory with an obstruction that has nothing to do with bot defences.
  events.emit('adapter_note', {
    msg: 'submit click-target obstructed by a non-captcha element',
    extra: { selector: submitSelector, topmost: probe.topmost, why: cls.why },
  });
  throw new SubmitObstructed(
    `refusing to submit: ${cls.why}. The engine never clicks through an overlay.`,
    { wallClass: null, probe, state },
  );
}
