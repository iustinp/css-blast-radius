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

// ---------------------------------------------------------------- exploring
// Interactions tried after load (#5, J2): which elements react to what, what
// can be done on the page now, and a fingerprint of its visible state.

/** Records the event types each element listens to (init script; exploring only). */
export const LISTENERS_SCRIPT = `(() => {
  if (window.__cbrL) return;
  const L = new WeakMap();
  window.__cbrL = L;
  const note = (t, type) => { if (!t || typeof t !== 'object') return; let s = L.get(t); if (!s) L.set(t, (s = new Set())); s.add(String(type).toLowerCase()); };
  const add = EventTarget.prototype.addEventListener;
  Object.defineProperty(EventTarget.prototype, 'addEventListener', {
    value: function addEventListener(type, fn, opts) { try { note(this, type); } catch {} return add.call(this, type, fn, opts); },
    writable: true, configurable: true, enumerable: false,
  });
  for (const p of ['onclick', 'onmousedown', 'onmouseup', 'onpointerdown', 'onpointerup', 'onmouseover', 'onmouseenter', 'onpointerenter', 'onpointerover']) {
    const d = Object.getOwnPropertyDescriptor(HTMLElement.prototype, p);
    if (!d || !d.set) continue;
    Object.defineProperty(HTMLElement.prototype, p, { ...d, set(v) { if (v) note(this, p.slice(2)); return d.set.call(this, v); } });
  }
  // Pending short timers (a script loaded 3 s after load…): waited for before exploring.
  const T = new Set();
  window.__cbrT = T;
  const st = window.setTimeout, ct = window.clearTimeout;
  window.setTimeout = function setTimeout(fn, ms, ...args) {
    if (typeof fn !== 'function' || !(Number(ms) <= 4000)) return st.call(this, fn, ms, ...args);
    const id = st.call(this, function () { T.delete(id); return fn.apply(this, arguments); }, ms, ...args);
    T.add(id);
    return id;
  };
  window.clearTimeout = function clearTimeout(id) { T.delete(id); return ct.call(this, id); };
})();`

/**
 * What can be done on the page now: [kind, target selector, label, family, score][],
 * best first. Never secrets, submits, uploads, new tabs or downloads.
 */
export const CANDIDATES_SCRIPT = `(() => {
  const L = window.__cbrL;
  const types = (el) => (L && L.get(el)) || null;
  const CLICK = ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend'];
  const HOVER = ['mouseover', 'mouseenter', 'pointerenter', 'pointerover'];
  const ROLES = new Set(['button', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'switch', 'checkbox', 'radio', 'option', 'combobox', 'treeitem', 'link']);
  const SECRET = /(^|[^a-z])(cc-|card|cvc|cvv|iban|pass|pin|ssn|secur|otp|token)/i;
  const TEXT = new Set(['', 'text', 'search']);
  const esc = (s) => CSS.escape(s);
  const vw = innerWidth, vh = innerHeight;
  const uniqueId = (e) => e.id && document.querySelectorAll('#' + esc(e.id)).length === 1;
  const selectorOf = (el) => {
    const parts = [];
    for (let e = el; e && e !== document.documentElement; e = e.parentElement) {
      if (uniqueId(e)) { parts.unshift('#' + esc(e.id)); return parts.join(' > '); }
      let i = 1;
      for (let s = e.previousElementSibling; s; s = s.previousElementSibling) if (s.localName === e.localName) i++;
      parts.unshift(esc(e.localName) + ':nth-of-type(' + i + ')');
    }
    parts.unshift('html');
    return parts.join(' > ');
  };
  const family = (kind, el) => {
    const parts = [];
    for (let e = el, k = 0; e && e !== document.body && k < 4; e = e.parentElement, k++) {
      parts.unshift(e.localName + Array.from(e.classList).slice(0, 3).map((c) => '.' + c).join(''));
    }
    return kind + '|' + parts.join('>');
  };
  const clip = (s) => String(s || '').replace(/\\s+/g, ' ').trim().slice(0, 60);
  const labelOf = (el) => {
    const lab = el.labels && el.labels[0] ? el.labels[0].innerText : '';
    const img = el.querySelector && el.querySelector('img[alt]');
    return clip(el.getAttribute('aria-label') || lab || el.getAttribute('title') || (el.localName === 'select' || el.localName === 'input' || el.localName === 'textarea' ? '' : el.innerText)
      || el.getAttribute('placeholder') || el.getAttribute('alt') || (img && img.alt) || el.getAttribute('name') || el.id || el.localName);
  };
  const secret = (el) => SECRET.test([el.getAttribute('autocomplete'), el.getAttribute('name'), el.id, el.getAttribute('aria-label')].join(' '));
  const out = [];
  const keys = new Set();
  for (const el of document.body ? document.body.getElementsByTagName('*') : []) {
    const tag = el.localName;
    const t = types(el);
    const listens = (list) => !!t && list.some((x) => t.has(x));
    const role = el.getAttribute('role');
    let kind = null, score = 0;
    if (tag === 'input') {
      const type = (el.getAttribute('type') || '').toLowerCase();
      if (el.readOnly || secret(el)) continue;
      if (TEXT.has(type)) (kind = 'type'), (score = 3);
      else if (type === 'checkbox' || type === 'radio') (kind = 'click'), (score = 2);
      else continue;
    } else if (tag === 'textarea') {
      if (el.readOnly || secret(el)) continue;
      (kind = 'type'), (score = 2);
    } else if (tag === 'select') {
      if (el.options.length < 2 || el.multiple || secret(el)) continue;
      (kind = 'select'), (score = 3);
    } else if (tag === 'button') {
      if (el.form && (el.getAttribute('type') || 'submit').toLowerCase() === 'submit') continue;
      (kind = 'click'), (score = 4);
    } else if (tag === 'a' && el.hasAttribute('href')) {
      const href = el.getAttribute('href').trim();
      if (el.target === '_blank' || el.hasAttribute('download') || /^(mailto|tel|sms):/i.test(href)) continue;
      (kind = 'click'), (score = listens(CLICK) || el.hasAttribute('aria-expanded') || el.hasAttribute('aria-controls') || /^javascript:/i.test(href) ? 3 : href.startsWith('#') ? 1 : 0.5);
    } else if (tag === 'summary') (kind = 'click'), (score = 5);
    else if ((role && ROLES.has(role)) || el.hasAttribute('onclick') || listens(CLICK)) (kind = 'click'), (score = 3);
    else if (listens(HOVER)) (kind = 'hover'), (score = 2);
    if (!kind) continue;
    if (el.hasAttribute('aria-expanded') || el.hasAttribute('aria-controls') || el.hasAttribute('aria-haspopup')) score += 2;
    if (kind === 'click' && listens(HOVER) && !listens(CLICK)) score -= 1;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true' || el.closest('[inert],fieldset[disabled]')) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.right <= 0 || r.left >= vw) continue;
    if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
    if (getComputedStyle(el).pointerEvents === 'none') continue;
    const label = labelOf(el);
    const fam = family(kind, el);
    const key = fam + '|' + label;
    if (keys.has(key)) continue;
    keys.add(key);
    if (r.top < vh) score += 2;
    out.push([kind, selectorOf(el), label, fam, score]);
    if (out.length >= 400) break;
  }
  return out.map((c, i) => [c, i]).sort((a, b) => b[0][4] - a[0][4] || a[1] - b[1]).slice(0, 150).map((x) => x[0]);
})()`;

/** A fingerprint of the page's visible structure (not its text): has an action changed anything? */
export const STATE_SCRIPT = `(() => {
  let h = 0x811c9dc5;
  const mix = (s) => { for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } h ^= 124; h = Math.imul(h, 0x01000193); };
  for (const el of document.body ? document.body.getElementsByTagName('*') : []) {
    mix(el.localName + '#' + el.id + '.' + el.getAttribute('class') + '|' + el.getAttribute('aria-expanded') + el.getAttribute('aria-selected') + el.getAttribute('aria-hidden')
      + (el.hasAttribute('open') ? 'o' : '') + (el.hidden ? 'h' : '') + (el.checkVisibility ? (el.checkVisibility() ? 'v' : '-') : ''));
  }
  return (h >>> 0).toString(36);
})()`;

/** Resolves once the DOM hasn't changed for `ms` (at most `max` ms). */
export function quietScript(ms: number, max: number): string {
  return `new Promise((done) => {
  const start = performance.now();
  let last = start;
  const mo = new MutationObserver(() => { last = performance.now(); });
  mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  const tick = () => { const now = performance.now(); if (now - last >= ${ms} || now - start >= ${max}) { mo.disconnect(); done(true); } else setTimeout(tick, 40); };
  setTimeout(tick, 40);
})`;
}
