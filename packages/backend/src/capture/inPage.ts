// Browser-side scripts for capture. Kept as plain JS strings so that no
// transpiler helper (e.g. esbuild's __name) leaks into page.evaluate.

/** Records classes added by scripts at any point (§5.3 runtime tokens). */
export const INIT_SCRIPT = `(() => {
  const seen = new Set();
  window.__cbrSeen = seen;
  const note = (el) => { if (el && el.classList) for (const c of el.classList) seen.add(c); };
  const mo = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'attributes') note(r.target);
      else for (const n of r.addedNodes) if (n.nodeType === 1) { note(n); if (n.querySelectorAll) n.querySelectorAll('[class]').forEach(note); }
    }
  });
  mo.observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
})();`;

/** Waits for fonts and two frames, then finishes running animations. */
export const SETTLE_SCRIPT = `(async () => {
  try { await document.fonts.ready; } catch {}
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  // Finite animations/transitions jump to their end state; infinite ones are
  // frozen at t=0 so repeated measurements of the same page agree.
  try {
    for (const a of document.getAnimations()) {
      try {
        const end = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming().endTime : 0;
        if (end === Infinity) { a.pause(); a.currentTime = 0; } else a.finish();
      } catch {}
    }
  } catch {}
  return true;
})()`;

/**
 * Collects stylesheets, tokens, inline styles, the compact L1 tree, the L2
 * shell and element boxes. Returns a JSON-serializable object.
 */
export const COLLECT_SCRIPT = `(() => {
  const de = document.documentElement;
  const NO_BOX = new Set(['script', 'noscript', 'meta', 'link', 'style', 'title', 'base', 'head', 'template']);
  const sheetText = (s) => { try { return Array.from(s.cssRules, (r) => r.cssText).join('\\n'); } catch { return s.ownerNode ? s.ownerNode.textContent || '' : ''; } };
  const links = [], inline = [], adopted = [];
  for (const s of Array.from(document.styleSheets)) {
    if (s.href) links.push(s.href); else inline.push(sheetText(s));
  }
  for (const s of (document.adoptedStyleSheets || [])) adopted.push(sheetText(s));

  const els = Array.from(document.getElementsByTagName('*'));
  const index = new Map();
  const tokens = new Set();
  const finalClasses = new Set();
  const styles = new Set();
  const nodes = [];
  const boxes = [];
  for (let i = 0; i < els.length; i++) {
    const el = els[i];
    index.set(el, i);
    const tag = el.localName.toLowerCase();
    tokens.add('t:' + tag);
    const flat = [];
    for (const a of Array.from(el.attributes)) {
      const name = a.name.toLowerCase();
      tokens.add('a:' + name);
      flat.push(name, a.value);
    }
    for (const c of Array.from(el.classList)) { tokens.add('c:' + c); finalClasses.add(c); }
    if (el.id) tokens.add('i:' + el.id);
    const st = el.getAttribute('style'); if (st) styles.add(st);
    let flags = 0;
    for (const c of el.childNodes) if (c.nodeType === 3 && c.data.length) { flags |= 1; break; }
    const p = el.parentElement;
    nodes.push([tag, p ? index.get(p) : -1, flat, flags]);
    if (!NO_BOX.has(tag) && boxes.length < 16000) {
      const r = el.getBoundingClientRect();
      boxes.push(Math.round(r.x * 2) / 2, Math.round(r.y * 2) / 2, Math.round(r.width * 2) / 2, Math.round(r.height * 2) / 2);
    }
  }
  const runtime = [];
  if (window.__cbrSeen) for (const c of window.__cbrSeen) if (!finalClasses.has(c)) runtime.push(c);

  // L2 shell: the DOM as it is now, without scripts, with form state and
  // CSSOM-only style rules baked in.
  const clone = de.cloneNode(true);
  const liveF = de.querySelectorAll('input,textarea,select option');
  const cloneF = clone.querySelectorAll('input,textarea,select option');
  for (let i = 0; i < liveF.length && i < cloneF.length; i++) {
    const l = liveF[i], c = cloneF[i];
    if (l.localName === 'input') {
      if (l.type === 'checkbox' || l.type === 'radio') { if (l.checked) c.setAttribute('checked', ''); else c.removeAttribute('checked'); }
      else if (l.type !== 'file' && l.type !== 'password') c.setAttribute('value', l.value);
    } else if (l.localName === 'textarea') c.textContent = l.value;
    else if (l.localName === 'option') { if (l.selected) c.setAttribute('selected', ''); else c.removeAttribute('selected'); }
  }
  const liveStyles = de.querySelectorAll('style');
  const cloneStyles = clone.querySelectorAll('style');
  for (let i = 0; i < liveStyles.length && i < cloneStyles.length; i++) {
    if (liveStyles[i].sheet) cloneStyles[i].textContent = sheetText(liveStyles[i].sheet);
  }
  for (const n of clone.querySelectorAll('script,noscript,meta[http-equiv]')) n.remove();
  for (const n of [clone, ...clone.querySelectorAll('*')]) {
    for (const a of Array.from(n.attributes)) if (/^on/i.test(a.name)) n.removeAttribute(a.name);
  }
  const head = clone.querySelector('head') || clone;
  for (const t of adopted) { const s = document.createElement('style'); s.setAttribute('data-cbr-adopted', ''); s.textContent = t; head.appendChild(s); }
  const dt = document.doctype;
  const doctype = dt ? '<!DOCTYPE ' + dt.name + (dt.publicId ? ' PUBLIC "' + dt.publicId + '"' : '') + (dt.systemId ? (dt.publicId ? '' : ' SYSTEM') + ' "' + dt.systemId + '"' : '') + '>' : '';

  return {
    quirks: document.compatMode === 'BackCompat',
    lang: de.getAttribute('lang') || undefined,
    dir: de.getAttribute('dir') || undefined,
    links, inline, adopted,
    tokens: Array.from(tokens), runtime, styles: Array.from(styles),
    tree: nodes,
    shell: doctype + '\\n' + clone.outerHTML,
    boxes,
  };
})()`;

/** Native evaluation: one char per selector (1 match, 0 none, 2 rejected). */
export function evalSelectorsScript(keys: string[]): string {
  return `((keys) => { let s = ''; for (const k of keys) { try { s += document.querySelector(k) ? '1' : '0'; } catch { s += '2'; } } return s; })(${JSON.stringify(keys)})`;
}

/** Boxes in the same order as COLLECT_SCRIPT (used for shell fidelity). */
export const BOXES_SCRIPT = `(() => {
  const boxes = [];
  const NO_BOX = new Set(['script', 'noscript', 'meta', 'link', 'style', 'title', 'base', 'head', 'template']);
  for (const el of document.getElementsByTagName('*')) {
    const tag = el.localName.toLowerCase();
    if (NO_BOX.has(tag) || boxes.length >= 16000) continue;
    const r = el.getBoundingClientRect();
    boxes.push(Math.round(r.x * 2) / 2, Math.round(r.y * 2) / 2, Math.round(r.width * 2) / 2, Math.round(r.height * 2) / 2);
  }
  return boxes;
})()`;
