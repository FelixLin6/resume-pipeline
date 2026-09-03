#!/usr/bin/env node
/**
 * tailor-batch — tailor every selected posting of a run in one deterministic
 * pass, BEFORE the appliers start (2026-09-02: tailoring used to run inside
 * each applier under a global lock, one compile loop at a time, on the
 * critical path of every application).
 *
 * Bespoke Resume Workflow (Felix's pivot 2026-09-03): the tailoring input is the
 * posting's OWN text, matched deterministically against assets/lexicon.json by
 * jd-match.js (languages/frameworks/tools/databases/platforms). Simplify's chips
 * are the fallback only when no JD text is on file. JD text comes from the run's
 * jdfacts.json (sibling of joblist.json, written by jd-fetch.js): requirements +
 * description (+ jd_text for ATS-resolved rows). Each job tailors on its own
 * local branch of my_resume (apply-<key8>), never pushed.
 *
 * Per selected row: jd-skills add (dataset) → apply-skills.js (Skills section
 * tailored, one page) → PDF written straight into the resume-drops day folder.
 * Rows run in parallel LANES, each lane a git worktree of my_resume, so the
 * shared checkout is never touched and nothing serializes except the two
 * tiny dataset/state writes (which self-lock).
 *
 * Usage:
 *   tailor-batch.js --joblist <runs/YYYY-MM-DD/joblist.json>
 *                   [--keys k1,k2,...]   only these selected keys (default: all selected)
 *                   [--lanes N]          parallel worktrees (default min(4, cpus-1))
 *                   [--day-dir <dir>]    PDF destination (default resume-drops/<date>/)
 *                   [--out <tailor.json>] (default <run dir>/tailor.json, merged on re-run)
 *                   [--dry-run]          print the plan, run nothing
 *
 * Output: tailor.json — per key {status: tailored|skipped-repost|failed, pdf,
 * kept/jd_kept/filler_kept, dropped_jd, study, error}. Appliers read the PDF
 * path from here and never tailor themselves. Re-running is idempotent: keys
 * already `tailored` in tailor.json are skipped unless --force.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const HOME = process.env.HOME;
const REPO = process.env.RESUME_REPO || `${HOME}/zylos/workspace/my_resume`;
const SCRIPTS = __dirname;
const STATE_DIR = `${HOME}/zylos/vault/jd-pipeline`;
const LANES_DIR = path.join(STATE_DIR, 'lanes');
const JD_SKILLS = `${HOME}/zylos/vault/jd-skills/jd-skills.js`;
const DROPS = `${HOME}/zylos/workspace/resume-drops`;

// One batch at a time (Stage 3 may re-invoke it for a missed row while a wave-2 batch runs).
if (!process.env.ZYLOS_TAILOR_BATCH_LOCKED) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const r = spawnSync('flock', [path.join(STATE_DIR, '.tailor-batch.lock'), process.execPath, __filename, ...process.argv.slice(2)],
    { stdio: 'inherit', env: { ...process.env, ZYLOS_TAILOR_BATCH_LOCKED: '1' } });
  process.exit(r.status === null ? 1 : r.status);
}

// ---------- args ----------
function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq !== -1) flags[a.slice(2, eq)] = a.slice(eq + 1);
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) flags[a.slice(2)] = argv[++i];
    else flags[a.slice(2)] = true;
  }
  return flags;
}
const flags = parseArgs(process.argv.slice(2));
if (!flags.joblist || flags.joblist === true) {
  console.error('usage: tailor-batch.js --joblist <path> [--keys a,b] [--lanes N] [--day-dir D] [--out F] [--dry-run] [--force]');
  process.exit(2);
}
const joblistPath = path.resolve(flags.joblist);
const joblist = JSON.parse(fs.readFileSync(joblistPath, 'utf8'));
const runDir = path.dirname(joblistPath);
const date = joblist.date || path.basename(runDir);
const dayDir = flags['day-dir'] && flags['day-dir'] !== true ? path.resolve(flags['day-dir']) : path.join(DROPS, date);
const outPath = flags.out && flags.out !== true ? path.resolve(flags.out) : path.join(runDir, 'tailor.json');
const wantKeys = flags.keys && flags.keys !== true ? new Set(String(flags.keys).split(',').map(s => s.trim()).filter(Boolean)) : null;
const lanesN = Math.max(1, parseInt(flags.lanes || String(Math.min(4, Math.max(1, os.cpus().length - 1))), 10));

const prior = fs.existsSync(outPath) ? JSON.parse(fs.readFileSync(outPath, 'utf8')) : { date, rows: {} };
prior.rows ||= {};

const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
function categoryFor(row) {
  const t = `${row.role_clean || ''} ${row.title || ''}`.toLowerCase();
  if (/quant|trading/.test(t)) return 'quant';
  if (/data scien|data analy|analytics/.test(t)) return 'ds';
  if (/machine learning|ml engineer|\bml\b|\bai\b|ai\/ml|deep learning/.test(t)) return 'mle';
  if (/infrastructure|devops|\bsre\b|site reliability|platform|cloud/.test(t)) return 'infra';
  return 'swe';
}

const rows = (joblist.rows || []).filter(r => r.status === 'selected' && (!wantKeys || wantKeys.has(r.key)));
const todo = rows.filter(r => flags.force || prior.rows[r.key]?.status !== 'tailored');
const missing = wantKeys ? [...wantKeys].filter(k => !rows.some(r => r.key === k)) : [];
if (missing.length) console.error(`warning: ${missing.length} requested key(s) are not selected rows in the joblist: ${missing.join(', ')}`);

console.log(`tailor-batch ${date}: ${rows.length} selected row(s), ${todo.length} to tailor, ${lanesN} lane(s)\n  PDFs → ${dayDir}\n  report → ${outPath}`);
if (flags['dry-run']) {
  for (const r of todo) console.log(`  - [${r.email_order ?? '?'}] ${r.company} — ${r.title} (${categoryFor(r)}, ${(r.skills || []).length} skills)`);
  process.exit(0);
}
if (!todo.length) { console.log('nothing to do'); process.exit(0); }

// ---------- lanes: one detached worktree of my_resume per lane ----------
function git(dir, ...args) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} in ${dir}: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout.trim();
}
fs.mkdirSync(LANES_DIR, { recursive: true });
try { git(REPO, 'worktree', 'prune'); } catch {}
const lanes = [];
for (let i = 1; i <= lanesN; i++) {
  const dir = path.join(LANES_DIR, `lane${i}`);
  if (!fs.existsSync(path.join(dir, '.git'))) {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    git(REPO, 'worktree', 'add', '--detach', dir, 'main');
  } else {
    // apply-skills.js re-forks from main itself; just make sure the lane is not
    // sitting on foreign changes (it refuses to run over those, by design).
    const dirty = git(dir, 'status', '--porcelain').split('\n').filter(Boolean).filter(l => !/resume\.(tex|pdf)$/.test(l));
    if (dirty.length) throw new Error(`lane worktree ${dir} has foreign changes:\n${dirty.join('\n')}`);
  }
  lanes.push({ i, dir, branch: `apply-lane${i}` });
}
fs.mkdirSync(dayDir, { recursive: true });
fs.mkdirSync(path.join(runDir, 'tailor'), { recursive: true });

// ---------- per-row work ----------
function run(cmd, args, opts = {}) {
  return new Promise(resolve => {
    const p = spawn(cmd, args, { env: { ...process.env, ...(opts.env || {}) }, cwd: opts.cwd });
    let out = '', err = '';
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => err += d);
    if (opts.stdin !== undefined) { p.stdin.write(opts.stdin); }
    p.stdin.end();
    p.on('close', code => resolve({ code, out, err }));
  });
}

const { matchJD, canonical } = require(path.join(SCRIPTS, 'jd-match.js'));
const MIN_JD_MATCHES = 3;
// jdfacts.json sits next to joblist.json (Stage 1 writes both). Index by key.
const jdFacts = (() => {
  const f = path.join(path.dirname(joblistPath), 'jdfacts.json');
  if (!fs.existsSync(f)) { console.error(`tailor-batch: no ${f} — falling back to Simplify chips for every row`); return new Map(); }
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  const rows = Array.isArray(j) ? j : (j.rows || []);
  return new Map(rows.filter(r => r && r.key).map(r => [r.key, r]));
})();
function jdInputFor(row) {
  const f = jdFacts.get(row.key);
  const text = f ? [f.jd_text, f.description, ...(f.requirements || [])].filter(Boolean).join('\n') : '';
  const chips = (row.skills || []).filter(Boolean);
  // Concrete chips only: a chip that maps onto the lexicon is real signal from the same JD;
  // concept chips ("Distributed Systems", "Web Development") are what Felix wants gone.
  const concrete = [...new Set(chips.map(canonical).filter(Boolean))];
  if (text.trim()) {
    const m = matchJD({ text, requirements: f.requirements || [] });
    const merged = [...new Set([...m.skills, ...concrete])];
    if (m.skills.length >= MIN_JD_MATCHES) return { skills: merged, boost: m.boost, source: 'jd-text', matched: m.skills.length, chips_kept: merged.length - m.skills.length };
    if (concrete.length) return { skills: merged, boost: m.boost, source: 'jd-text+chips', matched: m.skills.length, chips_kept: concrete.length, note: `only ${m.skills.length} lexicon hits in JD text` };
    return { skills: chips, boost: m.boost, source: 'simplify', matched: m.skills.length, note: 'no lexicon hits and no concrete chips — raw chips' };
  }
  if (concrete.length) return { skills: concrete, boost: [], source: 'chips', matched: 0, chips_kept: concrete.length, note: 'no JD text on file' };
  return { skills: chips, boost: [], source: 'simplify', matched: 0, note: 'no JD text on file, raw chips' };
}

async function tailorRow(row, lane) {
  const input = jdInputFor(row);
  const skills = input.skills;
  const rec = { company: row.company, title: row.title, lane: lane.i, started: new Date().toISOString(),
    skills_source: input.source, jd_matched: input.matched, chips_kept: input.chips_kept || 0, ...(input.note ? { source_note: input.note } : {}) };
  if (!skills.length) return { ...rec, status: 'failed', error: 'row has no skills list (no JD text and no chips)' };
  const stdin = skills.join('\n') + '\n';

  // 1. dataset row — a duplicate refusal means repost: mark seen, no tailoring.
  const addArgs = ['add', '--role', row.title, '--role-clean', row.role_clean || row.title,
    '--company', row.company, '--category', categoryFor(row), '--level', 'intern',
    '--source', input.source];
  if (row.apply_link) addArgs.push('--url', row.apply_link);
  const add = await run(process.execPath, [JD_SKILLS, ...addArgs], { stdin });
  if (add.code !== 0) {
    if (/already have/i.test(add.err)) {
      await run(process.execPath, [path.join(SCRIPTS, 'pipeline-check.js'), 'mark', row.key]);
      return { ...rec, status: 'skipped-repost', error: add.err.trim().split('\n')[0] };
    }
    return { ...rec, status: 'failed', error: `jd-skills add: ${add.err.trim()}` };
  }

  // 2. tailor in this lane's worktree, PDF straight into the day folder.
  const pdfName = `${date}-${slug(row.company)}-${slug(row.title).slice(0, 48)}.pdf`.replace(/-+\.pdf$/, '.pdf');
  const pdf = path.join(dayDir, pdfName);
  const report = path.join(runDir, 'tailor', `${slug(row.key).slice(0, 60)}.json`);
  const ap = await run(process.execPath, [path.join(SCRIPTS, 'apply-skills.js'),
    '--company', row.company, '--role', row.title, '--out', pdf, '--json', report,
    ...(input.boost.length ? ['--boost', input.boost.join(',')] : [])],
  { stdin, env: { RESUME_REPO: lane.dir, RESUME_APPLY_BRANCH: `apply-${String(row.key).replace(/[^0-9a-z]/gi, '').slice(0, 8)}` } });
  if (ap.code !== 0 || !fs.existsSync(pdf)) {
    return { ...rec, status: 'failed', error: `apply-skills: ${(ap.err || ap.out).trim().slice(-600)}` };
  }
  const j = JSON.parse(fs.readFileSync(report, 'utf8'));
  let commit = null;
  try { commit = git(lane.dir, 'rev-parse', 'HEAD'); } catch {}
  return {
    ...rec, status: 'tailored', pdf, pdf_name: pdfName, pages: j.pages, fit: j.fit,
    kept: j.kept.length, jd_kept: j.jd_kept, filler_kept: j.filler_kept.length,
    dropped_jd: j.dropped_jd, study: j.study, commit,
  };
}

(async () => {
  const queue = todo.slice();
  const results = {};
  const t0 = Date.now();
  async function worker(lane) {
    for (;;) {
      const row = queue.shift();
      if (!row) return;
      let res;
      try { res = await tailorRow(row, lane); } catch (e) { res = { company: row.company, title: row.title, status: 'failed', error: e.message }; }
      results[row.key] = res;
      const tag = res.status === 'tailored' ? `${res.kept} skills (${res.jd_kept.length} JD), ${res.fit}` : res.error;
      console.log(`  [lane${lane.i}] ${res.status.padEnd(15)} ${row.company} — ${row.title}: ${tag}`);
    }
  }
  await Promise.all(lanes.map(worker));

  // merge + write report
  const out = { date, joblist: joblistPath, day_dir: dayDir, updated: new Date().toISOString(), rows: { ...prior.rows, ...results } };
  fs.writeFileSync(outPath, JSON.stringify(out, null, 1));

  // keep `apply` pointing at the last tailored commit so Stage 3's single
  // "push apply" still means something; skipped if the main checkout is
  // sitting on apply with foreign changes.
  const last = Object.values(results).filter(r => r.status === 'tailored' && r.commit).pop();
  if (last) {
    try {
      const cur = git(REPO, 'rev-parse', '--abbrev-ref', 'HEAD');
      if (cur === 'apply') {
        const dirty = git(REPO, 'status', '--porcelain').split('\n').filter(Boolean);
        if (dirty.some(l => !/resume\.(tex|pdf)$/.test(l))) throw new Error('main checkout on apply with foreign changes');
        if (dirty.length) git(REPO, 'checkout', '--', '.');
        git(REPO, 'checkout', '-q', 'main');
      }
      git(REPO, 'branch', '-f', 'apply', last.commit);
    } catch (e) { console.error(`warning: could not move apply → ${last.commit.slice(0, 7)}: ${e.message}`); }
  }

  const n = s => Object.values(results).filter(r => r.status === s).length;
  const study = [...new Set(Object.values(results).flatMap(r => r.study || []))];
  const droppedJd = Object.values(results).filter(r => r.dropped_jd?.length).map(r => `${r.company}: ${r.dropped_jd.join(', ')}`);
  console.log(`\ndone in ${((Date.now() - t0) / 1000).toFixed(0)}s — tailored ${n('tailored')}, skipped-repost ${n('skipped-repost')}, failed ${n('failed')}`);
  if (droppedJd.length) console.log(`⚠ JD skills that did not fit:\n  ${droppedJd.join('\n  ')}`);
  if (study.length) console.log(`study list (${study.length}): ${study.join(' · ')}`);
  console.log(`report: ${outPath}`);
  process.exit(n('failed') ? 1 : 0);
})();
