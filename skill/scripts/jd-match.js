#!/usr/bin/env node
/**
 * jd-match — deterministic JD → skills list (Bespoke Resume Workflow, Felix's
 * pivot 2026-09-03). Scans the posting's own text for concrete languages,
 * frameworks, tools, databases and platforms from assets/lexicon.json and
 * returns them ordered by how much the JD leans on them. Replaces Simplify's
 * skill chips as the primary tailoring input (chips were broad concept words:
 * "concurrency", "distributed computing").
 *
 * Usage (CLI):
 *   jd-match.js --file jd.txt [--requirements req.json] [--json]
 *   cat jd.txt | jd-match.js
 * Module:
 *   const { matchJD } = require('./jd-match');
 *   matchJD({ text, requirements: [...] }) → { skills: ['python', ...],  // canonical, ordered
 *                                              hits: [{name, cat, score, count}],
 *                                              boost: ['node.js', ...] }   // snapshot skills to pull forward
 *
 * Scoring: every match counts 1; a match inside a requirements/qualifications
 * line (explicit `requirements` array or a heading-delimited region of the
 * text) adds 3 more, so a requirements mention scores 4 in total. Ties break by
 * lexicon category order (languages first), then by first position in the text. `boost` = verified snapshot skills that share a lexicon
 * category with any JD hit and were not themselves matched — apply-skills.js
 * uses it to order the filler so a frontend JD pulls the web stack forward and
 * a systems JD pulls C/Linux/GDB forward, instead of one fixed tail everywhere.
 */
const fs = require('fs');
const path = require('path');

const ASSETS = path.join(__dirname, '..', 'assets');
const LEX = JSON.parse(fs.readFileSync(path.join(ASSETS, 'lexicon.json'), 'utf8'));
const SNAP = JSON.parse(fs.readFileSync(path.join(ASSETS, 'snapshot.json'), 'utf8'));
const CAT_ORDER = new Map(LEX.categories.map((c, i) => [c, i]));

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Alias → regex: word boundaries that also work for tokens ending in + # . /
function aliasRe(a) {
  const body = esc(a);
  const lead = /^[A-Za-z0-9]/.test(a) ? '(?<![A-Za-z0-9])' : '(?<!\\S)';
  const tail = /[A-Za-z0-9]$/.test(a) ? '(?![A-Za-z0-9])' : '(?!\\S)';
  return new RegExp(lead + body + tail, 'gi');
}
const COMPILED = LEX.entries.map(e => ({
  ...e,
  res: e.pattern ? [new RegExp(e.pattern, 'g')] : (e.aliases || [e.name]).map(aliasRe),
}));

// Requirements/qualifications region of a JD: heading → next heading (or 1500 chars).
const REQ_HEAD = /(?:^|\n)\s*(?:(?:minimum|basic|required|preferred|desired|technical)\s+)?(?:qualifications|requirements|skills?(?: and experience)?|what (?:you|we)(?:'ll| will)? (?:bring|need|look for)|you (?:have|bring|are)|must have|nice to have)\s*:?\s*\n/gi;
function requirementRegions(text) {
  const out = [];
  let m;
  while ((m = REQ_HEAD.exec(text))) {
    const start = m.index + m[0].length;
    out.push(text.slice(start, start + 1500));
  }
  return out;
}

function matchJD({ text = '', requirements = [] } = {}) {
  const body = String(text || '');
  const reqText = [...(requirements || []).map(String), ...requirementRegions(body)].join('\n');
  const hits = [];
  for (const e of COMPILED) {
    let count = 0, reqCount = 0, first = Infinity;
    for (const re of e.res) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(body))) { count++; first = Math.min(first, m.index); if (m.index === re.lastIndex) re.lastIndex++; }
      re.lastIndex = 0;
      while ((m = re.exec(reqText))) { reqCount++; if (m.index === re.lastIndex) re.lastIndex++; }
    }
    if (!count && !reqCount) continue;
    hits.push({ name: e.name, cat: e.cat, count: count + reqCount, score: count + 3 * reqCount, first: first === Infinity ? 1e9 : first });
  }
  hits.sort((a, b) => b.score - a.score || CAT_ORDER.get(a.cat) - CAT_ORDER.get(b.cat) || a.first - b.first);
  const skills = hits.map(h => h.name);
  const hitSet = new Set(skills);
  // Boost (lexicon.kin): explicit trigger → boost groups. Only snapshot-verified
  // skills, never ones the JD already named, in snapshot order.
  const want = new Set();
  for (const g of Object.values(LEX.kin || {})) {
    if (!g || !Array.isArray(g.triggers)) continue;
    if (g.triggers.some(t => hitSet.has(t))) for (const b of g.boost || []) want.add(b);
  }
  const boost = (SNAP.verified || []).map(s => String(s).toLowerCase()).filter(s => !hitSet.has(s) && want.has(s));
  return { skills, hits: hits.map(({ first, ...h }) => h), boost };
}

// canonical(chip): map a Simplify chip (or any free-text skill) onto a lexicon
// name, or null when it is a concept word the lexicon deliberately omits
// ("Distributed Systems", "Web Development"). Used to keep only the CONCRETE
// chips as a secondary source behind the JD text.
function canonical(chip) {
  const t = String(chip || '').trim();
  if (!t) return null;
  const low = t.toLowerCase();
  for (const e of COMPILED) {
    if (e.name === low) return e.name;
    if ((e.aliases || []).some(a => a.toLowerCase() === low)) return e.name;
  }
  // Regex fallback for chips like "React.js (frontend)": the matched alias must
  // cover at least half the chip, so a long chip that merely contains "Java"
  // does not collapse onto java.
  for (const e of COMPILED) for (const re of e.res) {
    re.lastIndex = 0; const m = re.exec(t); re.lastIndex = 0;
    if (m && m[0].length * 2 >= t.replace(/\s*\(.*\)\s*$/, '').length) return e.name;
  }
  return null;
}

module.exports = { matchJD, canonical };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i === -1 ? d : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true); };
  const text = opt('file', null) ? fs.readFileSync(opt('file'), 'utf8') : fs.readFileSync(0, 'utf8');
  const requirements = opt('requirements', null) ? JSON.parse(fs.readFileSync(opt('requirements'), 'utf8')) : [];
  const r = matchJD({ text, requirements });
  if (opt('json', false)) console.log(JSON.stringify(r, null, 1));
  else { console.log(r.skills.join('\n')); console.error(`jd-match: ${r.skills.length} skills, boost ${r.boost.length}: ${r.hits.map(h => `${h.name}(${h.score})`).join(' ')}`); }
}
