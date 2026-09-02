#!/bin/bash
# Shared pipeline browser lifecycle — the ONE way any orchestrator (Claude or
# Codex, Mac or droplet) starts/stops the job-application Chrome on CDP 9222.
#   pipeline-browser.sh start|stop|status
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

case "${1:-}" in
  start)
    if alive; then echo "already running on CDP $CDP"; exit 0; fi
    if [ "$(uname)" = "Darwin" ]; then
      [ -x "$MAC_CHROME" ] || { echo "Chrome for Testing not found at: $MAC_CHROME" >&2; exit 1; }
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
    if alive; then pkill -f job-application-profile || true; sleep 3; fi
    pkill -f cdp-ipv4-shim >/dev/null 2>&1 || true
    if alive; then echo "FAILED: CDP $CDP still answering after stop" >&2; exit 1; fi
    echo "stopped (CDP $CDP dead)"
    ;;
  status)
    if alive; then ensure_v4; echo "up on CDP $CDP"; else echo "down"; exit 1; fi
    ;;
  *) echo "usage: pipeline-browser.sh start|stop|status" >&2; exit 2 ;;
esac
