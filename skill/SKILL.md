---
name: resume
description: >-
  Tailor the Skills section of Felix's résumé to a job posting's keyword list
  (usually Simplify's scraped skill chips) to maximize ATS/keyword matching for
  OA screens. Invoke when Felix says "/resume", or hands over a skills list for
  a company/role and wants the résumé tailored to it. Rewrites ONLY the Skills
  section on the `apply` branch of my_resume (always re-forked from main);
  Experience, Projects, and Education are never touched. Also records the
  posting into the jd-skills dataset with a cleaned role label.
---

# /resume — JD-keyword Skills tailoring

**Rationale (Felix, 2026-08-26):** maximize keyword matching in the Skills
section to pass ATS/get OAs — each added skill is one he can reach intermediate
understanding of in a weekend. Experience stays untouched so the résumé never
deviates far from what he can back up. `main` stays the honest source of truth;
`apply` is a disposable tailoring layer, re-forked from `main` on every run.

## Inputs

- **Skills list — Simplify's parsed "Required Skills", never your own JD parsing**
  (Felix, 2026-08-26: one consistent extractor or the dataset comparisons stop
  meaning anything). Sources, in order of preference:
  1. Felix pastes the chips directly.
  2. Given a `simplify.jobs/p/<uuid>` link (the repo's daily lists carry one per
     posting), fetch the page with curl and read the `__NEXT_DATA__` JSON:
     `props.pageProps.jobPosting.skills[].name`. No browser needed.
  3. Only if neither exists for a posting: extract keywords from raw JD text
     yourself and tag the dataset row `--source jd-text`, never `simplify`.
- **Sort the list by significance before feeding it** (Felix, 2026-08-26):
  core stack first (the languages/frameworks the JD names as the actual stack),
  then role-central concepts, then peripheral mentions. The fit loop preserves
  this order, so when the page runs out, the least significant keywords drop
  first. Drop obvious non-SWE noise chips (e.g. "Word/Pages/Docs") from the
  résumé run — keep them in the dataset row (raw is raw) and tell Felix.
- **Company** — required (names the commit and the archived PDF).
- **Role** — the verbatim posting title, if given.
- If company is missing, ask via C4 and wait; don't guess.

## Workflow

1. **Record the posting in the jd-skills dataset first** (skip only if this
   exact posting is already on file):

   ```bash
   jd-skills add --role "<verbatim title>" --role-clean "<judged label>" \
     --company <Co> --category swe --level intern --source simplify <<'END'
   <paste the skills list>
   END
   ```

   `--role-clean` is your judgment of what the role *really* is from the JD's
   responsibilities, not its title (e.g. "Security Software Engineer Intern" at
   Verkada → "Backend Software Engineer Intern"). Vocabulary + rules:
   `~/zylos/vault/jd-skills/README.md`. `--source` is `simplify` for chip
   pastes, `jd-text` for keywords you extracted from raw JD text yourself.

2. **Run the tailoring script** (pipe the same list on stdin):

   ```bash
   node ~/zylos/.claude/skills/resume/scripts/apply-skills.js \
     --company <Co> --role "<title>" <<'END'
   <paste the skills list>
   END
   ```

   What it does: re-forks `apply` from `main`, rewrites the Skills section as
   [JD skills first, then verified-snapshot filler], recompiles with tectonic,
   binary-searches the longest list that still fits one page (filler drops
   before JD skills), archives the PDF to `~/zylos/vault/resumes-sent/
   <date>-<company>.pdf`, and commits on `apply`. Add `--dry-run` to preview
   without committing/archiving.

3. **Push the branch:** `git -C ~/zylos/workspace/my_resume push --force origin apply`
   (force is expected — `apply` is rewritten every run).

4. **Deliver:** send the archived PDF back to Felix on the requesting channel
   (read that channel skill's attachment mechanics first if not loaded this
   session), plus a short report:
   - skills on the résumé (how many from the JD vs snapshot filler);
   - anything **dropped for fit** — ⚠ especially JD skills that didn't fit;
   - the **study list** the script prints — JD skills now claimed that are NOT
     in his verified snapshot. Always relay it verbatim in spirit: those are
     the "learn it in a weekend, before the interview" items.

## Daily pipeline (scheduled 4:15pm ET / 13:15 PT)

> **AUTO-APPLY REINSTATED (Felix, 2026-08-29 afternoon):** the same-morning
> "PDFs + links only, manual filing" simplification was reversed hours later —
> Felix wants fully autonomous daily submission again. This section is the
> restored full procedure. History of the flip-flop:
> `memory/reference/decisions.md` → "Resume pipeline simplified (2026-08-29)"
> and its reversal addendum.

A scheduler task runs the batch daily, just after Simplify's ~4:12pm ET mail
cutoff.

> **Order is deliberate (Felix, 2026-08-29 evening):** build the day's FINAL
> apply list before doing any per-posting work — never record, tailor, or
> open a browser for a posting that triage will drop. Then each surviving
> posting is finished end to end (tailor → apply → log outcome) before the
> next one starts. Reconciliation at the end must cover the ORIGINAL email
> list, not just what got filed.

### Stage architecture (Felix, 2026-08-29 — modular, parallel apply)

The day is three modules chained by the scheduler's MAIN session (the
orchestrator — subagents cannot spawn subagents). Each module has its own
agent definition and a file artifact as its contract, so any module can also
be invoked standalone:

| Stage | Agent | Instances | Input → Output |
|---|---|---|---|
| 1 LIST | `jd-list` | 1 | inbox → `joblist.json` (ALL rows: selected + dropped) |
| 2 APPLY | `job-applier` | N, parallel | disjoint slice of selected rows → `ledger-part<i>.md` + PDFs |
| 3 RECONCILE | `jd-reconcile` | 1 | joblist + all parts + inbox → `ledger.md`, lean two-section `README.md`, pushes, DM |

Run artifact — `~/zylos/vault/jd-pipeline/runs/<YYYY-MM-DD>/joblist.json`:

```json
{ "date": "YYYY-MM-DD", "source": "swelist-email | sweep-fallback",
  "email": "<subject / IMAP id>",
  "rows": [ { "key": "<dedup key>", "company": "", "title": "",
    "role_clean": "", "link": "<link from email>",
    "apply_link": "<simplify.jobs/p/<uuid> or ATS link>",
    "skills": ["significance-sorted"], "skills_source": "simplify | jd-text",
    "status": "selected | dropped | skipped-repost", "drop_reason": null,
    "flags": { "terms": "", "sponsorship": "", "location": "" } } ] }
```

Dropped rows STAY in the file — Stage 3's coverage check needs the full
email list, not just the survivors.

**Concurrency rules (2GB droplet, shared repos — violating these corrupts
state):**

- **Tailoring is serialized even when applying is parallel.** my_resume's
  `apply` worktree, jd-skills `data.jsonl`, and `state.json` are shared.
  Every applier wraps its record→tailor→PDF-copy→mark critical section in
  `flock ~/zylos/vault/jd-pipeline/tailor.lock -c '…'` — one tailor at a
  time; the browser-apply leg runs outside the lock, in parallel.
- **One Chrome, one agent-browser session per applier, EXPLICIT tab
  pinning.** The orchestrator starts the display once
  (`zylos-browser display start`) before Stage 2. Each applier sets
  `AGENT_BROWSER_SESSION=applier<i>` (its part index) on EVERY
  `agent-browser` call. Live-tested 2026-08-29: per-session current-tab
  pointers exist BUT are not durably pinned by `tab new` alone — after
  another session creates a tab, an unpinned pointer can jump to the
  newest tab. The working protocol (verified): at startup `connect 9222`,
  `tab new`, then `tab list` and note YOUR tab's index (tab indices are
  append-only, so it stays valid); thereafter re-pin with `tab <idx>` at
  the start of EVERY posting, after any click that spawns a new tab
  (target=_blank), and verify `get url` matches the posting you are
  working before filling any field. Never call `agent-browser` bare (the
  default session is shared between appliers = instant race), never use
  `zylos-browser` tab/apply commands in an applier (single-session CLI —
  display start/stop only, orchestrator/Stage 3), and nobody runs
  `display stop` mid-run — Stage 3 stops it at the very end.
- **Appliers never push or write shared files.** No applier touches
  `resume-drops` git state, the day `README.md`, or pushes `apply`; each
  writes only its own `ledger-part<i>.md` and copies PDFs (distinct
  per-company filenames) into the day folder. All commits/pushes happen
  once, in Stage 3.
- **N = min(2, ceil(selected / 4))** parallel appliers — hard RAM cap on
  the current 2GB droplet (shared Chrome + 2 heavy ATS tabs + tectonic
  already leaves only ~250MB headroom; this box has OOM-rebooted before).
  Raise the cap to 3–4 ONLY after the pending droplet RAM resize to 4GB.
  Slices are contiguous in email order. If >25 selected, wave one takes
  the 25 most promising, the remainder runs as a second applier wave
  before Stage 3; note the split in the DM.
- **Defense in depth (2026-08-29):** `apply-skills.js` (whole run),
  `jd-skills add`, and `pipeline-check mark/seed` also self-serialize via
  their own internal flock files in `~/zylos/vault/jd-pipeline/` — an
  applier that forgets the explicit tailor.lock can no longer corrupt
  state, but the instructional lock above stays mandatory (it also keeps
  the tailor→PDF-copy sequence atomic, which the per-script locks alone
  do not).

### Stage 1 — LIST (agent `jd-list`, one instance)

1. **Source = the daily SWElist email (Felix, 2026-08-26 — replaces the
   SimplifyJobs-lists sweep).** Felix subscribed felixl0808@gmail.com to
   SWElist on 08-26; the email is now the source of the day's jobs, and every
   JD must be visited through its own link in the email.
   - Read the inbox over IMAP (`GMAIL_APP_PASSWORD` in `.env`; helper
     `inbox-scan.py`) and find the newest SWElist daily email (subject/body
     like "your daily update (M/D) of tech internships from swelist") not yet
     processed. Track processed emails in the pipeline state via
     `pipeline-check.js mark swelist-email-<YYYY-MM-DD>` (mark accepts
     arbitrary keys).
   - Parse the email's **HTML body**: each posting row is a hyperlink —
     extract company, title, and the link, preserving email order.
   - **Visit each JD through its link** (Felix's explicit instruction).
     Follow redirects (`curl -L`); if it resolves to a
     `simplify.jobs/p/<uuid>` page, take the chips + `terms`/`degrees`/
     `sponsorship` from `__NEXT_DATA__` as before; anything else is the ATS
     JD — read the JD text for triage facts and keyword self-extraction
     (`--source jd-text`). A link that 403s from this droplet (Tesla-class
     edge block): fall back to the Simplify page for chips so the résumé PDF
     still gets tailored; the posting itself is parked like any other blocked
     posting at the apply step.
   - Dedup key per posting: the Simplify uuid when the link resolves to one,
     else `email:<company-slug>|<title-slug>`; skip keys already in
     `~/zylos/vault/jd-pipeline/state.json` (`pipeline-check.js mark` after
     each posting, as before). A `jd-skills` duplicate refusal still means
     repost → skip, mark seen, note in the DM.
   - **Fallback:** if no new SWElist email exists at run time, run the old
     sweep (`pipeline-check.js check` over both SimplifyJobs lists) instead
     and say so in the daily DM.
   While visiting each JD, capture BOTH the triage facts (degrees, terms,
   location, sponsorship) and the skills list (Simplify chips, else jd-text
   keywords) in that one visit — significance-sort the skills into the row's
   `skills` field for Stage 2, but do NOT act on them yet.
2. **Build the day's FINAL apply list — facts-only triage (Felix, 2026-08-26
   — no fit judgment; he decides what to apply to).** Drop a row ONLY for
   factual disqualification:
   - **Degree level:** `degrees` excludes "Bachelor's" (or the `advanced-degree`
     flag is set, or the JD demands MS/PhD). Felix: BS, May 2028.
   - **Degree field:** the JD requires a specific degree he doesn't have (e.g.
     EE/ME-only hardware roles). "CS or related" and unstated → qualified.
     When `degrees` data is missing and the title smells degree-restricted,
     check the Simplify page / JD text before dropping — never drop on a guess.
   - **Terms (Felix, 2026-08-26):** the big-tech-only restriction applies to
     **Fall 2026 alone** — drop Fall 2026 UNLESS big tech (🔥 flag or comparable
     household name). Every other term (Winter 2027 / Spring 2027 / Summer 2027 /
     Fall 2027 and later) → keep, UNLESS the company is too small (his words —
     read as: tiny/no-name startups out; established or recognizable companies
     in; when unsure keep it and let him decide). Company-size drops get a
     one-line reason in the daily DM like any other drop. Off-season rows
     without listings enrichment still have the ledger's own Terms column.
   - **Location (Felix, 2026-08-29): US only.** Drop postings located
     entirely outside the US. Any US office or US-remote option → keep.
     Location unstated → keep (never drop on a guess).
   - Citizenship/sponsorship are NEVER filters — pass them through as marks in
     the ledger.
   - **Company exclusions (Felix, 2026-08-26): TikTok / ByteDance — do NOT
     apply this cycle.** Felix has exhausted their 2-applications-per-season
     limit. Drop all TikTok/ByteDance rows with that one-line reason; still
     list them in the daily DM drop report. Revisit next season.
   Every dropped row goes into the daily DM AND the day ledger with a
   one-line reason — wrong exclusions must be visible to Felix, not silent.
   **The output of this step is the final apply list.** Nothing downstream —
   `jd-skills add`, tailoring, browser work — starts until the whole list is
   settled; work is never spent on a posting that won't be applied to.
3. **Write `joblist.json`** (schema above): every email row present with
   status, drop reason, cached sorted skills, and apply link. Mark dropped /
   skipped rows seen now (`pipeline-check.js mark`); selected rows are
   marked later by their applier. Return a compact summary to the
   orchestrator: counts (rows / selected / dropped), the joblist path, and
   the selected keys in email order.

### Stage 2 — APPLY (agent `job-applier` × N, parallel)

Input per instance: the joblist path, its part index `i`, and a disjoint
slice of selected row keys. Obey the concurrency rules above. **Per assigned
job, finish end to end (tailor → apply → log) before starting the next**
(Felix, 2026-08-29 — auto-apply is not a separate later phase):

   a. Under the tailor lock (`flock ~/zylos/vault/jd-pipeline/tailor.lock`):
      `jd-skills add` with a cleaned role label using the row's sorted
      skills. A duplicate company+role refusal is a REPOST under a new
      posting id — mark the key seen, log `skipped-repost` in the part
      ledger, and move on. Never `--force` past it in pipeline mode.
   b. Still under the same lock: `apply-skills.js --company <Co> --role
      "<title>"` — Skills section becomes [JD skills first, then
      verified-snapshot filler by significance], one page enforced. Copy the
      archived PDF into `~/zylos/workspace/resume-drops/<YYYY-MM-DD>/`
      (run-date, droplet TZ), then release the lock.
   c. **Auto-apply now, outside the lock (Felix's standing OK, 2026-08-26;
      reinstated 2026-08-29 — see `memory/reference/preferences.md` → "Job
      auto-apply"):** submit via the browser component in this applier's own
      tab (Greenhouse/Lever/Ashby; standing auth covers account-walled /
      email-verification flows). Park Workday / CAPTCHA / human-verification
      / unreachable postings for Felix with link + screenshot. Profile facts
      (phone, address, EEO answers, location prefs):
      `vault/my_second_brain/wiki/felix-resume.md`; source = job
      board/Simplify.
   d. Record the outcome in this instance's `ledger-part<i>.md` in the day
      folder immediately — **submitted** (every field and answer entered,
      timestamped, confirmation state), **failed** (what broke), or
      **parked** (what was done, exactly what's left) — then
      `pipeline-check.js mark <key>` under the tailor lock (so a crash loses
      at most the in-flight posting).

Return to the orchestrator: per-key outcomes + study-list lines. Do NOT
push, do NOT write `README.md` or `ledger.md`, do NOT stop the display.

### Stage 3 — RECONCILE (agent `jd-reconcile`, one instance)

Runs only after ALL appliers have returned.

1. **Merge** every `ledger-part*.md` plus the joblist's dropped/skipped rows
   into one `ledger.md` (email order), then delete the part files.
2. **Reconcile against the source email (Felix, 2026-08-26; coverage check
   added 2026-08-29).** Read the felixl0808@gmail.com inbox over IMAP
   (`GMAIL_APP_PASSWORD` in `.env`; also scan felixl@andrew.cmu.edu-era
   Kodiak mail only if relevant) for application-received / confirmation
   emails since the previous run, then check three ways:
   (a) every *submitted* row in `ledger.md` has a matching confirmation
       email — flag any submission with no confirmation as UNVERIFIED, don't
       silently trust the form's thank-you page; every confirmation email
       maps back to a ledger row — one with no entry means the ledger missed
       something, add it. Note rejections/next-step emails per row.
   (b) **COVERAGE: every posting row in the day's `joblist.json` (i.e. the
       SWElist email) is accounted for exactly once** — dropped (with
       reason), skipped-repost, submitted, failed, or parked. An unaccounted
       row is a miss: process it yourself inline (Stage 2 steps a–d, locks
       included) before finishing the run, and note the miss in the DM.
   (c) Write the reconciliation results (verified / unverified / unmatched /
       rejected) into `ledger.md` and the counts into the daily DM.
3. **Day folder + push.** Two files in
   `resume-drops/<YYYY-MM-DD>/`:
   - `ledger.md` — ALL the detail: filed applications with fields, answers,
     timestamps, confirmation state; drops and skips with reasons;
     reconciliation results; per-job study lists; anything unusual.
   - `README.md` — **LEAN DAILY SUMMARY (Felix, 2026-08-31).** It has
     exactly these compact sections, omitting either section when empty:
     - `Applied (N)` — one row per successfully submitted application;
       company and role only.
     - `Manual (N)` — only selected/applicable postings whose automated
       submission failed or was parked and that Felix must finish; company,
       role, direct apply link, tailored PDF link, and one short blocker.
     Use exactly one bullet per row: `- Company — Role` for Applied and
     `- Company — [Role](apply URL) — [PDF](PDF URL) — blocker` for Manual.
     Apart from the date title and section counts, include nothing else. In
     particular, omit dropped/ineligible/dead/duplicate postings, full form
     details, timestamps, confirmation detail, study lists, and narrative;
     those stay in `ledger.md` and the DM.
   **Apply links point at the posting's own Simplify page**
   (`https://simplify.jobs/p/<uuid>` — straight into the role with autofill),
   never the company page; for email rows whose link never resolved to a
   Simplify page, use the posting's own ATS link from the email.
   Update the root README's "Latest day" link, commit and push
   `resume-drops`. Push `apply` once (last company). Prune drops-repo day
   folders older than 14 days (`git rm`, history keeps them). Delete the
   day's PDFs from `vault/resumes-sent/` once pushed — the drops repo is the
   archive.
4. DM Felix a short summary: N email rows → M selected, submitted / parked /
   failed / dropped counts, verified vs UNVERIFIED counts, the repo day-link
   (github.com/FelixLin6/resume-drops/tree/main/<date>), aggregate study
   list, skipped-title list in one line, any fetch failures. One message,
   not per-job.
5. Stop the browser display (`zylos-browser display stop`) — last one out.

The orchestrator (main session) marks the scheduler task done only after
Stage 3 returns and its summary sanity-checks (README pushed? DM sent?
coverage clean?). If any stage's agent dies, relaunch it once; if the staged
path fails twice, fall back to the single `resume-pipeline` agent running
the whole day solo, and tell Felix the parallel path failed.

## Guardrails

- **Never touch `main`** or any section other than Skills. The script enforces
  this; don't hand-edit around it.
- **Never pad `assets/snapshot.json`.** It is the honesty baseline (verified
  skills traceable to real work). Adding to it requires evidence in the vault
  (wiki/felix-resume, wiki/cmu-coursework-record) or Felix's explicit say-so.
  Note its `_borderline` entries (go, rust, distributed systems) before making
  claims in cover letters or chat.
- `assets/skill-map.json` maps normalized skills → Skills rows; unknown skills
  fall into "Tools & Platforms". Add mappings freely when a new skill lands in
  the wrong row.
- The script refuses to run if the my_resume working tree has changes beyond
  resume.tex/resume.pdf — resolve those by hand, never `--force` past them.
  Leftover resume.tex/pdf residue from a previous run or dry-run is discarded
  automatically at the next run's re-fork; that residue is normal, leave it.
