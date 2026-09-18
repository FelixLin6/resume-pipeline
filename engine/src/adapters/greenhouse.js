// Greenhouse adapter — Phase 3. Selectors from REAL reconnaissance.
//
// Evidence base:
//
//   verified-shadow    — read off four live Greenhouse boards during
//                        navigation-only recon on 2026-09-17: covar,
//                        nanopathinc, relaypro, andurilindustries. Selectors
//                        were observed in the live DOM of the apply form.
//   observed-from-run  — from the 09-16 and 09-17 ledgers and screenshots
//                        (19 Greenhouse rows across the two days). Wording
//                        verbatim; selector inferred.
//
// Recon was strictly read-only: nothing typed, clicked, attached or submitted.
// Greenhouse's form is public and fully rendered on load, so nearly everything
// below is verified.
//
// ---------------------------------------------------------------------------
// THE FOUR FINDINGS THAT SHAPE THIS ADAPTER
// ---------------------------------------------------------------------------
//
// 1. A HIDDEN "requiredInput" PROXY WOULD PARK EVERY APPLICATION.
//    Every react-select control on the page is accompanied by a second,
//    LABEL-LESS input that is marked required:
//        input.remix-css-1a0ro4n-requiredInput   (required, "visible")
//    Recon counted five of them on the CoVar form alone. They carry no label,
//    so generic discovery maps them to no FieldKey, and a required field with
//    no FieldKey is `unmapped_required` — which parks the application. Without
//    this rule the adapter would park 100% of Greenhouse postings while the
//    form on screen looked perfectly fillable. The class hash
//    (`remix-css-1a0ro4n`) is build-volatile, so the match is on the stable
//    `requiredInput` suffix.
//
// 2. CUSTOM QUESTIONS ARE NUMERIC-ID-KEYED, SO THEY ARE BOUND BY LABEL.
//        #question_12915029007  "How many years of work experience do you have
//                                with Python (Programming Language)?"
//    The id is per posting. Note this specific question is the one that parked
//    CoVar on 09-17 — no duration data exists for any language and the profile
//    forbids inventing one, so it is `would_require_invention`, which is a
//    counted park (Q2), not a gap to be papered over.
//
// 3. "AUTOFILL MY APPLICATION" IS A TRAP AND IS NEVER CLICKED.
//    Greenhouse renders an autofill-from-résumé button next to the upload. F15
//    is a list of eight tenants whose parsers overwrote already-correct contact
//    fields — including setting the email to the forbidden CMU address. The
//    engine uploads to the file input directly and never invites a parse.
//
// 4. THE reCAPTCHA BADGE IS ON EVERY PAGE AND IS NOT A WALL.
//    Every board carries a reCAPTCHA Enterprise anchor iframe and a hidden
//    `#g-recaptcha-response-100000` textarea whether or not anything ever
//    challenges. This is the iCIMS hCaptcha lesson repeating on another ATS:
//    a marker keyed to PRESENCE would have walled all 19 Greenhouse rows of the
//    last two days, every one of which submitted fine.

/** @type {import('../schema/types.js').AtsAdapter} */
const greenhouse = {
  id: 'greenhouse',
  apiVersion: 1,

  match: {
    hostnames: [/(^|\.)greenhouse\.io$/i, /(^|\.)job-boards\.greenhouse\.io$/i],
    // Employer-hosted boards embed Greenhouse and carry the job id as a query
    // param: careers.withwaymo.com/jobs/…?gh_jid=8203200,
    // careers.duolingo.com/jobs/…?gh_jid=… (both observed 09-16/09-17).
    //
    // A bare `/jobs/<digits>` is NOT a hint: that shape is universal, and
    // including it resolved Trane's Oracle Cloud careers page
    // (careers.tranetechnologies.com/en/jobs/12345) to this adapter — which
    // would have driven a Greenhouse adapter against an Oracle form. An ATS we
    // do not recognize must reach the model-driven fallback, which knows it is
    // reading something unfamiliar.
    pathHints: [/[?&]gh_jid=/i, /[?&]gh_src=/i],
  },

  tenantOf(url) {
    if (/greenhouse\.io$/i.test(url.hostname)) {
      const seg = url.pathname.split('/').filter(Boolean)[0] ?? url.hostname;
      return `greenhouse:${seg.toLowerCase()}`;
    }
    // An embedded board's tenant is the employer host — two employers embedding
    // Greenhouse are two tenants, and their wall memory must not be shared.
    return `greenhouse:${url.hostname.toLowerCase()}`;
  },

  // Greenhouse needs no account. The post-submit email verification code seen
  // on several tenants (Amperesand, Emergent Labs, EQT, Relay ×2, Anduril ×2)
  // is NOT account creation — it is a one-time code, which the engine reads
  // through `secrets.verificationCode`, a capability every adapter has.
  accountCreation: false,

  // ---------------------------------------------------------------- flow ---
  steps: [
    {
      id: 'posting',
      title: 'Job posting page',
      selectorConfidence: 'verified-shadow',
      markers: [{ text: /apply for this job/i }],
      expects: [],
    },
    {
      id: 'apply-form',
      title: 'Application form (single page)',
      selectorConfidence: 'verified-shadow',
      markers: [
        { selector: '#first_name' },
        { selector: '#email' },
        { text: /apply for this job/i },
      ],
      expects: [
        'identity.firstName', 'identity.lastName', 'contact.email',
        'contact.phone', 'upload.resume',
      ],
      isReview: true,      // the form is the review: there is no summary page
    },
    {
      id: 'submit',
      title: 'Submit application',
      selectorConfidence: 'verified-shadow',
      markers: [{ text: /submit application/i }],
      expects: [],
      isSubmit: true,
    },
    {
      id: 'verify-code',
      title: 'Post-submit email verification code',
      selectorConfidence: 'observed-from-run',
      // Observed on 7 rows across 09-16/09-17: "form had a post-submit email
      // verification-code gate (not a captcha) — code retrieved over IMAP per
      // standing auth, application resubmitted successfully after entry."
      //
      // Load-bearing consequence: on these tenants the application is NOT filed
      // until the code is entered, so a stream that stops at `submitted` before
      // this step has recorded a submission that did not happen.
      markers: [{ text: /verification code|enter the code|we sent a code/i }],
      expects: [],
      optional: true,
    },
    {
      id: 'confirmation',
      title: '"Thank you for applying"',
      selectorConfidence: 'verified-shadow',
      markers: [
        { urlPattern: /\/confirmation/i },
        { urlPattern: /\/thank-you/i },
        { text: /thank you for applying|your application has been received/i },
      ],
      expects: [],
    },
  ],

  // -------------------------------------------------------------- quirks ---
  quirks: {
    dateStrategy: 'mm/dd/yyyy-text',
    typeaheadNeedsEnter: true,     // #candidate-location and #country are typeaheads
    forbidDatePicker: true,
    maxSubmitAttempts: 1,          // Q4 default; no observed idempotency to cite

    submitControl: {
      // Verified live: a `button.btn` whose text is "Submit application".
      // Greenhouse gives it no stable id, so it is addressed by role+name.
      selector: 'button:has-text("Submit application")',
      captchaWrappers: [
        'iframe[title*="recaptcha challenge" i]',
        'iframe[src*="recaptcha"][title*="challenge" i]',
      ],
      // The v3/Enterprise token box. Present and empty on every load — its
      // emptiness is NOT a wall here, which is why only the hit test decides.
      captchaResponse: 'textarea[id^="g-recaptcha-response"]',
    },

    wallMarkers: [
      // Only the interactive CHALLENGE popup counts. The anchor/badge iframe is
      // on 100% of Greenhouse pages (finding 4).
      { wallClass: 'recaptcha-interactive', selector: 'iframe[title*="recaptcha challenge" i]', requireVisible: true },
      { wallClass: 'http-403', status: 403 },
      { wallClass: 'http-429', status: 429 },
      { wallClass: 'spam-flag', text: /flagged as spam|marked as spam/i },
    ],

    dormantCaptchaMarkers: [
      'textarea[id^="g-recaptcha-response"]',
      'iframe[src*="recaptcha/enterprise/anchor"]',
    ],

    /** Finding 1. Without this the adapter parks every application. */
    noiseSelectors: [
      'input[class*="requiredInput"]',   // react-select's hidden required proxy
      '#iti-0__search-input',            // the phone widget's country search box
      'input[type=hidden]',
    ],

    /** Finding 3: never invite a résumé parse. */
    forbiddenControls: [
      'button:has-text("Autofill my application")',
      'button:has-text("Dropbox")',
      'button:has-text("Google Drive")',
      'button:has-text("Enter manually")',
    ],
  },

  // ------------------------------------------------------------- frames ----
  async formRoot() {
    // TOP LEVEL, verified on 4/4 boards. The only iframes are the reCAPTCHA
    // anchor and a Google API proxy.
    return { frames: [] };
  },

  // ----------------------------------------------------------- bindings ----
  bindings(step) {
    if (step !== 'apply-form' && step !== 'submit') return [];
    return [
      // ---- core block, VERIFIED on 4/4 boards -----------------------------
      { key: 'identity.firstName', selector: '#first_name', control: 'text', required: true, selectorConfidence: 'verified-shadow' },
      { key: 'identity.lastName', selector: '#last_name', control: 'text', required: true, selectorConfidence: 'verified-shadow' },
      { key: 'identity.preferredName', selector: '#preferred_name', control: 'text', required: false, selectorConfidence: 'verified-shadow' },
      { key: 'contact.email', selector: '#email', control: 'text', required: true, selectorConfidence: 'verified-shadow' },
      {
        key: 'contact.phone',
        // type=tel, wrapped in intl-tel-input. The country code is a SEPARATE
        // widget (#iti-0__search-input, declared noise) and had to be set by
        // hand on CoVar 09-17 — so the phone value written here is the E.164
        // form, which carries its own country code and does not depend on the
        // widget's state.
        selector: '#phone', control: 'text', required: true, selectorConfidence: 'verified-shadow',
      },
      {
        key: 'contact.address.country',
        selector: '#country', control: 'combobox', required: true, selectorConfidence: 'verified-shadow',
        optionText: { US: ['United States'] },
      },
      {
        key: 'loc.currentLocation',
        // Present on some boards only (CoVar yes, Nanopath no). The "Locate me"
        // button next to it is never clicked — it asks for geolocation.
        selector: '#candidate-location', control: 'combobox', required: true, selectorConfidence: 'verified-shadow',
      },

      // ---- uploads, VERIFIED ----------------------------------------------
      {
        key: 'upload.resume',
        // The direct file input, never the "Attach" button (F19: the fill
        // script's upload silently failed on five forms in one day and each was
        // redone by hand through this input).
        selector: '#resume', control: 'file', required: true, selectorConfidence: 'verified-shadow',
      },
      {
        key: 'upload.coverLetter',
        // Required on some postings (Nanopath 09-17: "Cover Letter is
        // required." parked the row). Accepts .txt directly — no PDF
        // conversion needed, per the evening-sweep record.
        selector: '#cover_letter', control: 'file', required: false, selectorConfidence: 'verified-shadow',
      },

      // ---- demographics ----------------------------------------------------
      // VERIFIED ids, but note the CONTROL TYPE: these render as
      // `input[type=text]` driven by react-select, NOT as <select>. Generic
      // discovery would type into them; declaring them comboboxes is what makes
      // the engine open the listbox and match an option instead.
      {
        key: 'selfid.gender', selector: '#gender', control: 'combobox', required: false,
        selectorConfidence: 'verified-shadow',
        optionText: { male: ['Male', 'Man'], female: ['Female', 'Woman'], decline: ['Decline To Self Identify', "I don't wish to answer"] },
      },
      {
        key: 'selfid.hispanic', selector: '#hispanic_ethnicity', control: 'combobox', required: false,
        selectorConfidence: 'verified-shadow',
        // YES_NO only. The form also offers "Decline To Self Identify", but
        // `selfid.hispanic` has no `decline` canonical — the profile records a
        // definite answer, so the honest mapping is that answer, and inventing
        // a canonical to carry the form's third option would put a value in the
        // enum that no profile field can ever produce.
        optionText: { no: ['No'], yes: ['Yes'] },
      },
      {
        key: 'selfid.veteran', selector: '#veteran_status', control: 'combobox', required: false,
        selectorConfidence: 'verified-shadow',
        optionText: {
          'not-a-protected-veteran': ['I am not a protected veteran'],
          'protected-veteran': ['I identify as one or more of the classifications of a protected veteran'],
          decline: ["I don't wish to answer"],
        },
      },
      {
        key: 'selfid.disability', selector: '#disability_status', control: 'combobox', required: false,
        selectorConfidence: 'verified-shadow',
        // Verbatim from the CoVar screenshot.
        optionText: {
          no: ['No, I do not have a disability and have not had one in the past'],
          yes: ['Yes, I have a disability, or have had one in the past'],
          decline: ['I do not want to answer'],
        },
      },
      {
        key: 'selfid.ethnicity',
        // NOT a stable id: the race question appears under different ids per
        // board, and EQT 09-17 rendered TWO race questions with DIFFERENT
        // vocabularies — a "U.S. Standard Demographic" block offering only
        // regional sub-categories (no plain "Asian") and a "Voluntary
        // Self-Identification" block that did offer "Asian". Bound by label so
        // both are found, with both vocabularies supplied.
        label: /race|ethnic/i, control: 'combobox', required: false,
        selectorConfidence: 'observed-from-run',
        optionText: {
          asian: ['Asian', 'Asian (Not Hispanic or Latino)', 'East Asian'],
          white: ['White', 'White (Not Hispanic or Latino)'],
          black: ['Black or African American'],
          'hispanic-latino': ['Hispanic or Latino'],
          decline: ["I don't wish to answer", 'Decline To Self Identify'],
        },
      },

      // ---- common custom questions, bound by LABEL (finding 2) ------------
      {
        key: 'links.linkedin',
        label: /linked\s*in\s*profile/i, control: 'text', required: false,
        selectorConfidence: 'verified-shadow',
      },
      {
        key: 'auth.workAuthorized',
        // Verbatim, Nanopath: "Are you legally authorized to work in the United
        // States? *"
        label: /legally authorized to work/i, control: 'combobox', required: true,
        selectorConfidence: 'verified-shadow',
        optionText: { 'authorized-no-sponsorship': ['Yes'], 'us-citizen': ['Yes'] },
      },
      {
        key: 'auth.sponsorship',
        // Verbatim, Nanopath: "Do you now or in the future require visa
        // sponsorship to continue working in the United States? *"
        label: /require (?:visa )?sponsorship/i, control: 'combobox', required: true,
        selectorConfidence: 'verified-shadow',
        optionText: { 'none-now-or-future': ['No'], now: ['Yes'], 'future-only': ['Yes'] },
      },
      {
        key: 'education.gpa',
        // Verbatim, Relay ×2: "What is your current cumulative GPA? (Note: A
        // minimum GPA of 3.5 is required for consideration on a 4.0 scale)".
        // The profile's 3.36 is written as-is — the never-round-up rule is a
        // profile constraint, and a posting's stated minimum is never a reason
        // to report a different number.
        label: /gpa|grade point/i, control: 'text', required: false,
        selectorConfidence: 'observed-from-run',
      },
    ];
  },

  // ------------------------------------------------------------ lifecycle --
  /** No gate. Greenhouse's form is public and fully rendered on load. */
  async passGate() { return { kind: 'none' }; },

  async identifyStep(ctx) {
    const root = ctx.frame;
    const url = ctx.url?.href ?? '';
    if (/\/confirmation|\/thank-you/i.test(url)) return 'confirmation';
    const body = await root.locator('body').first().innerText().catch(() => '');
    if (/thank you for applying|your application has been received/i.test(body)) return 'confirmation';
    if (/verification code|we sent a code/i.test(body)) return 'verify-code';
    if (await root.locator('#first_name').count()) return 'apply-form';
    if (/apply for this job/i.test(body)) return 'posting';
    return null;
  },

  async advance(ctx, from) {
    const root = ctx.frame;
    if (from === 'posting') {
      // The apply form is on the same page, behind an "Apply" button that only
      // scrolls/expands. Clicking it mutates nothing.
      const apply = root.locator('button:has-text("Apply")').first();
      if (await apply.count()) await apply.click();
      return { to: 'apply-form' };
    }
    if (from === 'apply-form' || from === 'submit') {
      const btn = root.locator('button:has-text("Submit application")').first();
      if (await btn.isDisabled().catch(() => false)) {
        return { to: from, blockedBy: [{ message: 'submit control is disabled' }] };
      }
      await btn.click();
      await ctx.page.waitForLoadState('domcontentloaded').catch(() => {});
      return { to: null };
    }
    return { to: null };
  },

  async upload(ctx, target, file) {
    const root = ctx.frame;
    // NAMED target (F6), and the direct input every time (F19).
    const byName = {
      resume: '#resume',
      'cover-letter': '#cover_letter',
      transcript: 'input[type=file][id*="transcript" i], input[type=file][id^="question_"]',
    };
    await root.locator(byName[target.name] ?? 'input[type=file]').first().setInputFiles(file.path);
  },

  async verifyUpload(ctx, target, file) {
    const root = ctx.frame;
    const wanted = file.path.split('/').pop();
    // F7 in its original form: Greenhouse REPLACES the file input with a chip
    // once an artifact is attached, so the input's own file list cannot be
    // trusted as the primary evidence. Observed 09-17 (Nanopath): the chip
    // renders as the filename plus an ✕ — there is no "Remove file" text on the
    // current UI, which is why the text match is on the FILENAME and the
    // remove-control check is a fallback.
    const body = await root.locator('body').first().innerText().catch(() => '');
    const shown = body.includes(wanted);
    const hasRemove = (await root.locator(
      `[aria-label*="Remove" i], button:has-text("Remove")`,
    ).count()) > 0;
    return {
      observedName: shown ? wanted : null,
      observedBytes: null,
      attached: shown || hasRemove,
      how: shown ? 'filename-in-dom' : hasRemove ? 'remove-button' : 'other',
    };
  },

  /** No summary page: the form is the review, so the diff reads the live
   *  control values — the bytes that will actually be posted. */
  async readReview(ctx) {
    const root = ctx.frame;
    return root.locator('input, select, textarea').evaluateAll((els) => {
      const out = {};
      for (const el of els) {
        if (el.type === 'hidden' || el.type === 'file') continue;
        // Skip react-select's hidden required proxy: it has no label and no
        // value, and including it would report a blank for every combobox.
        if (/requiredInput/.test(el.className || '')) continue;
        const lab = (el.id && el.ownerDocument.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.innerText)
          || el.closest('label')?.innerText
          || el.getAttribute('aria-label');
        if (!lab) continue;
        const key = String(lab).replace(/\s+/g, ' ').trim().slice(0, 80);
        if (el.type === 'checkbox' || el.type === 'radio') {
          if (el.checked) out[key] = 'checked';
        } else if (el.tagName === 'SELECT') {
          out[key] = el.options[el.selectedIndex]?.text ?? '';
        } else if (el.value) {
          out[key] = el.value;
        }
      }
      return out;
    });
  },

  async readConfirmation(ctx) {
    const root = ctx.frame;
    const text = await root.locator('body').first().innerText().catch(() => '');
    // Verbatim from the 09-16/09-17 confirmations: "Thank you for applying.
    // Your application has been received." (Brevium), "Thank you for applying."
    // (NISC, Hometap). Employer-embedded boards land on their own page instead
    // (careers.duolingo.com/thank-you).
    const ok = /thank you for applying|your application has been received/i.test(text)
      || /\/confirmation|\/thank-you/i.test(ctx.url?.href ?? '');
    const { extractApplicationId } = await import('../engine/submit.js');
    return {
      applicationId: extractApplicationId(text),
      text: text.slice(0, 400),
      url: ctx.url?.href ?? '',
      confirmed: ok,
    };
  },
};

export default greenhouse;
