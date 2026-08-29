#!/bin/bash
# Sync this repo with the live Zylos locations on the droplet.
#   ./sync.sh deploy   repo -> live   (after git pull; makes local edits take effect)
#   ./sync.sh export   live -> repo   (before committing droplet-side changes)
# Scheduler-task prompt is NOT synced by this script — apply via scheduler CLI.
set -euo pipefail
cd "$(dirname "$0")"

SKILL=~/zylos/.claude/skills/resume
AGENTS=~/zylos/.claude/agents
JDS=~/zylos/vault/jd-skills

case "${1:-}" in
  deploy)
    cp skill/SKILL.md "$SKILL/SKILL.md"
    cp skill/scripts/* "$SKILL/scripts/"
    cp skill/assets/* "$SKILL/assets/"
    cp agent/*.md "$AGENTS/"
    cp jd-skills/jd-skills.js jd-skills/aliases.json jd-skills/README.md "$JDS/"
    echo "deployed repo -> live"
    ;;
  export)
    cp "$SKILL/SKILL.md" skill/SKILL.md
    cp "$SKILL"/scripts/* skill/scripts/
    cp "$SKILL"/assets/* skill/assets/
    for f in agent/*.md; do cp "$AGENTS/$(basename "$f")" "$f"; done
    cp "$JDS/jd-skills.js" "$JDS/aliases.json" "$JDS/README.md" jd-skills/
    echo "exported live -> repo (now commit & push)"
    ;;
  *)
    echo "usage: ./sync.sh {deploy|export}" >&2; exit 2 ;;
esac
