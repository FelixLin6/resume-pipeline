#!/usr/bin/env node
// READ-ONLY probe: what distinguishes a FIRED hCaptcha challenge from the
// always-present invisible widget?
//
// This matters more than any other marker in the iCIMS adapter. Recon showed
// every iCIMS login page carries an hCaptcha iframe and an
// `h-captcha-response` textarea whether or not a challenge ever fires — so the
// scaffold's guessed marker `iframe[src*="hcaptcha"]` would report a wall on
// 100% of loads, including the ones that sail straight through.
//
// Same read-only discipline as recon.js: goto + evaluate(read) + screenshot.
// Nothing is clicked, typed, or submitted.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attach } from '../src/driver/attach.js';
import { startScratchChrome, freePort } from '../src/driver/scratch-chrome.js';
import { assertReadOnlySource } from './recon.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/* c8 ignore start — page-side */
function probeCaptcha() {
  const out = { widgets: [], responseTextareas: [], frames: [] };
  for (const el of document.querySelectorAll('[class*="h-captcha"], [data-hcaptcha-widget-id], .h-captcha')) {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    out.widgets.push({
      selector: el.id ? `#${el.id}` : `${el.tagName.toLowerCase()}.${(el.className || '').toString().trim().split(/\s+/)[0]}`,
      className: (el.className || '').toString(),
      display: cs.display, visibility: cs.visibility, opacity: cs.opacity,
      w: r.width, h: r.height,
    });
  }
  for (const t of document.querySelectorAll('textarea[name="h-captcha-response"]')) {
    out.responseTextareas.push({ id: t.id, hasValue: !!t.value, len: (t.value || '').length });
  }
  for (const f of document.querySelectorAll('iframe[src*="hcaptcha"]')) {
    const cs = getComputedStyle(f);
    const parent = f.parentElement;
    const pcs = parent ? getComputedStyle(parent) : null;
    const r = f.getBoundingClientRect();
    out.frames.push({
      srcFrag: (f.getAttribute('src') || '').split('#')[1]?.slice(0, 60) ?? null,
      title: f.getAttribute('title') || null,
      ariaHidden: f.getAttribute('aria-hidden'),
      display: cs.display, visibility: cs.visibility, w: r.width, h: r.height,
      parentDisplay: pcs?.display ?? null,
      parentVisibility: pcs?.visibility ?? null,
      parentOpacity: pcs?.opacity ?? null,
      parentClass: (parent?.className || '').toString().slice(0, 120),
    });
  }
  return out;
}
/* c8 ignore stop */

async function main(urls) {
  assertReadOnlySource(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8'));
  const port = await freePort();
  const chrome = await startScratchChrome({ port });
  const results = [];
  try {
    const { browser } = await attach({ port });
    for (const url of urls) {
      const ctx = await browser.newContext({ viewport: { width: 1350, height: 900 } });
      try {
        const page = await ctx.newPage();
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        try { await page.waitForLoadState('networkidle', { timeout: 12000 }); } catch { /* fine */ }
        const per = { url, frames: [] };
        for (const f of page.frames()) {
          try {
            const p = await f.evaluate(probeCaptcha);
            if (p.widgets.length || p.frames.length || p.responseTextareas.length) {
              per.frames.push({ frameUrl: f.url().slice(0, 80), ...p });
            }
          } catch { /* cross-origin frame, expected */ }
        }
        results.push(per);
      } finally { await ctx.close(); }
      await new Promise((r) => setTimeout(r, 3000));
    }
    await browser.close();
  } finally { chrome.stop(); }
  fs.writeFileSync(path.join(HERE, '..', 'recon', 'hcaptcha-probe.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
}

main(process.argv.slice(2)).catch((e) => { console.error(e); process.exit(1); });
