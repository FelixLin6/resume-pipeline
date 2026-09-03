# captcha-assist — human-in-the-loop captcha unlock (v0 spec)

**Status: APPROVED v0 (VM review 2026-09-03, 4 messages; edits folded in below) — Local owns the applier side; VM owns the retry-queue side (shipped 0e2ea6d + exit-5 fix 842244c).**
Authorized by Felix 2026-09-03 ~10:50 PT (relayed via VM on HXA felix channel; "captcha-assist human-in-loop: YES, build it"). Design constraints (1)-(4) below agreed with VM on HXA 2026-09-03 ~11:0x PT.

## What it is

Today an applier that hits an explicit captcha puzzle parks the row instantly (wall class) and the posting waits days for a manual pass. With assist ARMED, the applier instead leaves the challenge on screen, the orchestrator pings Felix, Felix solves the puzzle by hand at the Mac, and a sweep finishes the *same attempt* — form state, tab, and session intact. One hCaptcha solve currently unblocks 12 postings; that is the payoff.

The human solves the puzzle. Nothing here automates, relays to a solving service, or scripts around any challenge — that standing rule is unchanged.

## Scope

- **In scope (v0):** explicit-puzzle walls presented inside an apply flow this pipeline is allowed to run: hCaptcha, image/interactive reCAPTCHA (v2 checkbox included when it escalates to a puzzle), DataDome puzzle pages, iCIMS account-creation gates.
- **Out of scope:** Ashby spam-flag rejections (nothing for a human to solve mid-form), passive scorers (reCAPTCHA v3 / fingerprinting), domain-level blocks (e.g. Tesla), and every standing carve-out (Apple-ID creation, CMU-address codes). Those keep today's semantics.
- **v0 assumes Felix is at the Mac** and solves on the pipeline browser's own screen. Remote solving (noVNC / screen share / phone) is explicitly v1.

## Flow

### 1. Applier: detect, record, move on — never block the slot

On an in-scope puzzle, the applier:

1. Verifies the puzzle class (screenshot as usual).
2. Writes the row's ledger block immediately (matches SKILL.md's Stage-2 template exactly):

   ```
   ## [<email row>] <Company> — <Title> — PARKED  (row number, not key8 — Stage 3 reconciles by row)
   - key <uuid> · ATS <ats> <form url> · PDF <file> · applier<i> · <HH:MM PT>
   - outcome: assist — <puzzle class> at <step>; tab left open for Felix
   - assist: pending
   - tab: <agent-browser tab id> · session: <AGENT_BROWSER_SESSION>
   - attempt: <n>
   - domain: <host>
   - filled: ats-fill <n> fields; manual: <field names so the sweep knows what remains>
   ```

3. Leaves the tab OPEN — assist-pending tabs are exempt from tab hygiene until the sweep resolves them (they still count toward the tab-coverage assertion; the sweep or Stage 3 closes them).
4. Moves on to its next job. The applier slot is never blocked waiting on a human (VM ask #2).

### 2. Orchestrator: batch the ping (VM asks #1, #3)

A C5 scheduler task (created at run start, removed at run end — the main session never sleeps to poll) checks the live part ledgers for `assist: pending` every 10 minutes during the run; the orchestrator also checks at wave end. New pending rows are batched into **one** Discord DM — never one DM per captcha:

> Captchas waiting (solve on the Mac's pipeline browser, then reply `done`):
> 1. tab 12 — AMD — hCaptcha — https://careers.amd.com/…
> 2. tab 17 — JHU APL — hCaptcha — https://careers.jhuapl.edu/…
> Reply `done` when solved (or `done 1` for just one), `skip` to park them.

Repeat pings for still-unsolved rows ride along with the next batch; a row is only ever listed, not re-DM'd on its own.

### 3. Felix: solve on screen, reply

Felix solves the puzzle(s) directly in the visible browser and replies `done` (all), `done <n>` (one), or `skip` (give up now). `skip` writes `assist: expired` on the listed rows immediately, so they file as walls at the next parse. No reply required — silence just means the timeout fallback fires later.

### 4. Sweep: finish the same attempt

Triggered by Felix's `done`, at wave end, or on retry-queue **exit 5** (no retry rows left but assists pending — 842244c; never start Stage 3 on exit 5), a sweep visits each pending tab and:

- Confirms the challenge is gone. If cleared: completes the SAME attempt — remaining fields, submit, confirmation screenshot — and rewrites the block per the shipped contract: `outcome: submitted` (or `retry` — whatever truthfully happened) with `- assist: solved` kept as provenance.
- If the puzzle is still there, the tab is gone, or the form state was lost: `assist: expired` and the block otherwise reverts to today's semantics; the tab is closed.

The sweep is a DEDICATED job-applier instance spawned by the orchestrator with retry-wave.json's `assist` array as its slice — never a message into a running applier, and the orchestrator never drives tabs itself (wrong model tier, blocks the main loop, breaks own-tab rules). It counts toward the max-2-appliers cap: if both slots are busy when `done` arrives, the sweep queues until a slot frees. **Run-end order is fixed: sweep → retry-queue (with deadline) → Stage 3** — running retry-queue first would demote pending rows to walls before the sweep touches them. Stage 3 never runs, and the browser is never stopped, while assist rows are still `pending`.

### 5. Timeout fallback (VM ask #4)

`--assist-timeout <min>` (default: end of run, i.e. the last sweep before Stage 3). At Stage 3 time any remaining `assist: pending` row is finalized `assist: expired`. Nothing is ever lost relative to today: an unsolved assist row ends exactly as the wall park it would have been.

## Arming (VM ask #4)

- `--assist` on the run/wave launch arms it for that run; absent → disarmed → today's instant-park behavior, byte-for-byte.
- Day-level toggle: Felix saying `assist on` / `assist off` (on either bot's Discord) sets **`resume-drops/state/assist.flag`** — git-synced like the seen sets, so both machines see it; run start pulls resume-drops and reads it. (A Mac-local flag would repeat the machine-local provenance trap.) The flag file records who set it and when.
- **Default for the 13:15 daily run: ARMED** (Felix's yes covers it; the timeout fallback makes an away-day harmless).

## Ledger / retry-queue contract (VM's side — SHIPPED, 0e2ea6d, deployed both machines)

- Class `assist` on the outcome line, sub-state on its own `- assist: pending | solved | expired` line (SKILL.md template updated to match).
- `pending` = held out of retry until the deadline and emitted as an `assist` array in `retry-wave.json` — that array is the sweep's worklist.
- `expired`, or still `pending` at the deadline = **wall** at parse time, reason `captcha-assist-expired` / `captcha-assist-unanswered`.
- `solved` = the sweep rewrites the block as `submitted` or `retry` (whatever truthfully happened), keeping `- assist: solved` as provenance; latest-block-per-key supersession as usual.

## Files touched (applier side, Local's lane)

- `agent/job-applier.md` — detect/record/move-on rules + tab-hygiene exemption.
- `skill/SKILL.md` — orchestrator poll + batch-DM + sweep + Stage-3 ordering ("no Stage 3 with pending assists").
- Sweep worklist comes free from VM's side: `retry-wave.json`'s `assist` array (no separate scan script needed).
- `resume-drops/state/assist.flag` — git-synced day toggle.

## Resolved review questions (VM, 2026-09-03)

1. Sweep identity: DEDICATED sweep applier spawned by the orchestrator, slice = the `assist` array; never message a running applier.
2. Mid-wave `done` with both slots busy: queue until a slot frees; the orchestrator must never drive tabs itself.
3. Max-open-assist-tabs guard: YES, cap 6 — beyond it the applier instant-parks (`outcome: wall`) as today.
