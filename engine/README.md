# apply-engine — Phase 3 (WIP)

**Not on the daily path. Not deployed. Do not wire this into a run.**

The daily pipeline runs entirely on the current stack (`skill/`,
`agent/job-applier.md`, `agent-browser`). Nothing in this directory is
imported by it, and nothing here imports from it. The live skill assets are
opened **read-only** by the bank converter and are never modified.

## Status

| Phase | State |
|---|---|
| Phase 1 | design docs + scaffold, smoke test 12/12 |
| Phase 2 | reviewer rulings folded in; engine core implemented; iCIMS adapter carries real selectors; 92 tests |
| **Phase 3** | **Workday + Greenhouse + Lever adapters from live recon; wall pre-flight; metric harness; Gate 2 in code; shadow runner. 234 tests** |

## Phase 3 at a glance

| Piece | Where | What it answers |
|---|---|---|
| Wall pre-flight | `src/engine/preflight.js` | classify a landed page into the closed wall enum, in a throwaway context, *before* tailoring spends a PDF and a slot |
| `ip_class` probe | `src/engine/ipclass.js` | one probe per run; offline is telemetry, not a failure; the IP never enters the stream |
| Wall memory + reuse | `src/engine/walls.js` | (tenant, class, where) with 14-day decay, plus a solved-challenge reuse window |
| Gate 2 | `src/engine/gate2.js` | the submit gate as a runtime refusal **and** an audit over a finished stream |
| Click-target guard | `src/engine/overlay.js` | the Kitware trap: hit-test before any submit click |
| Metric harness | `src/metrics/`, `tools/metrics-report.js` | per-application and per-ATS cost from the event stream; sample in `assets/metrics-sample.md` |
| Shadow runner | `tools/shadow.js` | Gate 1: drive a real posting to the edge of submit and stop |
| Adapters | `src/adapters/{workday,greenhouse,lever}.js` | three new ATSes, selectors from live recon |

## GATE 0 — PASSED

The claim the whole supervisor design rests on: after a browser **death**, the
engine re-attaches and rebuilds contexts from saved `storageState` rather than
restarting the run.

`test/gate0-storagestate.test.js` does not simulate the death. It `SIGKILL`s
the scratch Chrome with a live page and live storage, then restores into a
**different browser, on a different port, with a different profile** — nothing
carries over but the JSON file.

**Verdict: PASS on `Chrome/149.0.7827.55`** (Playwright cache `chromium-1228`,
`chrome-mac-arm64` — the binary `pipeline-browser.sh` launches) **and on
`Chrome/151.0.7922.34`** (Linux x64, node 22.23.1, `chromium-1234` — droplet,
2026-09-17). Cookies and `localStorage` both round-trip, the restored cookie is
actually sent on the wire, a sibling context does not inherit the session, and a
restored context can re-save state forward. `sessionStorage` does **not**
survive and no adapter may depend on it. The `--user-data-dir-per-applier`
fallback is not needed; `design/architecture.md` §4a records what it would have
been.

**Gate 0 must be re-run after any Chrome-for-Testing upgrade.** The pin is an
explicit `VERIFIED_BUILDS` allowlist of builds Gate 0 has actually been run on —
the previous `/^Chrome\/1\d\d\./` form accepted any build from 100 to 199, so
it would have let every upgrade through silently. A missing Chrome binary is a
Gate 0 **failure**, not a skip: Gate 0 is a claim about the browser.

## Design (review these first)

| Doc | Contents |
|---|---|
| `design/interfaces.md` | Adapter interface, profile/answer-bank schema, typed events. Opens with F1-F23 (every recorded failure and the rule it forces); §6 records the settled Q1-Q8 rulings and §7 the C1-C7 critique items. |
| `design/architecture.md` | Driver process model, CDP attach, context-per-applier, storageState, **§4a Gate 0 verdict**, supervisor + §5a resume-means-re-verify, stop path, fallback, budgets, wall memory, cutover. |
| `design/claim-record.md` | Hub-side per-(tenant, job-id) claim record. Spec only. |

## Layout

```
src/schema/       enums.js, fieldkeys.js        closed vocabularies
src/bank/         convert.js                    live assets -> typed bank (read-only)
src/events/       schema.js, emitter.js, reader.js
src/driver/       endpoint, attach, supervisor, procs, scratch-chrome
src/engine/       discovery, match, mapping, fill, advance, upload, review,
                  submit, walls, preflight, ipclass, gate2, overlay
src/metrics/      harness.js, report.js         per-application + per-ATS cost
src/adapters/     icims, workday, greenhouse, lever, registry
                  (+ workday-steps.js: the progress rail, parsed not assumed)
assets/           GENERATED typed bank + conversion report + metrics sample
tools/            build-bank.js, recon.js, probe-hcaptcha.js,
                  metrics-report.js, shadow.js
test/             234 tests; fixtures/ mimic iCIMS, Workday, Greenhouse and
                  Lever form shapes, one per wall class, and the Kitware trap
```

## Shadow runs (Gate 1)

```
node tools/shadow.js --url <apply-url> --allowlist postings.json [--out events.jsonl]
```

Drives discovery → map → fill → advance against a REAL posting and stops before
submit. Four refusals, in code, not flags: never submits; never enters an email
on a posting outside the allowlist (those run in probe mode, zero writes); never
creates or uses an account (its context carries no `secrets` at all); never
touches the pipeline browser. The allowlist holds postings the current stack has
already applied to, matched on origin+path so a `?gh_src=Simplify` cannot make
it miss.

## Metrics

```
node tools/metrics-report.js <run>/events/ [--out report.md]
```

Three numbers per application, kept separate because they disagree and the
disagreement is information: `seq_span` (§8's literal definition), `tool_calls`
(minus heartbeats, which are liveness rather than work — this is what the budget
is measured against), and `browser_actions` (a weighted estimate from an
explicit, arguable table). Leads with Gate 2 and exits non-zero on a violation,
so a supervising script cannot treat a violating run as a successful one.
Sample output: `assets/metrics-sample.md`.

## Typed bank

```
node tools/build-bank.js
```

Reads `~/zylos/.claude/skills/resume/assets/{application-profile.json,answer-bank.md}`
**read-only** and writes `assets/`. Produces 23 typed enum facts, 11 prose
answers, and a conversion report listing everything it could **not** type —
those park rather than being approximated. It refuses any key the live profile
contradicts itself about (a default set *and* listed under `missing`), which
currently catches `auth.clearance` and `misc.willingToTravel`.

## Reconnaissance

```
node tools/recon.js <apply-url> ...      # navigation-only, writes recon/ (gitignored)
node tools/probe-hcaptcha.js <url> ...
```

Strictly read-only: `goto`, `evaluate`(read), `screenshot` only. The file
asserts against **its own source** that it calls no click/fill/type/press verb,
so the guarantee survives a careless edit. Own scratch Chrome, randomized port,
own profile, one isolated context per tenant.

## Test

```
npm install && npm test
```

234 tests. The browser-backed ones launch a scratch Chrome on a **randomized
throwaway port** (9222/9223 refused by `assertScratchPort`, not by convention)
and drive local fixtures over 127.0.0.1. The shared pipeline browser is never
contacted.

**One test touches the network**, and only that one: the live `ip_class` probe
in `test/preflight.test.js`, which skips cleanly when there is none. Everything
else — including every wall class and the Kitware submit trap — runs against
local fixtures.
