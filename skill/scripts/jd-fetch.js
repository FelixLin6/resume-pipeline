#!/usr/bin/env node
/**
 * jd-fetch — Stage 1 step 2: visit every posting link from the SWElist email in
 * parallel and emit the facts triage needs, so the model never curls per row.
 *
 *   jd-fetch.js <rows.json | joblist.json> [--out jdfacts.json] [--concurrency 8]
 *               [--timeout 20] [--compact jdfacts-compact.json]
 *
 * Input: swelist-fetch.py output ({rows:[{idx,company,title,link}]}) or any
 * joblist-shaped file whose rows carry a `link`.
 * Output (--out): {date, source_email, rows:[...]} — per row:
 *   idx, company, title, link, final_url, status, key,
 *   resolved: "simplify" | "ats" | "error",
 *   already_seen (key in ~/zylos/vault/jd-pipeline/state.json — read-only),
 *   Simplify rows: skills[], skills_source:"simplify", degrees[] (labels),
 *     seasons[] (labels, e.g. "Summer 2027"), title_term (regex on the title —
 *     the Simplify season tag is known to disagree with titles), requirements[],
 *     degree_text, term_text (sentences mentioning degree / term, for triage),
 *     additional_requirements[] (labels: US Authorization / US Citizenship /
 *     clearance...), sponsors_h1b, locations[], countries[], remote, ats,
 *     ats_click_url (Simplify's redirect to the ATS), apply_link (the Simplify
 *     page — what the day README links), salary, posting_title, posting_company,
 *     active
 *   non-Simplify rows: jd_text (visible text, ≤6KB), skills_source:"jd-text-needed"
 *   error rows: error, status (403 = edge-blocked; fall back per SKILL.md)
 * --compact writes a slim per-row view (no jd_text/requirements) for the model.
 * No npm deps. Never writes state.
 */
const fs = require('fs');
const path = require('path');
const { roleGate } = require(path.join(__dirname, 'role-gate.js'));
const { URL } = require('url');
const http = require('http');
const https = require('https');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const STATE = `${process.env.HOME}/zylos/vault/jd-pipeline/state.json`;

// Enums confirmed 2026-09-02 from simplify.jobs' _app bundle (degrees, additional
// requirements) and from rendered pages (seasons: 1 Winter, 2 Spring, 3 Summer, 4 Fall).
const DEGREES = { 1: "Bachelor's", 2: "Master's", 3: 'MBA', 4: 'PharmD', 5: 'PhD', 6: "Associate's", 7: 'JD', 8: 'MD',
  9: 'Bootcamp', 10: 'Certification', 11: 'Incomplete', 12: 'Bachelor of Arts (BA)', 13: 'Bachelor of Science (BS)',
  14: 'Bachelor of Fine Arts (BFA)', 15: 'Bachelor of Business Administration (BBA)', 16: 'Master of Arts (MA)',
  17: 'Master of Science (MS)', 18: 'MFA', 19: 'MEng', 20: 'AA', 21: 'AS', 22: 'DO', 23: 'DDS', 24: 'DVM' };
const SEASONS = { 1: 'Winter', 2: 'Spring', 3: 'Summer', 4: 'Fall' };
const ADDREQ = { 1: 'US Authorization', 2: 'US Citizenship', 3: 'US Top Secret Clearance', 4: 'Canada Authorization',
  5: 'Canada Citizenship', 6: 'Canada Top Secret Clearance', 7: 'UK Authorization', 8: 'UK Citizenship',
  9: 'UK Top Secret Clearance' };
const SALARY_PERIOD = { 1: 'hour', 2: 'year', 3: 'month', 4: 'week' };

// ---------- args ----------
const argv = process.argv.slice(2);
const flags = {}; const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) { const k = a.slice(2); if (argv[i + 1] && !argv[i + 1].startsWith('--')) flags[k] = argv[++i]; else flags[k] = true; }
  else positional.push(a);
}
if (!positional[0]) { console.error('usage: jd-fetch.js <rows.json> [--out jdfacts.json] [--compact jdfacts-compact.json] [--concurrency 8] [--timeout 20]'); process.exit(2); }
const CONC = parseInt(flags.concurrency || '8', 10);
const TIMEOUT = parseInt(flags.timeout || '20', 10) * 1000;

const input = JSON.parse(fs.readFileSync(positional[0], 'utf8'));
const rows = (input.rows || input).map((r, i) => ({ idx: r.idx ?? r.email_order ?? i + 1, company: r.company, title: r.title ?? r.email_title, link: r.link ?? r.apply_link }));
let seen = {};
try { seen = JSON.parse(fs.readFileSync(STATE, 'utf8')).seen || {}; } catch { /* no state yet */ }

// ---------- fetch with manual redirects ----------
function get(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    let u; try { u = new URL(url); } catch (e) { return reject(new Error('bad url')); }
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.get(u, { headers: { 'user-agent': UA, accept: 'text/html,*/*' }, timeout: TIMEOUT }, res => {
      const loc = res.headers.location;
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && loc && redirects < 8) {
        res.resume();
        return resolve(get(new URL(loc, u).toString(), redirects + 1));
      }
      const chunks = []; let size = 0;
      res.on('data', c => { size += c.length; if (size < 3_000_000) chunks.push(c); });
      res.on('end', () => resolve({ status: res.statusCode, url: u.toString(), body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}
async function fetchRetry(url) {
  try { return await get(url); } catch (e) {
    await new Promise(r => setTimeout(r, 1500));
    return get(url);
  }
}

// ---------- parsing ----------
const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
function stripHtml(h) {
  return h.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ').trim();
}
const TERM_RE = /\b(summer|fall|autumn|spring|winter)\s*(20\d\d)?\b|\b(20\d\d)\b|\bco-?op\b|\b\d+[- ](week|month)s?\b/i;
const DEGREE_RE = /\b(bachelor|master|phd|ph\.d|doctoral|b\.?s\.?|m\.?s\.?|degree|pursuing|undergraduate|graduate student|junior|senior|sophomore|freshman|class of)\b/i;
function sentencesMatching(texts, re, cap = 400) {
  const out = [];
  for (const t of texts) for (const s of String(t).split(/(?<=[.;])\s+|\n+/)) if (re.test(s)) out.push(s.trim());
  return out.join(' | ').slice(0, cap) || null;
}
function titleTerm(title) {
  const m = String(title).match(/\b(summer|fall|autumn|spring|winter)\b\s*'?(20\d\d|\d\d)?/i);
  if (!m) return null;
  const y = m[2] ? (m[2].length === 2 ? '20' + m[2] : m[2]) : '';
  return (m[1][0].toUpperCase() + m[1].slice(1).toLowerCase() + (y ? ' ' + y : '')).replace('Autumn', 'Fall');
}

function parseSimplify(body, uuid, row, final) {
  const m = body.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return { resolved: 'error', error: 'no __NEXT_DATA__ on Simplify page', status: 200 };
  let jp;
  try { jp = JSON.parse(m[1]).props.pageProps.jobPosting; } catch (e) { return { resolved: 'error', error: 'bad __NEXT_DATA__ json' }; }
  if (!jp) return { resolved: 'error', error: 'jobPosting missing (posting removed?)' };
  const texts = [...(jp.requirements || []), ...(jp.responsibilities || []), ...(jp.desirable || []), stripHtml(jp.description || '')];
  const locs = (jp.locations || []).map(l => l.value).filter(Boolean);
  const ats = (jp.tracked_obj || '').split(':')[0] || null;
  return {
    resolved: 'simplify', key: uuid,
    apply_link: `https://simplify.jobs/p/${uuid}`, ats_click_url: jp.url || null, ats,
    posting_title: jp.title || null, posting_company: jp.job?.company?.name || null,
    active: jp.active !== false && jp.archive !== true,
    skills: (jp.skills || []).map(s => s.name).filter(Boolean), skills_source: 'simplify',
    degrees: (jp.degrees || []).map(d => DEGREES[d] || `code:${d}`),
    seasons: (jp.seasons || []).map(([s, y]) => `${SEASONS[s] || 'code:' + s} ${y}`),
    title_term: titleTerm(row.title),
    additional_requirements: (jp.additional_requirements || []).map(c => ADDREQ[c] || `code:${c}`),
    sponsors_h1b: jp.sponsors_h1b ?? null,
    locations: locs, countries: [...new Set((jp.locations || []).map(l => l.country).filter(Boolean))],
    remote: locs.some(l => /remote/i.test(l)),
    salary: jp.min_salary || jp.max_salary ? { min: jp.min_salary, max: jp.max_salary, per: SALARY_PERIOD[jp.salary_period] || jp.salary_period, currency: jp.currency_type } : null,
    functions: (jp.functions || []).map(f => f.title),
    requirements: (jp.requirements || []).slice(0, 25).map(s => String(s).slice(0, 400)),
    degree_text: sentencesMatching(texts, DEGREE_RE), term_text: sentencesMatching(texts, TERM_RE),
    description: stripHtml(jp.description || '').slice(0, 8000) || null, // full JD copy: jd-match.js scans it (2026-09-03; was 1500)
  };
}

async function processRow(row) {
  const base = { idx: row.idx, company: row.company, title: row.title, link: row.link };
  if (!row.link) return { ...base, resolved: 'error', error: 'no link', key: `email:${slug(row.company)}|${slug(row.title)}` };
  let res;
  try { res = await fetchRetry(row.link); } catch (e) {
    return { ...base, resolved: 'error', error: e.message, key: `email:${slug(row.company)}|${slug(row.title)}` };
  }
  const out = { ...base, final_url: res.url, status: res.status };
  const sm = res.url.match(/simplify\.jobs\/p\/([0-9a-f-]{36})/i);
  if (sm) {
    if (res.status !== 200) return { ...out, resolved: 'error', error: `HTTP ${res.status} from Simplify`, key: sm[1] };
    return { ...out, ...parseSimplify(res.body, sm[1], row, res.url) };
  }
  const key = `email:${slug(row.company)}|${slug(row.title)}`;
  if (res.status !== 200) return { ...out, resolved: 'error', error: `HTTP ${res.status} (edge-blocked? fall back to Simplify chips per SKILL.md)`, key };
  const text = stripHtml(res.body);
  return { ...out, resolved: 'ats', key, apply_link: res.url, skills: [], skills_source: 'jd-text-needed',
    title_term: titleTerm(row.title), degree_text: sentencesMatching([text], DEGREE_RE), term_text: sentencesMatching([text], TERM_RE),
    jd_text: text.slice(0, 6000) };
}

(async () => {
  const t0 = Date.now();
  const results = new Array(rows.length);
  let next = 0, done = 0;
  async function worker() {
    while (next < rows.length) {
      const i = next++;
      results[i] = await processRow(rows[i]);
      results[i].already_seen = !!seen[results[i].key];
      done++;
      if (done % 25 === 0) console.error(`  ${done}/${rows.length}`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, rows.length) }, worker));
  // Role gate (Felix's policy 2026-09-03): software / ML / AI engineering + adjacent only.
  for (const r of results) Object.assign(r, roleGate(r));
  const gateCounts = results.reduce((c, r) => { c[r.role_gate] = (c[r.role_gate] || 0) + 1; return c; }, {});
  const d = new Date(); const p = n => String(n).padStart(2, '0');
  const out = { date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`, source_email: input.email || null,
    generated_at: d.toISOString(), rows: results };
  const counts = results.reduce((c, r) => { c[r.resolved] = (c[r.resolved] || 0) + 1; if (r.already_seen) c.already_seen = (c.already_seen || 0) + 1; return c; }, {});
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (flags.out) {
    fs.mkdirSync(path.dirname(path.resolve(flags.out)), { recursive: true });
    fs.writeFileSync(flags.out, JSON.stringify(out, null, 1));
  } else process.stdout.write(JSON.stringify(out, null, 1));
  if (flags.compact) {
    // Slim, one row per line (NDJSON) so the triage model can read it in ranges.
    // Degree/term sentences appear ONLY when the structured tags are missing or
    // disagree with the title — the full jdfacts.json keeps everything.
    const BACHELORS = new Set(["Bachelor's", 'Bachelor of Arts (BA)', 'Bachelor of Science (BS)', 'Bachelor of Fine Arts (BFA)', 'Bachelor of Business Administration (BBA)']);
    const lines = results.map(r => {
      const o = { idx: r.idx, key: r.key, company: r.company, title: r.title };
      if (r.resolved !== 'simplify') { o.resolved = r.resolved; if (r.error) o.error = r.error; if (r.status) o.status = r.status; }
      if (r.already_seen) o.already_seen = true;
      if (r.active === false) o.active = false;
      if (r.posting_title && r.posting_title !== r.title) o.posting_title = r.posting_title;
      if (r.ats) o.ats = r.ats;
      o.skills = r.skills || []; o.skills_source = r.skills_source;
      o.role_gate = r.role_gate; if (r.role_gate !== 'keep') o.role_gate_reason = r.role_gate_reason;
      if (r.degrees) o.degrees = r.degrees;
      if (r.seasons) o.seasons = r.seasons;
      if (r.title_term) o.title_term = r.title_term;
      if (r.additional_requirements?.length) o.additional_requirements = r.additional_requirements;
      if (r.sponsors_h1b != null) o.sponsors_h1b = r.sponsors_h1b;
      if (r.locations) o.locations = r.locations;
      if (r.remote) o.remote = true;
      if (r.salary) o.salary = `${r.salary.currency || ''} ${Math.round(r.salary.min || 0)}-${Math.round(r.salary.max || 0)}/${r.salary.per}`.trim();
      const degreesOk = (r.degrees || []).some(d => BACHELORS.has(d));
      if (r.resolved !== 'error' && !degreesOk) { o.degree_check_needed = true; if (r.degree_text) o.degree_text = r.degree_text.slice(0, 240); }
      const termAgrees = !r.title_term || (r.seasons || []).some(s => s.startsWith(r.title_term.split(' ')[0]));
      if (r.resolved !== 'error' && (!(r.seasons || []).length || !termAgrees)) { o.term_check_needed = true; if (r.term_text) o.term_text = r.term_text.slice(0, 240); }
      return JSON.stringify(o);
    });
    fs.writeFileSync(flags.compact, lines.join('\n') + '\n');
  }
  console.error(`jd-fetch: ${rows.length} rows in ${secs}s — ${JSON.stringify(counts)} — role-gate ${JSON.stringify(gateCounts)}${flags.out ? ' -> ' + flags.out : ''}${flags.compact ? ' (+ ' + flags.compact + ')' : ''}`);
})();
