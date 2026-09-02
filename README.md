# resume-pipeline

Felix's daily job-application pipeline, exported from the Zylos droplet as one
editable package. **Private repo — contains personal skill/profile data.**

## What's here vs where it runs live

| Repo path | Live droplet path | What it is |
|---|---|---|
| `skill/SKILL.md` | `~/zylos/.claude/skills/resume/SKILL.md` | The whole daily procedure: SWElist email source, facts-only triage rules, tailoring, auto-apply, inbox verification, README/DM formats |
| `skill/scripts/apply-skills.js` | `~/zylos/.claude/skills/resume/scripts/` | Tailoring engine: re-forks `apply` from `main` in my_resume, rewrites ONLY the Skills section, fits it to one page (measured fit: two cached TeX probes + one confirm compile; the old binary-search compile loop is the fallback), writes the PDF (`--out`) and a fit report (`--json`) |
| `skill/scripts/tailor-batch.js` | 〃 | Stage 1.5: tailors every selected row of a run in parallel git-worktree lanes before the appliers start → PDFs in the day folder + `tailor.json` |
| `skill/scripts/swelist-fetch.py`, `jd-fetch.js` | 〃 | Stage 1 fetchers: SWElist email → ordered rows; every JD link → Simplify facts / JD text, in parallel, as JSON for triage |
| `skill/scripts/ats-fill.js` | 〃 | Stage 2: fills an ATS form's standard block (contact, résumé upload, education, standard yes/no + EEO) in one call from the profile; prints what is left for the applier |
| `skill/assets/application-profile.json` | `~/zylos/.claude/skills/resume/assets/` | Every form fact (contact, education, work history, authorization, EEO standing answers, policies, constraints). Built from the vault 2026-09-02 — no credentials |
| `skill/assets/answer-bank.md` | 〃 | Felix's pre-written free-text answers with a coverage map; appliers assemble from it, never author (NOT-YET-APPROVED banner until Felix signs off) |
| `skill/scripts/pipeline-check.js` | 〃 | Seen-posting dedup state (reads/writes `~/zylos/vault/jd-pipeline/state.json`) |
| `skill/scripts/inbox-scan.py` | 〃 | Gmail IMAP reader (source email + confirmation scan); credentials from `~/zylos/.env`, never in code |
| `skill/scripts/gh-fill.sh`, `gh-pick.sh`, `sf-pick.sh`, `workday-answer.sh` | 〃 | Per-ATS browser-leg helpers (Greenhouse / SmartRecruiters / Workday) |
| `skill/assets/snapshot.json` | 〃 | **Honesty baseline** — verified skills traceable to real work. Never padded; additions need evidence or Felix's say-so |
| `skill/assets/skill-map.json` | 〃 | Normalized skill → Skills-section row mapping |
| `agent/jd-list.md` | `~/zylos/.claude/agents/` | Stage 1 subagent: SWElist email → JD visits → triage → `joblist.json` |
| `agent/job-applier.md` | 〃 | Stage 2 subagent, run ×N in parallel: per assigned job, tailor + auto-apply + `ledger-part<i>.md` |
| `agent/jd-reconcile.md` | 〃 | Stage 3 subagent: merge parts, inbox + coverage verification, lean applied/manual README, push, DM |
| `agent/resume-pipeline.md` | 〃 | Solo-fallback monolith (whole day in one agent) when the staged path fails |
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

scheduler (13:15 PT) → main session orchestrates three staged Opus subagents:

1. **LIST** (`jd-list`, ×1): `swelist-fetch.py` reads the newest SWElist
   email over IMAP → `jd-fetch.js` visits every JD link in parallel (triage
   facts + skills as JSON) → the model does facts-only triage into the
   day's FINAL apply list (degree/term/US-location/company-exclusion drops
   only; fit judgment stays with Felix) → write `joblist.json` (all rows,
   incl. drops).
1.5. **TAILOR** (`tailor-batch.js`, run by the orchestrator, no agent): every
   selected row → jd-skills dataset row → apply-skills.js in parallel
   worktree lanes (JD skills first, snapshot filler after, one page) → PDF
   in the resume-drops day folder + `tailor.json`. ~1 min for 25 jobs.
2. **APPLY** (`job-applier`, ×N in parallel over disjoint slices; one shared
   Chrome with a tab per applier): per job, end to end — open the ATS form →
   `ats-fill.js` fills the standard block → applier finishes custom
   questions from the profile + answer bank → submit → one confirmation
   screenshot → compact block in `ledger-part<i>.md` (park
   account-walled/CAPTCHA/unreachable).
3. **RECONCILE** (`jd-reconcile`, ×1): merge parts into `ledger.md` →
   reconcile against the inbox AND the original email list (every row
   dropped/submitted/failed/parked — no misses) → lean day README (only
   successful applications and selected failures requiring Felix) → push →
   one summary DM → stop the browser.

If the staged path fails twice, the solo `resume-pipeline` agent runs the
whole day monolithically.
