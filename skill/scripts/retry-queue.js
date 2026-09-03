#!/usr/bin/env node
/**
 * retry-queue — build the next apply wave from the day's ledger blocks.
 *
 * Felix (2026-09-02): "minimize the number of fallbacks as much as possible,
 * keep retrying with better approaches until the window closes." A park is a
 * last resort, so inside the window there is NO attempt cap: every row whose
 * class is `retry` goes back out, with attempt+1 and a per-domain spread.
 * At the deadline (--deadline) remaining retry rows are demoted to
 * needs-felix so Stage 3 can write the manual pile.
 *
 * Reads: resume-drops/<day>/ledger-part*.md and ledger.md (compact blocks,
 *   see SKILL.md Stage 2 step f). Parses per block:
 *     ## [<row>] <Company> — <Title> — SUBMITTED|PARKED|FAILED|SKIPPED-REPOST|DROP-AT-APPLY
 *     - key <uuid> · ATS <ats> <form url> · PDF <file> · applier<i> · <HH:MM PT>
 *     - outcome: submitted | retry, retry_reason: <r> | needs-felix, unlock: <a> | wall   ← canonical
 *       (applier contract c4d6002: the taxonomy word leads the existing outcome line; free
 *       text may follow after " — "). Also accepted: a separate `- class:` line with
 *       `- reason:` / `- unlock:`. Missing on a PARKED/FAILED row → retry, reason unclassified.
 *     - attempt: <n>      - domain: <host>
 *   The latest block per key wins (later attempts append new blocks).
 * Writes: <run dir>/retry-wave.json — { retry:[…], needs_felix:[…], wall:[…],
 *   submitted:n, slices:[[key…]…] } with slices domain-aware (one employer
 *   domain never spans two appliers) and edge-block rows (access-denied /
 *   403 / 429) pushed to the tail of the last slice so they run later.
 *
 * Usage:
 *   retry-queue.js --day 2026-09-01 [--day 2026-09-02] [--n 2]
 *                  [--deadline "2026-09-03T01:46:00-07:00"] [--drops <dir>] [--out <file>]
 *   Exit 0 with a wave, exit 4 when nothing is left to retry (pile empty or deadline passed).
 */
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : def; };
const days = []; args.forEach((a, i) => { if (a === '--day' && args[i + 1]) days.push(args[i + 1]); });
const N = Math.max(1, parseInt(opt('n', '2'), 10) || 2);
const DROPS = opt('drops', `${process.env.HOME}/zylos/workspace/resume-drops`);
const deadline = opt('deadline', null) ? new Date(opt('deadline')) : null;
const OUT = opt('out', null);
if (!days.length) { console.error('usage: retry-queue.js --day <YYYY-MM-DD> [--day …] [--n 2] [--deadline <ISO>] [--drops <dir>] [--out <file>]'); process.exit(2); }

const EDGE = /access.?denied|\b403\b|\b429\b|rate.?limit|edge|akamai|cloudflare|forbidden/i;
const WALL = /hcaptcha|recaptcha|datadome|captcha|spam/i;

function parseBlocks(text, day, file) {
  const out = [];
  const parts = text.split(/^(?=## \[)/m);
  for (const p of parts) {
    const h = p.match(/^## \[([^\]]*)\]\s+(.*?)\s+—\s+(SUBMITTED|PARKED|FAILED|SKIPPED-REPOST|DROP-AT-APPLY)\s*$/m);
    if (!h) continue;
    const headerRest = h[2];
    const [company, ...titleParts] = headerRest.split(' — ');
    const title = titleParts.join(' — ');
    const keyLine = p.match(/^- key:?\s+(\S+)(.*)$/m);
    if (!keyLine) continue;
    const key = keyLine[1].replace(/[`*]/g, ''); // tolerate `backticked`/**bold** keys
    const urlMatch = (keyLine[2] || '').match(/https?:\/\/[^\s·]+/);
    const url = urlMatch ? urlMatch[0] : null;
    const field = k => { const m = p.match(new RegExp(`^- ${k}:\\s*(.+)$`, 'mi')); return m ? m[1].trim() : null; };
    const status = h[3];
    const outcomeText = field('outcome') || '';
    // Canonical (applier contract c4d6002): the outcome line LEADS with the taxonomy word,
    // e.g. "retry, retry_reason: 403 — Access Denied on tesla.com". Alt: a separate `- class:` line.
    const lead = outcomeText.match(/^(submitted|retry|needs-felix|wall)\b[,:]?\s*(.*)$/i);
    let cls = (field('class') || (lead ? lead[1] : '')).toLowerCase();
    const explicit = !!cls;
    if (!cls) cls = status === 'SUBMITTED' ? 'submitted' : (status === 'PARKED' || status === 'FAILED') ? 'retry' : 'skip';
    // Heuristic safety net: an unclassified park whose outcome text names a captcha is a wall, not a retry.
    if (cls === 'retry' && !explicit && WALL.test(outcomeText)) cls = 'wall';
    const inline = k => { const m = (lead ? lead[2] : '').match(new RegExp(`${k}:\\s*([^—]+?)(?:\\s+—|$)`, 'i')); return m ? m[1].trim().replace(/[,;]$/, '') : null; };
    let reason = field('reason') || field('retry_reason') || inline('retry_reason') || inline('reason');
    if (!reason && cls === 'wall') reason = (outcomeText.match(WALL) || ['wall'])[0].toLowerCase();
    if (!reason && cls === 'retry') reason = 'unclassified';
    let domain = field('domain');
    if (!domain && url) { try { domain = new URL(url).hostname.replace(/^www\./, ''); } catch { /* ignore */ } }
    if (domain && /simplify\.jobs$/.test(domain)) domain = null; // the posting page, not the employer's ATS
    out.push({
      key, day, row: h[1], company: company.trim(), title: title.trim(), status, class: cls,
      reason,
      unlock: field('unlock') || inline('unlock'), attempt: parseInt(field('attempt') || '1', 10) || 1,
      domain: domain || null, url, applier: (p.match(/applier(\d+)/) || [])[0] || null,
      outcome: outcomeText || null, source: path.basename(file),
    });
  }
  return out;
}

const latest = new Map(); // key → record (last seen wins; ledger.md read first, parts after so live parts win)
for (const day of days) {
  const dir = path.join(DROPS, day);
  if (!fs.existsSync(dir)) { console.error(`warning: ${dir} missing, skipped`); continue; }
  const files = ['ledger.md', ...fs.readdirSync(dir).filter(f => /^ledger-part\d*\.md$/.test(f)).sort()]
    .map(f => path.join(dir, f)).filter(fs.existsSync);
  for (const f of files) for (const r of parseBlocks(fs.readFileSync(f, 'utf8'), day, f)) latest.set(r.key, r);
}

const recs = [...latest.values()];
const past = deadline && Date.now() >= deadline.getTime();
const retry = [], needs = [], wall = [];
let submitted = 0;
for (const r of recs) {
  if (r.class === 'submitted') { submitted++; continue; }
  if (r.class === 'wall') { wall.push(r); continue; }
  if (r.class === 'needs-felix') { needs.push(r); continue; }
  if (r.class === 'retry') {
    if (past) { needs.push({ ...r, class: 'needs-felix', unlock: r.unlock || `retry window closed after ${r.attempt} attempt(s): ${r.reason || 'see outcome'}`, demoted: true }); }
    else retry.push({ ...r, attempt: r.attempt + 1, edge: EDGE.test(`${r.reason || ''} ${r.outcome || ''}`) });
  }
}

// Domain-aware slicing: group by domain, biggest groups first, place each
// whole group on the currently lightest slice; edge-blocked groups go last so
// they land at the tail (later in the wave) — one employer never spans two appliers.
const groups = new Map();
for (const r of retry) { const d = r.domain || r.company.toLowerCase(); if (!groups.has(d)) groups.set(d, []); groups.get(d).push(r); }
const ordered = [...groups.values()].sort((a, b) => (a.some(r => r.edge) - b.some(r => r.edge)) || (b.length - a.length));
const slices = Array.from({ length: Math.min(N, Math.max(1, ordered.length)) }, () => []);
for (const g of ordered) { slices.sort((a, b) => a.length - b.length); slices[0].push(...g.map(r => r.key)); }
const keySet = new Set(slices.flat());
if (keySet.size !== retry.length) { console.error('FATAL: slice coverage mismatch'); process.exit(1); }

const wave = {
  generated: new Date().toISOString(), days, n: N, deadline: deadline ? deadline.toISOString() : null, deadline_passed: !!past,
  counts: { submitted, retry: retry.length, needs_felix: needs.length, wall: wall.length, total: recs.length },
  retry: retry.map(r => ({ key: r.key, day: r.day, company: r.company, title: r.title, attempt: r.attempt, reason: r.reason, domain: r.domain, url: r.url, edge: r.edge })),
  needs_felix: needs.map(r => ({ key: r.key, day: r.day, company: r.company, title: r.title, unlock: r.unlock, reason: r.reason, demoted: !!r.demoted })),
  wall: wall.map(r => ({ key: r.key, day: r.day, company: r.company, title: r.title, reason: r.reason })),
  slices,
};
const outPath = OUT || path.join(DROPS, days[days.length - 1], 'retry-wave.json');
fs.writeFileSync(outPath, JSON.stringify(wave, null, 1));
console.error(`retry-queue: ${recs.length} rows → submitted ${submitted}, retry ${retry.length} (${slices.map(s => s.length).join('+')} across ${slices.length} slice(s)), needs-felix ${needs.length}${past ? ' (deadline passed, retries demoted)' : ''}, wall ${wall.length} → ${outPath}`);
if (!retry.length) process.exit(4);
