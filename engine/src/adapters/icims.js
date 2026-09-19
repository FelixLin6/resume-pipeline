// iCIMS adapter — Phase 2. Selectors from REAL reconnaissance, not guesses.
//
// Evidence base, and how to read the confidence labels on each step:
//
//   verified-shadow    — read off live iCIMS tenants during navigation-only
//                        recon on 2026-09-17 (5 tenants: jobs-cesi,
//                        careers-decisionpointcorp, studentcareers-jhuapl,
//                        careers-gdms, careers-cotiviti). The selector was
//                        observed in the live DOM.
//   observed-from-run  — derived from this week's run records: the 09-16 and
//                        09-17 ledgers, STAGED.md, and the confirmation /
//                        parked screenshots. The WORDING is verbatim from
//                        those artifacts; the underlying selector is inferred
//                        from iCIMS conventions and must be confirmed at
//                        Gate 1 before it is trusted.
//
// Recon was strictly read-only: pages were loaded and inspected, nothing was
// typed into a real employer's form, no Next/Submit was ever clicked, and no
// captcha was attempted. That is why the steps BEHIND the gate carry the
// weaker label — we did not enter an email to reveal them, by design.
//
// Two corrections to the Phase 1 stub that recon forced:
//
//  1. THE FRAME CHAIN IS ONE LEVEL, NOT TWO. The stub guessed
//     ['iframe#icims_content_iframe', 'iframe[name="icims_iframe"]'].
//     All 5 tenants render a single `iframe#icims_content_iframe` whose inner
//     document is the same URL plus `in_iframe=1`. A two-level chain would
//     have failed to resolve on every tenant.
//
//  2. hCAPTCHA PRESENCE IS NOT A WALL. Every iCIMS login page carries an
//     hCaptcha iframe and an `h-captcha-response` textarea on EVERY load,
//     challenge or not. The stub's marker `iframe[src*="hcaptcha"]` would
//     have reported a wall on 100% of iCIMS applications — including the
//     three of four that sailed straight through on 09-17. The real
//     discriminator, probed directly: the challenge iframe
//     (`iframe[title="hCaptcha challenge"]`) sits in a `visibility:hidden`
//     wrapper until it fires.

/** @type {import('../schema/types.js').AtsAdapter} */
const icims = {
  id: 'icims',
  apiVersion: 1,

  match: {
    hostnames: [/\.icims\.com$/i],
    // Employer-owned careers domains CNAME onto the same iCIMS edge and carry
    // ?icims=1. Because it IS the same edge, a 403 on one is a 403 on the
    // other (JHU APL, 2026-09-11) — never treat the employer domain as an
    // alternate route around a block.
    pathHints: [/[?&]icims=1/i, /\/jobs\/\d+\//],
  },

  tenantOf(url) { return `icims:${url.hostname.toLowerCase()}`; },

  // Q1: iCIMS guest-apply involves no credential, so it stays imperative —
  // and this adapter is NOT permitted to create accounts, so the engine will
  // not attach `secrets.forTenant` to its context at all.
  accountCreation: false,

  // ---------------------------------------------------------------- flow ---
  steps: [
    {
      id: 'posting',
      title: 'Job posting page',
      selectorConfidence: 'verified-shadow',
      markers: [{ urlPattern: /\/jobs\/\d+\/[^/]+\/job/i }],
      expects: [],
    },

    {
      id: 'guest-apply',
      title: 'Enter Your Information (email + consent)',
      selectorConfidence: 'verified-shadow',
      // Heading verbatim on all 5 tenants, inside the content iframe.
      markers: [
        { urlPattern: /\/jobs\/\d+\/login/i },
        { selector: '#enterEmailSubmitButton' },
        { text: /Enter Your Information/i },
      ],
      expects: ['contact.email'],
      // "Next" is DISABLED until the consent box is checked. Observed live:
      // disabled on DecisionPoint / GDMS / JHU APL (all of which render a
      // consent checkbox) and ENABLED on CESI / Cotiviti (which render none).
      // So a disabled Next here is not an error — it is an unchecked box, and
      // on two tenants there is no box to check.
    },

    {
      id: 'captcha-gate',
      title: 'hCaptcha challenge (fires on submit of guest-apply)',
      selectorConfidence: 'verified-shadow',
      markers: [{ selector: 'iframe[title="hCaptcha challenge"]', requireVisible: true }],
      expects: [],
      optional: true,
      // isWall makes identifyStep evaluate this step FIRST and short-circuit
      // (advance.js Rule 1). Without it this step was unreachable BY
      // CONSTRUCTION: the challenge overlays guest-apply, whose 3 markers all
      // stay true underneath it, so a count-ranked identify scored 3–1 for
      // guest-apply on every fired challenge — the cesi false clean.
      isWall: true,
      // CRITICAL: this fires BEFORE the form loads, so nothing is filled
      // behind it — an assist slot spent here buys zero fields. Observed
      // 2026-09-17: 3 of 4 gates did NOT re-fire on a second visit, so it is
      // session/reputation-dependent rather than a tenant setting.
    },

    {
      id: 'candidate-profile',
      title: 'Candidate Profile / Basic Information (step 1 of N; N observed 3-5)',
      selectorConfidence: 'observed-from-run',
      markers: [
        { text: /Candidate Profile|Basic Information/i },
        { text: /Provide your resume below to pre-fill your profile/i },
      ],
      expects: [
        'upload.resume',
        'contact.email', 'account.login',
        'education.school', 'education.fieldOfStudy',
        'education.startDate', 'education.graduated',
        'work.title', 'work.employer', 'work.startDate', 'work.endDate',
        'work.description', 'work.isCurrent',
      ],
      // Load-bearing and recorded three times this week: the résumé upload
      // triggers an auto-parse that fills education + work experience AND
      // OVERWRITES the login/email with the forbidden CMU address (Cole,
      // SimVentions, Cotiviti). The tenant's own instruction text says so
      // outright — "Existing data in the form will be replaced". The engine's
      // post-upload re-verify barrier is what catches it.
    },

    {
      id: 'captcha-gate-2',
      title: 'SECOND hCaptcha, on Submit Profile',
      selectorConfidence: 'observed-from-run',
      markers: [{ selector: 'iframe[title="hCaptcha challenge"]', requireVisible: true }],
      expects: [],
      optional: true,
      isWall: true,
      // iCIMS DOUBLE-GATES. Confirmed by two screenshots this week (JHU APL
      // after-submit, Cotiviti) showing the puzzle re-appear over an already
      // filled Work Experience section. Budget an iCIMS tenant as TWO puzzles,
      // or detect this gate before spending the first assist slot.
    },

    {
      id: 'application-form',
      title: 'Standard employment application',
      selectorConfidence: 'observed-from-run',
      markers: [{ text: /employment application/i }],
      expects: [],
      // The résumé does NOT carry over from Basic Information and must be
      // re-uploaded (Cole, 2026-09-17).
    },
    { id: 'education-history', title: 'Education', selectorConfidence: 'observed-from-run', markers: [{ text: /education/i }], expects: ['education.school', 'education.degreeLevel'], optional: true },
    { id: 'employment-history', title: 'Employment history', selectorConfidence: 'observed-from-run', markers: [{ text: /employment history/i }], expects: [], optional: true },
    { id: 'work-eligibility', title: 'Work Eligibility / citizenship', selectorConfidence: 'observed-from-run', markers: [{ text: /work eligibility|citizenship status/i }], expects: ['auth.workAuthorized'], optional: true },
    { id: 'eeo', title: 'EEO', selectorConfidence: 'observed-from-run', markers: [{ text: /equal employment|eeo/i }], expects: ['selfid.gender', 'selfid.ethnicity'], optional: true },
    { id: 'veteran-self-id', title: 'VEVRAA veteran self-ID', selectorConfidence: 'observed-from-run', markers: [{ text: /veteran/i }], expects: ['selfid.veteran'], optional: true },
    { id: 'disability-self-id', title: 'OFCCP disability self-ID', selectorConfidence: 'observed-from-run', markers: [{ text: /disabilit/i }], expects: ['selfid.disability', 'selfid.signature'], optional: true },
    { id: 'review', title: 'Review', selectorConfidence: 'observed-from-run', markers: [{ text: /review your|please review/i }], expects: [], isReview: true },
    { id: 'submit', title: 'Submit', selectorConfidence: 'observed-from-run', markers: [{ text: /submit application/i }], expects: [], isSubmit: true },
  ],

  // -------------------------------------------------------------- quirks ---
  quirks: {
    // VERIFIED from the JHU APL prefill screenshots: education and work dates
    // are THREE controls — a Month <select>, a Day <select>, and a free-text
    // Year. Not a single mm/dd/yyyy text box, which the Phase 1 stub assumed,
    // and emphatically not a picker widget.
    dateStrategy: 'month-day-year-selects',
    typeaheadNeedsEnter: true,
    forbidDatePicker: true,

    // Q4: 1 is the default for every ATS and iCIMS gives no reason to raise
    // it. There is no observed tenant idempotency to cite, and iCIMS mails a
    // confirmation per submission, so a double submit is visible to the
    // employer.
    maxSubmitAttempts: 1,

    wallMarkers: [
      // Presence is NOT the signal — see the file header. The challenge iframe
      // is in the DOM on every load; only visibility discriminates.
      { wallClass: 'hcaptcha', selector: 'iframe[title="hCaptcha challenge"]', requireVisible: true },
      { wallClass: 'http-403', status: 403 },
      { wallClass: 'http-429', status: 429 },
      { wallClass: 'account-required', text: /wrong username or password/i },
    ],

    /** Not a wall: the widget that is always present. Exposed so the engine
     *  can assert the distinction rather than rediscover it. */
    dormantCaptchaMarkers: [
      'textarea[name="h-captcha-response"]',
      'iframe[src*="#frame=checkbox-invisible"]',
    ],
  },

  // ------------------------------------------------------------- frames ----
  async formRoot(/* ctx, step */) {
    // ONE level. Verified on 5/5 tenants 2026-09-17. Cotiviti's page carries 8
    // frames in total (Hotjar `#_hjRemoteVarsFrame` ×3, an ad-sync `#db-sync`,
    // two hCaptcha frames), which is exactly why this resolves by SELECTOR and
    // never by frame index.
    return { frames: ['iframe#icims_content_iframe'] };
  },

  // ----------------------------------------------------------- bindings ----
  bindings(step) {
    switch (step) {
      case 'guest-apply':
        return [
          {
            key: 'contact.email',
            // VERIFIED on 5/5: id="email", name="css_loginName", type=email.
            // Note the DOM does NOT mark it required even though it is.
            selector: '#email',
            control: 'text',
            required: true,
            selectorConfidence: 'verified-shadow',
          },
          {
            // Re-keyed consent.terms -> consent.privacy (Gate 1 fix batch):
            // this checkbox is the ENTRY gate — Next stays disabled until it
            // is checked on the tenants that render it — which is what
            // consent.privacy names. Both keys resolve to the same profile
            // answer (agree_to_terms_and_privacy), so the value is unchanged;
            // only the claim in the stream is now accurate.
            key: 'consent.privacy',
            // VERIFIED, and the id VARIES BY TENANT: #accept_gdpr on
            // DecisionPoint and GDMS, #accept_privacy on JHU APL, and ABSENT
            // on CESI and Cotiviti. A union selector covers the observed set;
            // the prefix form catches a tenant we have not seen.
            selector: '#accept_gdpr, #accept_privacy, input[type=checkbox][id^="accept_"]',
            control: 'checkbox',
            required: false,   // absent on 2 of 5 tenants — optional by tenant
            optionText: { yes: ['I accept', 'I agree'] },
            selectorConfidence: 'verified-shadow',
          },
        ];

      case 'candidate-profile':
        return [
          { key: 'upload.resume', label: /upload your resume/i, control: 'file', required: true, selectorConfidence: 'observed-from-run' },
          { key: 'upload.transcript', label: /upload your transcripts?/i, control: 'file', required: false, selectorConfidence: 'observed-from-run' },
          { key: 'account.login', label: /^login/i, control: 'text', required: true, selectorConfidence: 'observed-from-run' },
          { key: 'contact.email', label: /^email/i, control: 'text', required: true, selectorConfidence: 'observed-from-run' },
          { key: 'education.school', label: /school or university/i, control: 'combobox', required: false, selectorConfidence: 'observed-from-run' },
          {
            key: 'education.graduated',
            label: /did you graduate/i,
            control: 'select',
            required: true,
            optionText: { no: ['No'], yes: ['Yes'] },
            selectorConfidence: 'observed-from-run',
          },
          {
            key: 'work.isCurrent',
            label: /is this your current job/i,
            control: 'select',
            required: false,
            optionText: { no: ['No'], yes: ['Yes'] },
            selectorConfidence: 'observed-from-run',
          },
          {
            key: 'auth.workAuthorized',
            label: /citizenship status/i,
            control: 'select',
            required: true,
            // Verbatim from the JHU APL Work Eligibility block.
            optionText: { 'authorized-no-sponsorship': ['U.S. Citizen'], 'us-citizen': ['U.S. Citizen'] },
            selectorConfidence: 'observed-from-run',
          },
          {
            key: 'selfid.veteran',
            label: /veteran/i,
            control: 'select',
            required: false,
            // Verbatim from the DecisionPoint "Additional Data" block.
            optionText: { 'not-a-protected-veteran': ['I am NOT a protected veteran'] },
            selectorConfidence: 'observed-from-run',
          },
          {
            key: 'selfid.disability',
            label: /disabilit/i,
            control: 'select',
            required: false,
            optionText: { no: ['No, I do not have a disability and have not had one in the past'] },
            selectorConfidence: 'observed-from-run',
          },
        ];

      default:
        return [];
    }
  },

  // ------------------------------------------------------------ lifecycle --
  /** The guest-apply gate. No credential is involved, so this stays
   *  imperative under the Q1 ruling — and the engine hands this adapter a
   *  context with no `secrets.forTenant` at all. */
  async passGate(ctx) {
    const root = ctx.frame;
    const emailBox = root.locator('#email');
    if (!(await emailBox.count())) return { kind: 'none' };

    // The engine fills the email (it owns every fill primitive); the adapter
    // only reports what the gate looks like.
    const consent = root.locator('#accept_gdpr, #accept_privacy, input[type=checkbox][id^="accept_"]').first();
    const hasConsent = (await consent.count()) > 0;
    const next = root.locator('#enterEmailSubmitButton');
    const nextDisabled = hasConsent ? await next.isDisabled().catch(() => true) : false;

    ctx.log('guest-apply gate observed', {
      has_consent_checkbox: hasConsent,
      next_disabled: nextDisabled,
    });
    // 'observed', NOT 'passed' (droplet finding, Gate 1 fix batch): this
    // method has only LOOKED at the gate — the email is not yet entered and
    // Next is not yet clicked. The old {kind:'passed'} put a claimed gate
    // pass into the stream on all 32 probe rows where nothing was passed.
    // 'passed' is the engine's to emit, after the advance past this step
    // actually lands.
    return { kind: 'observed', via: 'guest' };
  },

  async identifyStep(ctx) {
    const root = ctx.frame;
    const url = ctx.url?.href ?? '';
    // The wall first, ALWAYS — the same Rule 1 the engine's identifyStep now
    // enforces. The challenge overlays guest-apply without removing any of its
    // markers, so any URL/button check that runs first reports the page under
    // the challenge instead of the challenge (the cesi false clean).
    const challenge = root.locator('iframe[title="hCaptcha challenge"]').first();
    if (await challenge.count() && await challenge.isVisible().catch(() => false)) {
      return 'captcha-gate';
    }
    if (/\/jobs\/\d+\/login/i.test(url) && await root.locator('#enterEmailSubmitButton').count()) {
      return 'guest-apply';
    }
    const body = await root.locator('body').first().innerText().catch(() => '');
    if (/Candidate Profile|Basic Information/i.test(body)) return 'candidate-profile';
    if (/employment application/i.test(body)) return 'application-form';
    if (/submit application/i.test(body)) return 'submit';
    return null;
  },

  async advance(ctx, from) {
    const root = ctx.frame;
    const buttonFor = {
      'guest-apply': '#enterEmailSubmitButton',
      'candidate-profile': 'input[type=submit][value*="Submit Profile" i], button:has-text("Submit Profile")',
    };
    const sel = buttonFor[from] ?? 'input[type=submit], button[type=submit]';
    const btn = root.locator(sel).first();

    if (await btn.isDisabled().catch(() => false)) {
      // A disabled Next is information, not a failure to work around. On this
      // ATS it means an unchecked consent box; the engine decides what to do.
      return { to: from, blockedBy: [{ message: 'advance control is disabled (consent not accepted?)' }] };
    }

    await btn.click();
    // NO top-level wait here, deliberately. The old line awaited
    // domcontentloaded on ctx.page — but the form lives in
    // iframe#icims_content_iframe, so the top page never navigates and that
    // await resolved in 66–74 ms (measured on six tenants), long before either
    // the in-frame transition or the challenge frame rendered. The ENGINE now
    // settles after every advance (advance.js Rule 2), polling inside the
    // correct frame for a step change or a fired wall; a wait the adapter
    // cannot do correctly is a wait it must not pretend to do.
    return { to: null };   // the engine settles, classifies, then re-identifies
  },

  async upload(ctx, target, file) {
    const root = ctx.frame;
    // NAMED target, never an ordinal (F6): Ashby's autofill-from-resume input
    // renders before the real one and nth=0 cost four days of manual re-uploads.
    const byName = {
      resume: 'input[type=file][name*="resume" i], input[type=file][id*="resume" i]',
      transcript: 'input[type=file][name*="transcript" i], input[type=file][id*="transcript" i]',
      'cover-letter': 'input[type=file][name*="cover" i], input[type=file][id*="cover" i]',
    };
    await root.locator(byName[target.name] ?? 'input[type=file]').first().setInputFiles(file.path);
    // iCIMS shows "Parsing resume, please wait..." while the parser runs.
    await ctx.page.waitForTimeout?.(0);
  },

  async verifyUpload(ctx, target, file) {
    const root = ctx.frame;
    const wanted = file.path.split('/').pop();
    // iCIMS renders the filename plus a "Replace Resume" / "Delete File"
    // control once an artifact is attached — the input's own file list is not
    // reliable here, which is exactly why verifyUpload is an ADAPTER method
    // (F7: Greenhouse replaces the input entirely).
    const body = await root.locator('body').first().innerText().catch(() => '');
    const shown = body.includes(wanted);
    const hasReplace = (await root.locator('button:has-text("Replace"), input[value*="Replace" i], button:has-text("Delete File")').count()) > 0;
    return {
      observedName: shown ? wanted : null,
      observedBytes: null,
      attached: shown || hasReplace,
      how: shown ? 'filename-in-dom' : hasReplace ? 'remove-button' : 'other',
    };
  },

  async readReview(ctx) {
    const root = ctx.frame;
    const rows = await root.locator('tr, .iCIMS_TableRow').evaluateAll((els) =>
      els.map((el) => (el.innerText || '').replace(/\s+/g, ' ').trim())
        .filter((t) => t && t.length < 300));
    const out = {};
    for (const r of rows) {
      const m = /^(.{2,60}?)\s*[::]\s*(.+)$/.exec(r);
      if (m) out[m[1].trim()] = m[2].trim();
    }
    return out;
  },

  async readConfirmation(ctx) {
    const root = ctx.frame;
    const text = await root.locator('body').first().innerText().catch(() => '');
    // Verbatim from the one iCIMS confirmation captured this week (Cole
    // Engineering): a green banner on the ORIGINAL posting page, not a
    // separate thank-you template.
    const ok = /Your application was submitted successfully|Thank you for applying|You are currently being considered/i.test(text);
    const { extractApplicationId } = await import('../engine/submit.js');
    return {
      applicationId: extractApplicationId(text),
      text: ok ? text.slice(0, 400) : text.slice(0, 400),
      url: ctx.url?.href ?? '',
      confirmed: ok,
    };
  },
};

export default icims;
