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
function describeControls(els) {
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
 * @returns {Promise<{fields: object[], root: object}>}
 */
export async function discover(root, { includeHidden = false } = {}) {
  const locator = root.locator(CONTROL_SELECTOR);
  const fields = await locator.evaluateAll(describeControls);
  return {
    fields: includeHidden ? fields : fields.filter((f) => f.visible || f.control === 'file'),
    all: fields,
  };
}

/**
 * Re-locate a discovered field. Prefers a stable attribute; falls back to the
 * positional index within the SAME selector set discovery used, so the two
 * cannot drift apart.
 */
export function locate(root, field) {
  if (field.id) return root.locator(`#${cssEscape(field.id)}`);
  if (field.name) return root.locator(`${field.tag}[name="${cssEscape(field.name)}"]`);
  return root.locator(CONTROL_SELECTOR).nth(field.index);
}

function cssEscape(s) { return String(s).replace(/(["\\#.:[\]()])/g, '\\$1'); }

/**
 * Emit the discovery summary event. Kept here so every discovery pass — the
 * first one, the post-upload barrier one (§5.5), and the post-crash re-verify
 * one (architecture.md §5a) — reports identically.
 */
export function emitDiscovery(events, { fields, rootFrames }) {
  return events.emit('field_discovered', {
    count: fields.length,
    required: fields.filter((f) => f.required).length,
    root_frames: rootFrames ?? [],
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
