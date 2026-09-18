# Typed-bank conversion report

Generated 2026-09-18T05:05:42.407Z from the LIVE assets at
`~/zylos/.claude/skills/resume/assets/` (opened read-only; unmodified).

This report is the point of the conversion. The live profile is a flat
fact sheet read by question-text regexes; the typed bank is a closed
vocabulary. Anything that could not be typed is listed here rather than
being approximated at fill time — that is the difference between a park
and the 2026-09-07 `"male"` matching `"Female"`.

## Coverage

- typed enum facts: **23**
- prose answers: **11** (3 carry JD slots)
- always-park rules: **6**
- education entries: 1; experience entries: 3
- forbidden identities: 1
- forbidden values (fabricated-number blocklist): 5

## Typed enum facts

| FieldKey | canonical value | source |
|---|---|---|
| `auth.workAuthorized` | `authorized-no-sponsorship` | profile |
| `auth.sponsorship` | `none-now-or-future` | profile |
| `auth.over18` | `yes` | profile |
| `auth.itarEligible` | `yes` | profile |
| `auth.previouslyEmployed` | `no` | profile |
| `auth.driversLicense` | `yes` | profile |
| `education.degreeLevel` | `bachelors` | profile |
| `education.currentlyEnrolled` | `yes` | profile |
| `education.graduated` | `no` | profile |
| `avail.employmentType` | `internship` | profile |
| `loc.relocation` | `yes` | profile |
| `selfid.gender` | `male` | profile |
| `selfid.ethnicity` | `asian` | profile |
| `selfid.hispanic` | `no` | profile |
| `selfid.veteran` | `not-a-protected-veteran` | profile |
| `selfid.disability` | `no` | profile |
| `consent.terms` | `yes` | profile |
| `consent.dataRetention` | `yes` | profile |
| `consent.backgroundCheck` | `yes` | profile |
| `consent.smsRecruiting` | `yes` | profile |
| `consent.marketing` | `no` | profile |
| `misc.hasNonCompete` | `no` | profile |
| `misc.relatedToEmployee` | `no` | profile |

## NOT typed — these PARK when a form requires them

| item | why |
|---|---|
| `auth.clearance` | live profile CONTRADICTS itself: a default of "none" is set, but the key is also listed under "missing". Refused — a contradiction is not a value. |
| `misc.willingToTravel` | live profile CONTRADICTS itself: a default of "yes" is set, but the key is also listed under "missing". Refused — a contradiction is not a value. |
| `missing:name.preferred / name.pronouns` | recorded absent in the live profile — park if required |
| `missing:education[0].major_gpa (computed ≈3.2–3.3 earlier, not higher than cumulative — so never worth entering)` | recorded absent in the live profile — park if required |
| `missing:high_school.name` | recorded absent in the live profile — park if required |
| `missing:date_of_birth (never on file; park if required)` | recorded absent in the live profile — park if required |
| `missing:languages_spoken[Chinese].proficiency label` | recorded absent in the live profile — park if required |
| `missing:work_experience[*].may_contact_employer` | recorded absent in the live profile — park if required |
| `missing:references.professional (×3) and references.openmax_reference_contact` | recorded absent in the live profile — park if required |
| `missing:standard_yes_no_defaults.willing_to_travel / consent_to_drug_screen` | recorded absent in the live profile — park if required |
| `missing:security clearance: 'None' is the vault default, never confirmed` | recorded absent in the live profile — park if required |
| `missing:a 'number that describes me' / non-technical interests (vault flags this gap explicitly)` | recorded absent in the live profile — park if required |
| `work.mayContact:OpenMax` | not on file — a required field parks |
| `work.mayContact:Chapman University — Gait Rehabilitation & Research Lab` | not on file — a required field parks |
| `work.mayContact:OpenMax` | not on file — a required field parks |

## Warnings

- sponsorship is scoped to US roles: a non-US jurisdiction needs "yes". The engine only ever fills the US-scoped answer; a non-US sponsorship question has no typed answer and parks.
- security clearance "none" is a vault default, never confirmed by Felix.

## Prose answers

| id | section | covers phrases | words | slots |
|---|---|---|---|---|
| `a-a` | A | 4 | 163 | 1 |
| `a-b` | B | 4 | 190 | 0 |
| `a-c` | C | 4 | 28 | 0 |
| `a-c1` | C1 | 0 | 152 | 0 |
| `a-c2` | C2 | 0 | 146 | 0 |
| `a-c3` | C3 | 0 | 125 | 0 |
| `a-d` | D | 3 | 145 | 1 |
| `a-e` | E | 3 | 134 | 1 |
| `a-f` | F | 5 | 148 | 0 |
| `a-g` | G | 3 | 143 | 0 |
| `a-h` | H | 3 | 74 | 0 |

Prose is never rendered into the event stream: an answer is recorded as
`answer_id` + `variant` + `slots` (Q5), which is enough to reconstruct it
from this bank and enough to audit which answer went where.

