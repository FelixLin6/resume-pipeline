#!/usr/bin/env node
/**
 * jd-skills — accumulate {role, skills[]} datapoints scraped from job descriptions
 * (Simplify's "skills" chips, or any other source) and analyse the skill
 * distribution per role category.
 *
 * Storage: data.jsonl (append-only, one JSON object per line).
 * The `raw` array is never rewritten — normalization is derived, so the alias
 * map can be changed later and replayed with `renormalize`.
 */

const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const DATA = path.join(DIR, 'data.jsonl');
const ALIASES = path.join(DIR, 'aliases.json');

// ---------- helpers ----------

function loadAliases() {
  if (!fs.existsSync(ALIASES)) return {};
  const raw = JSON.parse(fs.readFileSync(ALIASES, 'utf8'));
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith('_')) continue;
    out[k.toLowerCase()] = v.toLowerCase();
  }
  return out;
}

function normalizeSkill(s, aliases) {
  let t = String(s).toLowerCase().trim();
  t = t.replace(/\s+/g, ' ');
  t = t.replace(/[.,;:]+$/g, '');      // trailing punctuation only — keeps c++, c#, .net
  t = t.replace(/^[-•*•]\s*/, ''); // bullet prefixes from pasted lists
  t = t.trim();
  if (!t) return null;
  return aliases[t] || t;
}

function parseSkills(text, aliases) {
  // Accepts comma-separated, newline-separated, or a mix (Simplify chips paste
  // either way depending on how they're selected).
  const parts = String(text).split(/[\n,]+/);
  const seen = new Set();
  const raw = [];
  const norm = [];
  for (const p of parts) {
    const rawTrim = p.trim().replace(/^[-•*•]\s*/, '').trim();
    if (!rawTrim) continue;
    const n = normalizeSkill(rawTrim, aliases);
    if (!n || seen.has(n)) continue;   // dedupe within one posting
    seen.add(n);
    raw.push(rawTrim);
    norm.push(n);
  }
  return { raw, norm };
}

function loadRecords() {
  if (!fs.existsSync(DATA)) return [];
  return fs.readFileSync(DATA, 'utf8')
    .split('\n')
    .filter(l => l.trim())
    .map((l, i) => {
      try { return JSON.parse(l); }
      catch { console.error(`  ! skipping malformed line ${i + 1}`); return null; }
    })
    .filter(Boolean);
}

function writeAll(records) {
  fs.writeFileSync(DATA, records.map(r => JSON.stringify(r)).join('\n') + '\n');
}

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) flags[a.slice(2)] = argv[++i];
      else flags[a.slice(2)] = true;
    } else positional.push(a);
  }
  return { flags, positional };
}

function pct(n, d) { return d ? (100 * n / d) : 0; }

// Local calendar date, not UTC — a UTC stamp reads a day ahead every evening
// in a negative-offset timezone, which would silently misdate every record.
function localDate() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ---------- commands ----------

function cmdAdd(flags) {
  const aliases = loadAliases();
  const role = flags.role;
  const roleClean = flags['role-clean'];
  const category = (flags.category || '').toLowerCase();
  if (!role || !category) {
    console.error('error: --role and --category are both required.\n' +
                  'example: jd-skills add --role "Software Engineer Intern" --company Datadog --category swe --keywords "Python, React, SQL"');
    process.exit(1);
  }
  if (!roleClean || roleClean === true) {
    console.error('error: --role-clean is required — the cleaned label for what the role REALLY is,\n' +
                  'judged from the JD content, not the posting title (titles are marketing).\n' +
                  'example: --role "Security Software Engineer Intern" --role-clean "Backend Software Engineer Intern"\n' +
                  'If the title is already accurate, repeat it verbatim.');
    process.exit(1);
  }
  const text = flags.keywords && flags.keywords !== true ? flags.keywords : readStdin();
  if (!text || !text.trim()) {
    console.error('error: no skills given. Pass --keywords "a, b, c" or pipe them on stdin.');
    process.exit(1);
  }
  const { raw, norm } = parseSkills(text, aliases);
  if (!norm.length) { console.error('error: no skills parsed from input.'); process.exit(1); }

  const records = loadRecords();
  const dup = records.find(r =>
    (r.company || '').toLowerCase() === (flags.company || '').toLowerCase() &&
    (r.role || '').toLowerCase() === role.toLowerCase());
  if (dup && !flags.force) {
    console.error(`warning: already have "${role}" @ ${flags.company || '(no company)'} (added ${dup.added}).`);
    console.error('Nothing written. Re-run with --force if this is a genuinely different posting.');
    process.exit(1);
  }

  const rec = {
    role,                                 // verbatim posting title — never rewritten
    roleClean,                            // what the role really is, judged from the JD
    company: flags.company || null,
    category,
    level: flags.level || null,          // intern | new-grad | senior ...
    url: flags.url || null,
    source: flags.source || 'simplify',
    added: localDate(),
    raw,                                  // never rewritten
    skills: norm,                         // derived; rebuilt by `renormalize`
  };
  fs.appendFileSync(DATA, JSON.stringify(rec) + '\n');
  console.log(`added: ${role}${rec.company ? ' @ ' + rec.company : ''}  [${category}]  ${norm.length} skills`);
  if (roleClean.toLowerCase() !== role.toLowerCase()) console.log(`  cleaned label: ${roleClean}`);
  const changed = norm.filter((n, i) => n !== raw[i].toLowerCase());
  if (changed.length) console.log(`  normalized: ${changed.join(', ')}`);
  console.log(`  total postings on file: ${records.length + 1}`);
}

function cmdList(flags) {
  const records = loadRecords();
  const filtered = flags.category
    ? records.filter(r => r.category === String(flags.category).toLowerCase())
    : records;
  if (!filtered.length) { console.log('no records.'); return; }
  const n = parseInt(flags.limit || '20', 10);
  for (const r of filtered.slice(-n)) {
    const label = r.roleClean && r.roleClean.toLowerCase() !== r.role.toLowerCase()
      ? `${r.role} → ${r.roleClean}` : r.role;
    console.log(`${r.added}  [${r.category}]  ${label}${r.company ? ' @ ' + r.company : ''}  (${r.skills.length} skills)`);
  }
  console.log(`\n${filtered.length} posting(s)${flags.category ? ' in ' + flags.category : ''}, showing last ${Math.min(n, filtered.length)}.`);
}

function tally(records) {
  const counts = new Map();
  for (const r of records) for (const s of new Set(r.skills)) counts.set(s, (counts.get(s) || 0) + 1);
  return counts;
}

function cmdStats(flags) {
  const all = loadRecords();
  if (!all.length) { console.log('no records yet — add some with `jd-skills add`.'); return; }
  const cats = flags.category
    ? [String(flags.category).toLowerCase()]
    : [...new Set(all.map(r => r.category))].sort();
  const top = parseInt(flags.top || '25', 10);

  for (const cat of cats) {
    const rows = all.filter(r => r.category === cat);
    if (!rows.length) { console.log(`\n== ${cat} ==\n  (no postings)`); continue; }
    const counts = [...tally(rows).entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    console.log(`\n== ${cat} == ${rows.length} posting(s)`);
    if (rows.length < 5) console.log(`  ⚠ ${rows.length} posting(s) — too few to read as a distribution. Treat as anecdote.`);
    const width = Math.max(...counts.slice(0, top).map(c => c[0].length));
    for (const [skill, n] of counts.slice(0, top)) {
      const p = pct(n, rows.length);
      const bar = '█'.repeat(Math.round(p / 5));
      console.log(`  ${skill.padEnd(width)}  ${String(n).padStart(3)}  ${p.toFixed(0).padStart(3)}%  ${bar}`);
    }
    if (counts.length > top) console.log(`  ... and ${counts.length - top} more skills seen at least once`);
  }
}

function cmdCompare(positional, flags) {
  const [a, b] = positional.map(s => String(s).toLowerCase());
  if (!a || !b) { console.error('usage: jd-skills compare <categoryA> <categoryB> [--top N] [--min-count N]'); process.exit(1); }
  const all = loadRecords();
  const rowsA = all.filter(r => r.category === a);
  const rowsB = all.filter(r => r.category === b);
  if (!rowsA.length || !rowsB.length) {
    console.error(`error: need postings in both categories (${a}: ${rowsA.length}, ${b}: ${rowsB.length}).`);
    process.exit(1);
  }
  const top = parseInt(flags.top || '15', 10);
  const minCount = parseInt(flags['min-count'] || '2', 10);
  const ca = tally(rowsA), cb = tally(rowsB);
  const skills = new Set([...ca.keys(), ...cb.keys()]);

  // Additive smoothing so a skill absent from one side doesn't divide by zero.
  const rows = [];
  for (const s of skills) {
    const na = ca.get(s) || 0, nb = cb.get(s) || 0;
    if (na + nb < minCount) continue;
    const pa = (na + 0.5) / (rowsA.length + 1);
    const pb = (nb + 0.5) / (rowsB.length + 1);
    rows.push({ s, na, nb, pa, pb, lift: pa / pb });
  }
  rows.sort((x, y) => y.lift - x.lift);

  console.log(`\n${a} (${rowsA.length} postings)  vs  ${b} (${rowsB.length} postings)`);
  console.log(`Lift = how much more often a skill appears in ${a} than ${b}. Frequency alone is dominated by\nskills every posting lists; lift is what actually distinguishes the two.\n`);
  const fmt = r => `  ${r.s.padEnd(30)} ${a}:${String(r.na).padStart(3)} (${pct(r.na, rowsA.length).toFixed(0)}%)   ${b}:${String(r.nb).padStart(3)} (${pct(r.nb, rowsB.length).toFixed(0)}%)   lift ${r.lift.toFixed(2)}x`;
  const favA = rows.filter(r => r.lift > 1.25).slice(0, top);
  const favB = rows.filter(r => r.lift < 0.8).slice(-top).reverse();
  console.log(`-- distinctive to ${a} --`);
  favA.length ? favA.forEach(r => console.log(fmt(r))) : console.log('  (nothing yet leans this way)');
  console.log(`\n-- distinctive to ${b} --`);
  favB.length ? favB.forEach(r => console.log(fmt(r))) : console.log('  (nothing yet leans this way)');
  const shared = rows.filter(r => r.lift > 0.8 && r.lift < 1.25).sort((x, y) => (y.na + y.nb) - (x.na + x.nb));
  if (shared.length) {
    console.log(`\n-- common to both (table stakes, no signal) --`);
    shared.slice(0, 10).forEach(r => console.log(fmt(r)));
  }
  if (rowsA.length < 5 || rowsB.length < 5) console.log(`\n⚠ Small samples. Lift is noisy below ~5 postings per side; read directionally, not as fact.`);
}

function cmdRenormalize() {
  const aliases = loadAliases();
  const records = loadRecords();
  let changed = 0;
  for (const r of records) {
    const before = JSON.stringify(r.skills);
    const seen = new Set(); const norm = [];
    for (const raw of r.raw) {
      const n = normalizeSkill(raw, aliases);
      if (!n || seen.has(n)) continue;
      seen.add(n); norm.push(n);
    }
    r.skills = norm;
    if (JSON.stringify(r.skills) !== before) changed++;
  }
  writeAll(records);
  console.log(`renormalized ${records.length} record(s) from the untouched raw column; ${changed} changed.`);
}

function cmdExport(flags) {
  const records = loadRecords();
  if (flags.format === 'csv') {
    console.log('added,category,level,company,role,roleClean,skill');
    for (const r of records) for (const s of r.skills) {
      const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
      console.log([r.added, r.category, r.level || '', r.company || '', r.role, r.roleClean || '', s].map(esc).join(','));
    }
  } else {
    console.log(JSON.stringify(records, null, 2));
  }
}

function usage() {
  console.log(`jd-skills — job-description skill distribution tracker

  add          --role R --role-clean R2 --category C [--company X] [--level intern]
               [--url U] [--keywords "a, b, c"]   (or pipe the list on stdin)
               --role is the verbatim posting title; --role-clean is what the role
               really is, judged from the JD (repeat the title if already accurate).
  list         [--category C] [--limit N]
  stats        [--category C] [--top N]
  compare      <catA> <catB> [--top N] [--min-count N]
  renormalize                                (replay aliases.json over raw)
  export       [--format csv|json]

Categories are free text — whatever you consistently use (swe, mle, ds, quant, infra).

Paste workflow:
  jd-skills add --role "ML Engineer Intern" --company Scale --category mle <<'END'
  Python
  PyTorch
  Distributed Systems
  END

Data: data.jsonl (append-only; \`raw\` is never rewritten). Aliases: aliases.json.`);
}

const { flags, positional } = parseArgs(process.argv.slice(2));
const cmd = positional.shift();
switch (cmd) {
  case 'add': cmdAdd(flags); break;
  case 'list': cmdList(flags); break;
  case 'stats': cmdStats(flags); break;
  case 'compare': cmdCompare(positional, flags); break;
  case 'renormalize': cmdRenormalize(); break;
  case 'export': cmdExport(flags); break;
  default: usage();
}
