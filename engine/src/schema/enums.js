// Canonical enums — the closed vocabulary the engine can put into a form.
// Design: interfaces.md §3.1.
//
// The inversion this file exists for: on the current stack the QUESTION TEXT
// drove the answer (ats-fill.js hard-codes question regexes against profile
// booleans), which is how `"male"` came to match `"Female"` by bare substring
// on 2026-09-07. Here the canonical answer is a typed enum and the ADAPTER
// maps it to this tenant's option text — the engine never matches a canonical
// string against rendered option text directly.

export const YES_NO = Object.freeze(['yes', 'no']);

export const WORK_AUTHORIZATION = Object.freeze([
  'us-citizen', 'permanent-resident', 'authorized-no-sponsorship',
  'authorized-needs-sponsorship', 'not-authorized',
]);

export const SPONSORSHIP_NEED = Object.freeze(['none-now-or-future', 'future-only', 'now']);

export const CLEARANCE_LEVEL = Object.freeze([
  'none', 'eligible-not-held', 'confidential', 'secret', 'top-secret', 'ts-sci',
]);

export const DEGREE_LEVEL = Object.freeze([
  'high-school', 'associate', 'bachelors', 'masters', 'phd', 'other',
]);

export const EMPLOYMENT_TYPE = Object.freeze(['internship', 'co-op', 'full-time', 'part-time']);
export const WORK_ARRANGEMENT = Object.freeze(['onsite', 'hybrid', 'remote']);

export const GENDER = Object.freeze(['male', 'female', 'non-binary', 'decline']);
export const VETERAN_STATUS = Object.freeze(['not-a-protected-veteran', 'protected-veteran', 'decline']);
export const DISABILITY_STATUS = Object.freeze(['no', 'yes', 'decline']);
export const ETHNICITY = Object.freeze([
  'asian', 'white', 'black', 'hispanic-latino', 'native-american',
  'pacific-islander', 'two-or-more', 'decline',
]);

/** Which enum governs which FieldKey. An enum-typed field whose value is not
 *  in its enum is a load-time error in the bank, not a runtime surprise. */
export const ENUM_FOR_KEY = Object.freeze({
  'auth.workAuthorized': WORK_AUTHORIZATION,
  'auth.sponsorship': SPONSORSHIP_NEED,
  'auth.clearance': CLEARANCE_LEVEL,
  'auth.over18': YES_NO,
  'auth.itarEligible': YES_NO,
  'auth.previouslyEmployed': YES_NO,
  'auth.driversLicense': YES_NO,
  'education.degreeLevel': DEGREE_LEVEL,
  'education.currentlyEnrolled': YES_NO,
  'education.graduated': YES_NO,
  'avail.employmentType': EMPLOYMENT_TYPE,
  'loc.relocation': YES_NO,
  'loc.arrangement': WORK_ARRANGEMENT,
  'selfid.gender': GENDER,
  'selfid.ethnicity': ETHNICITY,
  'selfid.hispanic': YES_NO,
  'selfid.veteran': VETERAN_STATUS,
  'selfid.disability': DISABILITY_STATUS,
  'consent.backgroundCheck': YES_NO,
  'consent.dataRetention': YES_NO,
  'consent.smsRecruiting': YES_NO,
  'consent.marketing': YES_NO,
  'consent.terms': YES_NO,
  'misc.willingToTravel': YES_NO,
  'misc.hasNonCompete': YES_NO,
  'misc.relatedToEmployee': YES_NO,
});

/** Default rendered wording for a canonical value, used ONLY when an adapter
 *  supplies no tenant vocabulary. Deliberately conservative: if none of these
 *  match the rendered options, the field is skipped, never approximated. */
export const DEFAULT_OPTION_TEXT = Object.freeze({
  yes: ['Yes'],
  no: ['No'],
  'us-citizen': ['U.S. Citizen', 'US Citizen', 'United States Citizen', 'Citizen'],
  'permanent-resident': ['Permanent Resident', 'Green Card Holder'],
  'authorized-no-sponsorship': ['Yes', 'Authorized to work'],
  'none-now-or-future': ['No', 'No, I do not require sponsorship'],
  'future-only': ['Yes, in the future'],
  now: ['Yes'],
  none: ['None'],
  'eligible-not-held': ['Eligible', 'None'],
  bachelors: ["Bachelor's Degree", "Bachelor's", 'Bachelors', 'BS', 'B.S.'],
  masters: ["Master's Degree", "Master's", 'Masters'],
  phd: ['PhD', 'Doctorate', 'Ph.D.'],
  'high-school': ['High School', 'High School Diploma'],
  associate: ["Associate's Degree", 'Associates'],
  internship: ['Internship', 'Intern'],
  'co-op': ['Co-op', 'Cooperative Education', 'Co-Op'],
  'full-time': ['Full-Time', 'Full Time'],
  'part-time': ['Part-Time', 'Part Time'],
  onsite: ['On-site', 'Onsite', 'On Site'],
  hybrid: ['Hybrid'],
  remote: ['Remote'],
  male: ['Male'],
  female: ['Female'],
  'non-binary': ['Non-Binary', 'Nonbinary'],
  decline: ['Decline to self-identify', 'I do not wish to answer', 'Prefer not to say'],
  asian: ['Asian', 'Asian (Not Hispanic or Latino)'],
  white: ['White'],
  black: ['Black or African American'],
  'hispanic-latino': ['Hispanic or Latino'],
  'not-a-protected-veteran': [
    'I am not a protected veteran',
    'I AM NOT a protected veteran',
    'I am NOT a protected veteran',
    'Not a Veteran',
  ],
  'protected-veteran': ['I identify as one or more of the classifications of a protected veteran'],
});
