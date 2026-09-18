# apply-engine — Phase 2 (WIP)

**Not on the daily path. Not deployed. Do not wire this into a run.**

The daily pipeline runs entirely on the current stack (`skill/`,
`agent/job-applier.md`, `agent-browser`). Nothing in this directory is
imported by it, and nothing here imports from it. The live skill assets are
opened **read-only** by the bank converter and are never modified.

## Status

| Phase | State |
|---|---|
| Phase 1 | design docs + scaffold, smoke test 12/12 |
| **Phase 2** | **reviewer rulings folded in; engine core implemented; iCIMS adapter carries real selectors; 92 tests** |

## GATE 0 — PASSED

The claim the whole supervisor design rests on: after a browser **death**, the
engine re-attaches and rebuilds contexts from saved `storageState` rather than
restarting the run.

`test/gate0-storagestate.test.js` does not simulate the death. It `SIGKILL`s
the scratch Chrome with a live page and live storage, then restores into a
**different browser, on a different port, with a different profile** — nothing
carries over but the JSON file.

**Verdict: PASS on `Chrome/149.0.7827.55`** (Playwright cache `chromium-1228`,
`chrome-mac-arm64` — the binary `pipeline-browser.sh` launches). Cookies and
`localStorage` both round-trip, the restored cookie is actually sent on the
wire, a sibling context does not inherit the session, and a restored context
can re-save state forward. `sessionStorage` does **not** survive and no adapter
may depend on it. The `--user-data-dir-per-applier` fallback is not needed;
`design/architecture.md` §4a records what it would have been.

**Gate 0 must be re-run after any Chrome-for-Testing upgrade** — the test pins
the build string so a breaking upgrade surfaces here rather than as a mystery
re-login loop on a production day.

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
                  submit, walls
src/adapters/     icims.js                      real selectors + confidence labels
assets/           GENERATED typed bank + conversion report
tools/            build-bank.js, recon.js, probe-hcaptcha.js
test/             92 tests; fixtures/ mimic iCIMS + Workday form shapes
```

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

92 tests. The browser-backed ones launch a scratch Chrome on a **randomized
throwaway port** (9222/9223 refused by `assertScratchPort`, not by convention)
and drive local fixtures over 127.0.0.1. No network, and the shared pipeline
browser is never contacted.
