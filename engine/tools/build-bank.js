#!/usr/bin/env node
// Build the typed bank from the live assets, and write the conversion report.
//
// The live assets are opened READ-ONLY. Output goes to engine/assets/ only.
// The daily pipeline keeps reading the originals; it never learns this ran.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { convertAll, LIVE_ASSETS } from '../src/bank/convert.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'assets');

function reportMarkdown(report, profile, bank) {
  const L = [];
  L.push('# Typed-bank conversion report');
  L.push('');
  L.push(`Generated ${new Date().toISOString()} from the LIVE assets at`);
  L.push('`~/zylos/.claude/skills/resume/assets/` (opened read-only; unmodified).');
  L.push('');
  L.push('This report is the point of the conversion. The live profile is a flat');
  L.push('fact sheet read by question-text regexes; the typed bank is a closed');
  L.push('vocabulary. Anything that could not be typed is listed here rather than');
  L.push('being approximated at fill time — that is the difference between a park');
  L.push('and the 2026-09-07 `"male"` matching `"Female"`.');
  L.push('');
  L.push('## Coverage');
  L.push('');
  L.push(`- typed enum facts: **${Object.keys(bank.facts).length}**`);
  L.push(`- prose answers: **${bank.prose.length}** (${bank.prose.filter((p) => p.hasSlots).length} carry JD slots)`);
  L.push(`- always-park rules: **${bank.alwaysPark.length}**`);
  L.push(`- education entries: ${profile.education.length}; experience entries: ${profile.experience.length}`);
  L.push(`- forbidden identities: ${profile.constraints.forbiddenIdentities.length}`);
  L.push(`- forbidden values (fabricated-number blocklist): ${profile.constraints.forbiddenValues.length}`);
  L.push('');
  L.push('## Typed enum facts');
  L.push('');
  L.push('| FieldKey | canonical value | source |');
  L.push('|---|---|---|');
  for (const [k, v] of Object.entries(bank.facts)) L.push(`| \`${k}\` | \`${v.value}\` | ${v.source} |`);
  L.push('');
  L.push('## NOT typed — these PARK when a form requires them');
  L.push('');
  if (!report.rejectedFacts.length && !report.skipped.length) L.push('_none_');
  L.push('| item | why |');
  L.push('|---|---|');
  for (const r of report.rejectedFacts) L.push(`| \`${r.key}\` | ${r.why} |`);
  for (const r of report.skipped) L.push(`| \`${r.key}\` | ${r.why} |`);
  L.push('');
  L.push('## Warnings');
  L.push('');
  for (const w of [...report.warnings, ...report.bankWarnings]) L.push(`- ${w}`);
  if (!report.warnings.length && !report.bankWarnings.length) L.push('_none_');
  L.push('');
  L.push('## Prose answers');
  L.push('');
  L.push('| id | section | covers phrases | words | slots |');
  L.push('|---|---|---|---|---|');
  for (const p of bank.prose) {
    L.push(`| \`${p.id}\` | ${p.section} | ${p.covers.length} | ${p.variants[0].maxWords} | ${p.slots.length} |`);
  }
  L.push('');
  L.push('Prose is never rendered into the event stream: an answer is recorded as');
  L.push('`answer_id` + `variant` + `slots` (Q5), which is enough to reconstruct it');
  L.push('from this bank and enough to audit which answer went where.');
  L.push('');
  return L.join('\n') + '\n';
}

const { profile, bank, report } = convertAll({ assetsDir: LIVE_ASSETS });

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'application-profile.typed.json'), JSON.stringify(profile, null, 2) + '\n');
fs.writeFileSync(path.join(OUT, 'answer-bank.typed.json'), JSON.stringify(bank, null, 2) + '\n');
fs.writeFileSync(path.join(OUT, 'conversion-report.md'), reportMarkdown(report, profile, bank));

console.log(`typed facts: ${Object.keys(bank.facts).length}`);
console.log(`prose answers: ${bank.prose.length}`);
console.log(`not typed (park): ${report.rejectedFacts.length + report.skipped.length}`);
console.log(`warnings: ${report.warnings.length + report.bankWarnings.length}`);
console.log(`wrote ${OUT}/{application-profile.typed.json,answer-bank.typed.json,conversion-report.md}`);
