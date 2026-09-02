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
   without committing/archiving. The one-page fit is computed from two cached
   TeX probes and confirmed with ONE compile (`--fit measured`, default,
   2026-09-02); `--fit compile` is the old binary-search loop, kept as the
   automatic fallback. Same output either way.

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
| 1.5 TAILOR | script `tailor-batch.js` (orchestrator runs it, no agent) | 1 process, N lanes | `joblist.json` → `tailor.json` + every PDF in the day folder |
| 2 APPLY | `job-applier` | N, parallel | disjoint slice of selected rows → `ledger-part<i>.md` |
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

- **Appliers never tailor (2026-09-02).** All tailoring happens in Stage
  1.5 before any applier starts: `tailor-batch.js` runs the selected rows
  through `jd-skills add` + `apply-skills.js` in parallel git-worktree lanes
  of my_resume (`~/zylos/vault/jd-pipeline/lanes/lane<i>`, branch
  `apply-lane<i>`), writes each PDF straight into the resume-drops day
  folder, and records everything in the run's `tailor.json`. An applier
  only READS `tailor.json`. The one exception — a row missing from
  `tailor.json` (Stage 3 coverage miss, or a batch failure) — is handled by
  running `tailor-batch.js --joblist <path> --keys <key>` for that key; the
  script serializes itself, so no outer `tailor.lock` is needed any more.
- **One Chrome, one agent-browser session per applier, EXPLICIT tab
  pinning.** The orchestrator starts the browser once before Stage 2 via
  `~/zylos/.claude/skills/resume/scripts/pipeline-browser.sh` `start`
  (per-host: Mac = headless Chrome for Testing on the dedicated profile;
  droplet = `zylos-browser display start`). Each applier sets
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
- **Defense in depth (2026-08-29, per-checkout since 2026-09-02):**
  `apply-skills.js` (per checkout), `tailor-batch.js` (one batch at a
  time), `jd-skills add`, and `pipeline-check mark/seed` all self-serialize
  via flock files in `~/zylos/vault/jd-pipeline/`; parallel lanes never
  share a checkout, so nothing an applier does can corrupt tailoring state.

### Stage 1 — LIST (agent `jd-list`, one instance)

1. **Source = the daily SWElist email (Felix, 2026-08-26 — replaces the
   SimplifyJobs-lists sweep).** Felix subscribed felixl0808@gmail.com to
   SWElist on 08-26; the email is now the source of the day's jobs, and every
   JD must be visited through its own link in the email.
   - **Fetching is scripted (2026-09-02) — the model triages JSON, it never
     curls postings one by one.** In the run dir
     `~/zylos/vault/jd-pipeline/runs/<YYYY-MM-DD>/`:
     `python3 scripts/swelist-fetch.py --out rows.json` reads the inbox over
     IMAP (`GMAIL_APP_PASSWORD` in `.env`), picks the newest SWElist daily
     email (`--list` to see candidates, `--date`/`--imap-id` to pin one) and
     writes its posting rows in email order (`{idx, company, title, link}`
     plus the email's subject/date/IMAP id). Then
     `node scripts/jd-fetch.js rows.json --out jdfacts.json --compact
     jdfacts-compact.ndjson` visits every link in parallel (~30s for 300
     rows): links resolving to `simplify.jobs/p/<uuid>` yield the chips
     (`skills`), `degrees`, `seasons`, `additional_requirements` (US
     Authorization / Citizenship / clearance), `sponsors_h1b`, `locations`,
     `ats`, `active`, plus `title_term` and `degree_text`/`term_text`
     sentences (the Simplify season tag is unreliable — the JD's wording
     wins); any other final URL yields `jd_text` for self-extraction
     (`--source jd-text`); 403/timeouts stay `resolved:"error"` (edge block —
     fall back to the Simplify page for chips, park the posting at apply as
     before). Rows whose key is already in `state.json` are flagged
     `already_seen` (repost → skip). Triage from the compact NDJSON (one row
     per line; degree/term sentences only appear when the tags are missing
     or disagree); open `jdfacts.json` only for a row that needs more text.
   - Track processed emails via `pipeline-check.js mark
     swelist-email-<YYYY-MM-DD>` as before; **fallback** if no new SWElist
     email exists: the old sweep (`pipeline-check.js check`), and say so in
     the DM.
   - Dedup key: the Simplify uuid, else `email:<company-slug>|<title-slug>`
     (jd-fetch.js computes it). A `jd-skills` duplicate refusal still means
     repost → skip, mark seen, note in the DM.
   From the fetched facts take BOTH the triage facts (degrees, terms,
   location, sponsorship) and the skills list (Simplify chips, else jd-text
   keywords) — significance-sort the skills into the row's `skills` field
   for the tailor batch, but do NOT act on them yet.
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

### Stage 1.5 — TAILOR (script, run by the orchestrator — 2026-09-02)

Once `joblist.json` is settled, the orchestrator runs, inline (it is a
deterministic script, not model work):

```bash
node ~/zylos/.claude/skills/resume/scripts/tailor-batch.js \
  --joblist ~/zylos/vault/jd-pipeline/runs/<YYYY-MM-DD>/joblist.json \
  [--keys <wave-1 keys, comma-separated>] [--lanes N]
```

Per selected row it records the posting in the jd-skills dataset (a
duplicate refusal = repost → marks the key seen, status `skipped-repost`),
tailors the Skills section (JD skills first, then verified-snapshot filler,
one page — `apply-skills.js`, measured fit, one compile per job), and
writes the PDF as `resume-drops/<date>/<date>-<company>-<title>.pdf`.
Lanes are git worktrees of my_resume, default `min(4, cpus-1)`; ~5s per
job per lane, so a 25-job wave takes about a minute. Output:
`runs/<date>/tailor.json` — per key `status` (tailored / skipped-repost /
failed), `pdf`, `jd_kept`, `dropped_jd` (JD skills that did not fit —
still goes in the DM), `study`. Re-runs are idempotent (`--force` to redo);
`--keys` scopes a wave or a single miss. It also moves my_resume's `apply`
branch to the last tailored commit so Stage 3's single push still works.
The batch's summary line (tailored / skipped / failed, dropped JD skills,
study list) goes into the orchestrator's notes for the DM.

### Stage 2 — APPLY (agent `job-applier` × N, parallel)

Input per instance: the joblist path, the tailor.json path, its part index
`i`, and a disjoint slice of selected row keys. Obey the concurrency rules
above. **Per assigned job, finish end to end (open → fill → submit → log)
before starting the next** (Felix, 2026-08-29). The applier's job is the
browser leg only; everything that can be a script already is one.

**Working rules (2026-09-02 — these are what make ~20-minute applications
5-minute ones):**

- **Read state with `agent-browser snapshot -i`, never screenshots.**
  Screenshots are allowed exactly twice per posting: the confirmation page
  after submit, and the parked state when you park — saved as
  `resume-drops/<date>/screenshots/<company-slug>-<confirmation|parked>.png`.
  Anything else is wasted vision round-trips.
- **Facts come from `assets/application-profile.json`, prose from
  `assets/answer-bank.md`.** Both live in the resume skill's assets. The
  profile holds every form fact (contact, address, education incl. picklist
  fallbacks, work history, work authorization, EEO standing answers,
  location policy, availability, how-did-you-hear picks) and a
  `constraints` block; the bank holds Felix's pre-written answers with a
  coverage map (why-company template with a `[[SLOT]]`, hardest problem,
  project deep-dive variants, motivation, goals, teamwork, additional
  info). Pick the closest bank answer, fill the slot from the JD, trim to
  the limit. Open `wiki/felix-resume.md` only for a question neither file
  covers — and if it does not cover it either, park with the exact question
  text. While the bank still carries its NOT-YET-APPROVED banner it is a
  draft under the same assembly-only rule; never add a fact to it.
- **No re-verification.** Do not re-open or re-read the JD to "verify the
  joblist row" — Stage 1 already visited it and its facts stand. The only
  contradiction that matters is one the application form itself states
  (term, degree requirement, location, citizenship); then stop, do not
  submit, log `DROP-AT-APPLY` with both readings quoted.
- **No confirmation-email waits.** Stage 3 reconciles the inbox. Read IMAP
  (`inbox-scan.py`) only when the form demands a verification code.
- **No tailoring.** The PDF is in `tailor.json`; if your key is missing or
  `failed` there, run `tailor-batch.js --joblist <path> --keys <key>` once
  and re-read.

Per job:

   a. **Look up the key in `tailor.json`.** `skipped-repost` → log it as such
      in your part ledger, mark seen, next job. Otherwise note the PDF path
      and the row's study list.
   b. **Open `apply_link` in YOUR tab** (`tab <idx>` first, `get url` check),
      get from the Simplify page to the ATS form, and identify the ATS from
      the URL (`job-boards.greenhouse.io` → greenhouse; `jobs.lever.co` →
      lever; `jobs.ashbyhq.com` → ashby; `*.myworkdayjobs.com` → workday;
      anything else → generic).
   c. **Fill the standard block in one call:**
      `node ~/zylos/.claude/skills/resume/scripts/ats-fill.js <ats> --resume
      <pdf>` (inherits your `AGENT_BROWSER_SESSION`). It fills name, contact,
      résumé upload, links, school/degree/discipline/dates, the standard
      yes/no questions it can answer from the profile (work authorization,
      sponsorship, graduating-before-X, relocation) and the EEO block, then
      prints FILLED / PICKED / MISSED / UNHANDLED. Live-tested on Greenhouse
      2026-09-02 (20 fields, 43s, zero model turns); Lever/Ashby/generic use
      the same label matching and were reviewed but not yet run live;
      `workday` fills only the My Information text fields — Workday's
      pickers stay with `workday-answer.sh` and the tenant rules below.
   d. **Finish what the report lists as UNHANDLED / MISSED** — custom
      questions, how-did-you-hear checkboxes, free-text boxes (from the
      bank), any field it could not find — with `find label … fill` or
      `@ref` actions from one snapshot. Then one snapshot to review
      required fields, and submit. Verification code → `inbox-scan.py`.
      One confirmation screenshot.
   e. **Auto-apply authorization is unchanged** (Felix's standing OK,
      2026-08-26; reinstated 2026-08-29 — `memory/reference/preferences.md`
      → "Job auto-apply"): submit via your own tab across
      Greenhouse/Lever/Ashby/SuccessFactors/iCIMS/Workday; standing auth
      covers account-walled / email-verification flows. Park only CAPTCHA /
      human-verification walls and unreachable or closed postings, with
      link + one screenshot.
      **Workday is attempted, not parked (Felix, 2026-08-31).** Per tenant:
      reuse the account whose credential label is already in `~/zylos/.env`
      (`# WORKDAY_<TENANT>_PASSWORD=...`), else create one with the pipeline
      email and record it there before anything else; verification codes
      via `inbox-scan.py`. School / Field-of-Study pickers are not free
      text — type the name, then a literal `press Enter` to render results
      ("Computer Science / Information Technology" where a tenant has no AI
      entry). Textareas must be entered with real click + keystrokes, not
      DOM assignment (Blue Origin, 2026-09-01: values set by script render
      but fail Workday's validation). "Use My Last Application" autofill is
      fine but verify the attached PDF is the right file for the posting and
      re-check every checkbox on the review page. Honour a tenant's stated
      one-application-per-year policy: submit the best-fit role, park the
      rest as drafts for Felix. A tenant throwing "Something went wrong" /
      429 / "Security Check" walls gets one 60s-spaced retry, then park with
      that finding (drafts persist server-side).
   f. **Log the outcome in `ledger-part<i>.md` immediately, in the COMPACT
      format** — one block per posting, nothing else:

      ```
      ## [<email row>] <Company> — <Title> — SUBMITTED|PARKED|FAILED|SKIPPED-REPOST|DROP-AT-APPLY
      - key <uuid> · ATS <greenhouse|…> <form url> · PDF <file name> · applier<i> · <HH:MM PT>
      - outcome: <one line — confirmation text or URL, or the blocker and exactly what is left>
      - filled: ats-fill <n> fields; manual: <field names only, comma-separated>
      - answers: <ONLY free-text boxes, verbatim, each as "Q → A"; omit line if none>
      - notes: <only if unusual — account created (.env label), contradiction with joblist, ATS error>
      ```

      No narrative, no table of every field value, no "verified on the JD
      page" lines, no reasoning. Free-text answers are the one thing Felix
      needs to be able to read back, so they stay verbatim.
   g. `pipeline-check.js mark <key>` (self-locking; a crash loses at most the
      in-flight posting).

Return to the orchestrator: per-key outcomes, one line each. Do NOT push,
do NOT write `README.md` or `ledger.md`, do NOT stop the display.

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
       row is a miss: process it yourself inline before finishing the run
       (`tailor-batch.js --keys <key>` if it is not in `tailor.json`, then
       Stage 2 steps a–g in your own browser session), and note the miss in
       the DM.
   (c) Write the reconciliation results (verified / unverified / unmatched /
       rejected) into `ledger.md` and the counts into the daily DM.
3. **Day folder + push.** Two files in
   `resume-drops/<YYYY-MM-DD>/`:
   - `ledger.md` — the compact per-posting blocks from the part files
     (unchanged, in email order), plus: the counts table, the
     reconciliation results, the drops and skips with reasons, the
     aggregate study list and the JD-skills-that-did-not-fit line from
     `tailor.json`, and run incidents. Keep it compact — the blocks are
     the format, do not expand them into narrative.
   - `screenshots/` — the appliers' confirmation/parked shots (at most two
     per posting). Commit them as they are; never bulk-delete or "trim" a
     screenshots directory (2026-09-01: a cleanup one-liner wiped all 355
     before anything was copied).
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
   `resume-drops`. Push `apply` once (`tailor-batch.js` already pointed it
   at the last tailored commit). Prune drops-repo day folders older than 14
   days (`git rm`, history keeps them). The batch writes PDFs straight into
   the day folder, so `vault/resumes-sent/` only holds manual `/resume`
   runs — delete any of today's copies there once pushed.
4. DM Felix a short summary: N email rows → M selected, submitted / parked /
   failed / dropped counts, verified vs UNVERIFIED counts, the repo day-link
   (github.com/FelixLin6/resume-drops/tree/main/<date>), aggregate study
   list, skipped-title list in one line, any fetch failures. One message,
   not per-job.
5. Stop the browser — last one out — via
   `~/zylos/.claude/skills/resume/scripts/pipeline-browser.sh` `stop`
   (it verifies CDP 9222 is actually dead and fails loudly if not).

The orchestrator (main session) marks the scheduler task done only after
Stage 3 returns and its summary sanity-checks (README pushed? DM sent?
coverage clean?). If any stage's agent dies, relaunch it once; if the staged
path fails twice, fall back to the single `resume-pipeline` agent running
the whole day solo, and tell Felix the parallel path failed.

## Runtime portability (Codex)

The stages, scripts, and file contracts are runtime-agnostic; only the
orchestration layer differs. To run the daily pipeline on the Codex runtime:

- **Model pins (Felix, 2026-09-01):** Stage 1 `jd-list` and Stage 3
  `jd-reconcile` = `gpt-5.6-sol`, reasoning **medium**; Stage 2 `job-applier`
  = `gpt-5.6-luna`, reasoning **medium** (verified available on this account
  2026-09-01). Same spend logic as the Claude pins (Opus 5 / Sonnet 5): the
  expensive model carries triage + coverage judgment, the cheap one drives
  the browser. The appliers' narrowed free-text rule is what makes the cheap
  pin safe — do not change either without Felix's say-so.
- **Agent definitions:** Codex has no `.claude/agents` registry. Spawn each
  stage as a background agent whose prompt begins: "First read
  `~/zylos/.claude/agents/<name>.md` and obey it as your system
  instructions" (ignore its Claude frontmatter; the body is runtime-neutral).
- **Orchestrator prompt:** use `scheduler/daily-task-codex.md` (repo) — the
  Codex-vocabulary variant of the scheduler task.
- **Subagent mechanism:** use Codex's native background-agent capability
  (`multi_agent`); never pm2 or `codex exec` sidecars. FIRST-RUN CHECKS
  before trusting a live batch: (a) N≥2 agents actually run in parallel,
  (b) per-agent model/effort override works at spawn, (c) agent results
  return compactly (an orchestrator flooded with transcripts kills the run).
- **Rate limits:** Codex quotas are per OAuth account and every stage shares
  one account — prefer smaller applier waves; a capped account stalls the
  whole run, not one stage.
- **Browser:** identical on both runtimes — `pipeline-browser.sh
  start|stop|status` (above), `agent-browser` with
  `AGENT_BROWSER_SESSION=applier<i>`.
- **Stage 1.5 (tailor batch) and the fetch scripts are plain node/python**
  — the orchestrator runs them the same way on both runtimes. Measured fit
  needs `python3 -c "import pdfminer"` on the host (the Mac needs
  `pip3 install pdfminer.six` once); without it `apply-skills.js` silently
  uses the old compile loop.

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
