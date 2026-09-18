// The closed FieldKey set — shared by profile, answer bank, adapter bindings,
// and events. Design: interfaces.md §3.4.
//
// Adapters bind to FieldKeys, never to page labels. An adapter that needs a
// key not on this list must ADD IT HERE FIRST — the same discipline as the
// pinned ledger label set, and for the same reason: on 2026-09-05 an unknown
// header label made a row silently vanish from the retry census.

export const FIELD_KEYS = Object.freeze([
  'identity.firstName', 'identity.lastName', 'identity.fullName',
  'identity.preferredName', 'identity.middleName',

  'contact.email', 'contact.phone',
  'contact.address.line1', 'contact.address.line2', 'contact.address.city',
  'contact.address.state', 'contact.address.postalCode', 'contact.address.country',

  'links.linkedin', 'links.github', 'links.website',

  'education.school', 'education.degreeLevel', 'education.degreeText',
  'education.fieldOfStudy', 'education.startDate', 'education.endDate',
  'education.gpa', 'education.currentlyEnrolled', 'education.graduated',
  'education.classStanding',

  'auth.workAuthorized', 'auth.sponsorship', 'auth.over18', 'auth.clearance',
  'auth.itarEligible', 'auth.previouslyEmployed', 'auth.citizenship',
  'auth.driversLicense',

  'avail.earliestStart', 'avail.term', 'avail.employmentType', 'avail.hoursPerWeek',

  'loc.relocation', 'loc.arrangement', 'loc.currentLocation',

  'selfid.gender', 'selfid.ethnicity', 'selfid.hispanic', 'selfid.veteran',
  'selfid.disability', 'selfid.signature', 'selfid.date',

  'work.title', 'work.employer', 'work.city', 'work.state', 'work.country',
  'work.startDate', 'work.endDate', 'work.isCurrent', 'work.description',
  'work.reasonForLeaving',

  'consent.terms', 'consent.dataRetention', 'consent.backgroundCheck',
  'consent.smsRecruiting', 'consent.marketing',

  'misc.willingToTravel', 'misc.hasNonCompete', 'misc.relatedToEmployee',

  'account.login', 'account.password', 'account.passwordConfirm',

  'upload.resume', 'upload.transcript', 'upload.coverLetter',

  'source.howDidYouHear',
  'comp.expected',
]);

const KEY_SET = new Set(FIELD_KEYS);

/** A `prose.<promptId>` key is legal without being enumerated — the prompt id
 *  comes from the answer bank, which is itself a closed, reviewed file. */
export function isFieldKey(k) {
  return KEY_SET.has(k) || (typeof k === 'string' && /^prose\.[a-z0-9-]+$/i.test(k));
}

export function assertFieldKey(k) {
  if (!isFieldKey(k)) {
    throw new Error(
      `unknown FieldKey: ${k}. Add it to src/schema/fieldkeys.js first — ` +
      `an unenumerated key is how a row silently vanished from the census on 2026-09-05.`
    );
  }
  return k;
}

/** Keys whose VALUES may never appear in the event stream (Q5). */
export const IDENTITY_KEYS = Object.freeze([
  'contact.email', 'contact.phone',
  'contact.address.line1', 'contact.address.line2', 'contact.address.city',
  'contact.address.state', 'contact.address.postalCode', 'contact.address.country',
  'selfid.signature', 'account.login', 'account.password', 'account.passwordConfirm',
]);

export function isIdentityKey(k) { return IDENTITY_KEYS.includes(k); }
export function isProseKey(k) { return typeof k === 'string' && k.startsWith('prose.'); }
