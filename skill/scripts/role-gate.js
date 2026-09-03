#!/usr/bin/env node
/**
 * role-gate — Stage 1 deterministic filter for the Bespoke Resume Workflow
 * (Felix's policy 2026-09-03: only software / ML / AI engineering and adjacent
 * roles — infra, data engineering, embedded software, security software, dev
 * tools. Not hardware design, not business/ops, not lab research.)
 *
 * Framing: keep a role if what the intern SHIPS is code, models, data
 * pipelines, or the infrastructure that runs code; drop it if the deliverable
 * is a circuit, RTL, a mechanical part, a process, a spreadsheet or a deck.
 *
 * Three checks: (1) title family (keep / drop lists), (2) skills mix from the
 * JD text via lexicon categories (hardware tooling vs software), (3) anything
 * still ambiguous → `review`, and the triage agent applies the deliverable
 * test (keep only if ≥ half the responsibilities are writing code).
 *
 * Module:  const { roleGate } = require('./role-gate');
 *          roleGate(row) → { role_gate: 'keep'|'drop'|'review', role_gate_reason }
 *          row: { title, posting_title?, description?, requirements?, jd_text?, skills? }
 * CLI:     role-gate.js jdfacts.json   → prints a per-row table + counts
 */
const fs = require('fs');
const path = require('path');
const { matchJD, canonical } = require(path.join(__dirname, 'jd-match.js'));

// Title families. Order matters only for the reason text.
const KEEP = [
  ['software', /\bsoftware\b|\bswe\b|\bsde\b|\bsdet\b/i],
  ['developer', /\bdevelop(er|ment)\b|\bprogrammer\b|\bcoding\b/i],
  ['web/mobile', /\bbackend\b|\bback-end\b|\bfrontend\b|\bfront-end\b|\bfull.?stack\b|\bweb\b|\bmobile\b|\bios\b|\bandroid\b/i],
  ['ml/ai', /\bmachine learning\b|\bml\b|\bai\b|\bartificial intelligence\b|\bdeep learning\b|\bnlp\b|\bcomputer vision\b|\bllm\b|\bgenai\b|\bgenerative\b/i],
  ['scientist/research eng', /\bapplied scientist\b|\bresearch engineer\b|\bresearch scientist\b.*(ml|ai|machine)/i],
  ['data eng', /\bdata engineer/i],
  ['infra', /\bplatform\b|\binfrastructure\b|\bdevops\b|\bsre\b|\bsite reliability\b|\bcloud\b|\bdistributed systems\b/i],
  ['embedded sw', /\bembedded software\b|\bfirmware\b|\bembedded systems? software\b/i],
  ['systems/compiler', /\bcompiler\b|\boperating system\b|\bkernel\b|\bsystems software\b|\bruntime\b/i],
  ['security sw', /\bsecurity engineer|\bapplication security\b|\bappsec\b|\bcybersecurity engineer/i],
  ['quant dev', /\bquant(itative)? (developer|engineer|research)/i],
  ['game/graphics', /\bgame(play)? (engineer|developer|programmer)|\bgraphics (engineer|programmer)|\brendering\b/i],
  ['automation/test sw', /\btest automation\b|\bautomation engineer\b|\bqa engineer\b|\bquality engineer.*(software|automation)/i],
];
const DROP = [
  ['hardware', /\bhardware\b|\belectrical\b|\bee\b|\basic\b|\brtl\b|\bfpga\b|\banalog\b|\bdigital design\b|\bmixed.?signal\b|\bpcb\b|\bsilicon\b|\bvlsi\b|\bsoc\b|\bchip\b/i],
  ['rf/photonics', /\brf\b|\bphotonic|\boptical engineer|\bantenna\b|\bmicrowave\b/i],
  ['mechanical', /\bmechanical\b|\bmech\b|\bthermal\b|\bstructural\b|\bcad\b|\bhvac\b/i],
  ['manufacturing/process', /\bmanufactur|\bprocess engineer|\bindustrial engineer|\bproduction engineer|\bplant\b|\bfacilit/i],
  ['civil/chem/materials', /\bcivil\b|\bchemical\b|\bmaterials?\b engineer|\bmetallurg|\benvironmental engineer/i],
  ['hardware test/validation', /\bdesign verification\b|\bvalidation engineer\b|\btest engineer\b(?!.*software)|\breliability engineer\b(?!.*site)|\bfailure analysis\b/i],
  ['supply chain/ops', /\bsupply chain\b|\bprocurement\b|\blogistics\b|\boperations (intern|analyst|engineer)|\bsourcing\b|\binventory\b/i],
  ['business/pm', /\bbusiness (analyst|intern|development|operations)|\bproduct manag|\bprogram manag|\bproject manag|\bstrategy\b|\bconsult(ant|ing)\b|\bfinance\b|\baccounting\b|\bmarketing\b|\bsales\b|\bhr\b|\brecruit/i],
  ['it support', /\bit (intern|support|analyst|technician)|\bhelp ?desk\b|\bdesktop support\b|\bsystems administrator\b|\bnetwork administrator\b/i],
  ['analyst (bi)', /\bbusiness intelligence\b|\bbi analyst\b|\breporting analyst\b|\bfinancial analyst\b/i],
  ['lab/physics', /\bphysic(s|ist)\b|\bchemist\b|\bbiolog|\blaborator|\blab (intern|tech|assistant)|\bwet lab\b|\bmaterials science\b/i],
  ['design/ux', /\bux\b|\bui\/ux\b|\bgraphic design|\bindustrial design|\bvisual design|\bproduct design(er)?\b/i],
  ['writing/support', /\btechnical writer|\bdocumentation\b|\bcustomer (success|support)|\bsolutions engineer|\bsales engineer|\bfield engineer/i],
  ['technician', /\btechnician\b|\bdrafter\b|\bmachinist\b|\bassembl(er|y) (tech|intern)/i],
];
const HARDWARE_TERMS = new Set(['verilog', 'fpga', 'autocad', 'simulink', 'arduino', 'mqtt', 'assembly']);
const SOFTWARE_CATS = new Set(['language', 'framework', 'ml', 'data', 'database', 'cloud', 'devops', 'protocol', 'tool']);
const OFFICE_ONLY = new Set(['excel', 'tableau', 'sap', 'netsuite', 'jira', 'figma']);

function fam(list, s) { return list.filter(([, re]) => re.test(s)).map(([n]) => n); }

function roleGate(row) {
  const title = `${row.posting_title || ''} ${row.title || ''}`.replace(/\s+/g, ' ').trim();
  const keep = fam(KEEP, title), drop = fam(DROP, title);
  const text = [row.jd_text, row.description, ...(row.requirements || [])].filter(Boolean).join('\n');
  const m = text.trim() ? matchJD({ text, requirements: row.requirements || [] }) : { hits: [], skills: [] };
  const chips = [...new Set((row.skills || []).map(canonical).filter(Boolean))];
  const hits = m.hits.filter(h => h.cat !== 'concept');
  const hw = hits.filter(h => HARDWARE_TERMS.has(h.name)).length + chips.filter(c => HARDWARE_TERMS.has(c)).length;
  const sw = hits.filter(h => SOFTWARE_CATS.has(h.cat) && !HARDWARE_TERMS.has(h.name) && !OFFICE_ONLY.has(h.name)).length
    + chips.filter(c => !HARDWARE_TERMS.has(c) && !OFFICE_ONLY.has(c)).length;
  const langs = hits.filter(h => h.cat === 'language' && !HARDWARE_TERMS.has(h.name)).length;
  const mix = `sw ${sw} / hw ${hw}${langs ? ` / ${langs} lang` : ''}`;

  if (keep.length && !drop.length) return { role_gate: 'keep', role_gate_reason: `title: ${keep[0]}` };
  if (drop.length && !keep.length) {
    // A hardware-family title with a clearly software JD (e.g. "Hardware Engineer" that is really embedded C) → review, not drop.
    if (langs >= 2 && sw >= 4 && sw > 2 * hw) return { role_gate: 'review', role_gate_reason: `title says ${drop[0]} but JD reads software (${mix}) — deliverable test` };
    return { role_gate: 'drop', role_gate_reason: `not software: ${drop[0]} (${mix})` };
  }
  // Both families or neither: let the JD's skills mix decide, else review.
  if (sw >= 3 && sw > 2 * hw && langs >= 1) return { role_gate: 'keep', role_gate_reason: `JD skills read software (${mix})${drop.length ? `; title also matched ${drop[0]}` : ''}` };
  if (hw >= 2 && hw >= sw) return { role_gate: 'drop', role_gate_reason: `not software: JD skills are hardware tooling (${mix})${keep.length ? `; title matched ${keep[0]}` : ''}` };
  if (!sw && !hw && (chips.some(c => OFFICE_ONLY.has(c)) || hits.some(h => OFFICE_ONLY.has(h.name)))) return { role_gate: 'drop', role_gate_reason: `not software: office/BI tooling only (${mix})` };
  return { role_gate: 'review', role_gate_reason: `ambiguous (${keep.length ? 'keep:' + keep.join('/') : 'no keep family'}${drop.length ? ', drop:' + drop.join('/') : ''}; ${mix}) — deliverable test` };
}

module.exports = { roleGate };

if (require.main === module) {
  const f = process.argv[2];
  if (!f) { console.error('usage: role-gate.js jdfacts.json'); process.exit(2); }
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  const rows = Array.isArray(j) ? j : (j.rows || []);
  const counts = {};
  for (const r of rows) { const g = roleGate(r); counts[g.role_gate] = (counts[g.role_gate] || 0) + 1; console.log(`${g.role_gate.padEnd(6)} ${(r.company || '').slice(0, 22).padEnd(22)} ${(r.title || '').slice(0, 44).padEnd(44)} ${g.role_gate_reason}`); }
  console.error(`role-gate: ${rows.length} rows → ${JSON.stringify(counts)}`);
}
