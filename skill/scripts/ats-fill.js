#!/usr/bin/env node
/**
 * ats-fill — fill the standard block of an ATS application form in ONE call,
 * from application-profile.json, through the applier's own agent-browser
 * session (inherits AGENT_BROWSER_SESSION). No model turns per field.
 *
 * Usage (page already open in the session's current tab):
 *   ats-fill.js <greenhouse|lever|ashby|workday|generic> --resume <pdf>
 *               [--profile <json>] [--dry-run] [--no-eeo] [--no-upload]
 *
 * What it does: snapshots the accessibility tree, matches known field labels
 * (text boxes, react-select comboboxes, file inputs, standard yes/no and EEO
 * questions), fills them, and prints a report: FILLED / PICKED / MISSED /
 * UNHANDLED. The applier then snapshots once, handles what is listed under
 * UNHANDLED (custom questions), and submits. Never submits anything itself.
 *
 * Exit code 0 even when fields are missed — the report is the contract.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
const ats = (args.find(a => !a.startsWith('--')) || '').toLowerCase();
const flag = n => { const i = args.indexOf(`--${n}`); return i === -1 ? null : (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true); };
if (!['greenhouse', 'lever', 'ashby', 'workday', 'generic'].includes(ats)) {
  console.error('usage: ats-fill.js <greenhouse|lever|ashby|workday|generic> --resume <pdf> [--profile <json>] [--dry-run] [--no-eeo] [--no-upload]');
  process.exit(2);
}
const DRY = !!flag('dry-run');
const PROFILE = flag('profile') || path.join(__dirname, '..', 'assets', 'application-profile.json');
const RESUME = flag('resume');
const P = JSON.parse(fs.readFileSync(PROFILE, 'utf8'));
const edu = P.education[0];
const wa = P.work_authorization;
const eeo = P.eeo_voluntary_self_id;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const ym = s => { const [y, m] = s.split('-').map(Number); return { y, m, month: MONTHS[m - 1] }; };
const grad = ym(edu.expected_graduation), start = ym(edu.start);

// ---------- agent-browser plumbing ----------
function ab(...a) {
  if (DRY && !['snapshot', 'get'].includes(a[0])) { return { ok: true, out: '' }; }
  const r = spawnSync('agent-browser', a, { encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout || '') + (r.stderr || '') };
}
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function snapshot() {
  const { out } = ab('snapshot', '-i');
  const items = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*-\s+(\w+)\s+"((?:[^"\\]|\\.)*)"\s*(.*?)\[ref=(e\d+)\](.*)$/);
    if (!m) continue;
    items.push({ role: m[1], label: m[2].replace(/\\"/g, '"'), ref: m[4], flags: (m[3] + m[5]).trim(), line: line.trim() });
  }
  return items;
}
const norm = s => s.toLowerCase().replace(/\s+/g, ' ').replace(/[*:]+$/g, '').trim();
function find(items, role, label) {
  const want = label instanceof RegExp ? label : new RegExp('^' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i');
  const roles = Array.isArray(role) ? role : [role];
  return items.find(it => roles.includes(it.role) && want.test(norm(it.label)));
}

const report = { filled: [], picked: [], missed: [], skipped: [] };
const labelName = l => l instanceof RegExp ? l.source.replace(/\\[()]/g, '').replace(/[\^$()?:]/g, '').split('|')[0].trim() : l;
const handled = new Set();

function fillText(role, label, value) {
  if (value === null || value === undefined || value === '') return;
  const it = find(snapshot(), role, label);
  if (!it) { report.missed.push(`${labelName(label)} (no such field)`); return; }
  handled.add(it.ref + it.label);
  const r = ab('fill', '@' + it.ref, String(value));
  (r.ok ? report.filled : report.missed).push(`${it.label} = ${value}`);
}

// react-select style combobox: open, optionally type to filter, click the option.
function pick(label, options, typeText) {
  const opts = (Array.isArray(options) ? options : [options]).filter(Boolean);
  let it = find(snapshot(), 'combobox', label);
  if (!it) { report.missed.push(`${labelName(label)} (no such field)`); return false; }
  handled.add(it.ref + it.label);
  if (DRY) { report.picked.push(`${it.label} -> ${opts[0]}`); return true; }
  if (!/\[expanded\]/.test(it.flags)) ab('click', '@' + it.ref);
  sleep(600);
  if (typeText) {
    it = find(snapshot(), 'combobox', label) || it;
    ab('fill', '@' + it.ref, typeText);
    sleep(900);
  }
  let visible = snapshot().filter(x => x.role === 'option');
  for (const want of opts) {
    const w = norm(want);
    const opt = visible.find(o => norm(o.label) === w) || visible.find(o => norm(o.label).startsWith(w)) || visible.find(o => norm(o.label).includes(w));
    if (opt) {
      ab('click', '@' + opt.ref); sleep(500);
      report.picked.push(`${it.label} -> ${opt.label}`);
      return true;
    }
  }
  ab('press', 'Escape');
  report.missed.push(`${it.label} (wanted ${opts.join(' | ')}; options: ${visible.slice(0, 12).map(o => o.label).join(' ~ ')}${visible.length > 12 ? ' …' : ''})`);
  return false;
}

function upload(nth = 0) {
  if (!RESUME || flag('no-upload')) { report.skipped.push('resume upload (no --resume)'); return; }
  const base = path.basename(RESUME);
  if (!DRY && ab('snapshot').out.includes(base)) { report.skipped.push(`resume upload — ${base} already attached`); return; }
  const r = ab('upload', `input[type=file] >> nth=${nth}`, path.resolve(RESUME));
  sleep(1500);
  // Greenhouse replaces the input with a "Remove file" row, so verify by the
  // file name showing up in the page, not by the input's file list.
  const ok = DRY || (r.ok && ab('snapshot').out.includes(base));
  (ok ? report.filled : report.missed).push(`resume upload (file input #${nth}) = ${base}${ok ? '' : ' — NOT visible on the page after upload'}`);
}

// Standard yes/no questions answerable from the profile alone.
function standardQuestions(items) {
  for (const it of items) {
    if (it.role !== 'combobox' || handled.has(it.ref + it.label)) continue;
    const q = norm(it.label);
    let want = null;
    if (/authori[sz]ed to work|legally (eligible|authorized)|eligible to work/.test(q)) want = wa.authorized_to_work_in_us ? 'Yes' : 'No';
    else if (/sponsorship|sponsor/.test(q)) want = wa.requires_sponsorship_us_now_or_future ? 'Yes' : 'No';
    else if (/18 years|over 18|at least 18/.test(q)) want = wa.over_18 ? 'Yes' : 'No';
    else if (/previously (worked|been employed|employed)|worked (for|at) .* before|former employee/.test(q)) want = 'No';
    else if (/willing to relocate|open to relocat/.test(q)) want = P.location_preferences?.open_to_relocation ? 'Yes' : 'No';
    else if (/currently (enrolled|a student)|enrolled in/.test(q)) want = edu.currently_enrolled ? 'Yes' : 'No';
    else if (/return(ing)? to (school|your degree|studies)/.test(q)) want = edu.returning_to_school_after_internship ? 'Yes' : 'No';
    else if (/graduat(e|ing) (before|by|prior to)/.test(q)) {
      const m = q.match(/(january|february|march|april|may|june|july|august|september|october|november|december)?\s*(20\d\d)/);
      if (m) { const y = +m[2], mo = m[1] ? MONTHS.findIndex(x => x.toLowerCase() === m[1]) + 1 : 12; want = (grad.y < y || (grad.y === y && grad.m <= mo)) ? 'Yes' : 'No'; }
    }
    if (want) pick(new RegExp('^' + it.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i'), want);
  }
}

function eeoQuestions() {
  if (flag('no-eeo')) return;
  pick(/^gender$/i, [eeo.gender]);
  pick(/hispanic|latino/i, [eeo.hispanic_or_latino ? 'Yes' : 'No']);
  pick(/^(?!.*hispanic).*(race|ethnicity)/i, [eeo.race_ethnicity_combined_picklist, eeo.race_ethnicity]);
  pick(/veteran/i, [eeo.veteran_status, 'I am not a protected veteran', eeo.veteran_status_short]);
  pick(/disability/i, [eeo.disability_status, 'No, I do not have a disability', eeo.disability_status_short]);
}

// ---------- per-ATS field maps ----------
function greenhouse() {
  fillText('textbox', 'First Name', P.name.first);
  fillText('textbox', 'Last Name', P.name.last);
  fillText('textbox', 'Email', P.email.primary);
  fillText('textbox', /^preferred name/i, P.name.preferred);
  pick(/^country$/i, ['United States'], 'United States');
  fillText('textbox', 'Phone', P.phone.digits);
  upload(0);
  fillText('textbox', /^location \(city\)|^city$|^location$/i, `${P.address.city}, ${P.address.state_full}, United States`);
  pick(/^school$/i, [edu.school, ...(edu.school_search_fallbacks || [])], 'Carnegie Mellon');
  pick(/^degree$/i, [edu.degree_level_picklist, edu.degree, "Bachelor's"], 'Bachelor');
  pick(/^discipline|^major|field of study/i, [edu.field_of_study, ...(edu.field_of_study_fallbacks || [])]);
  pick(/^start date month/i, [start.month]);
  fillText('spinbutton', /^start date year/i, start.y);
  pick(/^end date month/i, [grad.month]);
  fillText('spinbutton', /^end date year/i, grad.y);
  fillText('textbox', /linkedin/i, P.links.linkedin);
  fillText('textbox', /^website|portfolio|personal site/i, P.links.website);
  fillText('textbox', /github/i, P.links.github);
  standardQuestions(snapshot());
  eeoQuestions();
}
function lever() {
  fillText('textbox', /^full name|^name$/i, P.name.full);
  fillText('textbox', /^email/i, P.email.primary);
  fillText('textbox', /^phone/i, P.phone.digits);
  fillText('textbox', /^current location|^location/i, `${P.address.city}, ${P.address.state}`);
  fillText('textbox', /linkedin/i, P.links.linkedin);
  fillText('textbox', /github/i, P.links.github);
  fillText('textbox', /portfolio|website/i, P.links.website);
  upload(0);
  standardQuestions(snapshot());
  eeoQuestions();
}
function ashby() {
  fillText('textbox', /^(full )?name$/i, P.name.full);
  fillText('textbox', /^first name/i, P.name.first);
  fillText('textbox', /^last name/i, P.name.last);
  fillText('textbox', /^email/i, P.email.primary);
  fillText('textbox', /^phone/i, P.phone.digits);
  fillText('textbox', /linkedin/i, P.links.linkedin);
  fillText('textbox', /github/i, P.links.github);
  fillText('textbox', /website|portfolio/i, P.links.website);
  fillText('textbox', /^location|^current location|^city/i, `${P.address.city}, ${P.address.state}`);
  upload(0);
  standardQuestions(snapshot());
  eeoQuestions();
}
// Workday "My Information" step only — the later steps (experience,
// questionnaires) are per-tenant and stay with the applier + workday-answer.sh.
function workday() {
  fillText('textbox', /^(legal )?first name/i, P.name.first);
  fillText('textbox', /^(legal )?last name/i, P.name.last);
  fillText('textbox', /^address line 1/i, P.address.line1);
  fillText('textbox', /^city/i, P.address.city);
  fillText('textbox', /^postal code|^zip/i, P.address.postal_code);
  fillText('textbox', /^phone number/i, P.phone.digits);
  fillText('textbox', /^email/i, P.email.primary);
  report.skipped.push('Workday dropdowns (State, Phone Device Type, Country Phone Code, How Did You Hear) — use workday-answer.sh; radios (previously employed) stay manual');
}
function generic() {
  fillText('textbox', /^first name/i, P.name.first);
  fillText('textbox', /^last name/i, P.name.last);
  fillText('textbox', /^(full )?name$/i, P.name.full);
  fillText('textbox', /^e-?mail/i, P.email.primary);
  fillText('textbox', /^(mobile |cell )?phone/i, P.phone.digits);
  fillText('textbox', /^address( line)? ?1?$/i, P.address.line1);
  fillText('textbox', /^city/i, P.address.city);
  fillText('textbox', /^(zip|postal)/i, P.address.postal_code);
  fillText('textbox', /linkedin/i, P.links.linkedin);
  fillText('textbox', /github/i, P.links.github);
  fillText('textbox', /website|portfolio/i, P.links.website);
  upload(0);
  standardQuestions(snapshot());
  eeoQuestions();
}

({ greenhouse, lever, ashby, workday, generic })[ats]();

// ---------- report ----------
const left = snapshot().filter(it => ['textbox', 'combobox', 'checkbox', 'radio', 'spinbutton'].includes(it.role) && !handled.has(it.ref + it.label)
  && !/toggle flyout/i.test(it.label));
console.log(`ats-fill ${ats}${DRY ? ' (dry-run)' : ''} — ${P.name.full}`);
const sec = (name, arr) => { if (arr.length) console.log(`\n${name} (${arr.length}):\n  ${arr.join('\n  ')}`); };
sec('FILLED', report.filled); sec('PICKED', report.picked); sec('MISSED', report.missed); sec('SKIPPED', report.skipped);
sec('UNHANDLED — yours to do', left.map(it => it.line));
console.log('\nNothing was submitted. Snapshot once, answer UNHANDLED from answer-bank.md / the profile, review, then submit.');
