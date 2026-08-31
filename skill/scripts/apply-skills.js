#!/usr/bin/env node
/**
 * apply-skills — rewrite the Skills section of resume.tex on the `apply` branch
 * with a JD-derived keyword list, top up from the verified snapshot, and shrink
 * until the PDF is one page.
 *
 * Experience, Projects and Education are never touched.
 *
 * Usage:
 *   apply-skills.js --company Verkada [--role "SWE Intern"] [--keywords "a, b"] [--dry-run]
 *   ... or pipe the skill list on stdin.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = process.env.RESUME_REPO || `${process.env.HOME}/zylos/workspace/my_resume`;
const TEX = path.join(REPO, 'resume.tex');
const PDF = path.join(REPO, 'resume.pdf');
const TECTONIC = `${process.env.HOME}/zylos/workspace/bin/tectonic`;
const ASSETS = path.join(__dirname, '..', 'assets');
const SENT_DIR = `${process.env.HOME}/zylos/vault/resumes-sent`;

// ---------- concurrency: one tailoring run at a time (parallel appliers, 2026-08-29) ----------
// Own lock file, distinct from the pipeline's outer tailor.lock so the two
// compose instead of deadlocking. Whole-run lock: the my_resume checkout,
// its apply branch, and resumes-sent/ are all shared mutable state.
{
  const LOCK = `${process.env.HOME}/zylos/vault/jd-pipeline/.apply-skills.lock`;
  if (!process.env.ZYLOS_APPLY_SKILLS_LOCKED) {
    const r = require('child_process').spawnSync(
      'flock', [LOCK, process.execPath, __filename, ...process.argv.slice(2)],
      { stdio: 'inherit', env: { ...process.env, ZYLOS_APPLY_SKILLS_LOCKED: '1' } });
    process.exit(r.status === null ? 1 : r.status);
  }
}

const skillMap = JSON.parse(fs.readFileSync(path.join(ASSETS, 'skill-map.json'), 'utf8'));
const snapshot = JSON.parse(fs.readFileSync(path.join(ASSETS, 'snapshot.json'), 'utf8'));
const VERIFIED = new Set(snapshot.verified.map(s => s.toLowerCase()));

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

if (!flags.company) {
  console.error('error: --company is required (it names the archived PDF and the commit).');
  process.exit(1);
}

// ---------- input ----------
function readStdin() { try { return fs.readFileSync(0, 'utf8'); } catch { return ''; } }
const rawInput = (flags.keywords && flags.keywords !== true) ? flags.keywords : readStdin();
if (!rawInput.trim()) {
  console.error('error: no skills given. Pass --keywords "a, b, c" or pipe the list on stdin.');
  process.exit(1);
}

// Collapse common JD spellings onto the snapshot/skill-map vocabulary.
const ALIAS = {
  'golang': 'go', 'node': 'node.js', 'nodejs': 'node.js', 'postgres': 'postgresql',
  'k8s': 'kubernetes', 'amazon web services': 'aws', 'azure': 'microsoft azure',
  'rest': 'rest api', 'rest apis': 'rest api', 'restful apis': 'rest api',
  'ci/cd': 'ci-cd', 'google cloud': 'gcp', 'google cloud platform': 'gcp',
  'sqs': 'amazon sqs', 'react.js': 'react', 'reactjs': 'react',
  'llm': 'large language models', 'llms': 'large language models',
  'linux/unix': 'linux', 'apache kafka': 'kafka',
  'c/c++': 'c++', 'software testing': 'testing', 'version control': 'git',
  'computer networking': 'networking', 'vue.js': 'vue', 'ios/swift': 'swift',
  'rdbms': 'databases', 'infrastructure as code (iac)': 'terraform',
};
function norm(s) {
  const t = String(s).toLowerCase().trim()
    .replace(/\s+/g, ' ')
    .replace(/^[-•*]\s*/, '')
    .replace(/[.,;:]+$/g, '')
    .trim();
  return ALIAS[t] || t;
}
// Display form: keep a canonical casing for known skills, else Title-ish the input.
const DISPLAY = {
  'c': 'C', 'c++': 'C++', 'c#': 'C#', 'sql': 'SQL', 'html': 'HTML', 'css': 'CSS',
  'aws': 'AWS', 'gcp': 'GCP', 'gdb': 'GDB', 'ci-cd': 'CI/CD', 'rag': 'RAG',
  'rest api': 'REST APIs', 'api design': 'API Design', 'oauth': 'OAuth', 'go': 'Go',
  'node.js': 'Node.js', 'next.js': 'Next.js', 'postgresql': 'PostgreSQL',
  'sqlite': 'SQLite', 'mysql': 'MySQL', 'mongodb': 'MongoDB', 'dynamodb': 'DynamoDB',
  'amazon sqs': 'Amazon SQS', 'scikit-learn': 'scikit-learn', 'numpy': 'NumPy',
  'pytorch': 'PyTorch', 'tensorflow': 'TensorFlow', 'javascript': 'JavaScript',
  'typescript': 'TypeScript', 'standard ml': 'Standard ML', 'microsoft azure': 'Microsoft Azure',
  'llm evaluation': 'LLM Evaluation', 'large language models': 'LLMs',
  'data structures & algorithms': 'Data Structures & Algorithms',
  'low-latency': 'Low-Latency', 'high-throughput': 'High-Throughput',
  'high concurrency': 'High-Concurrency', 'key-value stores': 'Key-Value Stores',
  'github actions': 'GitHub Actions', 'react': 'React', 'graphql': 'GraphQL',
  'html/css': 'HTML/CSS', 'devops': 'DevOps', 'nosql': 'NoSQL', 'etl': 'ETL',
  'cuda': 'CUDA', 'jira': 'JIRA', 'openshift': 'OpenShift',
  'langchain': 'LangChain', '.net': '.NET',
};
function display(n) {
  if (DISPLAY[n]) return DISPLAY[n];
  return n.split(' ').map(w => w.length <= 2 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)).join(' ');
}
function texEscape(s) { return s.replace(/([&%$#_{}])/g, '\\$1'); }

const jdSkills = [];
const seen = new Set();
for (const part of rawInput.split(/[\n,]+/)) {
  const n = norm(part);
  if (!n || seen.has(n)) continue;
  seen.add(n);
  jdSkills.push(n);
}

// Snapshot top-up: verified skills the JD did not mention, in snapshot order.
const filler = snapshot.verified.map(norm).filter(s => !seen.has(s));

// ---------- render ----------
function rowsFor(list) {
  const rows = new Map(skillMap.rows.map(r => [r, []]));
  for (const s of list) {
    const row = skillMap.map[s] || skillMap.default;
    if (!rows.has(row)) rows.set(row, []);
    rows.get(row).push(display(s));
  }
  return rows;
}

function renderSkills(list) {
  const rows = rowsFor(list);
  const items = [];
  for (const row of skillMap.rows) {
    const vals = rows.get(row) || [];
    if (!vals.length) continue;
    items.push(
      '        \\item{\n' +
      `            \\textbf{${texEscape(row)}}{: ${vals.map(texEscape).join(', ')}}\n` +
      '        }'
    );
  }
  return '\\section{Skills}\n    \\resumeSubHeadingListStart\n' + items.join('\n') + '\n\\resumeSubHeadingListEnd';
}

const SECTION_RE = /\\section\{Skills\}[\s\S]*?\\resumeSubHeadingListEnd/;

function writeTex(list) {
  const original = fs.readFileSync(TEX, 'utf8');
  if (!SECTION_RE.test(original)) {
    console.error('error: could not locate the Skills section in resume.tex — aborting rather than guessing.');
    process.exit(1);
  }
  fs.writeFileSync(TEX, original.replace(SECTION_RE, renderSkills(list)));
}

function pageCount() {
  execFileSync(TECTONIC, ['resume.tex'], { cwd: REPO, stdio: 'pipe' });
  if (process.platform === 'darwin') {
    const out = execFileSync('swift', ['-e',
      'import Foundation; import PDFKit; let d = PDFDocument(url: URL(fileURLWithPath: CommandLine.arguments[1]))!; print(d.pageCount)',
      PDF], { encoding: 'utf8' });
    return parseInt(out.trim(), 10);
  }
  const out = execFileSync('python3', ['-c',
    'import sys;from pdfminer.high_level import extract_pages;print(len(list(extract_pages(sys.argv[1]))))', PDF],
    { encoding: 'utf8' });
  return parseInt(out.trim(), 10);
}

// ---------- branch: `apply` is always a fresh fork of main ----------
function git(...args) {
  return execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8' }).trim();
}
const dirtyLines = git('status', '--porcelain').split('\n').filter(Boolean);
const foreign = dirtyLines.filter(l => !/resume\.(tex|pdf)$/.test(l));
if (foreign.length) {
  console.error('error: my_resume working tree has changes beyond resume.tex/resume.pdf:');
  foreign.forEach(l => console.error('  ' + l));
  console.error('Commit or discard them first — refusing to reset over them.');
  process.exit(1);
}
if (dirtyLines.length) git('checkout', '--', '.');   // residue from a previous run / dry-run
git('checkout', '-B', 'apply', 'main');              // re-fork: apply = main + this run's commit

// ---------- fit loop ----------
// The combined list is [JD skills..., snapshot filler...], so trimming from the
// tail drops filler before it drops anything the JD actually asked for.
// Binary-search the longest prefix that still renders on one page: ~7 compiles
// instead of one per dropped skill (tectonic is slow on this box).
const combined = [...jdSkills, ...filler];
const jdSet = new Set(jdSkills);

function pagesFor(n) {
  writeTex(combined.slice(0, n));
  return pageCount();
}

let pages = pagesFor(combined.length);
let keptList = combined.slice();

if (pages > 1) {
  let lo = 0, hi = combined.length;      // lo always fits, hi never does
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (pagesFor(mid) <= 1) lo = mid; else hi = mid;
  }
  keptList = combined.slice(0, lo);

  // Greedy rescue past the prefix cut: the cut point is set by whichever skill
  // happened to wrap a row, but a later (often shorter) skill can still land
  // on a row with horizontal room. JD skills first — they're the point — then
  // snapshot filler in priority order. Row-aware pruning keeps the compile
  // count bounded without skipping anything that could still fit: a candidate
  // is skipped only if its row already rejected an equal-or-shorter name, or
  // the row failed to open at all (a new row costs a whole line regardless of
  // the item, so one such failure condemns the row while it stays absent).
  const rest = combined.slice(lo);
  // Both halves keep their input order: the JD list arrives sorted by
  // significance (Felix, 2026-08-26 — significance beats squeezing in one
  // extra short keyword), and the filler order is his snapshot's major-first
  // priority.
  const candidates = [...rest.filter(x => jdSet.has(x)), ...rest.filter(x => !jdSet.has(x))];
  const rowOf = s => skillMap.map[s] || skillMap.default;
  const presentRows = new Set(keptList.map(rowOf));
  const failedLen = new Map();      // row -> shortest display length rejected on that (present) row
  const failedNewRow = new Set();   // rows that failed to open
  for (const s of candidates) {
    const row = rowOf(s);
    if (!presentRows.has(row)) {
      if (failedNewRow.has(row)) continue;
    } else if (failedLen.has(row) && display(s).length >= failedLen.get(row)) continue;
    writeTex([...keptList, s]);
    if (pageCount() <= 1) {
      keptList.push(s);
      presentRows.add(row);
    } else if (presentRows.has(row)) {
      failedLen.set(row, Math.min(failedLen.get(row) ?? Infinity, display(s).length));
    } else {
      failedNewRow.add(row);
    }
  }
  writeTex(keptList);
  pages = pageCount();
}
const jd = keptList.filter(s => jdSet.has(s));
const fill = keptList.filter(s => !jdSet.has(s));
const keptSet = new Set(keptList);
const dropped = combined.filter(s => !keptSet.has(s)).map(s => ({
  skill: s, from: jdSet.has(s) ? 'jd' : 'snapshot',
}));

// ---------- report ----------
const kept = keptList;
const newToResume = jd.filter(s => !VERIFIED.has(s));

console.log(`\ncompany:   ${flags.company}${flags.role ? '\nrole:      ' + flags.role : ''}`);
console.log(`pages:     ${pages}${pages > 1 ? '  ⚠ COULD NOT FIT — see below' : ''}`);
console.log(`skills:    ${kept.length} on the résumé (${jd.length} from the JD, ${fill.length} from your snapshot)`);

if (dropped.length) {
  console.log(`\ndropped to fit one page (${dropped.length}):`);
  const byFill = dropped.filter(d => d.from === 'snapshot').map(d => display(d.skill));
  const byJd = dropped.filter(d => d.from === 'jd').map(d => display(d.skill));
  if (byFill.length) console.log(`  snapshot filler: ${byFill.join(', ')}`);
  if (byJd.length) console.log(`  ⚠ JD SKILLS: ${byJd.join(', ')}   <- the JD asked for these and they did not fit`);
}

if (newToResume.length) {
  console.log(`\n⚠ STUDY LIST — ${newToResume.length} skill(s) now claimed that are NOT in your verified snapshot:`);
  for (const s of newToResume) console.log(`   - ${display(s)}`);
  console.log('  These are the ones you said you can reach intermediate understanding on in a weekend.');
  console.log('  Do it before the interview, not after the OA.');
} else {
  console.log('\nno unverified claims added — every JD skill was already in your snapshot.');
}

if (flags['dry-run']) {
  console.log('\n--dry-run: resume.tex was rewritten and compiled for the page check, but not committed or pushed.');
  console.log('The next run discards this residue automatically when it re-forks apply from main.');
  process.exit(0);
}

// ---------- archive + commit ----------
fs.mkdirSync(SENT_DIR, { recursive: true });
const d = new Date();
const p = n => String(n).padStart(2, '0');
const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
const slug = String(flags.company).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const archived = path.join(SENT_DIR, `${stamp}-${slug}.pdf`);
fs.copyFileSync(PDF, archived);

const msg = `apply: skills tailored for ${flags.company}${flags.role ? ' — ' + flags.role : ''}`;
const commitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'FelixLin6',
  GIT_AUTHOR_EMAIL: '106911338+FelixLin6@users.noreply.github.com',
  GIT_COMMITTER_NAME: 'zylos',
  GIT_COMMITTER_EMAIL: '68569236+FelixLin6@users.noreply.github.com',
};
execFileSync('git', ['-C', REPO, 'add', 'resume.tex', 'resume.pdf'], { stdio: 'pipe' });
execFileSync('git', ['-C', REPO, 'commit', '-m', msg, '-m',
  'Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>'],
{ stdio: 'pipe', env: commitEnv });

console.log(`\narchived:  ${archived}`);
console.log(`committed: ${msg}`);
console.log(`branch:    apply (push with: git -C ${REPO} push --force origin apply)`);
