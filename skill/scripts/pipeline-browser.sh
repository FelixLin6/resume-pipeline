#!/bin/bash
# Shared pipeline browser lifecycle — the ONE way any orchestrator (Claude or
# Codex, Mac or droplet) starts/stops the job-application Chrome on CDP 9222.
#   pipeline-browser.sh start [--clean]|stop|status
#   `start --clean` (macOS): wipe Chrome's session-restore state first. A wedged
#   Chrome (alive, ~100% CPU, CDP dead) re-wedges on a plain restart because the
#   profile's exit_type=Crashed makes it restore the dead tabs (Mac 2026-09-08,
#   3×). start also auto-cleans when it finds exit_type=Crashed in Preferences.
# macOS: headless Chrome for Testing with the dedicated job-application profile
#        (decision 2026-09-01: headless because macOS steals app focus on every
#        tab switch). zylos-browser's display manager does NOT manage it.
# Linux (droplet): delegates to `zylos-browser display start/stop`.
set -euo pipefail
CDP=9222
PROFILE="$HOME/zylos/components/browser/job-application-profile"
MAC_CHROME="$HOME/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36"

alive() { curl -s -m 3 "localhost:$CDP/json/version" >/dev/null 2>&1; }
alive4() { curl -s -m 3 "127.0.0.1:$CDP/json/version" >/dev/null 2>&1; }
alive6() { curl -s -m 3 "http://[::1]:$CDP/json/version" >/dev/null 2>&1; }

# Kill processes matching a pattern WITHOUT self-immolation. `pkill -f` matches
# full command lines, so it also kills the caller whose own command mentions the
# pattern — e.g. a Stage 3 `agent-browser --session x close && pipeline-browser.sh
# stop` kills its own parent shell mid-teardown (found by zylos-felix-cloud
# 2026-09-02: its test shell died exit 144). Skip this script and its parent.
reap() {
  local pat="$1" pid
  for pid in $(pgrep -f "$pat" 2>/dev/null); do
    [ "$pid" = "$$" ] && continue
    [ "$pid" = "$PPID" ] && continue
    kill "$pid" 2>/dev/null || true
  done
}

# Chrome 149 for Testing binds the DevTools server to ::1 only, even with
# --remote-debugging-address=127.0.0.1 (seen 2026-09-02: agent-browser's default
# 127.0.0.1 connect silently fell back to launching isolated browsers → crash
# storms). If only ::1 answers, run a tiny v4→v6 TCP shim so 127.0.0.1:$CDP works.
ensure_v4() {
  alive4 && return 0
  alive6 || return 1
  nohup node -e '
    const net=require("net");process.title="cdp-ipv4-shim";
    net.createServer(c=>{const u=net.connect('"$CDP"',"::1");
      c.pipe(u).on("error",()=>{});u.pipe(c).on("error",()=>{});
      c.on("error",()=>{});u.on("error",()=>u.destroy());
    }).listen('"$CDP"',"127.0.0.1");
  ' >/dev/null 2>&1 &
  disown
  for i in $(seq 1 5); do alive4 && { echo "  (v4 shim up: 127.0.0.1:$CDP -> [::1]:$CDP)"; return 0; }; sleep 1; done
  echo "WARNING: CDP answers only on [::1]:$CDP — v4 shim failed; set AGENT_BROWSER_CDP from curl http://[::1]:$CDP/json/version" >&2
  return 0
}

# Durable un-wedge (Mac 2026-09-08): drop session-restore files, mark the profile
# as exited cleanly, drop GPU/shader caches. Only ever called with Chrome down.
clean_profile() {
  local d="$PROFILE/Default"
  [ -d "$d" ] || return 0
  rm -rf "$d/Sessions" "$d/Last Session" "$d/Last Tabs" "$d/Current Session" "$d/Current Tabs" \
         "$d/GPUCache" "$PROFILE/GrShaderCache" "$PROFILE/ShaderCache" "$PROFILE/GraphiteDawnCache" 2>/dev/null || true
  if [ -f "$d/Preferences" ]; then
    node -e '
      const fs=require("fs");const p=process.argv[1];const j=JSON.parse(fs.readFileSync(p,"utf8"));
      j.profile=j.profile||{};j.profile.exit_type="Normal";j.profile.exited_cleanly=true;
      j.session=j.session||{};j.session.restore_on_startup=5;
      fs.writeFileSync(p,JSON.stringify(j));' "$d/Preferences" 2>/dev/null || true
  fi
  echo "  (profile cleaned: sessions + caches dropped, exit_type=Normal)"
}
crashed_profile() { grep -q '"exit_type":"Crashed"' "$PROFILE/Default/Preferences" 2>/dev/null; }

case "${1:-}" in
  start)
    if alive; then echo "already running on CDP $CDP"; exit 0; fi
    if [ "$(uname)" = "Darwin" ]; then
      [ -x "$MAC_CHROME" ] || { echo "Chrome for Testing not found at: $MAC_CHROME" >&2; exit 1; }
      if [ "${2:-}" = "--clean" ]; then clean_profile
      elif crashed_profile; then echo "  (exit_type=Crashed found — auto-cleaning to avoid re-wedge)"; clean_profile; fi
      nohup "$MAC_CHROME" --headless=new --remote-debugging-address=127.0.0.1 \
        --remote-debugging-port=$CDP --user-data-dir="$PROFILE" \
        --no-first-run --no-default-browser-check --disable-session-crashed-bubble \
        --disable-features=Translate,BackgroundSync --disable-gpu --disable-extensions \
        --disable-background-networking --disable-sync --renderer-process-limit=6 \
        --window-size=1400,1000 --user-agent="$UA" >/dev/null 2>&1 &
      disown
    else
      "$HOME/zylos/bin/zylos-browser" display start
    fi
    for i in $(seq 1 15); do alive && { ensure_v4; echo "up on CDP $CDP"; exit 0; }; sleep 1; done
    echo "FAILED: CDP $CDP not answering after start" >&2; exit 1
    ;;
  stop)
    [ "$(uname)" = "Darwin" ] || "$HOME/zylos/bin/zylos-browser" display stop || true
    if alive; then reap job-application-profile; sleep 3; fi
    reap cdp-ipv4-shim
    # Reap per-session agent-browser daemons — the appliers each spawn one and
    # they do NOT exit when Chrome dies (2026-09-02: 5 left holding CLOSE_WAIT
    # on the dead port; on the 2GB droplet that is the leak that matters).
    # Also match daemons whose process title is the bare platform binary
    # (`agent-browser-darwin-arm64`): 2 escaped the pattern on 2026-09-08.
    reap 'agent-browser.*(serve|daemon|--session)|agent-browser-(darwin|linux)-'
    if alive; then echo "FAILED: CDP $CDP still answering after stop" >&2; exit 1; fi
    echo "stopped (CDP $CDP dead)"
    ;;
  status)
    if alive; then ensure_v4; echo "up on CDP $CDP"; else echo "down"; exit 1; fi
    ;;
  *) echo "usage: pipeline-browser.sh start [--clean]|stop|status" >&2; exit 2 ;;
esac
