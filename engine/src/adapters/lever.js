// Lever adapter — Phase 3. Selectors from REAL reconnaissance, not guesses.
//
// Evidence base and confidence labels, same discipline as the iCIMS adapter:
//
//   verified-shadow    — read off a live Lever tenant during navigation-only
//                        recon on 2026-09-17 (jobs.lever.co/kitware, the same
//                        posting the 09-17 incident happened on). The selector
//                        was observed in the live DOM of the /apply page.
//   observed-from-run  — from the 2026-09-17 ledger, STAGED.md and the
//                        screenshots. Wording is verbatim; the selector is
//                        inferred and must be confirmed at Gate 1.
//
// Recon was strictly read-only: the /apply page was loaded and inspected, and
// nothing was typed, clicked, checked or uploaded. Lever's apply form is
// PUBLIC — there is no account gate — so unlike iCIMS every field on the whole
// application was directly observable, which is why almost everything here is
// verified-shadow.
//
// ---------------------------------------------------------------------------
// THE TWO FINDINGS THAT SHAPE THIS ADAPTER
// ---------------------------------------------------------------------------
//
// 1. CUSTOM QUESTIONS ARE UUID-KEYED, SO THEY CANNOT BE BOUND BY SELECTOR.
//    Live DOM:
//        input[name="cards[15be68ed-0850-4c64-a0b0-f3ed4952310e][field1]"]
//        textarea[name="cards[3f502e7b-7e95-4850-b63a-0e1d5b418297][field0]"]
//    The uuid is per POSTING, not per tenant, so a selector binding would be
//    write-once-use-never. Every custom question is therefore bound by LABEL,
//    and the engine's generic label discovery does the work. This is also why
//    Lever's per-application field count varies so much: the Kitware posting
//    carries 4 free-text essays and 7 radio groups inside cards.
//
// 2. THE INVISIBLE hCAPTCHA OVER SUBMIT IS REAL, AND IT IS FULL-VIEWPORT.
//    Recon found TWO hCaptcha enclave iframes on the /apply page, each
//    1350×900 — the whole viewport — titled "Widget containing checkbox for
//    hCaptcha security challenge", plus `#frame=checkbox-invisible` and
//    `#frame=challenge` frames and a hidden `#hcaptchaResponseInput`.
//
//    On 2026-09-17 this exact widget, on this exact tenant, was rendered at
//    invisible size and a click aimed at it went THROUGH to SUBMIT APPLICATION
//    and filed the application with nobody having reviewed the essays. Earlier
//    the same day the same widget rendered as a visible full-size image
//    challenge ("Select all objects that can roll on a flat surface"). So its
//    rendered size is not a property of the tenant and cannot be assumed.
//
//    The engine's answer is a hit test immediately before the click
//    (engine/overlay.js): `document.elementFromPoint` at the centre of
//    `#btn-submit`. `isVisible()` would have missed this — the overlay is
//    full-viewport and the button underneath looks perfectly clickable. This
//    adapter's job is only to DECLARE the selectors that test needs.

/** @type {import('../schema/types.js').AtsAdapter} */
const lever = {
  id: 'lever',
  apiVersion: 1,

  match: {
    hostnames: [/^jobs\.lever\.co$/i, /\.lever\.co$/i],
    pathHints: [/\/[0-9a-f-]{36}\/apply/i],
  },

  // jobs.lever.co/<tenant>/<posting-uuid>/apply — the tenant is the first path
  // segment, never the hostname, which is shared by every Lever customer.
  tenantOf(url) {
    const seg = url.pathname.split('/').filter(Boolean)[0] ?? url.hostname;
    return `lever:${seg.toLowerCase()}`;
  },

  // Lever's apply form is public: no account, no sign-in, nothing to create.
  // So this adapter gets no `secrets.forTenant` on its context at all (Q1).
  accountCreation: false,

  // ---------------------------------------------------------------- flow ---
  // ONE page. There is no wizard, no step graph to speak of, and the review
  // "step" is the same DOM as the form — which is why the review diff here is
  // a read-back of the live form rather than a scrape of a summary page.
  steps: [
    {
      id: 'posting',
      title: 'Job posting page',
      selectorConfidence: 'verified-shadow',
      markers: [{ urlPattern: /jobs\.lever\.co\/[^/]+\/[0-9a-f-]{36}$/i }],
      expects: [],
    },
    {
      id: 'apply-form',
      title: 'Application form (single page)',
      selectorConfidence: 'verified-shadow',
      markers: [
        { urlPattern: /\/apply(\?|$)/i },
        { selector: '#btn-submit' },
        { selector: 'input[name="name"]' },
      ],
      expects: [
        'identity.fullName', 'contact.email', 'contact.phone',
        'loc.currentLocation', 'upload.resume',
        'selfid.gender', 'selfid.ethnicity', 'selfid.veteran', 'selfid.disability',
      ],
      // The review page and the form are the same page.
      isReview: true,
    },
    {
      id: 'submit',
      title: 'SUBMIT APPLICATION',
      selectorConfidence: 'verified-shadow',
      markers: [{ selector: '#btn-submit' }],
      expects: [],
      isSubmit: true,
    },
    {
      id: 'confirmation',
      title: '"Application submitted!"',
      selectorConfidence: 'observed-from-run',
      // Verbatim from the 09-17 confirmation screenshot: "Application
      // submitted!" over a "RETURN TO THE MAIN PAGE" button.
      markers: [{ text: /application submitted!?/i }, { urlPattern: /\/thanks/i }],
      expects: [],
    },
  ],

  // -------------------------------------------------------------- quirks ---
  quirks: {
    // Lever has no date controls of its own. The ONLY date is the disability
    // self-ID signature date, a single free-text box (observed live:
    // input[name="eeo[disabilitySignatureDate]"]), so a single text format is
    // right and there is no picker anywhere to forbid — but the flag stays
    // true, because "this ATS has no picker today" is not a licence to open one
    // if a tenant grows a widget.
    dateStrategy: 'mm/dd/yyyy-text',
    typeaheadNeedsEnter: true,     // #location-input is a typeahead (see below)
    forbidDatePicker: true,

    // Q4: 1, the default for every ATS. There is no observed tenant idempotency
    // to cite for Lever, and the 09-17 incident is a standing reminder that on
    // this ATS an unintended single submission is already possible.
    maxSubmitAttempts: 1,

    /** F21. The engine's pre-click hit test reads these. */
    submitControl: {
      // VERIFIED live: id="btn-submit", text "SUBMIT APPLICATION", not
      // disabled even with the form empty — Lever validates server-side, so a
      // clickable-looking button is NOT evidence the form is complete.
      selector: '#btn-submit',
      // VERIFIED live: two full-viewport (1350×900) enclave iframes plus the
      // invisible-checkbox and challenge frames.
      captchaWrappers: [
        'iframe[title*="hCaptcha" i]',
        'iframe[src*="hcaptcha.html#frame=challenge"]',
        'iframe[src*="hcaptcha.html#frame=checkbox-invisible"]',
        'iframe[src*="hcaptcha-enclave.html"]',
      ],
      // VERIFIED live: the hidden input Lever posts the token in. Empty token +
      // present widget = the challenge has not been answered.
      captchaResponse: '#hcaptchaResponseInput',
    },

    wallMarkers: [
      // Presence is NOT the signal — the enclave iframes are on every Lever
      // apply page whether or not a challenge ever fires, exactly as on iCIMS.
      // The discriminator is the CHALLENGE frame being visible…
      { wallClass: 'hcaptcha', selector: 'iframe[src*="hcaptcha.html#frame=challenge"]', requireVisible: true },
      { wallClass: 'hcaptcha', selector: 'iframe[title="hCaptcha challenge"]', requireVisible: true },
      { wallClass: 'http-403', status: 403 },
      { wallClass: 'http-429', status: 429 },
    ],

    /** Always present, never a wall. Named so the engine can assert the
     *  distinction rather than rediscover it. */
    dormantCaptchaMarkers: [
      '#hcaptchaResponseInput',
      'iframe[src*="hcaptcha-enclave.html"]',
      'iframe[src*="#frame=checkbox-invisible"]',
    ],

    /** Controls the engine must ignore. Lever renders ELEVEN pronoun
     *  checkboxes (He/him, She/her, They/them, Xe/xem, Ze/hir, Ey/em, Hir/hir,
     *  Fae/faer, Hu/hu, "Use name only", "Custom") all sharing
     *  name="pronouns". None is required, none maps to a FieldKey, and the
     *  profile records pronouns as a single string — so the honest behaviour is
     *  to leave every one of them alone rather than to guess which box means
     *  what. They are declared here so they are skipped deliberately, not
     *  reported as eleven unmapped fields. */
    noiseSelectors: [
      'input[name="pronouns"]',
      '#customPronounsTextField',
      'input[type=hidden]',
    ],
  },

  // ------------------------------------------------------------- frames ----
  async formRoot() {
    // TOP LEVEL. Verified live: the entire form is in the main frame. The only
    // iframes on the page belong to hCaptcha.
    return { frames: [] };
  },

  // ----------------------------------------------------------- bindings ----
  bindings(step) {
    if (step !== 'apply-form' && step !== 'submit') return [];
    return [
      // ---- core block: all VERIFIED on the live Kitware /apply page --------
      {
        key: 'identity.fullName',
        // Lever asks for ONE full-name field, not first/last. The profile's
        // fullName is the only honest source; splitting or joining names is how
        // a middle name ends up as a surname.
        selector: 'input[name="name"]',
        control: 'text', required: true, selectorConfidence: 'verified-shadow',
      },
      {
        key: 'contact.email',
        selector: 'input[name="email"]',
        control: 'text', required: true, selectorConfidence: 'verified-shadow',
      },
      {
        key: 'contact.phone',
        selector: 'input[name="phone"]',
        control: 'text', required: true, selectorConfidence: 'verified-shadow',
      },
      {
        key: 'loc.currentLocation',
        // A typeahead: #location-input is what the human types into, and
        // #selected-location is the HIDDEN field Lever actually submits. Filling
        // the visible box without committing a suggestion leaves the hidden one
        // empty, which is the classic "the form looked filled" failure — so the
        // engine must press Enter (typeaheadNeedsEnter) and the read-back must
        // check the hidden field.
        selector: '#location-input',
        control: 'combobox', required: false, selectorConfidence: 'verified-shadow',
        commitsTo: '#selected-location',
      },
      {
        key: 'work.employer',
        // "Current company". Left OPTIONAL deliberately: Rippling's résumé
        // parser inventing a "current company" is a recorded failure (F15), and
        // a student with no current employer must not have one supplied here.
        selector: 'input[name="org"]',
        control: 'text', required: false, selectorConfidence: 'verified-shadow',
      },
      {
        key: 'upload.resume',
        // VERIFIED: id="resume-upload-input", name="resume", label
        // "Resume/CV ✱ ATTACH RESUME/CV". A NAMED target (F6) — the file input
        // is addressed directly and the ATTACH button is never clicked.
        selector: '#resume-upload-input',
        control: 'file', required: true, selectorConfidence: 'verified-shadow',
      },

      // ---- EEO block: all VERIFIED live -----------------------------------
      {
        key: 'selfid.gender',
        selector: 'select[name="eeo[gender]"]',
        control: 'select', required: false, selectorConfidence: 'verified-shadow',
        // Verbatim options: "Select ...", "Male", "Female", "Decline to self-identify".
        optionText: { male: ['Male'], female: ['Female'], decline: ['Decline to self-identify'] },
      },
      {
        key: 'selfid.ethnicity',
        // Radios, not a select. Verbatim option text includes the long CFR
        // definitions, so the candidate wording must be the LEADING phrase and
        // the engine's word-boundary tier does the rest.
        selector: 'input[name="eeo[race]"]',
        control: 'radio', required: false, selectorConfidence: 'verified-shadow',
        optionText: {
          asian: ['Asian (Not Hispanic or Latino)'],
          white: ['White (Not Hispanic or Latino)'],
          black: ['Black or African American (Not Hispanic or Latino)'],
          'hispanic-latino': ['Hispanic or Latino'],
          'two-or-more': ['Two or More Races (Not Hispanic or Latino)'],
          'native-american': ['American Indian or Alaska Native (Not Hispanic or Latino)'],
          'pacific-islander': ['Native Hawaiian or Other Pacific Islander (Not Hispanic or Latino)'],
          decline: ['Decline to self-identify'],
        },
      },
      {
        key: 'selfid.veteran',
        selector: 'select[name="eeo[veteran]"]',
        control: 'select', required: false, selectorConfidence: 'verified-shadow',
        optionText: {
          'not-a-protected-veteran': ['I am not a protected veteran'],
          'protected-veteran': ['I identify as one or more of the classifications of protected veteran listed above'],
          decline: ['I decline to self-identify for protected veteran status'],
        },
      },
      {
        key: 'selfid.disability',
        selector: '#disabilitySelectElement',
        control: 'select', required: false, selectorConfidence: 'verified-shadow',
        optionText: {
          no: ['No, I do not have a disability and have not had one in the past'],
          yes: ['Yes, I have a disability, or have had one in the past'],
          decline: ['I do not want to answer'],
        },
      },
      {
        key: 'selfid.signature',
        // Observed live but rendered hidden until a disability answer is
        // chosen — which is why the engine must re-discover after selecting
        // disability status rather than binding once at page load.
        selector: 'input[name="eeo[disabilitySignature]"]',
        control: 'text', required: false, selectorConfidence: 'verified-shadow',
        revealedBy: '#disabilitySelectElement',
      },
      {
        key: 'selfid.date',
        selector: 'input[name="eeo[disabilitySignatureDate]"]',
        control: 'text', required: false, selectorConfidence: 'verified-shadow',
        revealedBy: '#disabilitySelectElement',
      },

      // ---- location select, when the posting has several ------------------
      {
        key: 'loc.arrangement',
        // Observed live on Kitware: a location CHOICE, not an arrangement —
        // "Clifton Park, New York" / "Carrboro, North Carolina". There is no
        // canonical FieldKey for "which office", and guessing between two real
        // offices is exactly the kind of invention the bank forbids, so this is
        // declared only so the control is RECOGNIZED, and left unmapped: the
        // engine will skip it and, being non-required, will not park.
        selector: 'select[name="opportunityLocationId"]',
        control: 'select', required: false, selectorConfidence: 'verified-shadow',
        unmappable: 'a choice between real offices — no canonical value exists',
      },
    ];
  },

  // ------------------------------------------------------------ lifecycle --
  /** No gate: Lever's apply form is public. Reported as `none` rather than
   *  `passed`, because there was nothing to pass. */
  async passGate() { return { kind: 'none' }; },

  async identifyStep(ctx) {
    const root = ctx.frame;
    const url = ctx.url?.href ?? '';
    if (await root.locator('#btn-submit').count()) return 'apply-form';
    const body = await root.locator('body').first().innerText().catch(() => '');
    if (/application submitted!?/i.test(body) || /\/thanks/i.test(url)) return 'confirmation';
    if (/jobs\.lever\.co\/[^/]+\/[0-9a-f-]{36}$/i.test(url)) return 'posting';
    return null;
  },

  async advance(ctx, from) {
    const root = ctx.frame;
    if (from === 'posting') {
      // Navigate, never click: the posting page's "Apply for this job" is a
      // plain link to the same URL + /apply, and a goto cannot be intercepted
      // by an overlay.
      const target = new URL(ctx.url.href.replace(/\/+$/, '') + '/apply');
      await ctx.page.goto(target.href, { waitUntil: 'domcontentloaded' });
      return { to: 'apply-form' };
    }
    if (from === 'submit' || from === 'apply-form') {
      // The engine has already run the review gate AND the click-target hit
      // test (engine/submit.js) before this line can be reached. The adapter
      // only performs the click it was told the selector for.
      await root.locator('#btn-submit').click();
      await ctx.page.waitForLoadState('domcontentloaded').catch(() => {});
      return { to: null };
    }
    return { to: null };
  },

  async upload(ctx, target, file) {
    const root = ctx.frame;
    // NAMED target (F6). Lever's own ATTACH button opens a native picker that
    // automation cannot drive, so the file input is always addressed directly —
    // which is also what the 09-17 record says finally worked by hand on the
    // five forms where the fill script's upload silently failed (F19).
    const byName = {
      resume: '#resume-upload-input',
      // Additional documents ride in a card, so they are uuid-keyed and can
      // only be found by position among the card file inputs.
      transcript: 'input[type=file][name^="cards"]',
      'cover-letter': 'input[type=file][name^="cards"]',
    };
    await root.locator(byName[target.name] ?? 'input[type=file]').first().setInputFiles(file.path);
  },

  async verifyUpload(ctx, target, file) {
    const root = ctx.frame;
    const wanted = file.path.split('/').pop();
    // Lever renders the filename next to the input once attached, and keeps the
    // input's own file list — but the list is checked SECOND, because
    // Greenhouse's habit of replacing the input entirely (F7) is exactly why
    // this is an adapter method and not engine logic.
    const body = await root.locator('body').first().innerText().catch(() => '');
    const shown = body.includes(wanted);
    let inList = false;
    try {
      inList = await root.locator('#resume-upload-input')
        .evaluate((el, name) => [...(el.files ?? [])].some((f) => f.name === name), wanted);
    } catch { /* input may have been replaced */ }
    return {
      observedName: shown || inList ? wanted : null,
      observedBytes: null,
      attached: shown || inList,
      how: shown ? 'filename-in-dom' : inList ? 'input-files' : 'other',
    };
  },

  /** Lever has no separate review page: the form IS the review. So the diff
   *  reads the live control values back, which is strictly better evidence
   *  than a rendered summary — it is the bytes that will be posted. */
  async readReview(ctx) {
    const root = ctx.frame;
    return root.locator('input, select, textarea').evaluateAll((els) => {
      const out = {};
      for (const el of els) {
        if (el.type === 'hidden' || el.type === 'file') continue;
        const id = el.id ? `label[for="${CSS.escape(el.id)}"]` : null;
        const lab = (id && el.ownerDocument.querySelector(id)?.innerText)
          || el.closest('label')?.innerText
          || el.getAttribute('aria-label')
          || el.name;
        if (!lab) continue;
        const key = String(lab).replace(/\s+/g, ' ').trim().slice(0, 80);
        if (el.type === 'checkbox' || el.type === 'radio') {
          if (el.checked) out[key] = (el.closest('label')?.innerText ?? 'checked').replace(/\s+/g, ' ').trim();
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
    // Verbatim from the 2026-09-17 Kitware confirmation screenshot.
    const ok = /application submitted!?/i.test(text);
    const { extractApplicationId } = await import('../engine/submit.js');
    return {
      // Lever shows no application id on the thank-you page — the receipt email
      // is the only identifier. Reporting null is correct; scraping a
      // plausible-looking number off the page is how a fake id gets recorded.
      applicationId: extractApplicationId(text),
      text: text.slice(0, 400),
      url: ctx.url?.href ?? '',
      confirmed: ok,
    };
  },
};

export default lever;
