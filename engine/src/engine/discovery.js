// Field discovery: DOM + frame traversal via Playwright locators.
// Design: interfaces.md §1 (engine owns discovery), architecture.md §8.
//
// The cost story this file is the answer to: on the current stack, getting a
// fresh element reference means re-snapshotting the whole accessibility tree
// (~150 calls per iCIMS application) because a CLI-per-action tool has no
// place to keep a handle. Playwright locators re-resolve lazily at use time,
// so there is no snapshot step to repeat — and no @ref to go stale, which is
// what forced raw-coordinate mouse recovery inside iCIMS's nested iframes.
//
// One discovery pass = ONE round trip: a single evaluateAll over the control
// set, not one call per control.

const CONTROL_SELECTOR = 'input, select, textarea';

/**
 * Resolve an adapter's FrameRootSpec into something locators can hang off.
 *
 * Verified against 5 live iCIMS tenants (2026-09-17): the chain is ONE level,
 * `iframe#icims_content_iframe` — not the two levels the Phase 1 stub guessed.
 * Cotiviti's page carries 8 frames (Hotjar, ad-sync pixels), which is exactly
 * why the chain is resolved BY SELECTOR and never by frame index.
 */
export function resolveRoot(page, spec) {
  let root = page;
  for (const sel of spec?.frames ?? []) root = root.frameLocator(sel);
  if (spec?.form) root = root.locator(spec.form);
  return root;
}

/* c8 ignore start — this function is serialized into the page */
function describeControls(els, opts) {
  const noiseSelectors = opts?.noiseSelectors ?? [];
  const isNoise = (el) => noiseSelectors.some((s) => {
    // A selector the browser cannot parse must not take the discovery pass down
    // with it — it is reported as "not noise" and the control is handled
    // normally, which is the safe direction to fail in.
    try { return el.matches(s); } catch { return false; }
  });
  const labelOf = (el) => {
    const out = [];
    if (el.id) {
      const l = el.ownerDocument.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l) out.push(l.innerText);
    }
    const w = el.closest('label');
    if (w) out.push(w.innerText);
    if (el.getAttribute('aria-label')) out.push(el.getAttribute('aria-label'));
    const ab = el.getAttribute('aria-labelledby');
    if (ab) {
      for (const id of ab.split(/\s+/)) {
        const n = el.ownerDocument.getElementById(id);
        if (n) out.push(n.innerText);
      }
    }
    // Last resort: a table/div layout with the label in a sibling cell.
    if (!out.length) {
      const row = el.closest('tr, .row, .iCIMS_TableRow, div');
      if (row) {
        const t = (row.innerText || '').split('\n')[0];
        if (t && t.length < 120) out.push(t);
      }
    }
    return out.map((t) => (t || '').replace(/\s+/g, ' ').trim()).filter(Boolean)[0] ?? null;
  };

  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };

  return els.map((el, index) => {
    const tag = el.tagName.toLowerCase();
    const type = (el.type || '').toLowerCase();
    let control = 'text';
    if (tag === 'select') control = el.multiple ? 'multiselect' : 'select';
    else if (tag === 'textarea') control = 'textarea';
    else if (type === 'checkbox') control = 'checkbox';
    else if (type === 'radio') control = 'radio';
    else if (type === 'file') control = 'file';
    else if (type === 'number') control = 'spinbutton';
    else if (type === 'date') control = 'date';
    else if (el.getAttribute('role') === 'combobox' || el.getAttribute('aria-autocomplete')) control = 'combobox';

    const label = labelOf(el);
    return {
      index,
      tag,
      type: type || null,
      control,
      noise: isNoise(el),
      // Workday's only stable selector surface. Its element ids are positional
      // render ids (`#input-4` is the email box on one page and something else
      // on the next) and its class names are per-deploy emotion hashes, so a
      // discovered field without this cannot be matched to a Workday binding at
      // all. Null everywhere else, and harmless there.
      automationId: el.getAttribute('data-automation-id') || null,
      id: el.id || null,
      name: el.getAttribute('name') || null,
      label,
      placeholder: el.placeholder || null,
      // A form can mark required three different ways; all three count.
      required: !!el.required
        || el.getAttribute('aria-required') === 'true'
        || /\*\s*$/.test(label || ''),
      disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true',
      readOnly: !!el.readOnly,
      visible: visible(el),
      value: tag === 'select' ? (el.options[el.selectedIndex]?.text ?? '') : (el.value ?? ''),
      checked: type === 'checkbox' || type === 'radio' ? !!el.checked : null,
      // For radios: the QUESTION, as opposed to this member's option text.
      // A fieldset legend or an aria-labelled group is the question; without
      // it the group falls back to its first member's label.
      groupLabel: type === 'radio'
        ? (el.closest('fieldset')?.querySelector('legend')?.innerText
            || el.closest('[role="radiogroup"]')?.getAttribute('aria-label')
            || null)
        : null,
      options: tag === 'select'
        ? [...el.options].map((o) => (o.text || '').replace(/\s+/g, ' ').trim())
        : null,
      optionValues: tag === 'select' ? [...el.options].map((o) => o.value) : null,
    };
  });
}
/* c8 ignore stop */

/**
 * Discover every form control under a resolved root.
 *
 * `noiseSelectors` come from the adapter (`quirks.noiseSelectors`) and name
 * controls that exist but must never be filled or counted. This is not a
 * convenience — without it the Greenhouse adapter parks 100% of applications:
 * every react-select control on a Greenhouse form is shadowed by a LABEL-LESS
 * input marked `required` (`input.remix-css-…-requiredInput`, five of them on
 * the CoVar form). A required control with no label maps to no FieldKey, and an
 * unmapped required field parks the application — so a form that is perfectly
 * fillable on screen would be unfillable by the engine.
 *
 * Noise is SUPPRESSED, never hidden: the controls stay in `all` with
 * `noise: true`, and the discovery event reports how many were suppressed, so
 * an adapter that over-declares noise is visible in the stream rather than
 * quietly skipping real fields.
 *
 * @returns {Promise<{fields: object[], all: object[], noise: object[]}>}
 */
/**
 * Collapse each radio GROUP (same `name`) into one logical control whose
 * `options` are the member labels and whose `members` carry enough to address
 * the one that matches.
 *
 * Mac finding D6 made this necessary: radios were N separate controls, each
 * with an EMPTY option list, so every radio question — Lever's whole EEO race
 * block, the yes/no eligibility cards — skipped as `option_not_found` with
 * `candidates_seen: []`. The options were on the page; discovery just never
 * assembled them into a question.
 */
function collapseRadioGroups(kept) {
  const out = [];
  const groups = new Map();
  for (const f of kept) {
    if (f.control !== 'radio' || !f.name) { out.push(f); continue; }
    if (!groups.has(f.name)) {
      const rep = {
        ...f,
        label: f.groupLabel || f.label,
        options: [],
        members: [],
        checked: false,
      };
      groups.set(f.name, rep);
      out.push(rep);
    }
    const rep = groups.get(f.name);
    rep.options.push((f.label ?? '').trim());
    rep.members.push({ index: f.index, id: f.id, label: f.label, checked: f.checked });
    rep.checked = rep.checked || !!f.checked;
    rep.required = rep.required || f.required;
    rep.value = rep.checked ? (rep.members.find((m) => m.checked)?.label ?? rep.value) : '';
  }
  return out;
}

export async function discover(root, { includeHidden = false, noiseSelectors = [] } = {}) {
  const locator = root.locator(CONTROL_SELECTOR);
  const fields = await locator.evaluateAll(describeControls, { noiseSelectors });
  const kept = collapseRadioGroups(fields.filter((f) => !f.noise));
  return {
    fields: includeHidden ? kept : kept.filter((f) => f.visible || f.control === 'file'),
    all: fields,
    noise: fields.filter((f) => f.noise),
  };
}

/**
 * Re-locate a discovered field. Prefers a stable attribute; falls back to the
 * positional index within the SAME selector set discovery used, so the two
 * cannot drift apart.
 */
export function locate(root, field) {
  // The id is matched by ATTRIBUTE, never by a `#` selector: Greenhouse's
  // demographic controls carry all-digit ids, and `#4462...` is a CSS parse
  // error no amount of punctuation-escaping fixes (fleet 0918:
  // selfid.ethnicity died as fill_failed on "'#<digits>' is not a valid
  // selector"). The attribute form takes any id verbatim.
  if (field.id) return root.locator(`[id="${String(field.id).replace(/"/g, '\\"')}"]`);
  if (field.name) return root.locator(`${field.tag}[name="${cssEscape(field.name)}"]`);
  if (field.automationId) return root.locator(`[data-automation-id="${cssEscape(field.automationId)}"]`);
  return root.locator(CONTROL_SELECTOR).nth(field.index);
}

function cssEscape(s) { return String(s).replace(/(["\\#.:[\]()])/g, '\\$1'); }

/**
 * Emit the discovery summary event. Kept here so every discovery pass — the
 * first one, the post-upload barrier one (§5.5), and the post-crash re-verify
 * one (architecture.md §5a) — reports identically.
 */
export function emitDiscovery(events, { fields, rootFrames, noise = [] }) {
  return events.emit('field_discovered', {
    count: fields.length,
    required: fields.filter((f) => f.required).length,
    root_frames: rootFrames ?? [],
    // An adapter that over-declares noise silently skips real fields. Reporting
    // the suppression count is what makes that a visible mistake.
    noise_suppressed: noise.length,
  });
}

/** File inputs are discovered even when invisible: Greenhouse replaces the
 *  input with a "Remove file" row and Ashby renders an autofill-from-resume
 *  input BEFORE the real one, so an ordinal pick lands on the wrong control
 *  (F6). Adapters address uploads by NAMED target; this just makes sure the
 *  control set they name is actually in the discovered set. */
export function fileInputs(discovered) {
  return discovered.all.filter((f) => f.control === 'file');
}
