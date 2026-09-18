# apply-engine — WIP

**Not on the daily path. Not deployed. Do not wire this into a run.**

The daily pipeline runs entirely on the current stack (`skill/`,
`agent/job-applier.md`, `agent-browser`). Nothing in this directory is
imported by it, and nothing here imports from it.

Phase 1 of the apply-engine rebuild: a reviewable design plus a buildable
scaffold.

## Design (review these first)

| Doc | Contents |
|---|---|
| `design/interfaces.md` | Adapter interface, profile/answer-bank schema, typed event schema. Opens with F1-F23: every recorded failure mode on the current stack and the rule each one forces. |
| `design/architecture.md` | Driver process model, CDP attach, context-per-applier, storageState, supervisor, stop path, model-driven fallback, per-ATS tool-call budgets (the audited iCIMS ~470 → <40), wall memory, 4-gate cutover. |
| `design/claim-record.md` | Hub-side per-(tenant, job-id) claim record. **Spec only** — no hub changes in this phase. |

Open questions for the droplet reviewer are collected at the end of each doc
(Q1-Q8).

## Scaffold

```
src/events/schema.js       typed events, validated at emit time
src/events/emitter.js      JSONL stream, fsync on terminal events
src/driver/endpoint.js     dual-family CDP resolution (Chrome 149 binds ::1)
src/driver/attach.js       connectOverCDP + ApplierContexts
src/driver/supervisor.js   browser-death detection, bounded re-attach
src/driver/procs.js        pidfile + cmdline-checked kill (never pkill)
src/driver/scratch-chrome.js  TEST-ONLY launcher, throwaway port + profile
src/adapters/icims.js      flow steps from observed behaviour; selectors TODO
```

## Test

```
npm install && npm test
```

Gate 0: launches its own scratch Chrome on a **randomized throwaway port**
(9222/9223 are refused by `assertScratchPort`, not by convention), attaches
over real CDP, creates two isolated contexts, proves storage isolation and
per-tenant `storageState`, emits typed events, and asserts the stream shape.
Kills the scratch Chrome by pidfile with a cmdline check and removes the temp
profile.

The shared pipeline browser is never contacted.
