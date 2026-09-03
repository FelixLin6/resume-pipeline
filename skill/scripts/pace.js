/**
 * pace — human-pacing layer for ats-fill.js (opt-in via --pace).
 *
 * Targets the passive scorers (Ashby spam score, reCAPTCHA v3, fingerprint
 * timing heuristics), which read event cadence: instant programmatic fills,
 * zero mouse travel, and metronomic field-to-field timing are the tells.
 * Explicit puzzles (hCaptcha, DataDome) are out of scope — hard wall.
 *
 * What it changes when enabled:
 *   - log-normal "reading" pause before each field, occasional long pause
 *   - mouse travels a jittered 2-3 point path to the element, hovers, clicks
 *   - text goes in as per-character real keystrokes (press) with jittered
 *     inter-key gaps, not one instant fill; value verified, one fill fallback
 *   - the fixed combobox sleeps get jitter instead of constants
 *
 * Everything no-ops when disabled or in --dry-run, so the unpaced path stays
 * byte-identical to the Greenhouse-tested behavior.
 */

const state = {
  enabled: false,
  dry: false,
  ab: null,          // agent-browser runner injected by ats-fill.js
  mouse: null,       // last known mouse position {x, y}
};

const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, Math.round(ms)));

// One gaussian sample (Box-Muller).
function gauss() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Log-normal-ish delay centered on `mid`, clamped to [lo, hi].
function jitter(lo, mid, hi) {
  const x = mid * Math.exp(gauss() * 0.35);
  return Math.min(hi, Math.max(lo, x));
}

function init({ enabled, dry, ab }) {
  state.enabled = !!enabled && !dry;
  state.dry = !!dry;
  state.ab = ab;
}

// Pause between fields: mostly sub-second, sometimes a real reading pause.
function fieldPause() {
  if (!state.enabled) return;
  if (Math.random() < 0.07) sleep(jitter(2200, 3400, 6500));
  else sleep(jitter(350, 850, 2000));
}

function microPause() {
  if (state.enabled) sleep(jitter(60, 130, 320));
}

// Jittered replacement for the fixed sleeps in pick(); passes through the
// constant when pacing is off so unpaced timing is unchanged.
function paceSleep(ms) {
  sleep(state.enabled ? jitter(ms * 0.7, ms * 1.1, ms * 2.2) : ms);
}

function box(ref) {
  const r = state.ab('get', 'box', '@' + ref, '--json');
  try {
    const j = JSON.parse((r.out.match(/\{[^]*\}/) || ['{}'])[0]);
    const b = j.box || j.data || j;
    if (typeof b.x === 'number' && typeof b.width === 'number') return b;
  } catch { /* fall through */ }
  return null;
}

// Move the mouse to the element along a short jittered path, then hover.
// Best-effort: any failure just falls back to the plain click in the caller.
function approach(ref) {
  if (!state.enabled) return;
  state.ab('scrollintoview', '@' + ref);
  microPause();
  const b = box(ref);
  if (!b) return;
  const tx = b.x + b.width * (0.3 + Math.random() * 0.4);
  const ty = b.y + b.height * (0.35 + Math.random() * 0.3);
  const from = state.mouse || { x: tx + (Math.random() - 0.5) * 600, y: ty + 200 + Math.random() * 300 };
  const steps = 2 + (Math.random() < 0.5 ? 1 : 0);
  for (let i = 1; i <= steps; i++) {
    const t = i / (steps + 1);
    const mx = from.x + (tx - from.x) * t + (Math.random() - 0.5) * 40 * (1 - t);
    const my = from.y + (ty - from.y) * t + (Math.random() - 0.5) * 30 * (1 - t);
    state.ab('mouse', 'move', String(Math.round(mx)), String(Math.round(my)));
    sleep(jitter(25, 60, 140));
  }
  state.ab('mouse', 'move', String(Math.round(tx)), String(Math.round(ty)));
  state.mouse = { x: tx, y: ty };
  microPause();
}

/**
 * Paced replacement for ab('fill', @ref, value): approach, click, clear,
 * per-character keystrokes, verify. Returns {ok} like ab(). Falls back to
 * one plain fill if the typed value doesn't verify (autocomplete widgets).
 *
 * `press <char>` is the only primitive that dispatches real keydown/keyup
 * (verified 2026-09-03 on this agent-browser build: `type` and
 * `keyboard type` insert text with input events only — no key events, which
 * is exactly the tell passive scorers look for). CLI round-trip is ~7ms via
 * the daemon socket, so per-char calls are affordable.
 */
function typeInto(ref, value) {
  const v = String(value);
  if (!state.enabled) return state.ab('fill', '@' + ref, v);
  approach(ref);
  state.ab('click', '@' + ref);
  microPause();
  state.ab('fill', '@' + ref, '');           // clear (fields are usually empty; invisible when so)
  let ok = true;
  for (const c of v) {
    // press handles printable ASCII (verified incl. space/@/./:/uppercase);
    // anything else goes through type for that one character.
    const r = (c >= ' ' && c <= '~') ? state.ab('press', c) : state.ab('type', '@' + ref, c);
    ok = ok && r.ok;
    sleep(jitter(25, 75, 240) + (c === ' ' && Math.random() < 0.3 ? jitter(60, 120, 300) : 0));
  }
  const got = state.ab('get', 'value', '@' + ref).out.trim();
  if (!ok || (got && got !== v && !got.includes(v) && !v.includes(got))) {
    const r = state.ab('fill', '@' + ref, v);  // fallback: behavior parity with unpaced path
    return { ok: r.ok, out: r.out + ' [pace: typed value did not verify, fell back to fill]' };
  }
  return { ok: true, out: '' };
}

// Paced click for comboboxes/options: approach first, then click.
function click(ref) {
  if (state.enabled) approach(ref);
  return state.ab('click', '@' + ref);
}

module.exports = { init, fieldPause, microPause, paceSleep, typeInto, click, enabled: () => state.enabled };
