# Apply Engine — Driver Architecture (Phase 1 design)

Status: **DESIGN + WIP scaffold.** Not on the daily path. Tomorrow's 13:15
run uses the current stack unchanged.

---

## 1. Process model

Today's stack is **CLI-per-action**: every field is an `agent-browser`
subprocess spawn that reconnects to CDP, does one thing, and exits. That is
the root of three separate recorded problems:

- each spawn re-resolves the connection, which is where the silent
  private-browser launch got in (F1) and where the `.engine` pin trap lives (F2);
- spawn cost is real — the droplet measured **~266 ms per `agent-browser` CLI
  spawn**, so a 25-field form pays ~7 s in process startup alone;
- connection state is reconstructed from disk every time, so "which browser am
  I actually talking to" is a question that can get a different answer between
  two consecutive fills.

The engine is **one long-lived Node process per applier**, holding a
persistent in-process Playwright `Browser` handle.

```
orchestrator
  └── engine process (applier i)          ← one OS process, lives for the slice
        ├── CdpAttach            ← one connectOverCDP, held open
        ├── BrowserContext (applier i)    ← isolated: own cookies/storage
        │     └── Page  ──▶ FrameLocator chain (adapter-declared)
        ├── EventStream         ← JSONL, fsync on terminal events
        ├── Supervisor          ← watches for browser death, re-attaches
        └── ClaimClient         ← NullClaimClient in Phase 1
```

One process per applier rather than one process with N contexts: a crash
while applying to job A must not take down the applier working job B. That is
F4's lesson (a range close killed a sibling) applied at the process level.

## 2. CDP attach

```js
browser = await chromium.connectOverCDP(endpointURL)
```

Rules, each from a recorded failure:

1. **Never launch on the apply path.** `chromium.launch()` does not appear in
   engine code outside the smoke test. A failed attach throws; there is no
   fallback that could silently produce a private browser (F1).
2. **Endpoint resolution probes both families.** Chrome 149 for Testing binds
   DevTools to `::1` only, even given `--remote-debugging-address=127.0.0.1`
   (`pipeline-browser.sh:39-57`). `resolveEndpoint(port)` tries
   `http://127.0.0.1:<port>/json/version` then `http://[::1]:<port>/json/version`
   and returns the `webSocketDebuggerUrl` of whichever answers (F12). No
   IPv4 shim process needed — Playwright is given the URL that works.
3. **Identity is asserted, not assumed.** After attach, the engine reads
   `/json/version` and records `Browser` + `webSocketDebuggerUrl` in a
   `driver_event{kind:"attached"}`. The Playwright handle *is* the identity —
   there is no session-name indirection that could point somewhere else, which
   is what the handshake dance (`about:blank#<session>-handshake` + curl
   verify, `SKILL.md:194-200`) was compensating for. **The handshake becomes
   unnecessary, not merely automated.**
4. **No engine-pin files.** Nothing about the connection is persisted (F2).

## 3. Context per applier

`browser.newContext()` per applier, not `browser.contexts()[0]`.

- Isolated cookies, storage, and permissions per applier — two appliers on two
  Workday tenants no longer share a login.
- **No tab index space.** Everything is a `Page` object handle. The recorded
  "session pointer jumps to the newest tab" failure (F3) and the "re-pin with
  `tab <idx>` before every posting" ritual both disappear because there is
  nothing to index.
- `target=_blank` is handled by `context.on('page')`, so a popup is a handle
  the engine owns, not a tab that stole a shared pointer.
- Close by handle, by owner, only (F4).

**Caveat, now resolved:** `connectOverCDP` + `newContext()` on a real Chrome
creates a browser-level incognito-ish context. This is **confirmed on the exact
build the pipeline uses** — see §4a. Isolation holds, so the
`--user-data-dir-per-applier` fallback is not needed.

## 4. storageState

Per **ATS tenant**, not per applier:

```
engine/state/storage/<tenant-slug>.json     # e.g. workday-acme-wd1.json
```

- Saved after any successful login or account creation
  (`driver_event{kind:"storagestate_saved"}`).
- Loaded into a new context via `browser.newContext({ storageState })` when
  the tenant is seen again — including after a browser death (§5), which is
  what makes re-attach cheap instead of requiring a re-login.
- **Never committed.** `engine/state/` is gitignored; it contains session
  cookies. Credentials themselves stay in `~/zylos/.env` as today and are read
  only by the engine, never by an adapter (`interfaces.md` §2).
- Staleness: a loaded state that lands on a login page is discarded and the
  login is redriven; the engine does not trust the file over the page.

## 4a. GATE 0 — the storageState-across-death claim, MEASURED

The reviewer's first critique item (C1) was that §4 and §5 above are worthless
if `storageState` does not actually survive a browser death **on the build the
pipeline runs**, and that this must be proved before any more engine code is
written. It was, and it does.

**Test:** `engine/test/gate0-storagestate.test.js`. It does not simulate a
death. It establishes a real session (persistent cookie + `localStorage`) on a
real HTTP origin, saves `storageState`, then `SIGKILL`s the Chrome process
**with the page and context still live**, waits for the process to be gone and
for the Playwright handle to report `disconnected`, and then restores into a
**brand-new browser on a different port with a different temp profile** —
nothing carries over except the JSON file.

**Verdict: PASS**, on `Chrome/149.0.7827.55` (Playwright cache
`chromium-1228`, `chrome-mac-arm64` — the binary
`skill/scripts/pipeline-browser.sh` launches).

| Claim | Result |
|---|---|
| Persistent cookies survive the death | **yes** |
| The restored context actually **sends** the cookie on the wire (not merely holds it in a file) | **yes** — asserted by echoing `Cookie` back from the test origin |
| `localStorage` survives the death | **yes**, all keys |
| Restore works into a *different* browser, port, and profile | **yes** |
| Context isolation survives on the restored browser (a sibling context does **not** inherit the session) | **yes** |
| A restored context can **re-save** state forward (a chain of deaths does not degrade) | **yes** |
| `sessionStorage` survives | **no** — and it is not expected to |

Consequences, each load-bearing for a design decision above:

1. **§5's re-attach story stands.** After a browser death the engine rebuilds
   contexts from saved state rather than re-driving logins or restarting the
   run. The `--user-data-dir-per-applier` fallback is **not required** and is
   not implemented — see below for what would have been needed if it were.
2. **`sessionStorage` is off-limits to adapters.** No adapter may key flow
   state on it, and no step may be recognized by it, because the one thing
   Gate 0 proves does *not* survive is exactly that. Adapters carry flow state
   in the event stream instead.
3. **The build is pinned to the claim.** The test asserts the build string, so
   a Chrome upgrade that breaks this surfaces as a Gate 0 failure rather than
   as a mysterious re-login loop on a production day. **Gate 0 must be re-run
   after any Chrome-for-Testing upgrade** — that is now a release rule, not a
   suggestion.

**The fallback we did not need,** recorded so the option is not lost: had
`newContext()` isolation failed on this build, each applier would have needed
its own Chrome process with its own `--user-data-dir`, and the driver would
have become one-CDP-endpoint-per-applier with ports allocated by the
orchestrator. That costs ~5 Chrome processes of RAM, makes storageState
redundant (the profile *is* the state), and makes a wedged applier cheap to
kill in isolation. It is strictly more robust and strictly more expensive; if
a future Chrome breaks context isolation, this is the move.

## 5. Supervisor

Watches for the two distinct deaths the record shows are *not* the same thing
(F14 — a wedged Chrome is alive at ~100% CPU with CDP dead):

| Condition | Detection | Response |
|---|---|---|
| **CDP dead, process alive** (wedged) | `browser.on('disconnected')`, or an action rejecting with a target-closed error while `/json/version` times out | Do **not** restart the run. Report to the orchestrator; a wedged Chrome needs `pipeline-browser.sh stop` + `start --clean` (the `exit_type=Crashed` re-wedge, 2026-09-08 ×3), which is the orchestrator's call, not the engine's. |
| **Browser process gone** | `/json/version` connection-refused | Wait for the orchestrator to restart Chrome, then **re-attach and rebuild contexts from saved `storageState`** — do not restart the run, do not re-apply to jobs already `submitted` in the event stream. |
| **Page crashed, browser fine** | `page.on('crash')` | Recreate the page in the same context, resume at the current step from the event stream. |

Re-attach is bounded: **3 attempts, exponential backoff (2s, 8s, 30s)**, then
the engine exits non-zero with every in-flight job emitted as
`application_ended{outcome:"retry", reason:"browser-death"}` — which is
exactly the class the existing `retry-queue.js` already re-waves.

The critical property: **the event stream is the resume point.** Because every
step emits before and after, a restarted engine knows precisely which jobs
were submitted (never re-submit) and which were mid-flight (safe to retry).
Today that knowledge only exists in a markdown file written after the fact.

### 5a. Resume means RE-VERIFY, not resume (C2)

The reviewer's second critique: a resumed engine that trusts its own
pre-crash `field_filled` events is trusting a claim about a *browser that no
longer exists*. The form it re-attaches to may have been reloaded, may have
re-imported a cached profile (F16), or may never have received the value at
all if the crash landed between the fill and the read-back.

So the resume path is deliberately not an optimization:

```
re-attach
  → rebuild context from storageState
  → navigate to the step recorded in the stream
  → RE-RUN DISCOVERY from scratch on the form root
  → every field_filled recorded before the crash is UNVERIFIED:
      re-read it; if it matches intent, emit field_filled again
      (strategy:"reverify"); if it does not, re-fill and re-read
  → forbidden-value scan over the whole form
  → only now may the step advance
```

Nothing is skipped because "we already did it". The pre-crash events are used
for exactly one thing — knowing which jobs are already `submitted` so they are
never re-submitted — and for nothing else. A `field_filled` is evidence about
a moment, not a standing guarantee about a form, and the same reasoning that
makes C3 (re-check uploads after every advance) correct makes this correct.

## 6. Stop path

Never a pattern sweep. `pkill -f` kills the caller whose own command line
mentions the pattern — that is how a Stage 3 teardown killed its own shell
(exit 144, 2026-09-02) — and a bare `Chrome` pattern could hit Felix's real
browser (`SKILL.md:185-203`, Felix 2026-09-17).

**Kill by pidfile with a cmdline check:**

1. The launcher writes `engine/state/<name>.pid` containing the pid.
2. To stop: read the pid, then **verify the cmdline before signalling** —
   - Linux: read `/proc/<pid>/cmdline`, require it to contain the expected
     `--user-data-dir` path;
   - macOS (no `/proc`): `ps -p <pid> -o command=`, same substring check.
3. Only on a match, `SIGTERM`; after a grace period, `SIGKILL`.
4. A pid that does not match is a **stale pidfile** — remove it and do
   nothing. Never widen the search.

This is implemented in the scaffold for the scratch Chrome and is the pattern
the production stop path adopts.

## 7. Model-driven fallback

Unknown ATS, or a known ATS whose `identifyStep` returns `null` (tenant drift,
a redesign), falls back to the existing model-driven path — an agent reading
the page and acting. It plugs in at exactly one seam:

```
resolveAdapter(url) -> AtsAdapter | null
   null  ->  FallbackAdapter (model-driven)
```

The `FallbackAdapter` implements the same interface, so:

- **the event stream is unchanged** — a fallback application emits the same
  `field_mapped` / `page_advanced` / `submitted` events, so the ledger, the
  efficiency metric, and the review diff work identically;
- the quality gates still apply — review diff before submit, upload read-back,
  unmapped-required parks. The fallback may *discover* differently; it may not
  *decide* differently;
- `application_ended.model_turns` is non-zero for fallback runs and zero for
  adapter runs, which is how we measure what the adapters are buying us.

Mid-application degradation is allowed: an adapter that loses the flow emits
`adapter_note` + `page_advanced{to:null}` and the engine hands the *same
context and page* to the fallback. No restart, no reload, no lost form state.

## 8. Tool-call budget targets

Today's cost driver is one CLI spawn per action plus a model turn per
decision. The targets below are per application, counted as `seq` deltas
between `application_started` and `application_ended`:

**C7: only iCIMS keeps a line-item target.** The reviewer's objection to the
original table was that publishing `< 60` for Workday and `< 20` for
Greenhouse/Lever dressed estimates in the same typography as the one measured
number, and a target nobody measured is a target nobody can be held to. Those
rows now read **TBD from shadow** and are filled in from Gate 1 data, not from
this document.

| ATS | Target | Today (measured / estimated) | Why the target is reachable |
|---|---|---|---|
| **iCIMS** | **< 40** | **~470 calls, measured** (Cole Engineering fill alone, 2026-09-17) | See breakdown below — the only row with a measured baseline on both sides |
| Workday | **TBD from shadow** | est. 150-250 (multi-step wizard, account gate, dates) | Dates drop from ~12 per-digit `press` calls to 3 `fill` calls (F5); `storageState` removes per-tenant re-login. Magnitude unmeasured. |
| Greenhouse | **TBD from shadow** | ~25-40 with the fill script | Single page, one discovery pass, one review, one submit |
| Lever | **TBD from shadow** | similar | same |
| Ashby | **TBD from shadow** | similar + re-upload churn | Named upload target kills the `nth=0` autofill-input miss (F6) |

**Where iCIMS's ~470 → <40 actually comes from.** This is the headline claim
of the rebuild, so it should be auditable rather than asserted:

| Cost today | Calls | Under the engine |
|---|---|---|
| Re-snapshotting the whole a11y tree after every action (the only way to get a fresh `@ref`) | ~150 | 0 — Playwright locators re-resolve lazily on use; no snapshot step exists |
| Re-descending the nested iframe wrapper on each step / re-render | ~60 | 0 — `frameLocator` chains resolve inside the action itself |
| Per-digit `press` bursts on dates and numeric fields | ~40 | ~9 (3 dates × 3 `fill`) |
| Raw-coordinate `mouse move/down/up` recovery after snapshot desync (Cole, every radio/checkbox) | ~90 | 0 — never a coordinate click; role/label locators are immune to coordinate desync (A6) |
| One CLI spawn per field action, ~266 ms each | ~80 | ~30 in-process actions, no spawn |
| Manual re-verify passes by hand | ~50 | 1 discovery pass + 1 post-upload re-verify |

The two structural wins are that **the snapshot/`@ref` cycle disappears
entirely** (it is an artifact of a stateless CLI, not of browser automation)
and that **coordinate-click recovery disappears** (it was compensation for
snapshot desync inside iCIMS's nested iframes). Those two alone are ~300 of
the 470.

**Budget enforcement:** the engine carries a per-ATS soft cap. Crossing it
emits `adapter_note{msg:"over budget"}` and continues (never abandons a live
application over a metric); Stage 3 reports overruns so adapters get fixed.

Honest caveat: only the iCIMS number is measured; the others are estimates,
because **the current stack cannot count its own tool calls** — which is
precisely why `seq` exists in the event envelope. The first side-by-side day
(§9) produces the real baseline, and these targets should be re-set from it
rather than defended.

## 8a. Wall pre-flight and per-tenant memory

Today there is **no per-tenant wall store at all** — walls live as a coarse
`reason` string in that day's `retry-wave.json` and as prose in the ledger
that nothing reads back. So the same iCIMS gate is rediscovered from scratch
every day, at the cost of a tailored PDF and an applier slot each time.

**Pre-flight** runs in a **throwaway context** (own context, discarded after,
so a challenge cookie never contaminates the applier's context) *before*
tailoring:

1. `GET` the apply URL, follow redirects, record HTTP status.
2. Match the adapter's `wallMarkers` against the landed page.
3. Emit `preflight_result`. A detected wall means the job never consumes a
   tailoring slot.

**Per-tenant memory** — new file, `engine/state/walls.json`:

```json
{ "icims:careers-gdms.icims.com": {
    "wall_class": "hcaptcha", "occurrences": 3,
    "first_seen": "2026-09-09", "last_seen": "2026-09-17",
    "cleared_on_retry": 0, "retry_policy": "skip" } }
```

Policy, justified by the 2026-09-17 observation that **3 of 4 iCIMS gates did
not re-fire on a second visit** (F23):

- occurrences 1-2 → **one fresh-context retry**, then park. The retry is
  worth it: it succeeded 3 times in 4 on the one day we measured.
- occurrence ≥ 3 for a tenant → **skip the retry**, park immediately. GDMS is
  the recorded example of a tenant where the gate is real and persistent.
- `cleared_on_retry` is incremented when a retry succeeds, so the policy can
  be re-tuned from data instead of from this paragraph.

Known-hard classes short-circuit to park with no retry: `datadome` (the SPA
never renders, so there is no challenge to solve — B6), and a reCAPTCHA that
renders 0×0 (not interactable even by a human — Aramco, B4).

## 9. Migration / cutover

Explicitly **not** a flag-flip. Four gates, in order:

**Gate 0 — scaffold (this phase).** `npm test` passes: launch scratch Chrome
on a throwaway port, attach over CDP, create two isolated contexts, emit
events, assert stream shape. No production browser touched, ever.

**Gate 1 — shadow.** The engine runs against **already-submitted** postings
from a previous day, in a throwaway context, and stops **before** submit. It
emits a full event stream and a review diff. Success = the diff matches what
the current stack actually filled that day, per-field, for ≥ 3 postings per
ATS. Nothing is submitted; no risk to Felix's standing with any tenant.

**Gate 2 — side-by-side day.** One real day, **one ATS** (iCIMS first — worst
current cost, clearest win), **and the engine handles at most 3 postings**.
The current stack runs the rest of the day unchanged, in the same Chrome, in
its own contexts. Both write to the same day folder; the engine's rows are
marked `engine: true` in the ledger. Abort condition: any engine submit
without a passing review diff, any duplicate submission, any browser death
attributable to the engine → stop, revert to current stack for the remainder,
report.

**Gate 3 — per-ATS promotion.** An ATS graduates individually after **two
clean side-by-side days** on it. Greenhouse/Lever are the easiest and should
graduate first despite iCIMS being the biggest win, because they exercise the
shared engine path with the least adapter surface — de-risk the engine before
trusting a hard adapter.

Rollback at every gate is: **stop invoking the engine.** The current stack is
never modified, never has a shim inserted into it, and does not learn about
the engine's existence. That is a deliberate constraint of this branch, and it
is why no file under `skill/` is touched.

**Standing rule carried over:** the existing regression gate
(`scripts/pace-gate.sh` must run on each machine before any change to the
fill/stealth path) applies to engine changes that touch pacing, and the
agent-browser version + keydown count still get recorded. The engine does not
inherit an exemption.

## 10. What the scaffold implements (WIP)

- `src/driver/endpoint.js` — dual-family endpoint resolution (§2.2).
- `src/driver/attach.js` — `connectOverCDP`, no-launch guarantee, identity
  assertion.
- `src/driver/contexts.js` — context-per-applier, storageState load/save.
- `src/driver/supervisor.js` — disconnect detection + bounded re-attach
  (stubs the orchestrator-restart branch).
- `src/driver/procs.js` — pidfile write + cmdline-checked kill (§6).
- `src/events/*` — typed emitter with emit-time validation.
- `src/adapters/icims.js` — flow steps enumerated, selectors marked TODO.
- `test/smoke.test.js` — Gate 0.

Everything is marked WIP in-file. Nothing imports from `skill/`.
