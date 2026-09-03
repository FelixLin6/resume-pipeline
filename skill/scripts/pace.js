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
 *   - text goes in as real keystrokes with jittered gaps, not one instant
 *     fill — per-char press or 2-5 char type bursts, probed per run (builds
 *     differ, see probeStrategy); value verified, one fill fallback
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
  strategy: null,    // 'press' | 'type' — probed once per run (builds differ)
  hoverOnly: false,  // true once get box @ref proves unsupported on this build
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
  if (/unsupported token|parsing css selector/i.test(r.out)) {
    state.hoverOnly = true;
    console.error('pace: get box @ref unsupported on this agent-browser build — mouse mode=hover-only');
    return null;
  }
  try {
    const j = JSON.parse((r.out.match(/\{[^]*\}/) || ['{}'])[0]);
    const b = j.box || j.data || j;
    if (typeof b.x === 'number' && typeof b.width === 'number') return b;
  } catch { /* fall through */ }
  return null;
}

// Move the mouse to the element along a short jittered path, then hover.
// Best-effort: on builds where `get box @ref` is unsupported (e.g. 0.9.4
// rejects @refs there), fall back to hover — it still moves the real mouse.
function approach(ref) {
  if (!state.enabled) return;
  state.ab('scrollintoview', '@' + ref);
  microPause();
  const b = state.hoverOnly ? null : box(ref);
  if (!b) {
    state.ab('hover', '@' + ref);   // still real mouse travel, just no jittered path
    microPause();
    return;
  }
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
 * agent-browser builds diverge on which primitives dispatch real key events
 * (2026-09-03, joint review with zylos-felix-cloud): on 0.35.1 (Mac) `type`
 * and `keyboard type` insert text with input events ONLY — no keydown/keyup,
 * exactly the tell passive scorers read — and only per-char `press` produces
 * them (~7ms round-trip, affordable). On 0.9.4 (droplet) `type` DOES
 * dispatch real key events and a CLI round-trip is ~266ms, so per-char
 * press there is both slow and metronomic. So: probe once per run with a
 * throwaway offscreen input, then use chunked `type` where it's proven
 * eventful and per-char `press` only where `type` is eventless.
 */
function probeStrategy() {
  if (state.strategy) return state.strategy;
  const arm = "(()=>{const i=document.createElement('input');i.id='__pace_probe';i.type='text';" +
    "i.style.cssText='position:fixed;top:0;left:0;opacity:0.01;z-index:-1';window.__paceProbeKd=0;" +
    "i.addEventListener('keydown',()=>window.__paceProbeKd++);document.body.appendChild(i);return 'armed'})()";
  const read = "(()=>{const n=window.__paceProbeKd|0;const i=document.getElementById('__pace_probe');" +
    "if(i)i.remove();delete window.__paceProbeKd;return 'kd='+n})()";
  let kd = -1;
  if (state.ab('eval', arm).out.includes('armed')) {
    state.ab('type', '#__pace_probe', 'ab');
    const m = state.ab('eval', read).out.match(/kd=(\d+)/);
    if (m) kd = +m[1];
  }
  state.strategy = kd >= 2 ? 'type' : 'press';
  console.error(`pace: typing strategy=${state.strategy === 'type' ? 'chunked-type' : 'per-char-press'} (probe keydowns=${kd < 0 ? 'probe failed' : kd} for 2 chars)`);
  return state.strategy;
}

/**
 * Paced replacement for ab('fill', @ref, value): approach, click, clear,
 * real keystrokes with jittered gaps, verify. Returns {ok} like ab().
 * Falls back to one plain fill if the typed value doesn't verify
 * (controlled inputs rejecting keyed state, maxlength truncation,
 * autocomplete stealing the tail — all end up at unpaced-parity behavior).
 */
function typeInto(ref, value) {
  const v = String(value);
  if (!state.enabled) return state.ab('fill', '@' + ref, v);
  const strategy = probeStrategy();
  approach(ref);
  state.ab('click', '@' + ref);
  microPause();
  state.ab('fill', '@' + ref, '');           // clear (fields are usually empty; invisible when so)
  let ok = true;
  if (strategy === 'type') {
    // one spawn per 2-5 char burst; type itself dispatches key events here
    let i = 0;
    while (i < v.length) {
      const n = 2 + Math.floor(Math.random() * 4);
      const r = state.ab('type', '@' + ref, v.slice(i, i + n));
      ok = ok && r.ok;
      i += n;
      sleep(jitter(60, 140, 400));
    }
  } else {
    for (const c of v) {
      // press handles printable ASCII (verified incl. space/@/./:/uppercase);
      // anything else goes through type for that one character.
      const r = (c >= ' ' && c <= '~') ? state.ab('press', c) : state.ab('type', '@' + ref, c);
      ok = ok && r.ok;
      sleep(jitter(25, 75, 240) + (c === ' ' && Math.random() < 0.3 ? jitter(60, 120, 300) : 0));
    }
  }
  const got = state.ab('get', 'value', '@' + ref).out.trim();
  // Strict verify (cloud review, 2026-09-03): empty read-back and prefix
  // truncation must NOT pass. got may legitimately extend v (autocomplete
  // reformatting, e.g. "Irvine" -> "Irvine, CA"), so containment one way only.
  const verified = got === v || got.includes(v);
  if (!ok || !verified) {
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
