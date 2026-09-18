<!-- GENERATED SAMPLE — not a real run.
     Produced by tools/metrics-report.js over a synthetic event stream built in
     the shape the Phase 2 fixture tests produce: three appliers, four ATSes,
     eight applications, including one wall, two `would_require_invention`
     parks and one empty-picklist park. Committed so the report FORMAT is
     reviewable before Gate 1 produces a real one.

     The iCIMS "OVER on 2/3" row is the interesting part and is not an artifact
     of the fixture: at the current weights a 24-field iCIMS form costs ~44
     calls, so the <40 target from architecture.md §8 may be unreachable for
     forms above roughly 16 fields. Gate 1 settles whether the target moves or
     the adapter does. -->

# Apply-engine metrics — 2026-09-17

Generated 2026-09-18T06:01:37.631Z from 3 applier file(s), 383 event(s).

## Gate 2 — submit gate

No violations. 5 submit(s) across 8 application(s); each was preceded by a fresh, passing review diff, and no application was submitted twice.

## Per-ATS

`tool_calls` = seq delta minus heartbeats (heartbeats are engine liveness, not work). `actions` = weighted browser round trips.

| ATS | apps | budget | p50 | p90 | max | actions p50 | model turns | verdict |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| icims | 3 | 40 | 44 | 58 | 58 | 42 | 0 | OVER on 2/3 |
| greenhouse | 2 | _TBD from shadow_ | 26 | 28 | 28 | 24 | 0 | TBD from shadow |
| workday | 2 | _TBD from shadow_ | 50 | 85 | 85 | 48 | 0 | TBD from shadow |
| lever | 1 | _TBD from shadow_ | 44 | 44 | 44 | 43 | 0 | TBD from shadow |

**icims over budget (40):** `00000001…` 44 (+4), `00000002…` 58 (+18)

Per architecture.md §8 an overrun never abandons a live application — it is reported so the adapter gets fixed.

## Per-application

| job | ATS | outcome | calls | actions | fills | req. skipped | invent-parks | walls | review |
|---|---|---|---:|---:|---:|---:|---:|---|---|
| `00000007…` | workday | submitted | 85 | 90 | 35 | 0 | 0 | — | pass |
| `00000002…` | icims | submitted | 58 | 56 | 23 | 0 | 1 | — | pass |
| `00000008…` | workday | needs-felix | 50 | 48 | 21 | 1 | 0 | — | — |
| `00000001…` | icims | submitted | 44 | 42 | 16 | 0 | 1 | — | pass |
| `00000006…` | lever | submitted | 44 | 43 | 18 | 0 | 0 | — | pass |
| `00000005…` | greenhouse | submitted | 28 | 27 | 10 | 0 | 0 | — | pass |
| `00000004…` | greenhouse | needs-felix | 26 | 24 | 10 | 0 | 1 | — | — |
| `00000003…` | icims | wall | 3 | 2 | 0 | 0 | 0 | hcaptcha | — |

## Totals

- applications: **8** (0 incomplete)
- submitted: **5** (63%)
- tool calls: **338**, model turns: **0**
- walls: **1**
- `would_require_invention` parks: **3** — Q2's number: what the never-invent rule costs us, measured rather than feared.

## Reading this

- Only the **iCIMS** budget is a measured target (~470 today vs <40 claimed, architecture.md §8). Every other row is `TBD from shadow` and is filled in from Gate 1 data by editing `BUDGETS` in `src/metrics/harness.js`, citing the run that produced the number.
- **Per-field review-diff ground truth for iCIMS must come from Mac-side runs.** The droplet has three submitted iCIMS rows ever, and the ledgers' `filled:` lines are prose, not per-field values — so a shadow diff run there can prove the engine READS a form correctly but cannot prove it would have filled it the same way the current stack did.
- An `incomplete` row is an application whose engine died before `application_ended`. Its cost is a floor, not a total.

