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
 *                   [--out <pdf path>] [--json <report path>] [--fit measured|compile]
 *                   [--boost "a, b"]   (jd-match.js output: filler to pull forward)
 *                   [--max-unboosted N] (cap on filler outside --boost; default 6 with --boost)
 *   ... or pipe the skill list on stdin.
 *
 * --out      write the tailored PDF straight to this path (tailor-batch.js uses
 *            the resume-drops day folder) instead of vault/resumes-sent/.
 * --json     also write a machine-readable fit report (kept/dropped/study).
 * --fit      measured (default): word widths + vertical budget come from two
 *            cached TeX probes, the fit is computed arithmetically and confirmed
 *            with ONE compile. compile: the original binary-search + greedy
 *            rescue loop (7-25 compiles). measured falls back to compile on any
 *            inconsistency, so the output semantics are identical.
 * Env: RESUME_REPO (checkout to use), RESUME_APPLY_BRANCH (default "apply").
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
  // Lock is per checkout (2026-09-02): tailor-batch.js runs parallel lanes in
  // separate git worktrees (RESUME_REPO), and those must not serialize on
  // each other — only two runs against the SAME checkout are serialized.
  const repoTag = require('crypto').createHash('sha1').update(REPO).digest('hex').slice(0, 8);
  const LOCK = `${process.env.HOME}/zylos/vault/jd-pipeline/.apply-skills.${repoTag}.lock`;
  fs.mkdirSync(path.dirname(LOCK), { recursive: true });
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
  // 2026-09-02: names seen on real JDs that title-casing mangles.
  'grpc': 'gRPC', 'fastapi': 'FastAPI', 'xgboost': 'XGBoost', 'mlflow': 'MLflow', 'mlops': 'MLOps',
  'llmops': 'LLMOps', 'nlp': 'NLP', 'ai': 'AI', 'ml': 'ML', 'ios': 'iOS', 'macos': 'macOS', 'php': 'PHP',
  'llvm': 'LLVM', 'mlir': 'MLIR', 'xla': 'XLA', 'tensorrt': 'TensorRT', 'opencv': 'OpenCV', 'ros': 'ROS',
  'ros2': 'ROS 2', 'json': 'JSON', 'xml': 'XML', 'yaml': 'YAML', 'dbt': 'dbt', 'ui/ux': 'UI/UX', 'ux': 'UX',
  'ui': 'UI', 'jvm': 'JVM', 'api': 'API', 'apis': 'APIs', 'sdk': 'SDK', 'sdks': 'SDKs', 'jwt': 'JWT',
  'oop': 'OOP', 'tcp/ip': 'TCP/IP', 'http': 'HTTP', 'https': 'HTTPS', 'ssh': 'SSH', 'ssl/tls': 'SSL/TLS',
  'gpu': 'GPU', 'gpus': 'GPUs', 'cpu': 'CPU', 'fpga': 'FPGA', 'rtos': 'RTOS', 'iot': 'IoT', 'ci': 'CI',
  'cd': 'CD', 'etl/elt': 'ETL/ELT', 'elt': 'ELT', 'olap': 'OLAP', 'oltp': 'OLTP', 'ms sql server': 'MS SQL Server',
  'microsoft sql server': 'Microsoft SQL Server', 'pl/sql': 'PL/SQL', 't-sql': 'T-SQL', 'vba': 'VBA',
  'matlab': 'MATLAB', 'labview': 'LabVIEW', 'simulink': 'Simulink', 'sas': 'SAS', 'spss': 'SPSS',
  'llama': 'Llama', 'openai api': 'OpenAI API', 'hugging face': 'Hugging Face', 'jax': 'JAX',
  'sqlalchemy': 'SQLAlchemy', 'pyspark': 'PySpark', 'nextjs': 'Next.js', 'vue': 'Vue', 'vue.js': 'Vue.js',
  'nginx': 'NGINX', 'graphql': 'GraphQL', 'websockets': 'WebSockets', 'webrtc': 'WebRTC', 'rpc': 'RPC',
  'k8s': 'Kubernetes', 'ec2': 'EC2', 's3': 'S3', 'rds': 'RDS', 'ecs': 'ECS', 'eks': 'EKS', 'iam': 'IAM',
  'a/b testing': 'A/B Testing', 'ab testing': 'A/B Testing', 'kpi': 'KPI', 'kpis': 'KPIs', 'saas': 'SaaS',
  'erp': 'ERP', 'crm': 'CRM', 'sap': 'SAP', 'sap products': 'SAP Products', 'hpc': 'HPC',
  'high performance computing (hpc)': 'HPC', 'hci': 'HCI', 'ar/vr': 'AR/VR', 'vr': 'VR', 'ar': 'AR',
  'cad': 'CAD', 'plc': 'PLC', 'can': 'CAN', 'can bus': 'CAN Bus', 'spi': 'SPI', 'i2c': 'I2C', 'uart': 'UART',
  'usb': 'USB', 'pcb': 'PCB', 'rf': 'RF', 'dsp': 'DSP', 'asic': 'ASIC', 'soc': 'SoC', 'vhdl': 'VHDL',
  'verilog': 'Verilog', 'systemverilog': 'SystemVerilog', 'uvm': 'UVM', 'rtl': 'RTL',
  // 2026-09-03 (Bespoke lexicon names)
  'tailwind css': 'Tailwind CSS', 'freertos': 'FreeRTOS', 'mqtt': 'MQTT', 'netsuite': 'NetSuite', 'sap': 'SAP',
  'hpc': 'HPC', 'fpga': 'FPGA', 'tcp/ip': 'TCP/IP', 'cmake': 'CMake', 'vs code': 'VS Code', 'onnx': 'ONNX',
  'ollama': 'Ollama', 'swiftui': 'SwiftUI', 'graphql': 'GraphQL', 'mlflow': 'MLflow', 'websockets': 'WebSockets',
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

// Snapshot top-up: verified skills the JD did not mention. Order (Bespoke,
// 2026-09-03 — before this every résumé carried the same filler tail):
//   1. --boost skills (jd-match.js: snapshot skills sharing a lexicon category
//      with a JD hit), in snapshot order;
//   2. the rest in snapshot order (Felix's major-first priority), capped by
//      --max-unboosted so the un-related tail stays short and constant-ish
//      (his core stack) instead of a full dump.
// Trimming works from the tail, so the least JD-relevant filler drops first.
const rawFiller = snapshot.verified.map(norm).filter(s => !seen.has(s));
const boostSet = new Set(String(flags.boost && flags.boost !== true ? flags.boost : '').split(/[\n,]+/).map(norm).filter(Boolean));
// --max-unboosted N (default 6 when --boost is given, unlimited otherwise): the
// un-boosted remainder is what made every résumé end in the same tail, so only
// the first N of it (by row relevance) may appear; the page is allowed to run
// short instead. Felix can raise it per run.
const maxUnboosted = flags['max-unboosted'] != null && flags['max-unboosted'] !== true
  ? parseInt(flags['max-unboosted'], 10) : (boostSet.size ? 6 : Infinity);
const filler = [
  ...rawFiller.filter(s => boostSet.has(s)),
  ...rawFiller.filter(s => !boostSet.has(s)).slice(0, maxUnboosted),
];

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
const BRANCH = process.env.RESUME_APPLY_BRANCH || 'apply';
git('checkout', '-B', BRANCH, 'main');               // re-fork: apply = main + this run's commit

// ---------- fit loop ----------
// The combined list is [JD skills..., snapshot filler...], so trimming from the
// tail drops filler before it drops anything the JD actually asked for.
const combined = [...jdSkills, ...filler];
const jdSet = new Set(jdSkills);
const rowOf = s => skillMap.map[s] || skillMap.default;

function pagesFor(n) {
  writeTex(combined.slice(0, n));
  return pageCount();
}

// Greedy rescue past the prefix cut (shared by both fit modes): the cut point
// is set by whichever skill happened to wrap a row, but a later (often
// shorter) skill can still land on a row with horizontal room. JD skills
// first — they're the point — then snapshot filler in priority order. Both
// halves keep their input order: the JD list arrives sorted by significance
// (Felix, 2026-08-26 — significance beats squeezing in one extra short
// keyword), and the filler order is his snapshot's major-first priority.
// Row-aware pruning keeps the trial count bounded without skipping anything
// that could still fit: a candidate is skipped only if its row already
// rejected an equal-or-shorter name, or the row failed to open at all (a new
// row costs a whole line regardless of the item).
function rescue(lo, fits) {
  const keptList = combined.slice(0, lo);
  const rest = combined.slice(lo);
  const candidates = [...rest.filter(x => jdSet.has(x)), ...rest.filter(x => !jdSet.has(x))];
  const presentRows = new Set(keptList.map(rowOf));
  const failedLen = new Map();      // row -> shortest display length rejected on that (present) row
  const failedNewRow = new Set();   // rows that failed to open
  for (const s of candidates) {
    const row = rowOf(s);
    if (!presentRows.has(row)) {
      if (failedNewRow.has(row)) continue;
    } else if (failedLen.has(row) && display(s).length >= failedLen.get(row)) continue;
    if (fits([...keptList, s])) {
      keptList.push(s);
      presentRows.add(row);
    } else if (presentRows.has(row)) {
      failedLen.set(row, Math.min(failedLen.get(row) ?? Infinity, display(s).length));
    } else {
      failedNewRow.add(row);
    }
  }
  return keptList;
}

// --- compile mode: binary-search the longest prefix that still renders on one
// page (~7 compiles), then rescue with one compile per trial.
function fitByCompile() {
  let lo = 0, hi = combined.length;      // lo always fits, hi never does
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (pagesFor(mid) <= 1) lo = mid; else hi = mid;
  }
  return rescue(lo, list => { writeTex(list); return pageCount() <= 1; });
}

// --- measured mode (2026-09-02): ask TeX for the numbers once, then do the
// fit arithmetically. Two cached probes, both compiled with resume.tex's own
// preamble so fonts/sizes/margins are exact:
//   width probe   — \settowidth of every word (with its trailing comma) and of
//                   each bold row label, plus \linewidth inside the itemize and
//                   the interword space. Cached per word, keyed by the preamble
//                   hash, so steady state needs no width compile at all.
//   vertical probe — the real document with the Skills list replaced by items
//                   of 1/2/3 forced lines and \typeout{\pagetotal} after each,
//                   giving line height, item separation, list end cost and the
//                   page goal. Keyed by the hash of resume.tex minus Skills.
// Line breaking is simulated greedily at spaces (\raggedright → no space
// stretch, and greedy is line-count-optimal). Anything unmeasurable, or a
// confirm compile that still spills, falls back to compile mode.
const PROBE_DIR = `${process.env.HOME}/zylos/vault/jd-pipeline/.probe`;
const CACHE = `${process.env.HOME}/zylos/vault/jd-pipeline/.fit-cache.json`;
const sha = s => require('crypto').createHash('sha1').update(s).digest('hex');
const fmtPt = v => Math.round(v * 1000) / 1000;

function loadCache() { try { return JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch { return {}; } }
function saveCache(c) { fs.mkdirSync(path.dirname(CACHE), { recursive: true }); fs.writeFileSync(CACHE, JSON.stringify(c)); }

function runProbe(name, tex) {
  fs.mkdirSync(PROBE_DIR, { recursive: true });
  const file = path.join(PROBE_DIR, `${name}.tex`);
  fs.writeFileSync(file, tex);
  for (const ext of ['log', 'pdf']) { try { fs.unlinkSync(path.join(PROBE_DIR, `${name}.${ext}`)); } catch {} }
  execFileSync(TECTONIC, ['--keep-logs', '-o', PROBE_DIR, file], { cwd: PROBE_DIR, stdio: 'pipe' });
  const log = fs.readFileSync(path.join(PROBE_DIR, `${name}.log`), 'utf8');
  const out = {};
  for (const m of log.matchAll(/^ZM:([A-Za-z]+):(.*?)=(-?[\d.]+)pt$/gm)) {
    (out[m[1]] ||= {})[m[2]] = parseFloat(m[3]);
  }
  return out;
}

// Words as TeX breaks them: the row is "<bold label>: item, item, item";
// "Label:" is one unbreakable unit, then each space-separated word of each
// item, the last word of an item carrying the comma.
function rowWords(row, items) {
  const words = [];
  items.forEach((it, i) => {
    const parts = it.split(' ');
    parts.forEach((w, j) => words.push(j === parts.length - 1 && i < items.length - 1 ? w + ',' : w));
  });
  return words;
}

function fitByMeasure() {
  const original = fs.readFileSync(TEX, 'utf8');
  const preamble = original.slice(0, original.indexOf('\\begin{document}'));
  if (!preamble || /\\includegraphics|\\input\b|\\include\b/.test(original)) return null;
  const cache = loadCache();
  const pkey = sha(preamble);
  const vkey = sha(original.replace(SECTION_RE, '\\section{Skills}'));
  cache.widths = cache.widths?.key === pkey ? cache.widths : { key: pkey, words: {}, labels: {} };
  cache.vertical = cache.vertical?.key === vkey ? cache.vertical : null;

  // Everything this run could render: all words of all rows, all labels.
  const allItems = combined.map(display);
  const needWords = new Set(), needLabels = new Set(skillMap.rows);
  for (const it of allItems) it.split(' ').forEach(w => { needWords.add(w); needWords.add(w + ','); });
  const missingW = [...needWords].filter(w => cache.widths.words[w] === undefined);
  const missingL = [...needLabels].filter(l => cache.widths.labels[l] === undefined);
  const needConst = ['LW', 'SP', 'line', 'itemsep', 'itemshrink'].some(k => cache.widths[k] === undefined);
  if (missingW.length || missingL.length || needConst) {
    const enc = new Map(); let n = 0;
    const lines = [];
    for (const w of missingW) { enc.set(`w${n}`, w); lines.push(`\\settowidth{\\zml}{${texEscape(w)}}\\typeout{ZM:W:w${n}=\\the\\zml}`); n++; }
    for (const l of missingL) { enc.set(`l${n}`, l); lines.push(`\\settowidth{\\zml}{\\textbf{${texEscape(l)}}{:}}\\typeout{ZM:W:l${n}=\\the\\zml}`); n++; }
    // Items of 1 / 2 / 3 / 1 forced lines on an otherwise empty page give the
    // line height, the inter-item cost and the per-item shrinkability.
    const tex = preamble + '\\begin{document}\n\\newlength{\\zml}\n' +
      '\\resumeSubHeadingListStart\n' +
      '\\item{\\typeout{ZM:V:LW=\\the\\linewidth}\\typeout{ZM:V:SP=\\the\\fontdimen2\\font}x}\\par\\typeout{ZM:V:B=\\the\\pagetotal}\\typeout{ZM:V:SB=\\the\\pageshrink}\n' +
      '\\item{x\\\\x}\\par\\typeout{ZM:V:C=\\the\\pagetotal}\n' +
      '\\item{x\\\\x\\\\x}\\par\\typeout{ZM:V:D=\\the\\pagetotal}\n' +
      '\\item{x}\\par\\typeout{ZM:V:D2=\\the\\pagetotal}\\typeout{ZM:V:SD=\\the\\pageshrink}\n' +
      '\\resumeSubHeadingListEnd\n' +
      lines.join('\n') + '\n\\end{document}\n';
    let r;
    try { r = runProbe('widths', tex); } catch { return null; }
    const v = r.V || {};
    if (![v.LW, v.SP, v.B, v.C, v.D, v.D2, v.SB, v.SD].every(x => typeof x === 'number')) return null;
    const line = (v.D - v.C) - (v.C - v.B);
    const itemsep = (v.C - v.B) - 2 * line;
    if (!(line > 0) || itemsep < -0.01 || Math.abs((v.D2 - v.D) - (itemsep + line)) > 0.05) return null;
    Object.assign(cache.widths, { LW: v.LW, SP: v.SP, line, itemsep, itemshrink: Math.max(0, (v.SD - v.SB) / 3) });
    for (const [k, val] of Object.entries(r.W || {})) {
      const name = enc.get(k);
      if (name === undefined) continue;
      if (k[0] === 'w') cache.widths.words[name] = val; else cache.widths.labels[name] = val;
    }
    if ([...needWords].some(w => cache.widths.words[w] === undefined)) return null;
    if ([...needLabels].some(l => cache.widths.labels[l] === undefined)) return null;
    saveCache(cache);
  }
  if (!cache.vertical) {
    // The real document with a one-line Skills list: page height after that
    // item (base), the page goal, and the page's shrinkability at that point.
    // TeX keeps a page to one sheet while height - shrink <= goal at the
    // break after the last item (the list-end glue is discarded there).
    const probeSkills = '\\section{Skills}\n\\resumeSubHeadingListStart\n' +
      '\\item{x}\\par\\typeout{ZM:V:B=\\the\\pagetotal}\\typeout{ZM:V:G=\\the\\pagegoal}\\typeout{ZM:V:SH=\\the\\pageshrink}\n' +
      '\\resumeSubHeadingListEnd';
    let r;
    try { r = runProbe('vertical', original.replace(SECTION_RE, probeSkills)); } catch { return null; }
    const v = r.V || {};
    if (![v.B, v.G, v.SH].every(x => typeof x === 'number') || v.B > v.G) return null;
    cache.vertical = { key: vkey, base: v.B, goal: v.G, shrink: v.SH };
    saveCache(cache);
  }
  const { LW, SP, words, labels } = cache.widths;
  const V = cache.vertical;

  function linesForRow(row, items) {
    let lines = 1, x = labels[row];
    for (const w of rowWords(row, items)) {
      const ww = words[w];
      if (x + SP + ww <= LW + 1e-6) x += SP + ww;
      else { lines++; x = ww; }
    }
    return lines;
  }
  // Height after the last item, minus the page's shrinkability, must stay
  // within the goal (see the vertical probe note).
  function slack(list) {
    const rows = rowsFor(list);
    let total = 0, items = 0;
    for (const row of skillMap.rows) {
      const vals = rows.get(row) || [];
      if (!vals.length) continue;
      const n = linesForRow(row, vals);
      total += items === 0 ? (n - 1) * LINE : ITEMSEP + n * LINE;
      items++;
    }
    const shrink = V.shrink + Math.max(0, items - 1) * ITEMSHRINK;
    return V.goal - (V.base + total - shrink);
  }
  const { line: LINE, itemsep: ITEMSEP, itemshrink: ITEMSHRINK } = cache.widths;

  // Confirm with one compile; if the page still spills (model too generous),
  // demand one more line of slack and redo — at most 3 tries, then give up.
  let margin = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    const fits = list => slack(list) >= margin - 1e-6;
    let lo = 0, hi = combined.length;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (fits(combined.slice(0, mid))) lo = mid; else hi = mid; }
    const keptList = rescue(lo, fits);
    writeTex(keptList);
    if (pageCount() <= 1) {
      if (process.env.ZYLOS_FIT_DEBUG) console.error(`[fit] measured: ${keptList.length} skills, ${attempt + 1} confirm compile(s), slack ${slack(keptList).toFixed(2)}pt`);
      return keptList;
    }
    margin += LINE;
  }
  return null;
}

let pages, keptList, fitMode;
{
  const want = flags.fit || 'measured';
  let list = null;
  if (want === 'measured') {
    try { list = fitByMeasure(); } catch (e) { if (process.env.ZYLOS_FIT_DEBUG) console.error('[fit] measured failed: ' + e.message); list = null; }
  }
  if (list) {                      // fitByMeasure already confirmed one page with its own compile
    keptList = list; pages = 1; fitMode = 'measured';
  } else {
    fitMode = want === 'measured' ? 'compile (measured fell back)' : 'compile';
    pages = pagesFor(combined.length);
    keptList = combined.slice();
    if (pages > 1) {
      keptList = fitByCompile();
      writeTex(keptList);
      pages = pageCount();
    }
  }
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
console.log(`pages:     ${pages}${pages > 1 ? '  ⚠ COULD NOT FIT — see below' : ''}   (fit: ${fitMode})`);
if (flags.json && flags.json !== true) {
  fs.mkdirSync(path.dirname(path.resolve(flags.json)), { recursive: true });
  fs.writeFileSync(flags.json, JSON.stringify({
    company: flags.company, role: flags.role || null, pages, fit: fitMode,
    kept: kept.map(display), jd_kept: jd.map(display), filler_kept: fill.map(display),
    dropped_jd: dropped.filter(d => d.from === 'jd').map(d => display(d.skill)),
    dropped_filler: dropped.filter(d => d.from === 'snapshot').map(d => display(d.skill)),
    study: newToResume.map(display),
    pdf: flags.out && flags.out !== true ? path.resolve(flags.out) : null,
  }, null, 1));
}
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
const d = new Date();
const p = n => String(n).padStart(2, '0');
const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
const slug = String(flags.company).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const archived = (flags.out && flags.out !== true) ? path.resolve(flags.out) : path.join(SENT_DIR, `${stamp}-${slug}.pdf`);
fs.mkdirSync(path.dirname(archived), { recursive: true });
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
console.log(`branch:    ${BRANCH} (push with: git -C ${REPO} push --force origin ${BRANCH})`);
