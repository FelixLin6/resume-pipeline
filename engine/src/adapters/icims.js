// WIP — Phase 1 scaffold. iCIMS adapter STUB.
// Design: engine/design/interfaces.md §2.
//
// Flow steps below are enumerated from OBSERVED behaviour on this stack
// (2026-09-09 .. 2026-09-17 ledgers), not from iCIMS documentation. Selectors
// are TODO: they get filled in during Gate 1 (shadow runs against
// already-submitted postings), never guessed here.
//
// Why iCIMS is the first adapter: it is the worst measured cost on the
// current stack (~470 agent-browser calls for the Cole Engineering fill
// alone) and the largest single source of walls (8 postings across 6 tenants
// on one day).

/** @type {import('../schema/types.js').AtsAdapter} */
const icims = {
  id: 'icims',
  apiVersion: 1,

  match: {
    hostnames: [/\.icims\.com$/i],
    // Employer-owned careers domains often CNAME onto the same iCIMS edge and
    // carry ?icims=1. NOTE: because it is the same edge, a 403 on one is a
    // 403 on the other (JHU APL, droplet 2026-09-11) — the adapter must not
    // treat the employer domain as an alternate route.
    pathHints: [/[?&]icims=1/i, /\/jobs\/\d+\//],
  },

  tenantOf(url) {
    return `icims:${url.hostname.toLowerCase()}`;
  },

  // ---- Page flow, as observed ----
  steps: [
    {
      id: 'posting',
      title: 'Job posting page',
      markers: [{ urlPattern: /\/jobs\/\d+\/[^/]+\/job/i }],
      expects: [],
    },
    {
      id: 'guest-apply',
      title: 'Enter Your Information (email + consent)',
      // Reached via /jobs/<id>/login with a fat query string:
      // ?utm_source=Simplify&mobile=false&width=1350&height=500&bga=true
      // &needsRedirect=false&jan1offset=-480&jun1offset=-420
      markers: [{ urlPattern: /\/jobs\/\d+\/login/i }],
      expects: ['contact.email'],
      // "Next" stays DISABLED until the privacy/data-retention consent box is
      // checked — a disabled Next here is not an error, it is an unchecked box.
    },
    {
      id: 'captcha-gate',
      title: 'hCaptcha gate (fires on submit of guest-apply)',
      markers: [{ selector: 'iframe[src*="hcaptcha"]' }],
      expects: [],
      optional: true,
      // CRITICAL: this fires BEFORE the form loads, so nothing is filled
      // behind it — an assist slot spent here buys zero fields.
      // Observed 2026-09-17: 3 of 4 gates did NOT re-fire on a second visit.
      // It is session/reputation-dependent, not a tenant setting. Hence the
      // one-fresh-context-retry policy (architecture.md §8a).
    },
    {
      id: 'candidate-profile',
      title: 'Candidate Profile (step 1 of N; N observed 3-5)',
      markers: [{ text: /candidate profile|submit profile/i }],
      expects: [
        'upload.resume',
        'contact.email', 'contact.phone',
        'contact.address.line1', 'contact.address.city',
        'contact.address.state', 'contact.address.postalCode',
        'education.school', 'education.degreeLevel', 'education.startDate',
        'auth.workAuthorized', 'source.howDidYouHear',
      ],
      // OBSERVED, load-bearing: the resume upload triggers an auto-parse that
      // fills work experience + education AND OVERWRITES the login email with
      // the forbidden CMU address (Cole, SimVentions, Cotiviti). The engine's
      // post-upload re-verify barrier (interfaces.md §5.5) is what catches it.
    },
    {
      id: 'submit-profile',
      title: 'Submit Profile -> step 2',
      markers: [{ text: /submit profile/i }],
      expects: [],
      // A SECOND hCaptcha image challenge can fire HERE, after the profile is
      // already filled (SimVentions, Cotiviti, 2026-09-16).
    },
    {
      id: 'application-form',
      title: 'Standard employment application',
      markers: [{ text: /employment application/i }],
      expects: [],
      // The resume does NOT carry over from Basic Information and must be
      // re-uploaded (Cole, 2026-09-17).
    },
    { id: 'education-history',  title: 'Education',                markers: [{ text: /education/i }],        expects: [] },
    { id: 'employment-history', title: 'Employment history (3 entries observed)', markers: [{ text: /employment history/i }], expects: [] },
    { id: 'eeo',                title: 'EEO',                      markers: [{ text: /equal employment/i }], expects: ['selfid.gender', 'selfid.ethnicity'] },
    { id: 'veteran-self-id',    title: 'VEVRAA veteran self-ID',   markers: [{ text: /veteran/i }],          expects: ['selfid.veteran'] },
    { id: 'disability-self-id', title: 'OFCCP disability self-ID', markers: [{ text: /disability/i }],       expects: ['selfid.disability', 'selfid.signature'] },
    { id: 'review',             title: 'Review',  markers: [{ text: /review/i }],  expects: [], isReview: true },
    { id: 'submit',             title: 'Submit',  markers: [{ text: /submit application/i }], expects: [], isSubmit: true },
  ],

  quirks: {
    dateStrategy: 'mm/dd/yyyy-text',   // TODO confirm during Gate 1
    typeaheadNeedsEnter: true,
    forbidDatePicker: true,
    maxSubmitAttempts: 1,              // see interfaces.md Q4
    wallMarkers: [
      { wallClass: 'hcaptcha', selector: 'iframe[src*="hcaptcha"]' },
      { wallClass: 'http-403', status: 403 },
      { wallClass: 'account-required', text: /wrong username or password/i },
    ],
  },

  async formRoot(/* ctx, step */) {
    // OBSERVED: the form lives in a NESTED iframe wrapper. A cross-origin
    // in-page navigation mid-fill breaks out of it, which on the current
    // stack desynced snapshot/click coordinates and forced raw-coordinate
    // mouse recovery for every radio and checkbox (Cole, 2026-09-17).
    // frameLocator re-resolves on every use, so the desync class does not
    // exist here — this is ~90 of the ~470 calls, gone.
    return { frames: ['iframe#icims_content_iframe', 'iframe[name="icims_iframe"]'] };
    // TODO(Gate 1): confirm the exact chain per tenant; some render one frame.
  },

  bindings(/* step */) {
    return [];   // TODO(Gate 1): fill from shadow runs, never guessed.
  },

  async identifyStep() { throw new Error('WIP: not implemented in Phase 1'); },
  async advance()      { throw new Error('WIP: not implemented in Phase 1'); },
  async passGate()     { throw new Error('WIP: not implemented in Phase 1'); },
  async upload()       { throw new Error('WIP: not implemented in Phase 1'); },
  async verifyUpload() { throw new Error('WIP: not implemented in Phase 1'); },
  async readConfirmation() { throw new Error('WIP: not implemented in Phase 1'); },
};

export default icims;
