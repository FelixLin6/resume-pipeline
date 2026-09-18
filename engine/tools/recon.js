#!/usr/bin/env node
// Navigation-only reconnaissance. READ-ONLY, BY CONSTRUCTION.
//
// Purpose: derive real selectors, the real frame chain, and real wall markers
// for an ATS adapter from live tenant pages, without ever interacting with a
// real employer's form.
//
// The read-only guarantee is structural, not a promise in a comment:
//   - the only page verbs used are `goto`, `waitForLoadState`, `frames()`,
//     `evaluate` (a pure DOM read), `title`, `content` and `screenshot`;
//   - there is NO code path in this file that calls click/fill/type/press/
//     check/selectOption/setInputFiles/focus/hover/dispatchEvent — a
//     self-check below asserts that against this file's own source, so the
//     guarantee survives a future careless edit;
//   - the DOM scan runs in a page-side function that only READS.
//
// Safety, same rules as the rest of the engine:
//   - our OWN scratch Chrome, randomized free port (assertScratchPort refuses
//     9222/9223), own temp profile, killed by pidfile with a cmdline check;
//   - the shared pipeline browser is never contacted;
//   - one isolated context per tenant, discarded after, so no challenge cookie
//     is carried between tenants.
//
// Usage: node tools/recon.js <url> [<url> ...]   (writes engine/recon/, gitignored)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { attach } from '../src/driver/attach.js';
import { startScratchChrome, freePort, findChromeBinary } from '../src/driver/scratch-chrome.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'recon');

// ---------------------------------------------------------------------------
// The interaction ban, enforced against this file's own source.
// ---------------------------------------------------------------------------
const BANNED_VERBS = [
  'click', 'fill', 'type', 'press', 'check', 'uncheck', 'selectOption',
  'setInputFiles', 'focus', 'hover', 'dispatchEvent', 'tap', 'dragTo',
  'setChecked', 'pressSequentially',
];

export function assertReadOnlySource(src) {
  const offenders = BANNED_VERBS.filter((v) => new RegExp(`\\.${v}\\s*\\(`).test(src));
  if (offenders.length) {
    throw new Error(
      `recon.js must be read-only, but calls: ${offenders.join(', ')}. ` +
      `Reconnaissance never touches a real employer's form.`
    );
  }
  return true;
}

// ---------------------------------------------------------------------------
// The page-side DOM scan. Pure reads.
// ---------------------------------------------------------------------------
/* c8 ignore start — runs in the page, not in node */
function scanDocument() {
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const labelFor = (el) => {
    const texts = [];
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l) texts.push(l.innerText);
    }
    const wrap = el.closest('label');
    if (wrap) texts.push(wrap.innerText);
    if (el.getAttribute('aria-label')) texts.push(el.getAttribute('aria-label'));
    const ab = el.getAttribute('aria-labelledby');
    if (ab) {
      ab.split(/\s+/).forEach((id) => {
        const n = document.getElementById(id);
        if (n) texts.push(n.innerText);
      });
    }
    return texts.map((t) => (t || '').replace(/\s+/g, ' ').trim()).filter(Boolean)[0] ?? null;
  };
  const sel = (el) => {
    if (el.id) return `#${CSS.escape(el.id)}`;
    if (el.name) return `${el.tagName.toLowerCase()}[name="${el.name}"]`;
    const cls = (el.className || '').toString().trim().split(/\s+/).filter(Boolean)[0];
    return cls ? `${el.tagName.toLowerCase()}.${cls}` : el.tagName.toLowerCase();
  };

  const controls = [...document.querySelectorAll('input, select, textarea')].map((el) => ({
    tag: el.tagName.toLowerCase(),
    type: el.type ?? null,
    id: el.id || null,
    name: el.name || null,
    selector: sel(el),
    label: labelFor(el),
    placeholder: el.placeholder || null,
    required: el.required || el.getAttribute('aria-required') === 'true',
    disabled: !!el.disabled,
    visible: vis(el),
    // Values are NOT read off real tenant pages beyond option TEXT, which is
    // the ATS's own vocabulary and is what an adapter needs.
    options: el.tagName === 'SELECT'
      ? [...el.options].slice(0, 40).map((o) => (o.text || '').replace(/\s+/g, ' ').trim())
      : undefined,
  }));

  const buttons = [...document.querySelectorAll('button, input[type=submit], input[type=button], a[role=button]')]
    .map((el) => ({
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      selector: sel(el),
      text: (el.innerText || el.value || '').replace(/\s+/g, ' ').trim().slice(0, 80),
      disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true',
      visible: vis(el),
    })).filter((b) => b.text);

  const headings = [...document.querySelectorAll('h1, h2, h3, legend, .iCIMS_InfoMsg, [class*=Header]')]
    .map((el) => (el.innerText || '').replace(/\s+/g, ' ').trim())
    .filter((t) => t && t.length < 200).slice(0, 40);

  const iframes = [...document.querySelectorAll('iframe, frame')].map((el) => ({
    id: el.id || null,
    name: el.getAttribute('name') || null,
    src: (el.getAttribute('src') || '').slice(0, 300),
    title: el.getAttribute('title') || null,
    selector: el.id ? `iframe#${el.id}`
      : el.getAttribute('name') ? `iframe[name="${el.getAttribute('name')}"]`
      : 'iframe',
    width: el.getBoundingClientRect().width,
    height: el.getBoundingClientRect().height,
  }));

  const checkboxes = [...document.querySelectorAll('input[type=checkbox]')].map((el) => ({
    selector: sel(el), label: labelFor(el), checked: el.checked, visible: vis(el),
  }));

  return {
    url: location.href,
    title: document.title,
    headings,
    controls,
    buttons,
    iframes,
    checkboxes,
    text: (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 4000),
  };
}
/* c8 ignore stop */

// ---------------------------------------------------------------------------
export function classifyWall(bundle) {
  const hits = [];
  const all = JSON.stringify(bundle);
  if (/hcaptcha\.com/i.test(all) || /h-captcha/i.test(all)) hits.push('hcaptcha');
  if (/recaptcha/i.test(all)) hits.push('recaptcha-interactive');
  if (/datadome/i.test(all)) hits.push('datadome');
  if (/cf-challenge|cdn-cgi\/challenge/i.test(all)) hits.push('cloudflare-challenge');
  return hits;
}

export async function reconOne(browser, url, { outDir = OUT } = {}) {
  const u = new URL(url);
  const slug = `${u.hostname.split('.')[0]}`.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  const dir = path.join(outDir, slug);
  fs.mkdirSync(dir, { recursive: true });

  // Isolated context per tenant: a challenge cookie from one tenant must not
  // be carried to the next, or the wall-marker evidence is contaminated.
  const ctx = await browser.newContext({
    viewport: { width: 1350, height: 900 },
    locale: 'en-US',
  });
  const record = { url, tenant: `icims:${u.hostname.toLowerCase()}`, started: new Date().toISOString() };

  try {
    const page = await ctx.newPage();
    const responses = [];
    page.on('response', (r) => {
      if (responses.length < 400) responses.push({ url: r.url().slice(0, 200), status: r.status() });
    });

    const nav = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    record.http_status = nav?.status() ?? null;
    record.landed_url = page.url();
    try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch { /* fine */ }

    // Frame tree — the thing the run records could NOT tell us.
    const frames = [];
    for (const f of page.frames()) {
      const entry = { url: f.url().slice(0, 300), name: f.name() || null, isMain: f === page.mainFrame() };
      try {
        const fe = await f.frameElement();
        entry.element = await fe.evaluate((el) => ({
          id: el.id || null,
          name: el.getAttribute('name') || null,
          selector: el.id ? `iframe#${el.id}`
            : el.getAttribute('name') ? `iframe[name="${el.getAttribute('name')}"]`
            : `iframe[src*="${(el.getAttribute('src') || '').split('?')[0].slice(-40)}"]`,
        }));
        const parent = f.parentFrame();
        entry.parentUrl = parent ? parent.url().slice(0, 200) : null;
      } catch { entry.element = null; }
      try { entry.scan = await f.evaluate(scanDocument); } catch (e) { entry.scanError = String(e).slice(0, 200); }
      frames.push(entry);
    }
    record.frames = frames;
    record.frame_count = frames.length;
    record.walls = classifyWall(frames);
    record.blocked_responses = responses.filter((r) => r.status >= 400).slice(0, 20);

    await page.screenshot({ path: path.join(dir, 'landing.png'), fullPage: false });
    fs.writeFileSync(path.join(dir, 'frames.json'), JSON.stringify(record, null, 2));
  } catch (e) {
    record.error = String(e).slice(0, 400);
  } finally {
    record.ended = new Date().toISOString();
    fs.writeFileSync(path.join(dir, 'frames.json'), JSON.stringify(record, null, 2));
    await ctx.close();   // by handle, by owner
  }
  return record;
}

export async function main(urls) {
  assertReadOnlySource(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8'));
  if (!findChromeBinary()) throw new Error('no Chrome for Testing binary in the Playwright cache');

  const port = await freePort();                   // never 9222/9223
  const chrome = await startScratchChrome({ port });
  const summary = [];
  try {
    const { browser } = await attach({ port });
    for (const url of urls) {
      process.stderr.write(`recon: ${url}\n`);
      const r = await reconOne(browser, url);
      summary.push({
        url: r.url, status: r.http_status, landed: r.landed_url,
        frames: r.frame_count, walls: r.walls, error: r.error ?? null,
      });
      // Polite spacing between tenants — recon must not look like a sweep.
      await new Promise((res) => setTimeout(res, 4000));
    }
    await browser.close();
  } finally {
    chrome.stop();
  }
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
  return summary;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).then((s) => {
    console.log(JSON.stringify(s, null, 2));
  }).catch((e) => { console.error(e); process.exit(1); });
}
