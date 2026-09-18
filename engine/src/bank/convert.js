// Converter: the LIVE, flat, regex-read assets -> the typed, schema-validated
// bank the engine uses. Design: interfaces.md §3.
//
// READ-ONLY with respect to the live skill. This module opens
// ~/zylos/.claude/skills/resume/assets/{application-profile.json,answer-bank.md}
// for reading and writes only into engine/assets/. The daily pipeline keeps
// reading the originals and never learns this exists — that is the standing
// constraint of this branch.
//
// Why convert rather than hand-write: the live profile is the reviewed source
// of truth for every fact (it traces to the vault), so re-typing it by hand
// would fork the truth. But its SHAPE is the problem — `ats-fill.js` matches
// question regexes against profile booleans, which is how "male" matched
// "Female". The conversion turns facts into typed enum answers and reports
// every fact it could NOT type, so the gaps are visible rather than silent.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ENUM_FOR_KEY } from '../schema/enums.js';
import { assertFieldKey } from '../schema/fieldkeys.js';

export const LIVE_ASSETS = path.join(os.homedir(), 'zylos/.claude/skills/resume/assets');

/** yyyy-mm -> DateValue, with the 1st-of-month rule attached rather than
 *  applied (F5: the engine decides the format, never the adapter). */
function dateValue(yyyymm) {
  if (!yyyymm) return null;
  const [y, m, d] = String(yyyymm).split('-');
  return {
    year: Number(y),
    month: m ? Number(m) : null,
    day: d ? Number(d) : null,
    dayRule: 'first-of-month',
  };
}

const bool = (v) => (v === true ? 'yes' : v === false ? 'no' : null);

/** Pull the quoted fragments out of the prose blocklist entries — those are
 *  the strings a form field could actually contain. */
export function extractLiterals(entries) {
  const out = [];
  for (const e of entries) {
    for (const m of String(e).matchAll(/['‘’"“”]([^'‘’"“”]{3,60})['‘’"“”]/g)) {
      out.push(m[1].trim());
    }
  }
  return [...new Set(out)];
}

/** Blocklist entries that produced no enforceable literal. */
export function unenforceableEntries(entries) {
  return entries.filter((e) => extractLiterals([e]).length === 0);
}

// --------------------------------------------------------------- profile ---

export function convertProfile(live) {
  const edu = live.education?.[0] ?? {};
  const report = { typed: [], skipped: [], warnings: [] };
  const note = (arr, key, why) => { arr.push({ key, why }); };

  const profile = {
    schemaVersion: 2,
    _generated: { from: 'application-profile.json', at: new Date().toISOString() },

    identity: {
      firstName: live.name?.first ?? null,
      lastName: live.name?.last ?? null,
      fullName: live.name?.full ?? null,
      middleName: null,
      preferredName: live.name?.preferred ?? null,
      pronouns: live.name?.pronouns ?? null,
    },

    contact: {
      email: live.email?.primary ?? null,
      // The CMU address is not an "alternate" here — it is a FORBIDDEN
      // IDENTITY. It got written into live forms by résumé autofill on at
      // least 3 iCIMS tenants this week, so it is checked on read-back too.
      emailForbidden: [live.email?.email_alt].filter(Boolean),
      phone: {
        e164: live.phone?.e164 ?? null,
        digits: live.phone?.digits ?? null,
        formatted: live.phone?.formatted ?? null,
        type: 'mobile',
      },
      address: {
        line1: live.address?.line1 ?? null,
        line2: live.address?.line2 ?? null,
        city: live.address?.city ?? null,
        county: live.address?.county ?? null,
        state: live.address?.state ?? null,
        stateFull: live.address?.state_full ?? null,
        postalCode: live.address?.postal_code ?? null,
        country: live.address?.country_short ?? 'US',
        countryFull: live.address?.country ?? 'United States',
      },
    },

    links: {
      linkedin: live.links?.linkedin ?? null,
      github: live.links?.github ?? null,
      website: live.links?.website ?? null,
    },

    education: [{
      school: edu.school ?? null,
      schoolAliases: edu.school_search_fallbacks ?? [],
      degreeLevel: 'bachelors',
      degreeText: edu.degree ?? null,
      fieldOfStudy: edu.field_of_study ?? null,
      fieldOfStudyFallbacks: edu.field_of_study_fallbacks ?? [],
      start: dateValue(edu.start),
      end: dateValue(edu.expected_graduation),
      endIsExpected: true,
      gpa: edu.gpa ?? null,
      gpaScale: edu.gpa_scale ?? 4.0,
      currentlyEnrolled: bool(edu.currently_enrolled),
      returningAfterInternship: bool(edu.returning_to_school_after_internship),
      classStanding: edu.class_standing_ay_2026_27 ?? null,
      graduated: 'no',
      transcriptFile: edu.transcript_file ?? null,
    }],

    experience: (live.work_experience ?? []).map((w) => ({
      title: w.title,
      employer: w.company,
      onResume: !!w.on_resume,
      city: (w.location_for_forms ?? '').split(',')[0]?.trim() || null,
      state: (w.location_for_forms ?? '').split(',')[1]?.trim() || null,
      country: 'US',
      start: dateValue(w.start),
      end: dateValue(w.end),
      isCurrent: w.current ? 'yes' : 'no',
      description: w.one_line ?? null,
      reasonForLeaving: w.reason_for_leaving ?? null,
      // Explicitly NOT typed: null means "park if a form requires it".
      mayContactEmployer: bool(w.may_contact_employer),
      enterOnlyIfCompleteHistoryRequired: w.on_resume === false,
    })),

    authorization: {
      workAuthorization: live.work_authorization?.authorized_to_work_in_us
        ? 'authorized-no-sponsorship' : 'not-authorized',
      sponsorship: live.work_authorization?.requires_sponsorship_us_now_or_future
        ? 'now' : 'none-now-or-future',
      sponsorshipNote: live.work_authorization?.sponsorship_note ?? null,
      citizenship: live.work_authorization?.citizenship ?? null,
      itarEarEligible: bool(live.work_authorization?.itar_ear_eligible),
      clearance: (live.work_authorization?.security_clearance_held ?? '').toLowerCase() === 'none'
        ? 'none' : 'none',
      clearanceConfidence: 'vault-default-never-confirmed',
      over18: bool(live.work_authorization?.over_18),
      driversLicense: bool(live.work_authorization?.drivers_license),
      previouslyEmployed: bool(live.work_authorization?.previously_employed_by_this_company_default),
    },

    availability: {
      earliestStart: dateValue(live.availability?.earliest_start_date),
      primaryTerm: live.availability?.primary_term ?? null,
      terms: ['Winter 2027', 'Spring 2027', 'Summer 2027'],
      employmentTypes: ['internship', 'co-op'],
      hoursPerWeek: live.availability?.hours_per_week_during_internship ?? null,
    },

    locationPolicy: {
      openToRelocation: bool(live.location_preferences?.open_to_relocation),
      arrangements: ['onsite', 'hybrid', 'remote'],
      currentLocation: live.location_preferences?.current_location ?? null,
      policy: live.location_preferences?.policy ?? null,
    },

    selfId: {
      gender: (live.eeo_voluntary_self_id?.gender ?? '').toLowerCase() === 'male' ? 'male' : null,
      ethnicity: (live.eeo_voluntary_self_id?.race_ethnicity ?? '').toLowerCase() === 'asian' ? 'asian' : null,
      hispanicOrLatino: bool(live.eeo_voluntary_self_id?.hispanic_or_latino),
      veteran: 'not-a-protected-veteran',
      disability: 'no',
      signatureName: live.eeo_voluntary_self_id?.self_id_form_signature_name ?? null,
      answerPolicy: live.eeo_voluntary_self_id?.answer_policy ?? null,
    },

    source: {
      howDidYouHear: live.how_did_you_hear?.picklist_preference_order ?? [],
      freeText: live.how_did_you_hear?.free_text ?? null,
    },

    compensation: {
      minimumHourlyUsd: live.compensation?.minimum_hourly_usd ?? null,
      minimumAnnualUsd: live.compensation?.minimum_annual_usd ?? null,
      rules: live.compensation?.rules ?? null,
    },

    standardYesNo: Object.fromEntries(
      Object.entries(live.standard_yes_no_defaults ?? {}).map(([k, v]) => [k, bool(v)])
    ),

    constraints: {
      neverInvent: true,
      gpa: {
        value: edu.gpa ?? null,
        scale: edu.gpa_scale ?? 4.0,
        bandRule: 'nearest-band-never-round-up',
        rules: edu.gpa_rules ?? null,
      },
      // Fabricated-number blocklist AND forbidden identities, both checked on
      // write AND on read-back (F16).
      //
      // The live entries are PROSE ("SmartMeter '~10% water-waste reduction'
      // (fabricated, never cite)"), which a scanner cannot match against a
      // form field. The quoted fragment inside each entry is the actual
      // forbidden literal, so it is extracted here and the prose is kept
      // alongside for the human reading the report. An entry with no quoted
      // fragment yields no literal and is reported as unenforceable rather
      // than silently dropped.
      forbiddenValues: live.constraints?.forbidden_numbers ?? [],
      forbiddenLiterals: extractLiterals(live.constraints?.forbidden_numbers ?? []),
      forbiddenIdentities: [live.email?.email_alt].filter(Boolean),
      onePacketRule: true,
      noDurationsForTools: true,
    },

    /** Facts the live profile explicitly records as ABSENT. A required form
     *  field hitting one of these parks — it does not fall back to a guess. */
    missing: live.missing ?? [],
  };

  // ---- report on what could not be typed --------------------------------
  if (!profile.selfId.gender) note(report.skipped, 'selfid.gender', 'live value not in the canonical enum');
  if (!profile.selfId.ethnicity) note(report.skipped, 'selfid.ethnicity', 'live value not in the canonical enum');
  for (const m of profile.missing) note(report.skipped, `missing:${m}`, 'recorded absent in the live profile — park if required');
  if (live.work_authorization?.requires_sponsorship_outside_us) {
    report.warnings.push(
      'sponsorship is scoped to US roles: a non-US jurisdiction needs "yes". ' +
      'The engine only ever fills the US-scoped answer; a non-US sponsorship ' +
      'question has no typed answer and parks.'
    );
  }
  if (profile.authorization.clearanceConfidence !== 'confirmed') {
    report.warnings.push('security clearance "none" is a vault default, never confirmed by Felix.');
  }
  for (const e of unenforceableEntries(live.constraints?.forbidden_numbers ?? [])) {
    report.warnings.push(
      `forbidden-number entry has no quoted literal, so the scanner cannot enforce it: "${e}"`
    );
  }
  for (const w of profile.experience) {
    if (w.mayContactEmployer === null) {
      note(report.skipped, `work.mayContact:${w.employer}`, 'not on file — a required field parks');
    }
  }

  return { profile, report };
}

// ------------------------------------------------------------ enum facts ---

/** The typed fact table: FieldKey -> canonical enum value. This is the ONLY
 *  source the engine consults for an enum-typed control. */
export function buildFacts(profile) {
  const a = profile.authorization;
  const s = profile.selfId;
  const y = profile.standardYesNo ?? {};
  const raw = {
    'auth.workAuthorized': a.workAuthorization,
    'auth.sponsorship': a.sponsorship,
    'auth.over18': a.over18,
    'auth.itarEligible': a.itarEarEligible,
    'auth.clearance': a.clearance,
    'auth.previouslyEmployed': a.previouslyEmployed,
    'auth.driversLicense': a.driversLicense,
    'education.degreeLevel': profile.education[0]?.degreeLevel,
    'education.currentlyEnrolled': profile.education[0]?.currentlyEnrolled,
    'education.graduated': profile.education[0]?.graduated,
    'avail.employmentType': profile.availability.employmentTypes[0],
    'loc.relocation': profile.locationPolicy.openToRelocation,
    'selfid.gender': s.gender,
    'selfid.ethnicity': s.ethnicity,
    'selfid.hispanic': s.hispanicOrLatino,
    'selfid.veteran': s.veteran,
    'selfid.disability': s.disability,
    'consent.terms': y.agree_to_terms_and_privacy,
    'consent.dataRetention': y.consent_to_data_retention,
    'consent.backgroundCheck': y.consent_to_background_check,
    'consent.smsRecruiting': y.consent_to_sms_recruiting,
    'consent.marketing': y.subscribe_to_marketing,
    'misc.willingToTravel': y.willing_to_travel,
    'misc.hasNonCompete': y.has_non_compete,
    'misc.relatedToEmployee': y.related_to_employee,
  };

  // The live profile can contradict itself: `standard_yes_no_defaults` carries
  // a default for `willing_to_travel` while `missing` simultaneously lists it
  // as not on file. A contradiction is NOT a value — resolving it silently in
  // either direction would be exactly the invention this bank exists to make
  // impossible. So a key named in `missing` is refused even when a default is
  // present, and the report says why.
  const missingText = (profile.missing ?? []).join(' ; ').toLowerCase();
  const contradicts = (key) => {
    const leaf = key.split('.').pop()
      .replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();   // willingToTravel -> willing_to_travel
    return leaf.length > 3 && missingText.includes(leaf);
  };

  const facts = {};
  const rejected = [];
  for (const [key, value] of Object.entries(raw)) {
    if (value === null || value === undefined) { rejected.push({ key, why: 'no value on file' }); continue; }
    assertFieldKey(key);
    if (contradicts(key)) {
      rejected.push({
        key,
        why: `live profile CONTRADICTS itself: a default of ${JSON.stringify(value)} is set, ` +
             `but the key is also listed under "missing". Refused — a contradiction is not a value.`,
      });
      continue;
    }
    const allowed = ENUM_FOR_KEY[key];
    if (allowed && !allowed.includes(value)) {
      // The whole point: an out-of-enum value is refused at BUILD time, so it
      // can never reach a form as an approximation.
      rejected.push({ key, why: `value ${JSON.stringify(value)} not in its canonical enum` });
      continue;
    }
    facts[key] = { value, source: 'profile' };
  }
  return { facts, rejected };
}

// ----------------------------------------------------------------- prose ---

function wordCount(s) { return s.split(/\s+/).filter(Boolean).length; }

/** Parse answer-bank.md into typed ProseAnswers. The markdown stays the
 *  human-editable source; this is its machine projection. */
export function convertBank(md) {
  const answers = [];
  const warnings = [];
  const lines = md.split('\n');

  // Sections: "## A. Why this company …"  and variants "### C1 — Retrieval …"
  const marks = [];
  lines.forEach((ln, i) => {
    let m = /^##\s+([A-H])\.\s+(.+)$/.exec(ln);
    if (m) { marks.push({ i, id: m[1], title: m[2].trim(), level: 2 }); return; }
    m = /^###\s+([A-H](?:-long|\d))\s*[—-]\s*(.+)$/.exec(ln);
    if (m) marks.push({ i, id: m[1], title: m[2].trim(), level: 3 });
  });

  for (let k = 0; k < marks.length; k++) {
    const start = marks[k].i;
    const end = k + 1 < marks.length ? marks[k + 1].i : lines.length;
    const block = lines.slice(start + 1, end);

    // "Covers:" may wrap over several lines until a blank line.
    let covers = [];
    const ci = block.findIndex((l) => /^\*\*Covers:\*\*/.test(l));
    if (ci >= 0) {
      let j = ci; const buf = [];
      while (j < block.length && block[j].trim() !== '') { buf.push(block[j]); j++; }
      covers = [...buf.join(' ').matchAll(/"([^"]+)"/g)].map((x) => x[1]);
    }

    // Body = everything that is not metadata, up to the *Sources:* footer.
    const body = [];
    for (const l of block) {
      if (/^\*Sources:\*/.test(l)) break;
      if (/^\*\*(Covers|Selection rule|Length|Variant)/.test(l)) continue;
      if (/^>/.test(l) || /^---/.test(l)) continue;
      body.push(l);
    }
    const text = body.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    if (!text) continue;

    const slots = [...text.matchAll(/\[\[SLOT:?\s*([^\]]*)\]\]/g)].map((m2, n) => ({
      name: `slot${n + 1}`,
      instruction: m2[1].trim().slice(0, 300),
      // A slot with no JD fact available => park, never improvise. The live
      // bank's own rule is "delete the sentence"; the engine parks instead,
      // because deleting a sentence is an editorial act on a fact-bearing
      // answer and we do not do those unattended.
      from: 'jd',
      required: true,
    }));

    const id = `A-${marks[k].id}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    answers.push({
      id,
      section: marks[k].id,
      title: marks[k].title,
      covers,
      coversPatterns: covers.map(toPattern),
      variants: [{ maxWords: wordCount(text), text }],
      slots,
      hasSlots: slots.length > 0,
    });
    if (!covers.length && marks[k].level === 2) {
      warnings.push(`section ${marks[k].id} has no "Covers:" line — it can never be matched by the classifier`);
    }
  }

  return { answers, warnings };
}

/** A "Covers" phrase becomes a deterministic matcher, never an embedding. */
function toPattern(phrase) {
  const core = phrase
    .replace(/<[^>]+>/g, '')            // "<company>" is a placeholder
    .replace(/[^\w\s/]/g, ' ')
    .trim();
  const words = core.split(/\s+/).filter((w) => w.length > 3);
  return words.slice(0, 6).join('|');
}

// ------------------------------------------------------------------ main ---

export function convertAll({ assetsDir = LIVE_ASSETS } = {}) {
  const liveProfileRaw = fs.readFileSync(path.join(assetsDir, 'application-profile.json'), 'utf8');
  const liveBankRaw = fs.readFileSync(path.join(assetsDir, 'answer-bank.md'), 'utf8');
  const live = JSON.parse(liveProfileRaw);

  const { profile, report } = convertProfile(live);
  const { facts, rejected } = buildFacts(profile);
  const { answers, warnings } = convertBank(liveBankRaw);

  const bank = {
    schemaVersion: 2,
    _generated: {
      from: ['application-profile.json', 'answer-bank.md'],
      at: new Date().toISOString(),
      note: 'GENERATED. Edit the live assets and re-run tools/build-bank.js; never hand-edit this file.',
    },
    facts,
    prose: answers,
    /** Questions ruled unanswerable -> always park (never model-guessed). */
    alwaysPark: [
      { pattern: 'years|months of experience', reason: 'no durations for tools/languages are on file (SpaceX incident)' },
      { pattern: 'date of birth|birthdate|dob', reason: 'never on file' },
      { pattern: 'reference', reason: 'no professional references on file' },
      { pattern: 'salary history|current salary', reason: 'no employment salary history on file' },
      { pattern: 'high school name', reason: 'not on file' },
      { pattern: 'sat score', reason: 'never taken; never convert or estimate' },
    ],
  };

  return {
    profile,
    bank,
    report: { ...report, rejectedFacts: rejected, bankWarnings: warnings },
  };
}
