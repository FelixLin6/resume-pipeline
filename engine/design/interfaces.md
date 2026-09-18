# Apply Engine — Interfaces (Phase 1 design)

Status: **DESIGN, under review.** Nothing here is on the daily path. The live
skill (`~/zylos/.claude/skills/resume/`) and the current stack in `skill/`
are untouched by this branch.

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

  /** Called once per applier context, before the first navigation.
   *  Sets context-level things the ATS needs (extra headers, locale,
   *  default timeouts). MUST NOT navigate. */
  prepareContext?(ctx: AdapterContext): Promise<void>;

  /** Gate that runs before the application form is reachable:
   *  iCIMS guest-apply / "Apply with..." chooser, Workday sign-in or
   *  account creation, a cookie banner. Returns how it resolved.
   *  The engine supplies credentials; the adapter never reads .env. */
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
    /** Max submit attempts, ever, per (tenant, job). Ashby = 1 (F: spam
     *  flag stickiness). */
    maxSubmitAttempts: number;
    /** Selector fragments whose presence means a human-verification wall. */
    wallMarkers: WallMarker[];
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
    /** Credential for this tenant, if one exists. The adapter receives the
     *  value; it never learns the source and cannot enumerate. */
    forTenant(): Promise<{ username: string; password: string } | null>;
    /** One-time code from the pipeline inbox, adapter-blind to IMAP. */
    verificationCode(opts: { since: Date; matching: RegExp }): Promise<string | null>;
  };
  readonly deadline: Date;        // engine-owned per-application budget
}
```

**Open question for the reviewer (Q1):** should `secrets.forTenant()` be on
the adapter context at all, or should the engine drive login itself from a
declarative `loginSpec` the adapter provides (selectors for user/pass/submit)?
Declarative is safer (a credential never enters adapter code) but Workday's
account-creation flow has enough branching that I currently expect an
imperative `passGate`. My lean: **declarative `loginSpec` for sign-in, keep
imperative `passGate` only for account *creation***, which is rare and
already agent-supervised. Want your read.

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
  | 'unknown-challenge';

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

**Open question (Q2):** free-text. The settled plan says "unmapped REQUIRED
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
- Path: `~/zylos/workspace/resume-drops/<date>/events/applier<i>.jsonl`.
- Written by the engine process; nothing else writes that file.
- A crash mid-application leaves a valid prefix — every consumer must tolerate
  a truncated final line (this is what makes it crash-safe where the compact
  markdown ledger was not).

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
            "context": "throwaway" } }

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
            "value_preview": "412…4821", "strategy": "fill|type|select",
            "retries": 0 } }

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
            "screenshot": "…", "verified_by": "confirmation-page" } }

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

---

## 6. Open questions for the droplet reviewer

- **Q1** (§2): declarative `loginSpec` vs imperative `passGate` for
  credentials. My lean: declarative for sign-in, imperative only for account
  creation.
- **Q2** (§3.3): novel essay questions — always park, or bank-restricted
  assembly with verbatim audit trail? My lean: park in Phase 2, then decide
  with the numbers the event stream gives us.
- **Q3** (§4.1): should the event stream be per-applier files (as specified)
  or one file with an `applier` field and `O_APPEND` writes? Per-applier
  avoids interleaved-write risk entirely; one file makes Stage 3 trivial. My
  lean: per-applier files + a merge step, because a partial write from a dead
  applier must not corrupt a sibling's records — that is F4's lesson applied
  to files.
- **Q4** (§2 `quirks.maxSubmitAttempts`): Ashby's one-attempt rule is a quirk
  today. Should *every* ATS default to 1 and opt into more, rather than the
  reverse? A double-submit is worse than a missed retry in every case I can
  find in the record.
- **Q5** (§4.3): `field_filled.value_preview` — I masked it (`412…4821`).
  Confirm you want PII masked in the stream given the stream is committed to
  the resume-drops repo. My lean: mask everything except `field_key` and
  hashes; the ledger already carries what Felix needs to read.
