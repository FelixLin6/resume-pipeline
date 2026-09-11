#!/bin/bash
# sleep-guard.sh — session-start safety net for zylos-sleepctl (Mac only).
# If sleep prevention is still armed but no pipeline run is in flight
# (no agent-browser daemon alive), disarm it. If a run IS in flight, leave
# it armed — session rotations mid-run must not drop lid-close protection.
# Silent no-op on Linux, or where the wrapper / sudoers rule isn't installed.
CTL=/usr/local/bin/zylos-sleepctl
[ "$(uname)" = "Darwin" ] || exit 0
[ -x "$CTL" ] || exit 0
sudo -n "$CTL" status 2>/dev/null | grep -q 'SleepDisabled[[:space:]]*1' || exit 0
if pgrep -f 'agent-browser-darwin' >/dev/null 2>&1; then
  echo "[sleep-guard] armed + run in flight — leaving armed"
  exit 0
fi
sudo -n "$CTL" disarm
echo "[sleep-guard] stale arm with no run in flight — disarmed"
