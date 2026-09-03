#!/bin/bash
# pace-gate.sh — stealth-path regression gate (see SKILL.md, Stage 2 notes).
# Run before deploying ANY change to pace.js / ats-fill.js / the stealth path,
# on EACH machine (agent-browser builds diverge: 0.35.1 Mac vs 0.9.4 droplet
# differ on which primitives dispatch key events and on get-box @ref support).
#
# Uses an isolated session + the bundled sandbox form; never touches the
# pipeline browser. Prints the agent-browser version, unpaced vs paced report
# parity, real keydown/mousemove counts, and the pace strategy log lines.
# Exits non-zero on report divergence or a paced run with no real key events.
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
FORM="file://$DIR/../assets/pace-test-form.html"
export AGENT_BROWSER_SESSION=pace-gate
TMP="$(mktemp -d)"
trap 'agent-browser close >/dev/null 2>&1; rm -rf "$TMP"' EXIT

echo "agent-browser: $(agent-browser --version 2>/dev/null || echo '?')"

ARM='window.__ev={kd:0,mm:0};document.addEventListener("keydown",()=>__ev.kd++,true);document.addEventListener("mousemove",()=>__ev.mm++,true);"armed"'
STATS='JSON.stringify(window.__ev)'

run() { # $1 = label, remaining args = extra ats-fill flags
  local label=$1; shift
  agent-browser open "$FORM" >/dev/null || { echo "gate: cannot open sandbox form"; exit 1; }
  agent-browser eval "$ARM" >/dev/null
  node "$DIR/ats-fill.js" generic --no-upload --no-eeo "$@" \
    >"$TMP/$label.out" 2>"$TMP/$label.err"
  grep -E '^(FILLED|PICKED|MISSED|SKIPPED) \(' "$TMP/$label.out" > "$TMP/$label.counts" || true
  agent-browser eval "$STATS" | tr -d '"\\' > "$TMP/$label.events"
  echo; echo "== $label =="
  cat "$TMP/$label.counts"
  echo "events: $(cat "$TMP/$label.events")"
  sed -n 's/^pace:/pace:/p' "$TMP/$label.err"
  grep -F 'pace fallback: fill' "$TMP/$label.out" | sed 's/^/fallback: /' || true
}

run unpaced
run paced --pace

echo
if ! diff -q "$TMP/unpaced.counts" "$TMP/paced.counts" >/dev/null; then
  echo "GATE FAIL: paced report diverges from unpaced:"
  diff "$TMP/unpaced.counts" "$TMP/paced.counts"
  exit 1
fi
KD=$(sed -n 's/.*kd:\([0-9]*\).*/\1/p' "$TMP/paced.events")
if [ "${KD:-0}" -lt 20 ]; then
  echo "GATE FAIL: paced run produced only ${KD:-0} real keydown events — typing is not dispatching key events on this build"
  exit 1
fi
echo "GATE PASS: report parity OK, paced keydowns=$KD"
