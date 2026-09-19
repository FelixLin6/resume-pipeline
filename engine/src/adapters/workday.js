// Workday adapter — Phase 3. The hardest adapter in the set, and the only one
// permitted to create accounts.
//
// Evidence base and confidence labels:
//
//   verified-shadow    — read off live Workday tenants during navigation-only
//                        recon on 2026-09-17: visa.wd5 (chooser),
//                        jabil.wd5 (chooser + social sign-in gate),
//                        avisbudget.wd1 (create-account gate + 8-step rail),
//                        liveoakbancshares.wd1 (sign-in page),
//                        smithnephew.wd5 (posting page). Observed in the live
//                        DOM by navigation alone — no email was ever entered,
//                        nothing was clicked, no account was touched.
//   observed-from-run  — behind the account gate, which recon cannot reach
//                        without signing in. Derived from the 09-16 and 09-17
//                        ledgers, STAGED.md and the run screenshots across NINE
//                        tenants (liveoakbancshares, jabil, globalhr/RTX,
//                        vanguard, smithnephew, disney, visa, axcelis,
//                        avisbudget). The WORDING is verbatim from those
//                        artifacts; the SELECTOR is Workday's documented
//                        automation-id convention and must be confirmed at
//                        Gate 1 before it is trusted.
//
// Everything from `my-information` onward is necessarily observed-from-run.
// That is not a shortcut — it is the honest consequence of the rule that recon
// never enters an email on a real employer's form.
//
// ---------------------------------------------------------------------------
// FINDING 0 — SELECTORS ARE `data-automation-id`, NEVER id OR class
// ---------------------------------------------------------------------------
// Live recon settles this. Workday's element ids are POSITIONAL render ids that
// shift with the form (`#input-4` is the email box on the Live Oak sign-in page
// and also the email box on Avis's create-account page, where `#input-5` and
// `#input-6` are two different password fields), and its class names are
// emotion hashes (`css-1twblm4`) that change on every deploy. The only stable
// surface is `data-automation-id`, which is the contract Workday keeps:
// `email`, `password`, `verifyPassword`, `createAccountSubmitButton`,
// `signInSubmitButton`, `progressBar`, `applyManually`, `useMyLastApplication`.
//
// ---------------------------------------------------------------------------
// FINDING 1 — THE `beecatcher` HONEYPOT
// ---------------------------------------------------------------------------
// Verified live on BOTH the Live Oak sign-in page and the Avis create-account
// page:
//
//   <input name="website" data-automation-id="beecatcher" visible required=false
//    label="Enter website. This input is for robots only, do not enter if
//           you're human.">
//
// It is VISIBLE and it looks like an ordinary optional text field. Generic
// label discovery would map "website" to `links.website` and fill it with
// Felix's actual site — announcing to the tenant that a bot is driving. It is
// declared noise here so it is never discovered, never mapped, and never
// filled, on every Workday tenant.
//
// ---------------------------------------------------------------------------
// FINDING 2 — THE STEP RAIL IS TENANT-VARIABLE AND SELF-DESCRIBING
// ---------------------------------------------------------------------------
// Verbatim from `[data-automation-id="progressBar"]`, read live:
//
//   Avis  (8): Create Account/Sign In · My Information · My Experience ·
//              Application Questions 1 of 2 · Application Questions 2 of 2 ·
//              Voluntary Disclosures · Self Identify · Review
//   Jabil (7): Create Account/Sign In · My Information · My Experience ·
//              Application Questions · Voluntary Disclosures · Self Identify ·
//              Review
//
// and the ledgers add a 5-node Smith+Nephew rail with no Self Identify at all.
// So the step COUNT is not fixed and no adapter may hard-code it. The rail is
// read from the page, which is better than a static graph: the tenant tells us
// its own flow on every page, and `Application Questions N of M` is parsed
// rather than enumerated.
//
// ---------------------------------------------------------------------------
// FINDING 3 — THE CHOOSER, AND WHY "Autofill with Resume" IS NEVER CLICKED
// ---------------------------------------------------------------------------
// Verified live on Visa and Jabil: `[data-automation-id="applyAdventurePage"]`
// with three anchors — `autofillWithResume`, `applyManually`,
// `useMyLastApplication` — under the heading "Start Your Application" and the
// text "Choose an option to complete your application. On the next page, you
// will be required to create an account or log into your existing account."
//
// `autofillWithResume` is F15 with a button on it: eight tenants on record
// whose résumé parser overwrote already-correct contact fields, including
// setting the email to the forbidden CMU address. It is never clicked.

import { WORKDAY_STEP_TITLES, parseProgressBar } from './workday-steps.js';

/** @type {import('../schema/types.js').AtsAdapter} */
const workday = {
  id: 'workday',
  apiVersion: 1,

  match: {
    hostnames: [/\.myworkdayjobs\.com$/i, /\.myworkdaysite\.com$/i, /\.workday\.com$/i],
    /**
     * Hints exist only for employers who CNAME a Workday site onto their own
     * domain, so they must be shapes no other ATS produces. A bare `/job/` is
     * not one: it resolved Jobvite's `jobs.jobvite.com/tylertech/job/<id>` to
     * this adapter, which would have driven Workday's automation ids against a
     * Jobvite form and found nothing.
     *
     * These three are Workday-specific: the locale-prefixed site path, the
     * manual-apply route, and the post-submit task URL.
     */
    pathHints: [/\/[a-z]{2}-[A-Z]{2}\/[^/]+\/job\//, /\/apply\/applyManually/i, /\/jobTasks\//i],
  },

  /**
   * Tenant identity is (host, career site), NOT host alone.
   *
   * One host serves several career sites with different flows and different
   * accounts: `vanguard.wd5…/contractors_restricted` is not
   * `vanguard.wd5…/External`. Keying wall memory or storageState on the host
   * would merge two tenants that do not share a session.
   */
  tenantOf(url) {
    const parts = url.pathname.split('/').filter(Boolean);
    // /en-US/<site>/... or /<site>/...
    const site = /^[a-z]{2}-[A-Z]{2}$/.test(parts[0] ?? '') ? parts[1] : parts[0];
    return `workday:${url.hostname.toLowerCase()}/${(site ?? '').toLowerCase()}`;
  },

  /**
   * Q1: this is the ONLY adapter in the set that declares account creation, so
   * it is the only one whose `passGate` receives `ctx.secrets.forTenant`. On
   * every other adapter that method is absent from the context object.
   *
   * Nine Workday tenants have per-tenant accounts on record, each with its own
   * credential in `~/zylos/.env` (`WORKDAY_<TENANT>_PASSWORD`), all on the
   * pipeline address. The adapter never sees where they come from and cannot
   * enumerate them: it asks for THIS tenant's credential and receives a value.
   *
   * It also never INVENTS a password. `forTenant()` returns the credential to
   * use for both sign-in and creation, which means every secret this adapter
   * can touch is one the engine already registered for value-match redaction
   * (Q1) before the adapter ran. There is no code path here that can produce a
   * string the emitter does not already know to redact — which is what the
   * 2026-09-17 leak (a freshly created password pasted into a pushed file)
   * actually needed.
   */
  accountCreation: true,

  /**
   * Q1: sign-in is DECLARATIVE. The engine navigates, types and waits; the
   * credential never enters adapter code and never enters an adapter stack
   * frame.
   */
  loginSpec: {
    at: {
      urlPattern: /\/login|\/apply/i,
      selector: '[data-automation-id="signInSubmitButton"], [data-automation-id="signInFormo"]',
    },
    // VERIFIED live on Live Oak and Avis.
    username: '[data-automation-id="email"]',
    password: '[data-automation-id="password"]',
    submit: '[data-automation-id="signInSubmitButton"]',

    /**
     * Some tenants put a method chooser in front of the email form. VERIFIED
     * live on Jabil: Apple / Google / LinkedIn / "Sign in with email" buttons,
     * and no email field at all until the last is pressed.
     *
     * This is an extension to LoginSpec (interfaces.md §2): `revealForm` is a
     * control that must be pressed before the username field EXISTS. It is
     * distinct from `continueAfterUsername`, which is pressed after the
     * username is typed. Both are credential-free clicks, so both stay
     * declarative.
     */
    revealForm: '[data-automation-id="SignInWithEmailButton"]',

    success: {
      selector: '[data-automation-id="progressBar"], [data-automation-id="applyFlowPage"]',
      urlPattern: /\/(jobTasks|candidateHome|apply)/i,
    },
    failure: {
      // Verbatim from the 09-17 Avis row: sign-in failed with "wrong
      // email/password or account locked". The same wording pattern shows up on
      // the Disney and RTX password failures.
      text: /wrong email or password|wrong email\/password|account.*locked|incorrect.*password/i,
    },
    verification: {
      // Workday mails "Verify your candidate account" (observed for Vanguard,
      // Smith+Nephew, Jabil). Selectors behind the gate.
      input: '[data-automation-id="verificationCode"], input[data-automation-id*="code" i]',
      submit: '[data-automation-id="submitVerificationCode"], [data-automation-id="bottom-navigation-next-button"]',
      matching: /\b(\d{6})\b/,
    },
    selectorConfidence: 'verified-shadow',
  },

  // ---------------------------------------------------------------- flow ---
  steps: [
    {
      id: 'posting',
      title: 'Job posting page',
      selectorConfidence: 'verified-shadow',
      // VERIFIED on Smith+Nephew: an <a> reading "Apply", plus the requisition
      // id in the page text.
      markers: [{ urlPattern: /\/job\//i }, { text: /job requisition id/i }],
      expects: [],
    },
    {
      id: 'chooser',
      title: 'Start Your Application (Autofill / Manually / Use My Last Application)',
      selectorConfidence: 'verified-shadow',
      markers: [
        { selector: '[data-automation-id="applyAdventurePage"]' },
        { selector: '[data-automation-id="useMyLastApplication"]' },
        { text: /start your application/i },
      ],
      expects: [],
      optional: true,   // absent on tenants that route straight to the gate
    },
    {
      id: 'account-gate',
      title: 'Create Account / Sign In (rail step 1)',
      selectorConfidence: 'verified-shadow',
      markers: [
        { selector: '[data-automation-id="createAccountSubmitButton"]' },
        { selector: '[data-automation-id="signInSubmitButton"]' },
        { selector: '[data-automation-id="SignInWithEmailButton"]' },
      ],
      expects: ['account.login'],
    },
    {
      id: 'my-information',
      title: 'My Information',
      selectorConfidence: 'observed-from-run',
      markers: [{ text: /my information/i }, { selector: '[data-automation-id="legalNameSection"]' }],
      expects: [
        'identity.firstName', 'identity.lastName',
        'contact.address.line1', 'contact.address.city', 'contact.address.state',
        'contact.address.postalCode', 'contact.phone',
        'source.howDidYouHear', 'auth.previouslyEmployed',
      ],
    },
    {
      id: 'my-experience',
      title: 'My Experience',
      selectorConfidence: 'observed-from-run',
      markers: [{ text: /my experience/i }, { selector: '[data-automation-id="workExperienceSection"]' }],
      expects: [
        'work.title', 'work.employer', 'work.startDate', 'work.endDate',
        'education.school', 'education.degreeLevel', 'education.fieldOfStudy',
        'education.gpa', 'upload.resume',
      ],
    },
    {
      id: 'application-questions',
      title: 'Application Questions (1..N — the rail says how many)',
      selectorConfidence: 'observed-from-run',
      markers: [{ text: /application questions/i }],
      expects: ['auth.workAuthorized', 'auth.sponsorship'],
    },
    {
      id: 'voluntary-disclosures',
      title: 'Voluntary Disclosures (EEO + terms consent)',
      selectorConfidence: 'observed-from-run',
      markers: [{ text: /voluntary disclosures/i }],
      expects: ['selfid.gender', 'selfid.ethnicity', 'selfid.hispanic', 'selfid.veteran', 'consent.terms'],
    },
    {
      id: 'self-identify',
      title: 'Self Identify (CC-305 disability)',
      selectorConfidence: 'observed-from-run',
      markers: [{ text: /self identify|voluntary self-identification of disability|CC-305/i }],
      expects: ['selfid.disability', 'selfid.signature', 'selfid.date'],
      // ABSENT on the 5-node Smith+Nephew rail. A missing optional step is
      // data about the tenant, not an error.
      optional: true,
    },
    {
      id: 'review',
      title: 'Review',
      selectorConfidence: 'observed-from-run',
      markers: [{ text: /^review$|please review your application/i }],
      expects: [],
      isReview: true,
    },
    {
      id: 'submit',
      title: 'Submit',
      selectorConfidence: 'observed-from-run',
      markers: [{ selector: '[data-automation-id="bottom-navigation-next-button"]' }],
      expects: [],
      isSubmit: true,
    },
    {
      id: 'confirmation',
      title: '"Application Submitted"',
      selectorConfidence: 'observed-from-run',
      // Verbatim from the 09-17 Visa and Vanguard confirmation screenshots:
      // "Application Submitted — Your application has been submitted
      // successfully. You'll receive a confirmation email shortly."
      markers: [
        { urlPattern: /jobTasks\/completed\/application/i },
        { text: /application submitted/i },
      ],
      expects: [],
    },
  ],

  // -------------------------------------------------------------- quirks ---
  quirks: {
    /**
     * F5 lives here. Workday's date control is THREE spinbuttons — Month, Day,
     * Year — and the current stack's per-digit `press` bursts against it
     * crashed Chrome reproducibly, wedged the shared CDP session nine times,
     * and once garbled 2026 into 2006. Three `fill` calls, one per section.
     *
     * Corroborated on four tenants' run records ("date 09/17/2026 via 3
     * spinbutton fills" — Avis; the same phrasing on Live Oak and RTX).
     */
    dateStrategy: 'three-spinbuttons',
    forbidDatePicker: true,
    typeaheadNeedsEnter: true,

    /**
     * Q4: 1, the default. Workday gives no observed tenant idempotency to cite
     * — the opposite, in fact: Avis's Candidate Home shows each submission as a
     * separate active application, and the 09-17 record treats a second
     * application on one tenant as a decision needing Felix's explicit
     * go-ahead. A double submit here is visible to the employer as two rows.
     */
    maxSubmitAttempts: 1,

    submitControl: {
      selector: '[data-automation-id="bottom-navigation-next-button"]',
      captchaWrappers: ['[data-automation-id="noCaptchaWrapper"]'],
      captchaResponse: null,
      /**
       * `click_filter` is a Workday div that WRAPS the submit button (verified
       * live inside `noCaptchaWrapper` on both the Live Oak sign-in page and
       * the Avis create-account page). It is normal, not a wall — the engine's
       * hit test treats an ancestor of the target as a hit, so a wrapped button
       * passes.
       *
       * It becomes a problem only when something scrolls it out of the
       * viewport, which is the "tenant click_filter block" that failed Avis
       * attempt 1 on 09-17. The recorded fix, applied by the engine before the
       * hit test: press Escape (dismiss any open picklist overlay) and scroll
       * the control into view.
       */
      preClick: { pressEscape: true, scrollIntoView: true },
    },

    wallMarkers: [
      { wallClass: 'http-403', status: 403 },
      { wallClass: 'http-429', status: 429 },
      { wallClass: 'tenant-5xx', status: 503 },
      // Workday's own error page. NOT a bot wall — the tenant threw. Recorded
      // on RTX 09-16 after a submit attempt; the playbook is reload and
      // re-enter from the server-side draft, which is why this is
      // `tenant-broken` and not a challenge class.
      { wallClass: 'tenant-broken', text: /something went wrong|we'?re sorry, an error has occurred/i },
      { wallClass: 'account-required', text: /wrong email or password|account.*locked/i },
    ],

    dormantCaptchaMarkers: ['[data-automation-id="noCaptchaWrapper"]'],

    /**
     * FINDING 1. The honeypot leads this list, and the positional ids follow:
     * Workday renders hidden state inputs that carry no label and would be
     * reported as unmapped fields.
     */
    noiseSelectors: [
      '[data-automation-id="beecatcher"]',   // the bot trap — NEVER fill
      'input[name="website"][data-automation-id]',
      'input[type=hidden]',
    ],

    /** Never clicked, on any tenant. */
    forbiddenControls: [
      '[data-automation-id="autofillWithResume"]',   // F15 with a button on it
      '[data-automation-id="AppleSignInButton"]',
      '[data-automation-id="GoogleSignInButton"]',
      '[data-automation-id="LinkedInSignInButton"]',
    ],

    /**
     * THE JABIL BLOCKER, modelled.
     *
     * The "Type to Add Skills" multi-select on My Experience is a typeahead
     * over a TENANT-PROVIDED picklist. On Jabil that picklist is empty: its
     * search returned "No Items." for every query tried — single letters, "a",
     * "En", "Linux", "Python", and an empty string on focus. The field is
     * required, so the application cannot be completed by any means available
     * to us, and it parked on 2026-09-16.
     *
     * This is NOT a rendering bug and no keyboard trick fixes it (the sibling
     * "How Did You Hear About Us?" react-virtualized picklist on the same page
     * WAS solvable by pure keyboard — ArrowDown to a category, ArrowRight to
     * expand, ArrowDown to a leaf, Enter to commit — and that technique is
     * recorded below because it is worth reusing). An empty source list is a
     * tenant configuration fact.
     *
     * The rule: when a required picklist's search yields the empty marker for
     * every probe, the engine parks with `option_not_found` and the reason
     * names the tenant picklist. It does NOT try more queries, and it certainly
     * does not type a free-text value into a control that only accepts chips.
     */
    picklist: {
      emptyMarker: /No Items\.?/i,
      // Probes are bounded and ordered cheapest-first. Four probes was what the
      // 09-16 attempt used before concluding the list was empty.
      probes: ['', 'a', 'Python', 'Linux'],
      // The keyboard commit sequence that DID work on the hierarchical
      // How-Did-You-Hear picklist, where mouse clicks could not land because
      // react-virtualized renders zero-height rows.
      keyboardCommit: ['ArrowDown', 'ArrowRight', 'ArrowDown', 'Enter'],
      selectorConfidence: 'observed-from-run',
    },

    /**
     * THE CHOOSER POLICY (finding 3), and the re-verify rule that goes with it.
     *
     * Preference order, and why:
     *
     *  1. `useMyLastApplication` WHEN a prior application exists on this tenant.
     *     Observed working on Visa (Austin) and Avis (R0190464) on 09-17: it
     *     carries legal name, address and phone, and leaves only the new
     *     questions to answer. It is by far the cheapest path.
     *
     *  2. `applyManually` otherwise. Safe, complete, and the default.
     *
     *  3. `autofillWithResume` NEVER. See F15.
     *
     * THE RE-VERIFY RULE IS NOT OPTIONAL. On 09-16 Live Oak's "Use My Last
     * Application" carried over the WRONG RÉSUMÉ — the sibling posting's PDF —
     * and it was caught only because the applier checked. It also silently
     * reset five Application Questions, the entire Voluntary Disclosures block
     * and the CC-305 name and date to blank while keeping name/address/phone.
     *
     * So a reused application is treated exactly like a résumé parse (§5.5):
     * every field is UNVERIFIED until re-read, and the résumé is re-uploaded
     * for THIS posting regardless of what is already attached. "It carried
     * over" is a claim about a form, not evidence about this application.
     */
    chooser: {
      prefer: ['useMyLastApplication', 'applyManually'],
      never: ['autofillWithResume'],
      selectors: {
        useMyLastApplication: '[data-automation-id="useMyLastApplication"]',
        applyManually: '[data-automation-id="applyManually"]',
        autofillWithResume: '[data-automation-id="autofillWithResume"]',
      },
      reuseForcesFullReverify: true,
      reuseForcesResumeReupload: true,
      selectorConfidence: 'verified-shadow',
    },

    /** The cookie banner. Credential-free, so it belongs to passGate. DECLINE
     *  is the choice: the banner governs NON-essential cookies (Visa's own
     *  wording: "Workday will only use non-essential cookies at Visa's
     *  instruction and with your permission"), the session cookies the flow
     *  needs are unaffected, and declining is the narrower consent to give on
     *  someone else's behalf. */
    cookieBanner: {
      accept: '[data-automation-id="legalNoticeAcceptButton"]',
      decline: '[data-automation-id="legalNoticeDeclineButton"]',
      prefer: 'decline',
      selectorConfidence: 'verified-shadow',
    },

    /** The advance control, verbatim "Save and Continue" on every tenant
     *  observed. */
    advanceControl: '[data-automation-id="bottom-navigation-next-button"]',
  },

  // ------------------------------------------------------------- frames ----
  async formRoot() {
    // TOP LEVEL. Verified on 5/5 tenants: Workday renders its whole SPA in the
    // main document; there is no application iframe.
    return { frames: [] };
  },

  // ----------------------------------------------------------- bindings ----
  bindings(step) {
    switch (step) {
      case 'account-gate':
        return [
          {
            key: 'account.login',
            selector: '[data-automation-id="email"]',
            control: 'text', required: true, selectorConfidence: 'verified-shadow',
          },
          {
            key: 'account.password',
            selector: '[data-automation-id="password"]',
            control: 'text', required: true, selectorConfidence: 'verified-shadow',
          },
          {
            key: 'account.passwordConfirm',
            // Present only on the CREATE path. Verified live on Avis.
            selector: '[data-automation-id="verifyPassword"]',
            control: 'text', required: false, selectorConfidence: 'verified-shadow',
          },
          {
            key: 'consent.terms',
            selector: '[data-automation-id="createAccountCheckbox"]',
            control: 'checkbox', required: true, selectorConfidence: 'verified-shadow',
            optionText: { yes: ['I fully read, understand and agree to the Terms and Conditions'] },
          },
        ];

      case 'my-information':
        return [
          { key: 'source.howDidYouHear', selector: '[data-automation-id="source"]', control: 'combobox', required: true, selectorConfidence: 'observed-from-run' },
          {
            key: 'auth.previouslyEmployed',
            label: /previously (?:been )?employed|former employee/i,
            control: 'radio', required: true, selectorConfidence: 'observed-from-run',
            optionText: { no: ['No'], yes: ['Yes'] },
          },
          { key: 'identity.firstName', selector: '[data-automation-id="legalNameSection_firstName"]', control: 'text', required: true, selectorConfidence: 'observed-from-run' },
          { key: 'identity.lastName', selector: '[data-automation-id="legalNameSection_lastName"]', control: 'text', required: true, selectorConfidence: 'observed-from-run' },
          { key: 'contact.address.line1', selector: '[data-automation-id="addressSection_addressLine1"]', control: 'text', required: true, selectorConfidence: 'observed-from-run' },
          { key: 'contact.address.city', selector: '[data-automation-id="addressSection_city"]', control: 'text', required: true, selectorConfidence: 'observed-from-run' },
          {
            key: 'contact.address.state',
            // A picklist, not a text box — "State (California, picker)" on the
            // Avis row.
            selector: '[data-automation-id="addressSection_countryRegion"]',
            control: 'combobox', required: true, selectorConfidence: 'observed-from-run',
          },
          { key: 'contact.address.postalCode', selector: '[data-automation-id="addressSection_postalCode"]', control: 'text', required: true, selectorConfidence: 'observed-from-run' },
          { key: 'contact.phone', selector: '[data-automation-id="phone-number"]', control: 'text', required: true, selectorConfidence: 'observed-from-run' },
        ];

      case 'my-experience':
        return [
          { key: 'work.title', selector: '[data-automation-id="jobTitle"]', control: 'text', required: false, selectorConfidence: 'observed-from-run' },
          { key: 'work.employer', selector: '[data-automation-id="company"]', control: 'text', required: false, selectorConfidence: 'observed-from-run' },
          { key: 'work.description', selector: '[data-automation-id="roleDescription"]', control: 'textarea', required: false, selectorConfidence: 'observed-from-run' },
          {
            key: 'education.school',
            // A typeahead. The 09-17 Vanguard/Smith+Nephew debug screenshots are
            // named for the trouble this one caused.
            selector: '[data-automation-id="school"]',
            control: 'combobox', required: true, selectorConfidence: 'observed-from-run',
          },
          {
            key: 'education.degreeLevel',
            selector: '[data-automation-id="degree"]',
            control: 'combobox', required: true, selectorConfidence: 'observed-from-run',
            // Verbatim from the Jabil My Experience screenshot: the option reads
            // "Bachelors", with no apostrophe and no "Degree".
            optionText: { bachelors: ['Bachelors', "Bachelor's Degree", "Bachelor's"] },
          },
          {
            key: 'education.fieldOfStudy',
            selector: '[data-automation-id="fieldOfStudy"]',
            control: 'combobox', required: false, selectorConfidence: 'observed-from-run',
            /**
             * Tenant picklists disagree about this value and the profile's
             * fallbacks are what bridge them — recorded across three tenants
             * in one day:
             *   Visa    no "Artificial Intelligence" entry at all -> fell back
             *           to "Computer Science"
             *   Disney  typed "Artificial Intelligence", typeahead resolved it
             *           to "Artificial Intelligence and Robotics"
             *   Avis    committed "Artificial Intelligence and Robotics" via
             *           typed-search + Enter
             * The ORDER here is the profile's declared fallback order, and the
             * engine takes the first that the tenant's list actually offers.
             */
            optionText: {
              'artificial-intelligence': [
                'Artificial Intelligence and Robotics',
                'Artificial Intelligence',
                'Computer Science',
              ],
            },
          },
          {
            key: 'education.gpa',
            // Verbatim label from the Jabil screenshot: "Overall Result (GPA)".
            selector: '[data-automation-id="gpa"]',
            label: /overall result \(gpa\)|gpa/i,
            control: 'text', required: false, selectorConfidence: 'observed-from-run',
          },
          {
            key: 'upload.resume',
            selector: '[data-automation-id="file-upload-input-ref"]',
            control: 'file', required: true, selectorConfidence: 'observed-from-run',
          },
        ];

      case 'application-questions':
        return [
          {
            key: 'auth.workAuthorized',
            label: /legally authorized to work|work authorization/i,
            control: 'radio', required: true, selectorConfidence: 'observed-from-run',
            optionText: { 'authorized-no-sponsorship': ['Yes'], 'us-citizen': ['Yes'] },
          },
          {
            key: 'auth.sponsorship',
            label: /require.*sponsorship|will you now or in the future/i,
            control: 'radio', required: true, selectorConfidence: 'observed-from-run',
            optionText: { 'none-now-or-future': ['No'], now: ['Yes'], 'future-only': ['Yes'] },
          },
          {
            key: 'auth.over18',
            label: /18 years|age of majority/i,
            control: 'radio', required: false, selectorConfidence: 'observed-from-run',
            optionText: { yes: ['Yes'], no: ['No'] },
          },
        ];

      case 'voluntary-disclosures':
        return [
          {
            key: 'selfid.gender',
            selector: '[data-automation-id="gender"]',
            control: 'combobox', required: false, selectorConfidence: 'observed-from-run',
            // "Sex Male" on the RTX row; "gender Man" on the Disney row — the
            // same canonical value, two tenant vocabularies.
            optionText: { male: ['Male', 'Man'], female: ['Female', 'Woman'], decline: ['I do not wish to answer', 'Prefer not to answer'] },
          },
          {
            key: 'selfid.hispanic',
            label: /hispanic or latino/i,
            control: 'combobox', required: false, selectorConfidence: 'observed-from-run',
            optionText: { no: ['No'], yes: ['Yes'] },
          },
          {
            key: 'selfid.ethnicity',
            selector: '[data-automation-id="ethnicity"]',
            control: 'combobox', required: false, selectorConfidence: 'observed-from-run',
            /**
             * Visa's picklist split "Asian" into sub-regions with NO plain
             * "Asian" option and the applier picked "East Asian"; RTX offered
             * "Asian (Not Hispanic or Latino)". Both wordings are supplied, in
             * specificity order, so the engine matches whichever the tenant
             * renders — and if it renders neither, the field is optional and
             * skips rather than guessing at a region.
             */
            optionText: {
              asian: ['Asian (Not Hispanic or Latino)', 'Asian', 'East Asian'],
              white: ['White (Not Hispanic or Latino)', 'White'],
              decline: ['I do not wish to answer', 'Prefer not to answer'],
            },
          },
          {
            key: 'selfid.veteran',
            selector: '[data-automation-id="veteranStatus"]',
            control: 'combobox', required: false, selectorConfidence: 'observed-from-run',
            // Verbatim from the RTX and Disney rows: "I am not a veteran".
            optionText: {
              'not-a-protected-veteran': ['I am not a veteran', 'I am not a protected veteran'],
              'protected-veteran': ['I identify as one or more of the classifications of a protected veteran'],
              decline: ['I do not wish to answer'],
            },
          },
          {
            key: 'consent.terms',
            label: /terms and conditions|i have read|acknowledge/i,
            control: 'checkbox', required: true, selectorConfidence: 'observed-from-run',
            optionText: { yes: ['Yes', 'I Agree'] },
          },
        ];

      case 'self-identify':
        return [
          {
            key: 'selfid.disability',
            label: /disability|CC-305/i,
            control: 'radio', required: false, selectorConfidence: 'observed-from-run',
            optionText: {
              no: ['No, I do not have a disability and have not had one in the past', 'No, I do not have a disability'],
              yes: ['Yes, I have a disability, or have had one in the past'],
              decline: ['I do not want to answer', 'I prefer not to answer'],
            },
          },
          {
            key: 'selfid.signature',
            selector: '[data-automation-id="name"]',
            label: /^name$/i,
            control: 'text', required: true, selectorConfidence: 'observed-from-run',
          },
          {
            key: 'selfid.date',
            /**
             * THREE SPINBUTTONS, and the source of a reproducible tenant bug:
             * on Visa 09-17 the Date sections DISPLAYED the correct value while
             * "Date is required" kept failing across ~8 fill attempts. The fix
             * that worked was a single hard reload of the /apply URL (the draft
             * persists server-side) and re-entering that one step.
             *
             * So a date read-back that matches while validation still fails is
             * a known Workday state, and the engine's response is a bounded
             * reload-and-retry of the STEP, not more fills into a control that
             * already reads correctly.
             */
            selector: '[data-automation-id="dateSectionMonth-input"]',
            control: 'date', required: true, selectorConfidence: 'observed-from-run',
            dateParts: {
              month: '[data-automation-id="dateSectionMonth-input"]',
              day: '[data-automation-id="dateSectionDay-input"]',
              year: '[data-automation-id="dateSectionYear-input"]',
            },
            knownBug: {
              symptom: 'value reads back correct but "Date is required" persists',
              remedy: 'hard-reload the /apply URL once and re-enter this step only',
              observed: 'visa.wd5 2026-09-17',
            },
          },
        ];

      default:
        return [];
    }
  },

  // ------------------------------------------------------------ lifecycle --
  /**
   * The gate: cookie banner, then the chooser, then account creation.
   *
   * Q1 keeps this imperative because account CREATION is imperative — but note
   * what this function does NOT do. It never types a credential (the engine
   * owns every fill primitive), and it never generates one. It reports what the
   * gate looks like and which chooser option it would take, and the engine
   * decides and acts.
   */
  async passGate(ctx) {
    const root = ctx.frame;

    // 1. Cookie banner. Credential-free, and declining is the narrower consent.
    const decline = root.locator('[data-automation-id="legalNoticeDeclineButton"]');
    if (await decline.count()) {
      ctx.log('workday cookie banner present', { choice: 'decline' });
    }

    // 2. The chooser.
    const chooser = root.locator('[data-automation-id="applyAdventurePage"]');
    if (await chooser.count()) {
      const hasReuse = (await root.locator('[data-automation-id="useMyLastApplication"]').count()) > 0;
      ctx.log('workday chooser observed', {
        has_use_my_last_application: hasReuse,
        has_apply_manually: (await root.locator('[data-automation-id="applyManually"]').count()) > 0,
        // Recorded so the stream shows the trap was seen and declined, rather
        // than showing nothing and leaving it ambiguous whether we knew.
        autofill_with_resume_present_and_refused:
          (await root.locator('[data-automation-id="autofillWithResume"]').count()) > 0,
      });
      return { kind: 'none' };   // the engine picks, per quirks.chooser
    }

    // 3. The account gate.
    const createBtn = root.locator('[data-automation-id="createAccountSubmitButton"]');
    const signInBtn = root.locator('[data-automation-id="signInSubmitButton"]');
    const emailFirst = root.locator('[data-automation-id="SignInWithEmailButton"]');

    if (await emailFirst.count()) {
      ctx.log('workday sign-in method chooser (social buttons) — email path required', {});
      return { kind: 'needs-human', unlock: 'reveal the email sign-in form' };
    }

    if (await createBtn.count()) {
      // The credential comes FROM the engine. This adapter cannot invent one,
      // so there is no secret here the emitter has not already registered for
      // value-match redaction (Q1).
      const cred = await ctx.secrets.forTenant?.();
      ctx.log('workday create-account gate observed', {
        // Never the value, never a preview, never a length that narrows it.
        credential_available: !!cred,
        has_verify_password: (await root.locator('[data-automation-id="verifyPassword"]').count()) > 0,
        has_terms_checkbox: (await root.locator('[data-automation-id="createAccountCheckbox"]').count()) > 0,
        // FINDING 1, reported every time so its presence is auditable.
        honeypot_present: (await root.locator('[data-automation-id="beecatcher"]').count()) > 0,
      });
      // 'observed', not 'passed': this branch has SEEN the create-account
      // form; no account exists yet. Same droplet ruling as the iCIMS gate —
      // a gate_result may only claim what actually happened.
      return cred
        ? { kind: 'observed', via: 'account-creation-available' }
        : { kind: 'needs-human', unlock: 'no stored credential for this Workday tenant' };
    }

    if (await signInBtn.count()) {
      // Ordinary sign-in NEVER reaches adapter code (Q1) — it is driven from
      // `loginSpec` by the engine. Reporting it is all this branch may do,
      // and what it reports is an OBSERVATION: 'passed' is emitted by the
      // engine after loginSpec's `success` condition is actually met.
      ctx.log('workday sign-in gate observed', {
        honeypot_present: (await root.locator('[data-automation-id="beecatcher"]').count()) > 0,
      });
      return { kind: 'observed', via: 'login-form' };
    }

    return { kind: 'none' };
  },

  async identifyStep(ctx) {
    const root = ctx.frame;

    // The rail is the most reliable identifier Workday offers, and it is
    // self-describing: it names the active step and says how many there are.
    const rail = root.locator('[data-automation-id="progressBarActiveStep"]').first();
    if (await rail.count()) {
      const text = await rail.innerText().catch(() => '');
      const parsed = parseProgressBar(text);
      if (parsed?.stepId) return parsed.stepId;
    }

    if (await root.locator('[data-automation-id="applyAdventurePage"]').count()) return 'chooser';
    if (await root.locator('[data-automation-id="createAccountSubmitButton"], [data-automation-id="signInSubmitButton"], [data-automation-id="SignInWithEmailButton"]').count()) {
      return 'account-gate';
    }

    const url = ctx.url?.href ?? '';
    if (/jobTasks\/completed\/application/i.test(url)) return 'confirmation';

    const body = await root.locator('body').first().innerText().catch(() => '');
    if (/application submitted/i.test(body)) return 'confirmation';
    if (/job requisition id/i.test(body)) return 'posting';
    return null;
  },

  async advance(ctx, from) {
    const root = ctx.frame;

    if (from === 'posting') {
      const apply = root.locator('a:has-text("Apply"), [data-automation-id="adventureButton"]').first();
      if (await apply.count()) {
        await apply.click();
        await ctx.page.waitForLoadState('domcontentloaded').catch(() => {});
      }
      return { to: null };
    }

    // The chooser is a decision, not a transition: which option to take is
    // engine policy (quirks.chooser), so the adapter refuses to pick one here.
    if (from === 'chooser') {
      return {
        to: 'chooser',
        blockedBy: [{ message: 'chooser requires an engine decision (quirks.chooser), not an adapter click' }],
      };
    }

    // Every wizard step advances with the same control, verbatim "Save and
    // Continue" on every tenant observed.
    const next = root.locator('[data-automation-id="bottom-navigation-next-button"]').first();
    if (!(await next.count())) {
      return { to: null, blockedBy: [{ message: 'no Save and Continue control on this step' }] };
    }
    if (await next.isDisabled().catch(() => false)) {
      return { to: from, blockedBy: [{ message: 'Save and Continue is disabled' }] };
    }

    await next.click();
    await ctx.page.waitForLoadState('domcontentloaded').catch(() => {});

    // Workday renders validation errors in place and stays on the step.
    const errors = await root.locator('[data-automation-id="errorMessage"], [role="alert"]')
      .allInnerTexts().catch(() => []);
    const blockedBy = errors.filter(Boolean).slice(0, 8)
      .map((message) => ({ message: message.replace(/\s+/g, ' ').trim().slice(0, 200) }));

    return { to: null, ...(blockedBy.length ? { blockedBy } : {}) };
  },

  async upload(ctx, target, file) {
    const root = ctx.frame;
    // NAMED target (F6). Workday's visible control is a drop zone; the real
    // input is the file-upload-input-ref behind it.
    const byName = {
      resume: '[data-automation-id="file-upload-input-ref"]',
      transcript: '[data-automation-id="file-upload-input-ref"]',
      'cover-letter': '[data-automation-id="file-upload-input-ref"]',
    };
    await root.locator(byName[target.name] ?? 'input[type=file]').first().setInputFiles(file.path);
  },

  async verifyUpload(ctx, target, file) {
    const root = ctx.frame;
    const wanted = file.path.split('/').pop();
    // Workday lists attachments by filename with a Delete control. The FILENAME
    // check is what catches the 09-16 Live Oak case, where "Use My Last
    // Application" carried over the SIBLING POSTING'S résumé — a file that was
    // genuinely attached, and genuinely wrong. `attached: true` with the wrong
    // name must therefore be reported as the wrong name, not as success.
    const body = await root.locator('body').first().innerText().catch(() => '');
    const shown = body.includes(wanted);
    const anyAttachment = await root.locator('[data-automation-id="attachment-name"], [data-automation-id="deleteFile"]').count();

    let observedName = shown ? wanted : null;
    if (!shown && anyAttachment) {
      const names = await root.locator('[data-automation-id="attachment-name"]').allInnerTexts().catch(() => []);
      observedName = names[0]?.trim() ?? null;
    }

    return {
      observedName,
      observedBytes: null,
      // Only OUR file counts as attached. A different file present is a
      // mismatch the engine must park on, not an upload that succeeded.
      attached: shown,
      how: shown ? 'filename-in-dom' : anyAttachment ? 'other' : 'other',
    };
  },

  async readReview(ctx) {
    const root = ctx.frame;
    // The Review step renders labelled panels rather than form controls.
    const rows = await root.locator('[data-automation-id="displayItem"], [data-automation-id="panel"] li, [data-automation-id="formLabel"]')
      .evaluateAll((els) => els.map((el) => (el.innerText || '').replace(/\s+/g, ' ').trim())
        .filter((t) => t && t.length < 300));
    const out = {};
    for (const r of rows) {
      const m = /^(.{2,60}?)\s*[:：]\s*(.+)$/.exec(r);
      if (m) out[m[1].trim()] = m[2].trim();
    }
    return out;
  },

  async readConfirmation(ctx) {
    const root = ctx.frame;
    const text = await root.locator('body').first().innerText().catch(() => '');
    // Verbatim from the 09-17 Visa and Vanguard confirmation screenshots.
    const ok = /application submitted/i.test(text)
      || /jobTasks\/completed\/application/i.test(ctx.url?.href ?? '');
    const { extractApplicationId } = await import('../engine/submit.js');
    return {
      // Workday shows no application id on the confirmation modal — the
      // requisition id is on the posting, and the receipt email carries the
      // rest. Null is the honest answer.
      applicationId: extractApplicationId(text),
      text: text.slice(0, 400),
      url: ctx.url?.href ?? '',
      confirmed: ok,
    };
  },

  /** Exported for tests and for the engine's step-count sanity check. */
  stepTitles: WORKDAY_STEP_TITLES,
};

export default workday;
