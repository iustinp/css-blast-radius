// Selector analysis: split selector lists, relax selectors that a snapshot
// cannot evaluate (§6.3), and extract the tokens a page must contain for a
// selector to match (the L0 upper bound) and the features the L1 matcher
// must support.
//
// Relaxation rule: drop the part that can't be evaluated; if it sits inside
// :not() or a counting construct (:nth-child(… of S)), drop that whole
// construct. Dropping a positive simple selector only broadens the match
// set, so a relaxed selector may over-count but never misses a page.

import parser from "postcss-selector-parser";

type Node = parser.Node;
type Selector = parser.Selector;

const PSEUDO_ELEMENTS_LEGACY = new Set(["before", "after", "first-line", "first-letter"]);

/** Pseudo-classes whose state a pristine snapshot doesn't have. */
const DYNAMIC = new Set([
  "hover", "active", "focus", "focus-visible", "focus-within", "visited", "target",
  "target-within", "checked", "indeterminate", "open", "closed", "popover-open", "modal",
  "fullscreen", "picture-in-picture", "valid", "invalid", "user-valid", "user-invalid",
  "in-range", "out-of-range", "placeholder-shown", "autofill", "-webkit-autofill", "defined",
  "state", "playing", "paused", "seeking", "buffering", "stalled", "muted", "volume-locked",
  "current", "past", "future", "blank", "local-link", "has-slotted", "active-view-transition",
  "active-view-transition-type", "xr-overlay", "-webkit-full-screen", "drop", "target-current",
  "interest-source", "interest-target",
]);

/** Pseudo-classes that a snapshot can evaluate as-is. */
const STATIC = new Set([
  "root", "empty", "first-child", "last-child", "only-child", "first-of-type", "last-of-type",
  "only-of-type", "nth-child", "nth-last-child", "nth-of-type", "nth-last-of-type", "not", "is",
  "where", "has", "matches", "-webkit-any", "any-link", "link", "lang", "dir", "enabled",
  "disabled", "required", "optional", "read-only", "read-write", "default", "scope",
]);

const POSITIVE_WRAPPERS = new Set(["is", "where", "matches", "-webkit-any", "has"]);

export interface ComplexSelector {
  /** Authored complex selector (after nesting desugaring). */
  text: string;
  /** Relaxed, normalized selector: cache key and querySelector input. */
  key: string;
  /** True when nothing was dropped: the relaxed selector is the selector. */
  exact: boolean;
  /** Dropped constructs, for display: [":hover", ":not(:focus)"]. */
  dropped: string[];
  /** Tokens every matching page must contain: t:tag, c:class, i:id, a:attr. */
  tokens: string[];
  /** Features the L1 matcher must support, e.g. "pseudo:has", "comb:~". */
  features: string[];
  /** Set when browsers would reject the selector (the whole rule is dropped). */
  invalid?: string;
  /** Set when the selector could not be analyzed; treated as `*`. */
  unanalyzable?: string;
  /**
   * True when the relaxed form is only an upper bound because unknown syntax
   * was dropped (not just interaction state): matches count as *possible*.
   */
  upperBound: boolean;
}

const cache = new Map<string, ComplexSelector>();

export function splitSelectorList(selectorText: string): string[] {
  try {
    return parser()
      .astSync(selectorText)
      .nodes.map((n) => n.toString().trim())
      .filter(Boolean);
  } catch {
    return [selectorText.trim()];
  }
}

function pseudoName(node: parser.Pseudo): string {
  return node.value.replace(/^::?/, "").toLowerCase();
}

function isPseudoElement(node: parser.Pseudo): boolean {
  return node.value.startsWith("::") || PSEUDO_ELEMENTS_LEGACY.has(pseudoName(node));
}

/** True when the node contains anything relaxation would drop. */
function containsDroppable(node: Node): boolean {
  let found = false;
  const visit = (n: Node) => {
    if (found) return;
    if (n.type === "pseudo") {
      const p = n as parser.Pseudo;
      const name = pseudoName(p);
      if (!isPseudoElement(p) && (DYNAMIC.has(name) || !STATIC.has(name))) {
        found = true;
        return;
      }
      if (name.startsWith("nth-") && /\bof\b/i.test(p.toString()) && /:[\w-]/.test(ofPart(p))) {
        if (droppableInText(ofPart(p))) found = true;
      }
    }
    if ("nodes" in n && Array.isArray((n as any).nodes)) for (const c of (n as any).nodes) visit(c);
  };
  visit(node);
  return found;
}

function ofPart(p: parser.Pseudo): string {
  const s = p.toString();
  const open = s.indexOf("(");
  const inner = open >= 0 ? s.slice(open + 1, s.lastIndexOf(")")) : "";
  const m = /\bof\b([\s\S]*)$/i.exec(inner);
  return m ? m[1] : "";
}

function droppableInText(text: string): boolean {
  for (const m of text.matchAll(/(?<!:):([\w-]+)/g)) {
    const name = m[1].toLowerCase();
    if (PSEUDO_ELEMENTS_LEGACY.has(name)) continue;
    if (DYNAMIC.has(name) || !STATIC.has(name)) return true;
  }
  return false;
}

interface RelaxCtx {
  dropped: string[];
  unknownPseudo: boolean;
}

/** Relaxes one selector (a complex selector) in place. */
function relaxSelector(sel: Selector, ctx: RelaxCtx): void {
  const first = sel.nodes.find((n) => n.type !== "comment");
  const relative = first?.type === "combinator";
  for (const node of [...sel.nodes]) {
    if (node.type !== "pseudo") continue;
    const p = node as parser.Pseudo;
    const name = pseudoName(p);
    if (isPseudoElement(p)) {
      // A pseudo-element counts as its originating element; exact.
      p.remove();
      continue;
    }
    if (name === "not") {
      if (containsDroppable(p)) {
        ctx.dropped.push(p.toString().trim());
        p.remove();
      }
      continue;
    }
    if (POSITIVE_WRAPPERS.has(name)) {
      for (const inner of p.nodes as Selector[]) relaxSelector(inner, ctx);
      continue;
    }
    if (name.startsWith("nth-") && /\bof\b/i.test(p.toString())) {
      if (droppableInText(ofPart(p))) {
        ctx.dropped.push(p.toString().trim());
        p.remove();
      }
      continue;
    }
    if (STATIC.has(name)) continue;
    if (!DYNAMIC.has(name)) ctx.unknownPseudo = true;
    ctx.dropped.push(":" + name);
    p.remove();
  }
  fillEmptyCompounds(sel, relative);
}

/** After removals, an empty compound (".a :hover" → ".a ") becomes "*". */
function fillEmptyCompounds(sel: Selector, relative: boolean): void {
  const emptyBefore: Array<Node | undefined> = [];
  let hasNode = false;
  let leading = true;
  for (const n of sel.nodes) {
    if (n.type === "comment") continue;
    if (n.type === "combinator") {
      // A relative selector (:has(> img)) legitimately starts with a combinator.
      if (!hasNode && !(leading && relative)) emptyBefore.push(n);
      leading = false;
      hasNode = false;
    } else {
      hasNode = true;
      leading = false;
    }
  }
  if (!hasNode) emptyBefore.push(undefined);
  for (const before of emptyBefore) {
    const u = parser.universal({ value: "*" });
    if (before) sel.insertBefore(before as Parameters<Selector["insertBefore"]>[0], u);
    else sel.append(u);
  }
}

const RAW_ARG_PSEUDOS = /^(nth-|lang$|dir$|state$|host-context$|part$|highlight$)/;

/** Canonical text for a selector AST: stable whitespace, no comments. */
export function serialize(node: Node): string {
  switch (node.type) {
    case "selector": {
      let out = "";
      let leading = true;
      for (const n of (node as Selector).nodes) {
        if (n.type === "comment") continue;
        if (n.type === "combinator") {
          const v = n.value.trim();
          out += v === "" ? " " : leading ? `${v} ` : ` ${v} `;
        } else {
          out += serialize(n);
        }
        leading = false;
      }
      return out;
    }
    case "pseudo": {
      const p = node as parser.Pseudo;
      const name = p.value.toLowerCase();
      if (!p.nodes.length && !/\(/.test(p.toString())) return name;
      if (RAW_ARG_PSEUDOS.test(pseudoName(p))) {
        const raw = p.toString().trim();
        const inner = raw.slice(raw.indexOf("(") + 1, raw.lastIndexOf(")"));
        return `${name}(${inner.replace(/\s+/g, " ").trim()})`;
      }
      return `${name}(${p.nodes.map((n) => serialize(n)).join(", ")})`;
    }
    case "attribute": {
      const a = node as parser.Attribute;
      const ns = a.namespace ? `${a.namespace === true ? "*" : a.namespace}|` : "";
      const value = a.operator ? a.operator + JSON.stringify(a.value ?? "") : "";
      const flag = a.insensitive ? " i" : /\ss\s*\]$/.test(a.toString()) ? " s" : "";
      return `[${ns}${a.attribute}${value}${flag}]`;
    }
    case "comment":
      return "";
    default:
      return node.toString().trim();
  }
}

/** Tokens required on any page where the selector matches. */
function requiredTokens(sel: Selector, out: Set<string>): void {
  for (const n of sel.nodes) {
    switch (n.type) {
      case "tag": {
        const t = n as parser.Tag;
        if (t.namespace === undefined || t.namespace === true || t.namespace === "") {
          if (t.value !== "*") out.add("t:" + t.value.toLowerCase());
        }
        break;
      }
      case "class":
        out.add("c:" + n.value);
        break;
      case "id":
        out.add("i:" + n.value);
        break;
      case "attribute": {
        const a = n as parser.Attribute;
        if (!a.namespace) out.add("a:" + a.attribute.toLowerCase());
        break;
      }
      case "pseudo": {
        const p = n as parser.Pseudo;
        const name = pseudoName(p);
        // A single positive argument must also exist on the page.
        if ((POSITIVE_WRAPPERS.has(name)) && p.nodes.length === 1) {
          requiredTokens(p.nodes[0] as Selector, out);
        }
        break;
      }
    }
  }
}

function features(sel: Selector, out: Set<string>): void {
  sel.walk((n) => {
    if (n.type === "combinator") out.add("comb:" + (n.value.trim() || " "));
    else if (n.type === "pseudo") {
      const p = n as parser.Pseudo;
      const name = pseudoName(p);
      out.add("pseudo:" + name + (name.startsWith("nth-") && /\bof\b/i.test(p.toString()) ? "-of" : ""));
    } else if (n.type === "attribute") {
      const a = n as parser.Attribute;
      out.add("attr:" + (a.operator ?? "exists"));
      if (a.insensitive) out.add("attr-flag:i");
      if ((a as any).raws?.insensitiveFlag === "s" || /\ss\s*]$/.test(a.toString())) out.add("attr-flag:s");
      if (a.namespace) out.add("namespace");
    } else if (n.type === "tag" && (n as parser.Tag).namespace) out.add("namespace");
  });
}

/** Rejections browsers apply that the parser itself accepts. */
function validate(sel: Selector, topLevel: boolean): string | undefined {
  const nodes = sel.nodes.filter((n) => n.type !== "comment");
  if (nodes.length === 0) return "empty selector";
  if (nodes[nodes.length - 1].type === "combinator") return "selector ends with a combinator";
  if (topLevel && nodes[0].type === "combinator") return "selector starts with a combinator";
  for (let i = 1; i < nodes.length; i++) {
    if (nodes[i].type === "combinator" && nodes[i - 1].type === "combinator") return "two combinators in a row";
  }
  let problem: string | undefined;
  sel.walk((n) => {
    if (problem) return;
    if ((n.type === "class" || n.type === "id") && !n.value) problem = `empty ${n.type} name`;
    if (n.type === "nesting") problem = "unresolved nesting selector";
    if (n.type === "pseudo") {
      const p = n as parser.Pseudo;
      const name = pseudoName(p);
      const needsArgs = ["not", "is", "where", "has", "nth-child", "nth-last-child", "nth-of-type", "nth-last-of-type", "lang", "dir"];
      if (needsArgs.includes(name) && p.nodes.length === 0 && !/\(/.test(p.toString())) {
        problem = `:${name}() needs an argument`;
      }
    }
  });
  return problem;
}

export function analyzeComplex(text: string, opts: { topLevel?: boolean } = {}): ComplexSelector {
  const topLevel = opts.topLevel ?? true;
  const cacheKey = (topLevel ? "T" : "N") + text;
  const hit = cache.get(cacheKey);
  if (hit) return hit;

  let result: ComplexSelector;
  try {
    const root = parser().astSync(text);
    if (root.nodes.length !== 1) throw new Error("expected one complex selector");
    const sel = root.nodes[0] as Selector;
    const invalid = validate(sel, topLevel);
    if (invalid) {
      result = { text, key: text, exact: false, dropped: [], tokens: [], features: [], invalid, upperBound: false };
    } else {
      const ctx: RelaxCtx = { dropped: [], unknownPseudo: false };
      const relaxed = sel.clone() as Selector;
      relaxSelector(relaxed, ctx);
      const key = serialize(relaxed).trim() || "*";
      const tokens = new Set<string>();
      requiredTokens(relaxed, tokens);
      const feats = new Set<string>();
      features(relaxed, feats);
      result = {
        text,
        key,
        exact: ctx.dropped.length === 0,
        dropped: ctx.dropped,
        tokens: [...tokens].sort(),
        features: [...feats].sort(),
        upperBound: ctx.unknownPseudo,
      };
    }
  } catch (err: any) {
    // Unknown syntax is treated as `*`: an upper bound, never a zero.
    result = {
      text,
      key: "*",
      exact: false,
      dropped: [],
      tokens: [],
      features: [],
      unanalyzable: String(err?.message ?? err),
      upperBound: true,
    };
  }
  if (cache.size > 50_000) cache.clear();
  cache.set(cacheKey, result);
  return result;
}

export function isRootLike(cs: ComplexSelector): boolean {
  return cs.key === ":root" || cs.key === "html" || cs.key === "html:root" || cs.key === ":root:root";
}
