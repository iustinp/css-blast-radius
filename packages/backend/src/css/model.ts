// Stylesheet model: the authored CSS turned into change units — style rules
// (nesting and @scope desugared into full selectors), named definitions,
// layer order, imports — plus the name-usage tables used to count pages for
// custom properties, fonts, keyframes and similar global definitions (§6.2).

import postcss from "postcss";
import { createHash } from "node:crypto";
import { analyzeComplex, splitSelectorList, type ComplexSelector } from "./selectors.js";

export interface Decl {
  prop: string;
  value: string;
  important: boolean;
}

export interface Condition {
  kind: string; // media | supports | container | scope | layer | starting-style | <other at-rule>
  text: string;
}

export interface StyleRule {
  index: number;
  /** Desugared selector list. */
  selectorText: string;
  complex: ComplexSelector[];
  decls: Decl[];
  declSig: string;
  conditions: Condition[];
  condKey: string;
  layer: string | null;
  /** condKey + selector: the identity used to pair rules across versions. */
  key: string;
  line: number;
  endLine: number;
  /** First and last lines of the enclosing at-rules and rules (what a partial apply keeps with the rule). */
  ctxLines: number[];
  /** Set when browsers would drop the rule (invalid selector). */
  invalid?: string;
  /** Usage keys found in declarations: var:--x, font:name, anim:name… */
  uses: string[];
  /** Custom properties declared by this rule. */
  declaresVars: string[];
}

export interface Definition {
  kind: string; // font-face | keyframes | property | counter-style | position-try | font-feature-values | font-palette-values
  name: string;
  usageKey: string; // e.g. "font:brand sans"
  sig: string;
  line: number;
  endLine: number;
  ctxLines: number[];
  /** Names used by the definition's own declarations (var() in keyframes, @position-try). */
  uses: string[];
}

export interface StylesheetModel {
  hash: string;
  rules: StyleRule[];
  defs: Definition[];
  layerOrder: string[];
  imports: string[];
  namespaces: string[];
  other: Array<{ name: string; sig: string; line: number }>;
  parseError?: { message: string; line?: number };
  /** usage key → indexes of rules whose declarations use it. */
  usage: Map<string, number[]>;
  /** custom property → custom properties its value references (--a: var(--b) gives a→[b]). */
  varEdges: Map<string, Set<string>>;
}

const DEF_KINDS: Record<string, string> = {
  "font-face": "font",
  "font-feature-values": "font",
  keyframes: "anim",
  "-webkit-keyframes": "anim",
  property: "var",
  "counter-style": "counter",
  "position-try": "ptry",
  "font-palette-values": "palette",
};

const CONDITIONAL = new Set(["media", "supports", "container", "scope", "layer", "starting-style", "document", "-moz-document"]);

function norm(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ").trim();
}

function unquote(s: string): string {
  return s.replace(/^["']|["']$/g, "");
}

const FONT_PROPS = new Set(["font-family", "font"]);
const ANIM_PROPS = new Set(["animation", "animation-name"]);
const COUNTER_PROPS = new Set(["list-style", "list-style-type", "content", "counter-reset", "counter-increment", "counter-set"]);
const PTRY_PROPS = new Set(["position-try", "position-try-fallbacks", "position-try-options"]);

/**
 * Usage keys a declaration value creates. Shared with inline-style capture.
 * A custom property declaration is not a use: `--a: var(--b)` gives the
 * dependency edge `vdep:--b>--a`, and its identifiers give `ind:<name>` keys
 * (a font or animation name possibly consumed through var(--a)).
 */
// Identifiers (including <dashed-ident>s such as @position-try names) not
// inside numbers (1s), hex colors (#0050d8) or dotted names.
const IDENT = /"([^"]*)"|'([^']*)'|(?<![\w#.-])(-{0,2}[a-zA-Z_][\w-]*)/g;

export function usageKeysFor(prop: string, value: string): string[] {
  const out = new Set<string>();
  if (prop.startsWith("--")) {
    for (const m of value.matchAll(/var\(\s*(--[\w-]+)/g)) out.add(`vdep:${m[1]}>${prop}`);
    const plain = value.replace(/var\([^)]*\)?/g, " ");
    for (const part of plain.split(",")) {
      const raw = part.trim();
      const name = unquote(raw).toLowerCase();
      if (name && (/^["']/.test(raw) || /^[a-z_-]/.test(name))) out.add("ind:" + name);
    }
    for (const m of plain.matchAll(IDENT)) out.add("ind:" + (m[1] ?? m[2] ?? m[3]).toLowerCase());
    return [...out];
  }
  for (const m of value.matchAll(/var\(\s*(--[\w-]+)/g)) out.add("var:" + m[1]);
  const p = prop.toLowerCase();
  // var(--x) is a custom-property use, not a name; its fallback still counts.
  const named = value.replace(/var\(\s*--[\w-]+/g, "(");
  const idents = (text = named, strings = true) =>
    [...text.matchAll(IDENT)].filter((m) => strings || m[3]).map((m) => (m[1] ?? m[2] ?? m[3]).toLowerCase());
  if (FONT_PROPS.has(p)) {
    const parts = value.split(",");
    for (let i = 0; i < parts.length; i++) {
      let part = parts[i].trim();
      const q = /^["']([^"']+)["']$/.exec(part) ?? /["']([^"']+)["']\s*$/.exec(part);
      if (q) {
        out.add("font:" + q[1].toLowerCase());
        continue;
      }
      if (p === "font" && i === 0) {
        // Shorthand: the family follows the size (the last token with a digit).
        const words = part.split(/\s+/);
        let last = -1;
        words.forEach((w, k) => {
          if (/\d/.test(w)) last = k;
        });
        part = words.slice(last + 1).join(" ");
      }
      if (part) out.add("font:" + part.toLowerCase());
    }
  } else if (ANIM_PROPS.has(p)) {
    for (const id of idents()) out.add("anim:" + id);
  } else if (COUNTER_PROPS.has(p)) {
    // In `content`, only counter(name, style) / counters(name, "sep", style) name counters.
    const texts = p === "content" ? [...value.matchAll(/counters?\(([^)]*)\)/g)].map((m) => m[1]) : [named];
    for (const t of texts) for (const id of idents(t, false)) out.add("counter:" + id);
  } else if (PTRY_PROPS.has(p)) {
    for (const id of idents()) out.add("ptry:" + id);
  } else if (p === "font-palette") {
    for (const id of idents()) out.add("palette:" + id);
  }
  return [...out];
}

function conditionOf(at: postcss.AtRule): Condition {
  return { kind: at.name.toLowerCase(), text: norm(`@${at.name} ${at.params}`) };
}

function isSimpleCompound(sel: string): boolean {
  return !/[\s>+~,]/.test(sel.replace(/\([^)]*\)/g, "()")) && !/::/.test(sel);
}

function substituteNesting(own: string, parent: string): string {
  if (own.includes("&")) return own.replace(/&/g, parent);
  return `${parent} ${own}`;
}

/**
 * Splits CSS at top-level statement boundaries (end of a top-level block or
 * of a top-level `;` statement), skipping strings and comments.
 */
export function splitTopLevel(text: string): Array<{ start: number; end: number; line: number }> {
  const out: Array<{ start: number; end: number; line: number }> = [];
  let depth = 0;
  let start = 0;
  let line = 1;
  let startLine = 1;
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    if (c === 10) line++;
    else if (c === 47 && text.charCodeAt(i + 1) === 42) {
      const e = text.indexOf("*/", i + 2);
      const stop = e < 0 ? n : e + 2;
      for (let k = i; k < stop; k++) if (text.charCodeAt(k) === 10) line++;
      i = stop - 1;
    } else if (c === 34 || c === 39) {
      for (i++; i < n; i++) {
        const d = text.charCodeAt(i);
        if (d === 92) i++;
        else if (d === c || d === 10) {
          if (d === 10) line++;
          break;
        }
      }
    } else if (c === 123) depth++;
    else if (c === 125 || (c === 59 && depth === 0)) {
      if (c === 125) depth = Math.max(0, depth - 1);
      if (depth === 0) {
        out.push({ start, end: i + 1, line: startLine });
        start = i + 1;
        startLine = line;
      }
    }
  }
  if (start < n && text.slice(start).trim()) out.push({ start, end: n, line: startLine });
  return out;
}

const chunkCache = new Map<string, StylesheetModel>();

/** One top-level statement, parsed on its own. `part` may carry a parseError. */
export interface Chunk {
  body: string;
  /** 1-based line of the chunk's first character. */
  line: number;
  part: StylesheetModel;
}

export function parseChunks(text: string): Chunk[] {
  const out: Chunk[] = [];
  for (const c of splitTopLevel(text)) {
    const body = text.slice(c.start, c.end);
    let part = chunkCache.get(body);
    if (!part) {
      part = parseChunk(body);
      if (chunkCache.size > 100_000) chunkCache.clear();
      chunkCache.set(body, part);
    }
    out.push({ body, line: c.line, part });
  }
  return out;
}

/**
 * Joins parsed chunks into one model. A chunk that doesn't parse contributes
 * nothing (browsers skip a malformed statement and carry on); the first error
 * is kept on the model.
 */
export function assemble(chunks: Chunk[], text = chunks.map((c) => c.body).join("")): StylesheetModel {
  const model = emptyModel(createHash("sha1").update(text).digest("hex"));
  const seenLayers = new Set<string>();
  for (const chunk of chunks) {
    const part = chunk.part;
    // Line numbers inside a part are relative to the chunk's first character.
    const lineBase = chunk.line - 1;
    if (part.parseError) {
      model.parseError ??= { message: part.parseError.message, line: (part.parseError.line ?? 1) + lineBase };
      continue;
    }
    for (const r of part.rules) {
      const index = model.rules.length;
      model.rules.push({ ...r, index, line: r.line + lineBase, endLine: r.endLine + lineBase, ctxLines: r.ctxLines.map((l) => l + lineBase) });
      for (const k of r.uses) {
        let list = model.usage.get(k);
        if (!list) model.usage.set(k, (list = []));
        list.push(index);
      }
    }
    for (const d of part.defs) model.defs.push({ ...d, line: d.line + lineBase, endLine: d.endLine + lineBase, ctxLines: d.ctxLines.map((l) => l + lineBase) });
    for (const l of part.layerOrder) {
      if (!seenLayers.has(l)) {
        seenLayers.add(l);
        model.layerOrder.push(l);
      }
    }
    model.imports.push(...part.imports);
    model.namespaces.push(...part.namespaces);
    for (const o of part.other) model.other.push({ ...o, line: o.line + lineBase });
    for (const [k, v] of part.varEdges) {
      let set = model.varEdges.get(k);
      if (!set) model.varEdges.set(k, (set = new Set()));
      for (const x of v) set.add(x);
    }
  }
  return model;
}

/**
 * Parses a stylesheet. Top-level blocks are parsed independently and cached
 * by their text, so an edit reparses only the block being edited (§6.1).
 */
export function parseStylesheet(text: string): StylesheetModel {
  return assemble(parseChunks(text), text);
}

function emptyModel(hash: string): StylesheetModel {
  return { hash, rules: [], defs: [], layerOrder: [], imports: [], namespaces: [], other: [], usage: new Map(), varEdges: new Map() };
}

function parseChunk(text: string): StylesheetModel {
  const model = emptyModel("");

  let root: postcss.Root;
  try {
    root = postcss.parse(text);
  } catch (err: any) {
    model.parseError = { message: String(err?.reason ?? err?.message ?? err), line: err?.line };
    return model;
  }

  let anon = 0;
  const seenLayers = new Set<string>();
  const noteLayer = (name: string) => {
    if (!seenLayers.has(name)) {
      seenLayers.add(name);
      model.layerOrder.push(name);
    }
  };

  const selectorCache = new Map<postcss.Rule, string[]>();
  const resolveSelectors = (rule: postcss.Rule): string[] => {
    const cached = selectorCache.get(rule);
    if (cached) return cached;
    const own = splitSelectorList(rule.selector);
    let parentRule: postcss.Rule | undefined;
    let scope: postcss.AtRule | undefined;
    for (let p = rule.parent; p && p.type !== "root"; p = p.parent as any) {
      if (p.type === "rule") {
        parentRule = p as postcss.Rule;
        break;
      }
      if (p.type === "atrule" && (p as postcss.AtRule).name.toLowerCase() === "scope" && !scope) {
        scope = p as postcss.AtRule;
      }
    }
    let result = own;
    if (scope) {
      const m = /^\s*\(([^)]*)\)/.exec(scope.params);
      const scopeRoot = m ? m[1].trim() : "";
      if (scopeRoot) {
        const sr = `:is(${scopeRoot})`;
        result = result.map((s) =>
          s.includes(":scope") ? s.replace(/:scope\b/g, sr) : s.includes("&") ? s.replace(/&/g, sr) : `${sr} ${s}`,
        );
      }
    }
    if (parentRule) {
      const parents = resolveSelectors(parentRule);
      const p = parents.length === 1 && isSimpleCompound(parents[0]) ? parents[0] : `:is(${parents.join(", ")})`;
      result = result.map((s) => substituteNesting(s, p));
    }
    selectorCache.set(rule, result);
    return result;
  };

  const enclosingRule = (node: postcss.Node): postcss.Rule | undefined => {
    for (let p = node.parent; p && p.type !== "root"; p = p.parent as any) {
      if (p.type === "rule") return p as postcss.Rule;
    }
    return undefined;
  };

  const layerPath = (node: postcss.Node): string | null => {
    const names: string[] = [];
    if (node.type === "atrule" && (node as any).__cbrLayer) names.push((node as any).__cbrLayer);
    for (let p = node.parent; p && p.type !== "root"; p = p.parent as any) {
      if (p.type === "atrule" && (p as postcss.AtRule).name.toLowerCase() === "layer") {
        names.unshift((p as any).__cbrLayer as string);
      }
    }
    return names.length ? names.join(".") : null;
  };

  root.walk((node) => {
    if (node.type === "atrule") {
      const at = node as postcss.AtRule;
      const name = at.name.toLowerCase();
      if (name === "layer") {
        const parent = layerPath(at);
        if (at.nodes) {
          const own = at.params.trim() || `<anonymous-${++anon}>`;
          (at as any).__cbrLayer = own;
          noteLayer(parent ? `${parent}.${own}` : own);
        } else {
          for (const n of at.params.split(",").map((s) => s.trim()).filter(Boolean)) {
            noteLayer(parent ? `${parent}.${n}` : n);
          }
        }
      } else if (name === "import") {
        model.imports.push(norm(at.params));
      } else if (name === "namespace") {
        model.namespaces.push(norm(at.params));
      } else if (DEF_KINDS[name]) {
        let defName = norm(at.params);
        if (name === "font-face") {
          const fam = at.nodes?.find((n) => n.type === "decl" && (n as postcss.Declaration).prop.toLowerCase() === "font-family") as
            | postcss.Declaration
            | undefined;
          defName = fam ? unquote(norm(fam.value)) : "";
        } else if (name === "font-feature-values") {
          defName = unquote(defName);
        }
        const kind = name === "-webkit-keyframes" ? "keyframes" : name;
        const uses = new Set<string>();
        if (kind === "keyframes" || kind === "position-try") {
          at.walkDecls((d) => {
            for (const k of usageKeysFor(d.prop.startsWith("--") ? d.prop : d.prop.toLowerCase(), norm(d.value))) uses.add(k);
          });
        }
        model.defs.push({
          kind,
          name: defName,
          usageKey: `${DEF_KINDS[name]}:${kind === "property" ? defName : defName.toLowerCase()}`,
          sig: norm(at.toString()),
          line: at.source?.start?.line ?? 0,
          endLine: at.source?.end?.line ?? at.source?.start?.line ?? 0,
          ctxLines: ctxLinesOf(at),
          uses: [...uses],
        });
      } else if (!CONDITIONAL.has(name) && !at.nodes?.some((n) => n.type === "rule")) {
        model.other.push({ name, sig: norm(at.toString()), line: at.source?.start?.line ?? 0 });
      }
      // Bare declarations in a conditional group apply to the enclosing
      // rule's selector (nesting) or to the scope root (@scope).
      if (CONDITIONAL.has(name) && at.nodes?.some((n) => n.type === "decl")) {
        const owner = enclosingRule(at);
        if (owner) emitRule(at, resolveSelectors(owner));
        else if (name === "scope") {
          const m = /^\s*\(([^)]*)\)/.exec(at.params);
          if (m && m[1].trim()) emitRule(at, [`:is(${m[1].trim()})`]);
        }
      }
      return;
    }
    if (node.type !== "rule") return;
    const rule = node as postcss.Rule;
    // Rules inside definitions (keyframe selectors) are not style rules.
    for (let p = rule.parent; p && p.type !== "root"; p = p.parent as any) {
      if (p.type === "atrule" && DEF_KINDS[(p as postcss.AtRule).name.toLowerCase()]) return;
    }
    emitRule(rule, resolveSelectors(rule));
  });

  return model;

  function emitRule(container: postcss.Container, selectors: string[]): void {
    const decls: Decl[] = [];
    for (const child of container.nodes ?? []) {
      if (child.type !== "decl") continue;
      const d = child as postcss.Declaration;
      decls.push({ prop: d.prop.startsWith("--") ? d.prop : d.prop.toLowerCase(), value: norm(d.value), important: !!d.important });
    }
    if (decls.length === 0) return;

    const conditions: Condition[] = [];
    if (container.type === "atrule") conditions.push(conditionOf(container as postcss.AtRule));
    for (let p = container.parent; p && p.type !== "root"; p = p.parent as any) {
      if (p.type === "atrule") conditions.unshift(conditionOf(p as postcss.AtRule));
    }
    const condKey = conditions.map((c) => c.text).join(" > ");

    const complex = selectors.map((s) => analyzeComplex(s));
    const invalid = complex.find((c) => c.invalid)?.invalid;
    const selectorText = selectors.join(", ");

    const uses = new Set<string>();
    const declaresVars: string[] = [];
    // @container style(--x: …): the rule applies only while --x has that value.
    for (const c of conditions) {
      if (c.kind === "container" && c.text.includes("style(")) for (const m of c.text.matchAll(/--[\w-]+/g)) uses.add("var:" + m[0]);
    }
    for (const d of decls) {
      for (const k of usageKeysFor(d.prop, d.value)) uses.add(k);
      if (d.prop.startsWith("--")) {
        declaresVars.push(d.prop);
        for (const m of d.value.matchAll(/var\(\s*(--[\w-]+)/g)) {
          if (!model.varEdges.has(d.prop)) model.varEdges.set(d.prop, new Set());
          model.varEdges.get(d.prop)!.add(m[1]);
        }
      }
    }

    const index = model.rules.length;
    for (const k of uses) {
      if (!model.usage.has(k)) model.usage.set(k, []);
      model.usage.get(k)!.push(index);
    }

    model.rules.push({
      index,
      selectorText,
      complex,
      decls,
      declSig: decls.map((d) => `${d.prop}:${d.value}${d.important ? "!important" : ""}`).join(";"),
      conditions,
      condKey,
      layer: layerPath(container),
      key: `${condKey}|${selectorText}`,
      line: container.source?.start?.line ?? 0,
      endLine: container.source?.end?.line ?? container.source?.start?.line ?? 0,
      ctxLines: ctxLinesOf(container),
      invalid,
      uses: [...uses],
      declaresVars,
    });
  }
}

function ctxLinesOf(node: postcss.Node): number[] {
  const out: number[] = [];
  for (let p = node.parent; p && p.type !== "root"; p = p.parent as any) {
    const start = p.source?.start?.line;
    if (start === undefined) continue;
    out.push(start, p.source?.end?.line ?? start);
  }
  return out;
}

/** The model with a different rule list; rule indexes and usage tables are rebuilt. */
export function withRules(model: StylesheetModel, rules: StyleRule[]): StylesheetModel {
  const out: StylesheetModel = { ...model, rules: [], usage: new Map(), varEdges: new Map() };
  for (const r of rules) {
    const index = out.rules.length;
    out.rules.push(r.index === index ? r : { ...r, index });
    for (const k of r.uses) {
      let list = out.usage.get(k);
      if (!list) out.usage.set(k, (list = []));
      list.push(index);
    }
    for (const d of r.decls) {
      if (!d.prop.startsWith("--")) continue;
      for (const m of d.value.matchAll(/var\(\s*(--[\w-]+)/g)) {
        let set = out.varEdges.get(d.prop);
        if (!set) out.varEdges.set(d.prop, (set = new Set()));
        set.add(m[1]);
      }
    }
  }
  return out;
}

/** A model without the rules browsers would drop (used on save, §6.1). */
export function withoutInvalidRules(model: StylesheetModel): StylesheetModel {
  return hasInvalidRules(model) ? withRules(model, model.rules.filter((r) => !r.invalid)) : model;
}

/** What a browser applies from `text`: malformed statements and invalid rules dropped. */
export function browserModel(text: string): StylesheetModel {
  return withoutInvalidRules(parseStylesheet(text));
}

export function hasInvalidRules(model: StylesheetModel): boolean {
  return model.rules.some((r) => r.invalid);
}
