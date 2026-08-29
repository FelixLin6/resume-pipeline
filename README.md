# resume-pipeline

Felix's daily job-application pipeline, exported from the Zylos droplet as one
editable package. **Private repo — contains personal skill/profile data.**

## What's here vs where it runs live

| Repo path | Live droplet path | What it is |
|---|---|---|
| `skill/SKILL.md` | `~/zylos/.claude/skills/resume/SKILL.md` | The whole daily procedure: SWElist email source, facts-only triage rules, tailoring, auto-apply, inbox verification, README/DM formats |
| `skill/scripts/apply-skills.js` | `~/zylos/.claude/skills/resume/scripts/` | Tailoring engine: re-forks `apply` from `main` in my_resume, rewrites ONLY the Skills section, binary-searches the longest skill list that still compiles (tectonic) to one page, archives the PDF |
| `skill/scripts/pipeline-check.js` | 〃 | Seen-posting dedup state (reads/writes `~/zylos/vault/jd-pipeline/state.json`) |
| `skill/scripts/inbox-scan.py` | 〃 | Gmail IMAP reader (source email + confirmation scan); credentials from `~/zylos/.env`, never in code |
| `skill/scripts/gh-fill.sh`, `gh-pick.sh`, `sf-pick.sh`, `workday-answer.sh` | 〃 | Per-ATS browser-leg helpers (Greenhouse / SmartRecruiters / Workday) |
| `skill/assets/snapshot.json` | 〃 | **Honesty baseline** — verified skills traceable to real work. Never padded; additions need evidence or Felix's say-so |
| `skill/assets/skill-map.json` | 〃 | Normalized skill → Skills-section row mapping |
| `agent/resume-pipeline.md` | `~/zylos/.claude/agents/resume-pipeline.md` | The Opus-5 background subagent that executes the daily batch |
| `scheduler/daily-task.md` | scheduler DB (`task-mt9kwxxt-hq9wqr`) | Export of the daily trigger's prompt — edit here, then ask Zylos to apply it to the live task |
| `jd-skills/jd-skills.js`, `aliases.json`, `README.md` | `~/zylos/vault/jd-skills/` | The JD/skills dataset CLI and its vocabulary rules |

## Deliberately NOT in this repo

- **Mutable run state** — `jd-skills/data.jsonl` (the growing dataset) and
  `jd-pipeline/state.json` (seen keys) change every run on the droplet; keeping
  them here would conflict daily. They live only on the droplet.
- **Secrets** — everything reads `~/zylos/.env` at runtime (`GMAIL_APP_PASSWORD`,
  ATS account passwords). Nothing in this repo holds a credential; keep it that way.
- **Outputs** — tailored PDFs go to `FelixLin6/resume-drops`; the résumé source is
  `FelixLin6/my_resume`.

## Edit → deploy loop

This repo is the editing surface; the droplet paths above are what actually runs.

1. Edit locally, commit, push.
2. Tell Zylos "pull the pipeline repo" (or run on the droplet):
   `cd ~/zylos/workspace/resume-pipeline && git pull && ./sync.sh deploy`
3. `sync.sh deploy` copies skill/ + agent/ into the live locations.
   Scheduler-prompt changes are applied by Zylos via the scheduler CLI (not by file copy).

Zylos-side edits flow back with `./sync.sh export` (live → repo) then commit/push,
so always `git pull` before editing locally.

## Map of the run (one day)

scheduler (13:15 PT) → main session launches the Opus subagent → read newest
SWElist email over IMAP → per posting: follow link → Simplify chips or JD-text
keywords → facts-only triage (degree/term/company-exclusion drops only; fit
judgment stays with Felix) → record in jd-skills dataset → tailor via
apply-skills.js → copy PDF into resume-drops day folder → auto-apply through the
browser component (park account-walled/CAPTCHA/unreachable) → inbox verification
(submission ↔ confirmation-email reconciliation, both directions) → day README
ledger (Applications filed / Needs you) → push → one summary DM.
