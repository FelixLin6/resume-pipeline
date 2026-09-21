# Apply Engine — Interfaces (Phase 1 design)

Status: **DESIGN, REVIEWED AND SETTLED (Phase 2).** Nothing here is on the
daily path. The live skill (`~/zylos/.claude/skills/resume/`) and the current
stack in `skill/` are untouched by this branch.

The droplet reviewer has ruled on Q1-Q8 and raised seven critique items. Their
rulings are folded into the body of this document and are **authoritative** —
where a section previously offered a lean, it now states a rule. §6 records
the rulings verbatim-in-substance so the provenance of each rule is auditable.

Audience: the droplet reviewer (`zylos-felix-cloud`) and Felix.
Companion docs: `architecture.md` (driver/process model), `claim-record.md`
(cross-machine dedup).

---

## 0. Why this shape — the failure modes it is answering

Every interface decision below is traceable to a recorded failure on this
stack. The short list, with the rule each one forces:

| # | Failure (recorded) | Rule it forces here |
|---|---|---|
| F1 | agent-browser silently launched a **private/isolated** browser and every fill landed on `about:blank`; the `[agent-browser] launched browser` line prints on both real attaches and silent private launches (2026-09-02 crash storm; `ats-fill.js:57-67`, `SKILL.md:185-203`) | The engine **never launches** a browser on the apply path. It attaches over CDP to an already-running endpoint, and a failed attach is a **hard error**, never a fallback launch. No "engine pin" file, no auto-connect. |
| F2 | **Engine-pin trap**: per-session `.engine` pin files under `~/.agent-browser/` had to be deleted by hand after any failed call, or the session stayed bound to the stray browser (`job-applier.md:26-37`) | No per-session pin state on disk at all. Connection identity is a live in-process `Browser` handle; if it is gone, it is gone, and the supervisor re-attaches explicitly. |
| F3 | Session current-tab pointers **jump to the newest tab** when a sibling applier opens one; required re-pinning `tab <idx>` before every posting and after every `target=_blank` (`SKILL.md:165-184`) | One **isolated `BrowserContext` per applier**; every action goes through a `Page`/`FrameLocator` object handle, never an index into a shared tab list. Cross-talk becomes structurally impossible, not proceduraly avoided. |
| F4 | A tab-close **range loop** killed a sibling's in-flight application (2026-09-02) | Contexts are closed by handle, by their owner, only. There is no index space to range over. |
| F5 | Workday date-picker **crashed Chrome reproducibly**; per-digit `press` bursts wedged the shared CDP session 9× and garbled 2026 → 2006 (2026-09-07) | Date values are a typed `DateValue`, and the adapter declares a `dateStrategy`. Engine never opens a picker widget; Workday's adapter fills three spinbuttons with `fill`, one call each. Per-char typing is a pacing option, never the default path for numeric fields. |
| F6 | Ashby rendered an **autofill-from-resume file input before the real one**; `nth=0` hit the wrong input for 4 days of manual re-uploads (`ats-fill.js:230-232`) | Upload targets are **named, adapter-declared selectors**, not ordinals; and every upload is followed by a mandatory `verifyUpload` read-back. |
| F7 | Greenhouse replaces the file input with a "Remove file" row, so the input's file list cannot verify the upload (`ats-fill.js:149-151`) | `verifyUpload` is an **adapter method**, not engine logic — the adapter says what "attached" looks like on its DOM. |
| F8 | `"male"` matched `"Female"` by bare substring (2026-09-07) | Option matching is a shared, engine-owned normalizer with word-boundary semantics; adapters supply candidate values, never their own matcher. |
| F9 | Blue Origin Workday: values set by **DOM assignment** rendered but failed validation (2026-09-01) | Only real input events. The engine's fill primitives are Playwright `fill`/`type`/`selectOption`; no `evaluate`-assignment path exists in the API. |
| F10 | Truncated 8-char keys caused a **false 13-row coverage hole and 7 unmarked submissions** (2026-09-10); an unknown header label made a row silently vanish from the retry census (2026-09-05) | The ledger stops being parsed prose. Every fact is a field in a **typed event**, `job_key` always full, `outcome` a closed enum validated at emit time. |
| F11 | Model-guessed / invented answers were the standing risk the whole honesty regime exists to prevent (`job-applier.md:52-115`) | Answer bank is **schema-typed with enums**. An unmapped REQUIRED field raises `field_skipped{reason:"unmapped_required"}` and parks. The adapter may not call the model. |
| F12 | Chrome 149 for Testing binds DevTools to **`::1` only** even with `--remote-debugging-address=127.0.0.1`; agent-browser's v4 connect silently fell back to launching isolated browsers (`pipeline-browser.sh:39-57`) | The attach layer resolves the endpoint by **probing both `127.0.0.1` and `[::1]`** and uses the one that answers. No shim required; no silent fallback permitted. |
| F13 | `pkill -f <pattern>` killed the caller's own shell mid-teardown (exit 144, 2026-09-02); a bare "Chrome" pattern could hit Felix's real browser | Stop path is **kill-by-pidfile with a cmdline check**, never a pattern sweep. See `architecture.md` §6. |
| F14 | Wedged Chrome (alive, ~100% CPU, CDP dead) re-wedged on restart via `exit_type=Crashed` session restore (2026-09-08, 3×) | Supervisor distinguishes *process dead* from *CDP dead*, and **never restarts the run** — it re-attaches contexts from saved `storageState`. |
| F15 | **Résumé-parse autofill overwrote already-filled contact fields** — Rippling set email to the forbidden CMU address, blanked phone, invented "current company"; same on Cole iCIMS, SimVentions, Cotiviti, Jobvite, Eightfold (2026-09-16/17, ≥8 tenants) | Upload is a **discovery barrier**: the engine re-runs discovery and re-verifies every already-filled field *after* every upload. `post_upload_reverify` is a mandatory engine step, not adapter discretion. §5.5. |
| F16 | **Eightfold/Taleo stale-profile trap** — forms pre-load cached data from *unrelated earlier* applications: wrong résumé PDF silently pre-attached, email set to the forbidden CMU address; re-imports on every fresh visit even after correction (3× in one night, 2026-09-12) | `constraints.forbiddenValues` is extended to cover **forbidden identities** (the CMU address) and is checked on **read-back as well as write**. A forbidden value found *already in the form* is `field_skipped{reason:"forbidden_value"}` + mandatory correction, then re-verify. |
| F17 | **Cross-applier contamination**: applier2's tab pointer landed on applier1's live Tesla tab and an `upload` attached a **Cone Health PDF to a live Tesla application** (2026-09-12) | Context-per-applier (structural). Additionally, `upload_verified` asserts `stamped_job_key` matches the **current** `jobKey` — a mismatched artifact is a hard park, so even a hypothetical cross-wire cannot submit. |
| F18 | **Avature attaches one résumé per *account*, not per application** — Intuit AI Scientist went out with the iOS posting's PDF (2026-09-15) | Same `stamped_job_key` read-back assert (F17), which catches account-scoped artifacts too. This is why the stamp is in **PDF metadata**, not only the filename. |
| F19 | `ats-fill.js` **upload silently failed on 5 forms in one day** (EQT, Clockwork, Kitware, Nanopath, Collier — 2026-09-17), all redone by hand | `verifyUpload` is mandatory and its result gates advance. An unverified upload can never be followed by a submit. |
| F20 | **Cyvl submitted with a term mismatch** (form said Summer 2027, joblist said 2026) on a one-shot Ashby (2026-09-15) | Form-vs-joblist contradiction check is an **engine pre-submit gate** (`review_diff` severity `fail`), not an applier's reading comprehension. |
| F21 | **Invisible-size hCaptcha over SUBMIT** — a click meant to park on the widget passed through and filed an application unreviewed (Kitware, 2026-09-17) | The engine never clicks a captcha widget, and `submit()` is the only code path that may click a submit-labelled control — reachable only after a passing review diff. |
| F22 | A sweep agent pasted a freshly created iCIMS **password into `STAGED.md` and pushed it** (2026-09-17) | Events are schema-validated and there is **no event field that can carry a credential**. `secrets` values never enter `AdapterContext.log`, and `field_filled` carries a hash + masked preview only (Q5). |
| F23 | **iCIMS guest-apply hCaptcha fires *before* the form loads**, so an assist slot buys zero filled fields; it gated 8 postings across 6 tenants in one day. But on 2026-09-17, **3 of 4 gates did not re-fire on a second visit** — it is session/reputation-dependent, not a tenant setting | Wall memory is per-tenant with an **occurrence counter**, and the retry policy is "one fresh-context retry, then park; third occurrence for a tenant skips the retry" — which the 3-of-4 observation directly justifies. |

---

## 1. Ownership split: engine vs adapter

The engine is a **state machine over one application**. The adapter is a
**passive description of one ATS**, plus a small number of imperative hooks
where description is not enough.

### The engine owns

- The loop: `discover → map → fill → verify → advance`, repeated per page.
- The CDP connection, the context, the page, and their lifecycle.
- Field **discovery** (querying the accessible form controls in a frame).
- **Mapping** discovered fields to profile/answer-bank values, including all
  normalization and option matching (F8).
- All **fill primitives** (`fill`, `selectOption`, `setInputFiles`, `check`),
  with pacing applied uniformly.
- The **event stream** (§4). Adapters never write events directly; they
  return values and the engine emits.
- **Retry, park, and budget** policy. An adapter cannot decide to park.
- The **review-page diff** and the submit gate (F10, §5 of `architecture.md`).
- Wall detection dispatch and per-tenant wall memory.

### The adapter owns

- **Selectors and frame paths** for this ATS, as data.
- The **page-flow graph**: which steps exist, how to recognize the current
  one, and how to advance.
- **Quirks**: how a date is entered, how an upload is verified, whether a
  picker needs `Enter` pressed to render results, whether a login/guest gate
  precedes the form.
- **Option-text vocabularies** where the ATS's wording deviates (mapping the
  canonical enum to *candidate* option texts — the engine still does the
  matching).

### The adapter must NOT

- Call the model. (F11)
- Emit events, write the ledger, or touch the filesystem.
- Open a browser, create a context, or close a page.
- Decide an outcome (`submitted` / `wall` / `park`). It reports observations;
  the engine decides.
- Click Submit. Only the engine's `submit()` step does, and only after the
  review diff passes.

This split is the point of the rebuild: adapters are the part that changes
weekly as tenants drift, so they must be cheap, declarative, and
un-privileged.

---

## 2. The adapter interface

ESM module, default-exporting one object. TypeScript-style signatures given
for precision; Phase 1 scaffold is plain ESM with JSDoc types.

```ts
interface AtsAdapter {
  /** Stable id: "icims" | "workday" | "greenhouse" | "lever" | "ashby" */
  readonly id: string;

  /** Adapter contract version. Engine refuses an adapter whose major
   *  differs from its own. */
  readonly apiVersion: 1;

  /** URL patterns that select this adapter. First match wins; order is
   *  defined by the registry, not by the adapter. */
  readonly match: {
    hostnames: RegExp[];          // e.g. [/\.icims\.com$/]
    pathHints?: RegExp[];         // disambiguates shared hosts
  };

  /** Tenant identity for storageState, wall memory, and claim records.
   *  Pure function of the URL — no network, no page access. */
  tenantOf(url: URL): string;     // "icims:jobs.example.com"

  /** ---- Lifecycle ---- */

  /** Normalize the ENTRY url before the first navigation. Pure URL→URL —
   *  no network, no page access. Exists because tracker-decorated posting
   *  links can force a layout outside the adapter's model: Simplify hands
   *  out iCIMS links with `mobile=true&needsRedirect=false`, which renders
   *  a frameless mobile layout (no `icims_content_iframe`) and suppresses
   *  the redirect that would fix it (Lennox, fleet 0918). Every navigator
   *  (shadow, preflight) applies it when present. */
  entryUrl?(url: URL): URL;

  /** Called once per applier context, before the first navigation.
   *  Sets context-level things the ATS needs (extra headers, locale,
   *  default timeouts). MUST NOT navigate. */
  prepareContext?(ctx: AdapterContext): Promise<void>;

  /** DECLARATIVE sign-in (Q1). Selectors only — the engine drives the
   *  typing, so a credential never enters adapter code and never enters an
   *  adapter's stack frame. This is the ONLY supported path for signing in
   *  to an existing account. */
  readonly loginSpec?: LoginSpec;

  /** Whether this adapter is permitted to CREATE accounts. Default false.
   *  This flag alone decides whether `ctx.secrets.forTenant()` exists on the
   *  context handed to `passGate` (Q1). */
  readonly accountCreation?: boolean;

  /** Gate that runs before the application form is reachable:
   *  iCIMS guest-apply / "Apply with..." chooser, a cookie banner, Workday
   *  ACCOUNT CREATION. Returns how it resolved.
   *
   *  Q1 ruling: `passGate` is imperative and is reserved for account
   *  *creation* and for non-credential gates. It receives
   *  `ctx.secrets.forTenant()` **only when the adapter declares
   *  `accountCreation: true`**; on every other adapter that method is absent
   *  from the context object, not merely unused. Ordinary sign-in goes
   *  through `loginSpec` and never reaches adapter code. */
  passGate?(ctx: AdapterContext): Promise<GateResult>;

  /** ---- Page flow ---- */

  /** The ordered step graph for this ATS. Declarative. */
  readonly steps: StepSpec[];

  /** Identify which step the current page is. Called after every
   *  navigation and every advance. Returning null => unknown page, engine
   *  falls back to the model-driven path (architecture.md §7). */
  identifyStep(ctx: AdapterContext): Promise<StepId | null>;

  /** Move from the current step to the next one. Implements the click +
   *  the wait. MUST use page.waitForURL / locator waits — never a bare
   *  sleep, never a coordinate click. */
  advance(ctx: AdapterContext, from: StepId): Promise<AdvanceResult>;

  /** ---- Fields ---- */

  /** Where the form lives. Returns the FrameLocator chain to descend
   *  (iCIMS nests iframes; Greenhouse/Lever are top-level). The engine
   *  calls this before every discovery pass, because iCIMS re-creates
   *  its inner frame on step change. */
  formRoot(ctx: AdapterContext, step: StepId): Promise<FrameRootSpec>;

  /** Adapter-declared field bindings for this step: the ones where label
   *  discovery is unreliable or the selector is known. Merged with (and
   *  takes precedence over) the engine's generic discovery. */
  bindings(step: StepId): FieldBinding[];

  /** ---- Quirks ---- */

  readonly quirks: {
    /** How this ATS wants a date. */
    dateStrategy: 'three-spinbuttons' | 'single-text' | 'mm/dd/yyyy-text' | 'iso-text';
    /** Typeahead pickers that need an explicit Enter to render results. */
    typeaheadNeedsEnter: boolean;
    /** Never open a native date-picker widget on this ATS (F5). */
    forbidDatePicker: boolean;
    /** Max submit attempts, ever, per (tenant, job).
     *
     *  Q4 ruling: **the default is 1 for every ATS**, not just Ashby. An
     *  adapter that sets this above 1 must carry an inline comment citing
     *  *observed tenant idempotency* — a specific run where a re-submit was
     *  seen to be de-duplicated by the tenant. "Probably fine" is not a
     *  citation. A double submission is worse than a missed retry in every
     *  case in the record.
     *
     *  The companion rule lives in the submit step, not here: a submit whose
     *  CLICK succeeded but whose confirmation read timed out is recorded as
     *  `submitted` with `verified_by:"unconfirmed-click"` and is **never
     *  retried**, regardless of this number. */
    maxSubmitAttempts: number;
    /** Selector fragments whose presence means a human-verification wall. */
    wallMarkers: WallMarker[];

    // ---- PHASE 3 ADDITIONS, each forced by a live-recon finding ----------

    /** The submit control and the captcha wrappers that can sit over it.
     *  The ENGINE hit-tests before any submit click (F21); the adapter only
     *  says which selectors to test. See §5.7. */
    submitControl?: {
      selector: string;
      captchaWrappers?: string[];
      captchaResponse?: string | null;
      preClick?: { pressEscape?: boolean; scrollIntoView?: boolean };
    };

    /** Controls that exist but must never be filled or counted.
     *
     *  Not a convenience — without it the Greenhouse adapter parks 100% of
     *  applications. Every react-select control on a Greenhouse form is
     *  shadowed by a LABEL-LESS input marked `required`
     *  (`input.remix-css-…-requiredInput`, five of them on the CoVar form).
     *  A required control with no label maps to no FieldKey, and an unmapped
     *  required field parks — so a form that is perfectly fillable on screen
     *  becomes unfillable by the engine.
     *
     *  It is also how a BOT HONEYPOT is refused: Workday renders a visible,
     *  innocuous-looking `input[name="website"]
     *  [data-automation-id="beecatcher"]` labelled "Enter website. This input
     *  is for robots only, do not enter if you're human." Generic label
     *  discovery maps it to `links.website` and fills it.
     *
     *  Noise is SUPPRESSED, never hidden: suppressed controls stay in
     *  `discovered.all` with `noise: true`, and `field_discovered` reports
     *  `noise_suppressed`, so an adapter that over-declares noise is visible
     *  in the stream rather than quietly skipping real fields. */
    noiseSelectors?: string[];

    /** Controls the engine must never click. Chiefly résumé-parse autofill
     *  (F15: eight tenants whose parser overwrote already-correct contact
     *  fields, including setting the email to the forbidden CMU address). */
    forbiddenControls?: string[];
  };

  /** Upload one artifact. Named target, never an ordinal (F6). */
  upload(ctx: AdapterContext, target: UploadTarget, file: ArtifactRef): Promise<void>;

  /** Read-back assertion after upload — adapter knows what "attached"
   *  looks like on its own DOM (F7). Returns what it actually observed. */
  verifyUpload(ctx: AdapterContext, target: UploadTarget, file: ArtifactRef): Promise<UploadEvidence>;

  /** Scrape the review/confirmation page into {label -> rendered value}
   *  so the engine can diff it against intended values before submit. */
  readReview?(ctx: AdapterContext): Promise<Record<string, string>>;

  /** After submit: pull the confirmation text and the ATS's own
   *  application id, which is the primary verification (inbox secondary). */
  readConfirmation(ctx: AdapterContext): Promise<ConfirmationEvidence>;
}
```

### `AdapterContext`

The only surface an adapter may touch. It is deliberately **narrower than
Playwright's `Page`**: no `page.close()`, no `context.newPage()`, no
`evaluate` (F9), no `browser`.

```ts
interface AdapterContext {
  readonly jobKey: string;        // full uuid, never truncated (F10)
  readonly tenant: string;
  readonly url: URL;              // current, refreshed by the engine
  readonly page: RestrictedPage;  // goto/waitForURL/locator/frameLocator/
                                  // getByRole/getByLabel/keyboard/screenshot
  readonly frame: FrameLocator | RestrictedPage;  // the resolved form root
  readonly log: (msg: string, data?: object) => void;  // observation only;
                                  // becomes an adapter_note event, never a
                                  // parsed log line (F10)
  readonly secrets: {
    /** Credential for this tenant. PRESENT ONLY when the adapter declares
     *  `accountCreation: true` (Q1) — on every other adapter this method is
     *  absent from the object, so an adapter cannot obtain a credential even
     *  by calling it. The adapter receives the value; it never learns the
     *  source and cannot enumerate. */
    forTenant?(): Promise<{ username: string; password: string } | null>;
    /** One-time code from the pipeline inbox, adapter-blind to IMAP.
     *  Returns the code AND the id of the message it came from, so the
     *  ledger can show which email was consumed without the engine having to
     *  re-read the mailbox (Q1). */
    verificationCode(opts: { since: Date; matching: RegExp }):
      Promise<{ code: string; sourceMessageId: string } | null>;
  };
  readonly deadline: Date;        // engine-owned per-application budget
}
```

### Q1 ruling — credentials never reach adapter code

1. **Sign-in is declarative.** The adapter supplies a `LoginSpec` (selectors);
   the engine does the navigating, typing and waiting. A credential is read
   from `~/zylos/.env` by the engine and written into the page by the engine.
2. **`passGate` stays imperative, but only for account *creation*** and for
   gates that involve no credential (iCIMS guest-apply, cookie banners,
   "Apply with…" choosers).
3. **`secrets.forTenant()` is conditionally present.** The engine builds the
   `AdapterContext` per adapter; `forTenant` is attached only when
   `adapter.accountCreation === true`. Capability, not convention.
4. **The engine redacts by value-match before emit.** Every `adapter_note`
   (and every other event payload) is scanned at emit time for the *literal
   values* of any secret loaded for this run, and each occurrence is replaced
   with `[redacted:secret]`. The existing forbidden-*key* check (F22) catches
   `{password: …}`; this catches `log("created account with Hunter2!")`, which
   is the shape the 2026-09-17 leak actually had. Both run.

```ts
interface LoginSpec {
  /** Marker that says "this page is the sign-in page". */
  at: { urlPattern?: RegExp; selector?: string; text?: RegExp };
  username: string;               // selector
  password: string;               // selector
  submit: string;                 // selector
  /** Optional selectors for the two-step layouts (Workday). */
  continueAfterUsername?: string;
  /** How the engine knows it worked / failed — never a sleep. */
  success: { urlPattern?: RegExp; selector?: string };
  failure?: { selector?: string; text?: RegExp };
  /** If sign-in can demand an emailed code. */
  verification?: { input: string; submit: string; matching: RegExp };

  /** PHASE 3 ADDITION. A control that must be pressed before the username
   *  field EXISTS. Distinct from `continueAfterUsername`, which is pressed
   *  after the username is typed.
   *
   *  Forced by live recon on Jabil's Workday tenant, which renders Apple /
   *  Google / LinkedIn / "Sign in with email" buttons and NO email field at
   *  all until the last is pressed. It stays declarative because it is a
   *  credential-free click, so no credential enters adapter code. */
  revealForm?: string;
}
```

### Supporting types

```ts
type StepId = string;             // "guest-apply" | "my-information" | ...

interface StepSpec {
  id: StepId;
  /** Human label for events/ledger. */
  title: string;
  /** How identifyStep recognizes this page. Declarative markers, matched
   *  inside the form root. */
  markers: { urlPattern?: RegExp; text?: RegExp; selector?: string }[];
  /** Fields the engine should expect here; a REQUIRED one that is never
   *  discovered is an error, not a silent skip (F10/F11). */
  expects: FieldKey[];
  /** Whether this step is the review page and/or the submit page. */
  isReview?: boolean;
  isSubmit?: boolean;
  /** Steps that may legitimately be skipped by a tenant. */
  optional?: boolean;
}

interface FieldBinding {
  key: FieldKey;                  // canonical schema key, §3
  selector?: string;              // CSS/role selector inside the form root
  label?: RegExp;                 // fallback: label-based discovery
  control: 'text' | 'textarea' | 'select' | 'combobox' | 'radio'
         | 'checkbox' | 'date' | 'file' | 'spinbutton';
  required: boolean;
  /** Canonical enum value -> candidate option texts for this tenant.
   *  Engine does the matching; this is vocabulary, not logic (F8). */
  optionText?: Record<string, string[]>;
}

interface FrameRootSpec {
  /** Ordered frame chain, outermost first. Empty = top-level document.
   *  iCIMS: ["iframe#icims_content_iframe", "iframe[name=icims_iframe]"]. */
  frames: string[];
  /** Selector for the form element inside the innermost frame. */
  form?: string;
}

type GateResult =
  | { kind: 'none' }                                  // no gate present
  | { kind: 'passed'; via: 'guest' | 'login' | 'account-created' }
  | { kind: 'wall'; wallClass: WallClass }            // engine decides park
  | { kind: 'needs-human'; unlock: string };          // e.g. CMU-address code

interface AdvanceResult {
  to: StepId | null;              // null = flow ended (or unknown)
  /** Validation errors the ATS rendered when we tried to advance. */
  blockedBy?: { field?: FieldKey; message: string }[];
}

type WallClass =
  | 'hcaptcha' | 'recaptcha-interactive' | 'recaptcha-v3-score'
  | 'datadome' | 'cloudflare-challenge' | 'spam-flag'
  | 'http-403' | 'http-429' | 'tenant-5xx' | 'account-required'
  // Phase 3. `akamai` refuses rather than challenging (a reference number and
  // no widget), so it must not sit in a class that retries. `tenant-broken`
  // (the SmartRecruiters NG0908 signature) is the tenant being DOWN, not the
  // tenant gating us. See architecture.md §8b.
  | 'akamai' | 'tenant-broken'
  | 'unknown-challenge';

/** What the engine decided to do about a detected wall. Closed, and refused at
 *  emit time if it is not one of these. */
type WallAction =
  | 'retry-fresh-context' | 'park' | 'skip-retry-third-strike'
  | 'reuse-solved-session';   // Phase 3, architecture.md §8b

interface WallMarker { wallClass: WallClass; selector?: string; text?: RegExp; status?: number; }

interface UploadTarget { name: 'resume' | 'transcript' | 'cover-letter' | 'other'; hint?: string; }

interface ArtifactRef {
  path: string;
  sha256: string;                 // computed at tailor time
  bytes: number;
  /** Job key stamped into filename AND PDF metadata (quality gate). */
  stampedJobKey: string;
}

interface UploadEvidence {
  observedName: string | null;
  observedBytes: number | null;
  /** True only if the adapter positively saw the artifact attached. */
  attached: boolean;
  how: 'input-files' | 'filename-in-dom' | 'remove-button' | 'other';
}

interface ConfirmationEvidence {
  applicationId: string | null;
  text: string;
  url: string;
  screenshotPath?: string;
}
```

---

## 3. Profile and answer-bank schema

The current `application-profile.json` is a **flat fact sheet read by regex**
(`ats-fill.js:156-183` hard-codes question regexes against profile booleans).
That is exactly what made F8 and F11 possible: the question text drives the
answer. The rebuild inverts it — **the canonical answer is a typed enum, and
the adapter maps it to this tenant's option text.**

### 3.1 Canonical enums

Every value the engine can put into a form is one of:

```ts
type YesNo = 'yes' | 'no';

type WorkAuthorization = 'us-citizen' | 'permanent-resident'
  | 'authorized-no-sponsorship' | 'authorized-needs-sponsorship'
  | 'not-authorized';

type SponsorshipNeed = 'none-now-or-future' | 'future-only' | 'now';

type ClearanceLevel = 'none' | 'eligible-not-held' | 'confidential'
  | 'secret' | 'top-secret' | 'ts-sci';

type DegreeLevel = 'high-school' | 'associate' | 'bachelors' | 'masters'
  | 'phd' | 'other';

type EmploymentType = 'internship' | 'co-op' | 'full-time' | 'part-time';

type WorkArrangement = 'onsite' | 'hybrid' | 'remote';

type Gender = 'male' | 'female' | 'non-binary' | 'decline';
type VeteranStatus = 'not-a-protected-veteran' | 'protected-veteran' | 'decline';
type DisabilityStatus = 'no' | 'yes' | 'decline';
type Ethnicity = 'asian' | 'white' | 'black' | 'hispanic-latino'
  | 'native-american' | 'pacific-islander' | 'two-or-more' | 'decline';
```

Rationale: `"male"` vs `"Female"` (F8) cannot recur, because the engine never
matches the *canonical* string against option text directly — it matches each
candidate in `optionText['male']` with word-boundary equality, and an
unmatched REQUIRED enum is a park, not a guess.

### 3.2 Profile

```ts
interface Profile {
  schemaVersion: 2;
  identity: {
    firstName: string; lastName: string; fullName: string;
    preferredName: string | null; pronouns: string | null;
  };
  contact: {
    email: string;                // pipeline address only
    emailForbidden: string[];     // CMU address — never used (constraints)
    phone: { e164: string; digits: string; formatted: string; type: 'mobile' };
    address: {
      line1: string; line2: string | null; city: string;
      state: string; stateFull: string; postalCode: string;
      country: 'US'; countryFull: 'United States';
    };
  };
  links: { linkedin: string; github: string; website: string | null };
  education: EducationEntry[];
  experience: ExperienceEntry[];
  authorization: {
    workAuthorization: WorkAuthorization;
    sponsorship: SponsorshipNeed;
    citizenship: string;
    itarEarEligible: boolean;
    clearance: ClearanceLevel;
    over18: YesNo;
    driversLicense: YesNo;
  };
  availability: {
    /** Canonical start date. A form wanting a "full date" gets the
     *  1st-of-month rule applied by the engine, not by an adapter. */
    earliestStart: DateValue;
    terms: string[];               // "Summer 2027", ...
    employmentTypes: EmploymentType[];
    hoursPerWeek: string | null;
  };
  locationPolicy: {
    openToRelocation: YesNo;
    arrangements: WorkArrangement[];
    currentLocation: string;
  };
  selfId: {
    gender: Gender; ethnicity: Ethnicity; hispanicOrLatino: YesNo;
    veteran: VeteranStatus; disability: DisabilityStatus;
    signatureName: string;
  };
  /** Hard rules the engine enforces mechanically, not by prompt. */
  constraints: {
    neverInvent: true;
    gpa: { value: number; scale: number;
           bandRule: 'nearest-band-never-round-up' };
    /** Fabricated-number blocklist AND forbidden identities (the CMU
     *  address). Checked on write and on read-back (F16). */
    forbiddenValues: string[];
    forbiddenIdentities: string[]; // ["felixl@andrew.cmu.edu"]
    onePacketRule: true;           // form values must match the attached PDF
    /** No years/months of experience for any language or tool — none are
     *  on file. A form demanding one parks. */
    noDurationsForTools: true;
  };
}

interface EducationEntry {
  school: string; schoolAliases: string[];
  degreeLevel: DegreeLevel; degreeText: string;
  fieldOfStudy: string; fieldOfStudyFallbacks: string[];
  start: DateValue; end: DateValue; endIsExpected: boolean;
  gpa: number | null;
  currentlyEnrolled: YesNo; returningAfterInternship: YesNo;
  classStanding: string;
}

interface DateValue {
  year: number; month: number; day: number | null;
  /** When day is null and a form demands one. */
  dayRule: 'first-of-month';
}
```

`DateValue` being a type rather than a string is the direct answer to F5: the
engine hands the adapter a `DateValue` and the adapter's `dateStrategy`
decides the three `fill` calls. No format string is ever guessed from a
placeholder.

### 3.3 Answer bank

```ts
interface AnswerBank {
  schemaVersion: 2;
  /** Typed, closed-vocabulary answers — the ONLY source for enum fields. */
  facts: Record<FieldKey, EnumAnswer>;
  /** Free-text: pre-written, slot-filled, never authored at runtime. */
  prose: ProseAnswer[];
  /** Questions Felix has explicitly ruled unanswerable -> always park. */
  alwaysPark: { pattern: RegExp; reason: string }[];
}

interface EnumAnswer {
  value: string;                  // one of the canonical enums
  /** Provenance, carried into the event stream for auditability. */
  source: 'profile' | 'felix-explicit';
}

interface ProseAnswer {
  id: string;                     // "A-why-company"
  /** Which question kinds this answers. Matched by the engine's
   *  classifier, which is deterministic keyword+embedding, not a
   *  free-form model call. */
  covers: RegExp[];
  variants: { maxWords: number; text: string }[];
  /** Slots the engine fills from JD facts already in joblist.json.
   *  A slot with no JD fact available => park, never improvise. */
  slots: { name: string; from: 'jd.team' | 'jd.product' | 'jd.stack' }[];
}
```

**Q2 — SETTLED (see ruling below).** The original question was: free-text. The settled plan says "unmapped REQUIRED
field → park, never model-guess", and enum fields are fully covered by the
above. But a novel *essay* question ("describe a time you…") that the bank
does not cover is currently a park, and on recent days that is a meaningful
share of the parked pile. Two options: (a) park always — maximal safety,
today's behavior; (b) allow a model call **restricted to assembling from bank
+ profile text only**, with the assembled answer stored verbatim in the event
stream for Felix to audit post-hoc. I lean (a) for Phase 2 and revisit with
data — the event stream will tell us exactly how many applications (a) costs
us, which we currently cannot measure. Your call matters here since you
raised the typed-event requirement partly for this.

### Q2 ruling — novel essays PARK in this phase

A novel essay question the bank does not cover is a **park**, full stop. No
assembly, no model call, no "restricted composition from bank + profile" —
that path is not built in Phase 2 and no code path exists that could reach it.

The park is recorded as `field_skipped{reason:"would_require_invention"}`, and
the engine **counts these per run day** and reports the count on the day's
summary. That number is the entire point of parking rather than guessing: it
converts "we might be losing applications to this rule" from an anxiety into a
measurement. Phase 3 revisits assembly *with* the count in hand, or does not.

The reason code stays distinct from `unmapped_required`: an unmapped required
*enum* is a bank gap fixable by adding a fact; a `would_require_invention` is
a question no bank entry could answer without writing new prose. Conflating
them would hide which of the two is actually costing us applications.

### 3.4 `FieldKey`

A closed set, shared by profile, answer bank, adapter bindings, and events.
Adapters bind to `FieldKey`s, never to labels:

```
identity.firstName | identity.lastName | identity.fullName | identity.preferredName
contact.email | contact.phone | contact.address.line1 | contact.address.city
contact.address.state | contact.address.postalCode | contact.address.country
links.linkedin | links.github | links.website
education.school | education.degreeLevel | education.fieldOfStudy
education.startDate | education.endDate | education.gpa
auth.workAuthorized | auth.sponsorship | auth.over18 | auth.clearance
auth.itarEligible | auth.previouslyEmployed
avail.earliestStart | avail.term | avail.employmentType | avail.hoursPerWeek
loc.relocation | loc.arrangement | loc.currentLocation
selfid.gender | selfid.ethnicity | selfid.hispanic | selfid.veteran
selfid.disability | selfid.signature | selfid.date
upload.resume | upload.transcript | upload.coverLetter
prose.<promptId>
source.howDidYouHear
```

An adapter that needs a key not on this list must add it here first — same
discipline as the pinned ledger label set (F10), and for the same reason.

---

## 4. The typed event stream

**One stream, three consumers.** The ledger, the efficiency/tool-call metric,
and the review-page diff all read this and nothing else. No log-line parsing
anywhere (this was the droplet's requirement, and F10 is why it is right).

### 4.1 Transport

- **JSONL**, one object per line, append-only, `fsync` on submit-class events.
- **Per-applier files** (Q3 ruling): `~/zylos/workspace/resume-drops/<date>/events/applier<i>.jsonl`.
- Written by exactly one engine process; nothing else ever writes that file.

**Q3 ruling — per-applier files, merge key `(applier, seq)`.**

One shared file with `O_APPEND` would make Stage 3 trivial but puts a dying
applier's partial write in the same file as a healthy sibling's records. That
is F4's lesson (a range close killed a sibling's in-flight application) applied
to files: **a failing applier must not be able to damage another applier's
record.** So:

- one file per applier, merged at read time;
- the merge key is the pair **`(applier, seq)`** — globally unique because
  `seq` is per-applier monotonic, and stable under re-ordering, so the merge is
  a sort, not a reconciliation;
- **a truncated final line is DROPPED and REPORTED, never repaired.** The
  reader discards the unparseable tail, counts it, and surfaces
  `events_truncated: {applier: i, bytes: n}` in the Stage 3 summary. No
  best-effort JSON repair, no "probably it was an application_ended". A
  half-written event is an absence of information, and inventing its contents
  is exactly the class of error the typed stream exists to abolish.

A crash mid-application therefore leaves a valid prefix plus one reported
casualty — which is what makes it crash-safe where the compact markdown ledger
was not.

### 4.2 Envelope

Every event, without exception:

```json
{
  "v": 1,
  "ts": "2026-09-17T20:14:03.221Z",
  "seq": 418,
  "run": "2026-09-17",
  "applier": 2,
  "job_key": "8f2c1a94-...-full-uuid-never-truncated",
  "tenant": "icims:jobs.example.com",
  "ats": "icims",
  "step": "my-information",
  "type": "field_mapped",
  "data": { }
}
```

`seq` is a per-applier monotonic counter — it is what makes the tool-call
budget measurable (§4.4) and makes gap detection possible after a crash.

### 4.3 Event types

```jsonc
// Application lifecycle
{ "type": "application_started",
  "data": { "apply_url": "...", "pdf": "...", "pdf_sha256": "...",
            "attempt": 1, "claim": "held|none|offline" } }

{ "type": "preflight_result",
  "data": { "reachable": true, "http_status": 200,
            "wall_class": null, "elapsed_ms": 2140,
            "context": "throwaway",
            // C5: one probe per RUN (not per job), stamped onto every
            // preflight so a day's wall rate is interpretable. A datacenter
            // egress is itself a wall risk factor and must be visible when
            // reading back why a day went badly.
            "ip_class": "residential" } }

// Per-field
{ "type": "field_discovered",
  "data": { "count": 24, "required": 11, "root_frames": ["iframe#icims_content_iframe"] } }

{ "type": "field_mapped",
  "data": { "field_key": "auth.sponsorship", "control": "combobox",
            "canonical": "none-now-or-future",
            "option_text": "No, I do not require sponsorship",
            "match": "exact|candidate|normalized-word",
            "source": "profile", "required": true } }

{ "type": "field_skipped",
  "data": { "field_key": "education.gpa" | null,
            "label": "Cumulative GPA (verbatim page label)",
            "required": true,
            "reason": "unmapped_required" | "unmapped_optional"
                    | "no_such_field" | "value_absent"
                    | "option_not_found" | "forbidden_value"
                    | "would_require_invention",
            "candidates_seen": ["3.0-3.49", "3.5-3.79"] } }

{ "type": "field_filled",
  "data": { "field_key": "contact.phone", "value_hash": "sha256:...",
            // Q5: free-text preview ONLY, first 12 chars + length. Never for
            // a credential/email/phone/address field — those carry no preview
            // at all, only the hash. See §4.6.
            "value_preview": null, "value_len": 12,
            "strategy": "fill|type|select", "retries": 0 } }

// A prose answer is recorded by IDENTITY, never by rendered text (Q5).
{ "type": "field_filled",
  "data": { "field_key": "prose.why-company", "answer_id": "A-why-company",
            "variant": 150, "slots": { "team": "Autonomy" },
            "value_hash": "sha256:...", "strategy": "fill" } }

// Uploads
{ "type": "upload_attempted",
  "data": { "target": "resume", "path": "...", "sha256": "...",
            "bytes": 184213, "stamped_job_key": "8f2c…" } }

{ "type": "upload_verified",
  "data": { "target": "resume", "attached": true,
            "observed_name": "Felix-Lin-Acme-8f2c1a94.pdf",
            "observed_bytes": 184213, "sha256_match": true,
            "how": "filename-in-dom" } }

// Flow
{ "type": "page_advanced",
  "data": { "from": "guest-apply", "to": "my-information",
            "url": "https://…", "elapsed_ms": 3180,
            "blocked_by": [] } }

{ "type": "gate_result",
  "data": { "kind": "passed", "via": "guest" } }

// Walls
{ "type": "wall_detected",
  "data": { "wall_class": "hcaptcha", "where": "submit",
            "marker": "iframe[src*=hcaptcha]",
            "tenant_prior_walls": 2,
            "action": "retry-fresh-context" | "park" | "skip-retry-third-strike" } }

// Evidence
{ "type": "evidence_captured",
  "data": { "kind": "review-diff" | "screenshot" | "confirmation",
            "path": "…/screenshots/acme-confirmation.png",
            "sha256": "…" } }

{ "type": "review_diff",
  "data": { "checked": 18, "matched": 17,
            "mismatches": [ { "field_key": "education.fieldOfStudy",
                              "intended": "Artificial Intelligence",
                              "rendered": "Computer Science",
                              "severity": "warn" } ],
            "verdict": "pass" | "fail" } }

// Terminal
{ "type": "submitted",
  "data": { "application_id": "R-104882", "confirmation_url": "…",
            "confirmation_text": "Thank you for applying",
            "screenshot": "…",
            // Q4: "unconfirmed-click" means the click landed but the
            // confirmation read timed out. It is still SUBMITTED and is
            // NEVER retried — a double submission is the worse error.
            "verified_by": "confirmation-page" | "application-id"
                         | "unconfirmed-click" } }

// Q7: liveness. Emitted every 10 events or 5 minutes, whichever comes first,
// so a silent applier is distinguishable from a slow one.
{ "type": "heartbeat",
  "data": { "since_ms": 61000, "events_since": 10, "step": "candidate-profile",
            "last_event_type": "field_filled" } }

{ "type": "application_ended",
  "data": { "outcome": "submitted" | "retry" | "wall" | "needs-felix"
                     | "assist" | "drop-at-apply" | "skipped-repost",
            "reason": "…", "unlock": null,
            "duration_ms": 214880, "tool_calls": 31, "model_turns": 0 } }

// Adapter observations (never parsed for meaning; for humans + debugging)
{ "type": "adapter_note", "data": { "msg": "…", "extra": { } } }

// Engine/driver health
{ "type": "driver_event",
  "data": { "kind": "attached" | "context_created" | "context_closed"
                  | "browser_died" | "reattached" | "storagestate_saved"
                  | "storagestate_loaded",
            "detail": "…" } }
```

### 4.4 What each consumer takes

| Consumer | Reads | Replaces |
|---|---|---|
| **Ledger** (Stage 3) | `application_started`, `application_ended`, `submitted`, `field_skipped{required}`, prose answers from `field_filled` | parsing `ledger-part<i>.md` blocks with a pinned label set (F10) |
| **Efficiency metric** | `seq` deltas + `tool_calls` on `application_ended`, grouped by `ats` | nothing — this is not measurable today at all |
| **Review diff** | `field_mapped` (intended) vs `review_diff.rendered` | the "one review snapshot" the applier eyeballs |
| **Wall memory** | `wall_detected`, `preflight_result` | ad-hoc per-day notes |
| **Retry queue** | `application_ended.outcome`, `tenant`, `attempt` | `retry-queue.js` regexing `outcome:`/`domain:`/`attempt:` lines |

The compact markdown ledger does not disappear — Stage 3 **renders** it from
the event stream, so Felix's reading experience is unchanged while the
machine-readable path stops being prose.

### 4.5 Validation

Events are validated **at emit time** against the schema (closed enums for
`type`, `outcome`, `reason`, `wall_class`). An invalid event throws in the
engine rather than being written — the 2026-09-05 "unknown label silently
skipped" failure becomes impossible to introduce.

### 4.6 Q5 ruling — what the stream may carry

The event stream is committed to the `resume-drops` repo, so its contents are
as public as that repo is. The rule is therefore not "mask PII where
convenient" but **an allowlist of what may appear at all**:

**May appear:** `field_key` (a canonical key, never a page label except in
`field_skipped.label`, which is the page's own wording and carries no value),
`value_hash`, `value_len`, canonical enum values, `option_text` (the ATS's own
rendered option wording — not Felix's data), `match` kind, `source`, counts,
timings, URLs, `application_id`, confirmation text.

**May appear only as a 12-char head + length:** free-text answers that are not
identity data — `value_preview` = `value.slice(0, 12)` plus `value_len`. This
exists so a human reading the stream can tell a garbled fill from a good one.

**Never appears, in any form, at any length:**

- credentials (already structurally refused by the forbidden-key check, F22,
  and now also by value-match redaction, Q1);
- **email addresses, phone numbers, street addresses** — these are identity
  fields; their events carry the hash only, `value_preview: null`. The old
  `"412…4821"` masked preview is withdrawn: a masked phone number is still a
  phone number to anyone holding a second copy.
- **rendered prose.** A prose answer is stored as `answer_id` + `variant` +
  `slots`, which is enough to reconstruct it from the bank and enough to audit
  which answer went where, without putting the essay in the repo.

**Enforcement is at emit time, not by convention.** The emitter extends its
guards with:

1. the existing forbidden-key scan (F22);
2. **secret value-match redaction** (Q1) over every string in the payload;
3. an **identity-field guard**: `field_filled` for any `FieldKey` in the
   identity set (`contact.email`, `contact.phone`, `contact.address.*`,
   `selfid.signature`) throws if `value_preview` is non-null;
4. a **shape guard on prose**: `field_filled` for a `prose.*` key throws if it
   carries `value_preview` instead of `answer_id`;
5. a **PII pattern sweep** over every string in every payload: anything
   matching an email address or a 10+ digit phone-shaped run throws. This is
   the backstop that catches a value arriving through a field nobody
   classified — including the forbidden CMU address, which must never appear
   in the stream even as evidence that we refused it (the `field_skipped`
   event names the *reason*, not the value).

### 4.7 Q7 ruling — heartbeat is an engine constant

`heartbeat` is emitted by the engine, not by any adapter, **every 10 events or
every 5 minutes, whichever comes first**. It is not adapter-configurable and
not per-ATS tunable — a constant, so that "this applier has gone quiet" means
the same thing on every ATS.

Crucially it is tied to **`field_filled` as well as `page_advanced`**. A
heartbeat keyed only to page transitions would go silent for the entire length
of a 25-field page, which is exactly the window in which the current stack's
wedges happen. Ten fills is a heartbeat.

### 4.8 Q8 ruling — drop-at-apply is TERMINAL

`application_ended{outcome:"drop-at-apply"}` writes `state:"parked"` with the
drop reason, and the job is **never re-queued** — not by the retry wave, not on
a later day, not by a fresh run. The claim is not released.

The reasoning is that a drop-at-apply is a *rule* firing (course-schedule
document demanded, role gate, term mismatch), and rules are deterministic over
the posting. If a later machine reaches a different conclusion on the same
posting, that is **rule drift**, and the right response is to surface the
disagreement for a human — not to let the second machine's verdict silently
win by re-attempting. The engine therefore records the drop reason in the
claim record and a differing later verdict is reported as a drift alert.

**Release is reserved for genuinely never-attempted work:** a crash *before the
first navigation* of the application. Once the engine has navigated, the job is
attempted, and its outcome — including a drop — stands.

---

## 5. Answer-bank → form: the mapping algorithm (engine-owned)

Given a discovered control and a `FieldBinding`:

1. **Resolve canonical value** from profile/answer bank by `FieldKey`.
   Absent → `field_skipped{reason:"value_absent"}`; if `required`, park.
2. **Text/number/date controls** → format by `control` + `dateStrategy`, fill
   with real input events (F9), read back the value, emit `field_filled`.
3. **Option controls** (select/combobox/radio):
   a. Candidate list = `binding.optionText[canonical] ?? [defaultTextFor(canonical)]`.
   b. Enumerate rendered options (after typeahead + `Enter` if
      `typeaheadNeedsEnter`).
   c. Match, in order: exact normalized equality → candidate normalized
      equality → **word-boundary** regex (F8). Never bare substring.
   d. No match → `field_skipped{reason:"option_not_found", candidates_seen}`;
      if `required`, park. **Never pick "the closest-looking option".**
4. **Forbidden values** (`constraints.forbiddenValues`) are checked before
   every fill **and on every read-back**; a hit is
   `field_skipped{reason:"forbidden_value"}`. A forbidden value we were about
   to write is a hard park. A forbidden value *the form already contains*
   (F16 — the stale-profile trap) is a **mandatory correction**, followed by
   re-verification. This makes the fabricated-number blocklist and the
   never-use-the-CMU-address rule mechanical rather than prompt instructions.

### 5.5 Upload is a discovery barrier (F15, F16, F19)

The single most expensive recurring data error on this stack is a résumé
upload whose parser rewrites fields that were already correct. The engine
therefore treats every upload as a barrier:

```
fill(pre-upload fields)
  → upload(target, artifact)
  → verifyUpload()                      ← must return attached:true, or park
  → assert artifact.stampedJobKey === ctx.jobKey     ← F17, F18
  → re-run discovery on the form root   ← the parser may have added fields
  → re-read EVERY already-filled field  ← emit field_filled again on change
  → forbidden-value scan over the whole form         ← F16
  → only now may the step advance
```

`post_upload_reverify` emits a `review_diff`-shaped event scoped to the step,
so a parser overwrite is visible in the stream as a concrete before/after
rather than being discovered by a human reading the submitted application.

This is also where the tool-call budget is *spent well*: a second discovery
pass costs one action in Playwright (`frame.locator(...).all()`), whereas on
the current stack a re-snapshot is another CLI spawn plus a model turn — which
is exactly why the current stack skips it and keeps getting bitten.

**C3: upload verification is a standing invariant, not a one-time check.**
Avature attaches one résumé per *account*, not per application (F18), and
Eightfold re-imports a cached profile on every fresh visit (F16). Both mean an
artifact verified as attached on page 2 can be a *different* artifact by page
4, with no action of ours in between. So:

```
after every page_advanced, while any artifact is attached:
  re-run verifyUpload(target, artifact)
  re-assert artifact.stampedJobKey === ctx.jobKey
  mismatch or attached:false  ->  hard park, never a silent re-upload
```

The re-check emits `upload_verified` again with the same `target`, so the
stream shows the attachment being *continuously* true rather than
once-upon-a-time true. A stream where `upload_verified{attached:true}` appears
once and a submit happens four pages later is, after this rule, a schema
violation rather than a plausible record.

### 5.6 The review gate lives in code (C6)

The Gate 2 abort condition — "any engine submit without a passing review diff"
— is not a runbook instruction a supervising agent might overlook. It is an
assertion inside `submit()`:

```
submit(ctx):
  const rd = lastEventFor(jobKey, 'review_diff')
  if (!rd)                    throw ReviewGateError('no review diff')
  if (rd.data.verdict !== 'pass') throw ReviewGateError('review diff failed')
  if (rd.seq < lastMutatingSeq(jobKey)) throw ReviewGateError('diff is stale')
  ...only now may a submit-labelled control be clicked
```

The staleness clause matters as much as the verdict: a diff that passed
*before* the last fill is not evidence about the form being submitted. The
engine has no flag, no override parameter, and no caller-supplied bypass —
there is deliberately no way to spell "submit anyway" in this API.

**Phase 3 hardening, in `src/engine/gate2.js`.** The rule is now stated once and
used twice — as the runtime refusal above, and as an **audit over a finished
stream** that the metric report runs before it may describe a day as clean. The
runtime check can only protect code that calls it; the audit protects the
RECORD, and the record is what Gate 2 is judged on. The audit also catches the
cutover plan's other abort condition, a **duplicate submission**, and evaluates
each submit *as of its own seq*, so a later passing diff cannot retroactively
bless an earlier bad submit.

Two clauses were added to the rule itself, both from the same observation —
that a *barrier* diff and a *review* diff are different claims:

1. A `review_diff` carrying `scope:"post_upload_reverify"` is **not** the
   review diff. A passing barrier diff is not evidence that the review page
   matched intent, and treating it as one would let an application submit with
   no review-page check at all.
2. A **failing barrier diff after a passing review diff blocks the submit**. A
   barrier emits no mutating event, so the staleness clause alone would not
   catch it — a résumé parser that clobbered a field during the post-upload
   re-verify would slip through behind a review diff that was still technically
   fresh.

### 5.7 The click lands where you think it does (F21)

A passing diff says the FORM is right. It says nothing about whether the click
will reach the button. On 2026-09-17 a Lever hCaptcha rendered at invisible
size and a click aimed at the widget passed **through** to SUBMIT APPLICATION,
filing an application nobody had reviewed. The engine's exposure is the mirror
image — a click aimed at the button landing on the captcha — and both are the
same defect: nobody asked what was actually on top.

So `submit()` hit-tests before it clicks (`src/engine/overlay.js`):
`document.elementFromPoint` at the centre of the adapter's declared submit
control, with the target counted as hit if it is the topmost element, contains
it, or is contained by it (Workday wraps its buttons in a `click_filter` div,
which is normal).

`isVisible()` is **not** a substitute and the test suite asserts why: on the
reproduction fixture the trapped button reports `isVisible() === true`, because
it is visible — it is simply not what a click would reach. Live recon on the
same Lever tenant found the hCaptcha enclave iframes at **1350×900**, the whole
viewport.

Outcomes:

- click reaches the control → an `adapter_note` recording that the guard ran,
  so "we checked" is distinguishable from "nobody checked";
- a **captcha** would eat the click → `wall_detected{where:"submit"}` carrying
  the overlay's geometry and whether the challenge token is still empty, then a
  refusal;
- a **non-captcha** overlay (a cookie banner, a modal) → a refusal with **no
  wall event**. An obstruction is not a bot defence, and recording one would
  poison that tenant's wall memory.

An adapter that declares no `submitControl` is recorded as unguarded in the
stream, so the gap is visible rather than silent.

---

## 6. Reviewer rulings (Q1-Q8) — settled, authoritative

Ruled by the droplet reviewer, 2026-09-17. Each is implemented in Phase 2 at
the section cited; this table is the index, not the specification.

| Q | Ruling | Where implemented |
|---|---|---|
| **Q1** | Declarative `loginSpec` for sign-in. Imperative `passGate` only for **account creation** and credential-free gates. `secrets.forTenant()` is attached to the context **only when `accountCreation: true`**. `verificationCode` returns `{code, sourceMessageId}`. Engine **redacts secret values by value-match** from every `adapter_note` (and every payload) before emit. | §2, §4.6 |
| **Q2** | Novel essays **PARK** this phase. `field_skipped{reason:"would_require_invention"}`, **counted per day**. No assembly path exists. | §3.3 |
| **Q3** | **Per-applier event files**, merge key `(applier, seq)`. A truncated final line is **dropped and reported**, never repaired. | §4.1 |
| **Q4** | `maxSubmitAttempts` defaults to **1 for every ATS**; opting higher requires an adapter comment citing *observed tenant idempotency*. A submit whose click succeeded but whose confirmation read timed out is **`submitted` with `verified_by:"unconfirmed-click"` and is NEVER retried**. | §2 quirks, §4.3 |
| **Q5** | Stream carries `field_key`, hashes, enum canonicals, `option_text` only. Free-text preview = **first 12 chars + length**. Prose stored as **answer id + variant + slots**, never rendered text. **No credential / email / phone / address ever**, at any length — enforced by extended emit-time guards. | §4.6 |
| **Q6** | The claim is acquired at **pre-flight, before tailoring** — not at first navigation. A wall found at pre-flight must not have already cost a tailoring slot, and two machines must not both tailor the same posting. `NullClaimClient` remains acceptable this phase. | `architecture.md` §8a, `claim-record.md` |
| **Q7** | `heartbeat` is an **engine constant**: every **10 events or 5 minutes**, whichever first, tied to **`field_filled` as well as `page_advanced`**. Not adapter-configurable. | §4.7 |
| **Q8** | `drop-at-apply` is **TERMINAL** — `state:"parked"` + drop reason, claim not released. A differing later machine conclusion is **rule drift** to surface, not grounds to re-attempt. Release only for genuinely never-attempted work (crash before first navigation). | §4.8, `claim-record.md` |

## 7. Reviewer critique items (C1-C7) — accepted

| # | Item | Disposition |
|---|---|---|
| **C1** | **GATE 0 NOW.** Prove `storageState` (cookies + localStorage) round-trips across a browser **death** on the exact Chrome-for-Testing build the pipeline uses; if `newContext()` isolation fails on that build, document the `--user-data-dir-per-applier` fallback. | **DONE, PASS.** `test/gate0-storagestate.test.js` SIGKILLs the scratch Chrome mid-session and restores into a *different* browser on a *different* port with a *different* profile. Verdict and fallback status: `architecture.md` §4a. |
| **C2** | **Supervisor resume = re-verify.** After re-attach, re-run discovery; every pre-crash `field_filled` is **unverified until re-read**. | `architecture.md` §5; the engine's `resume()` marks the step dirty and re-reads before it may advance. |
| **C3** | **Re-check `upload_verified` after every `page_advanced`** — Avature/Eightfold swap attachments at *account* level, so an upload verified on page 2 can be a different file by page 4. | §5.5 extended: the post-upload barrier becomes a **standing invariant**, re-asserted on every advance while an artifact is attached. |
| **C4** | **Wall memory keyed `(tenant, wall_class, where)`** with decay: the third-strike skip **expires after 14 days**. | `architecture.md` §8a. |
| **C5** | `preflight_result.ip_class` (`"residential" \| "datacenter"`) from a **one-time per-run probe**. | §4.3 `preflight_result`; probe runs once per run, not per job. |
| **C6** | **In-engine assertion:** refuse to pass any `review_diff` with `verdict:"fail"`. The Gate 2 abort condition lives in **code**, not in a runbook. | §5.6 — `submit()` throws `ReviewGateError` unless the immediately preceding `review_diff` for this job is `pass`. |
| **C7** | Workday/Greenhouse/Lever budgets are published as **"TBD from shadow"**; only iCIMS keeps a line-item target (`<40`). | `architecture.md` §8 table rewritten. |
