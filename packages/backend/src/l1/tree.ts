// Compact page tree for L1 matching (§5.2): just what selector matching
// needs — tags, attributes, structure, and whether an element has text
// (for :empty) — matched with css-select through a small adapter.

import { compile, type Options } from "css-select";

type Adapter<N, E extends N> = NonNullable<Options<N, E>["adapter"]>;

/** Serialized form: [tag, parentIndex (-1 = document), flat attrs, flags]. */
export type CompactNode = [string, number, string[], number];

export interface CompactTree {
  v: 1;
  quirks: boolean;
  lang?: string;
  dir?: string;
  n: CompactNode[];
}

export const FLAG_HAS_TEXT = 1;

export interface DocNode {
  type: "doc";
  parent: null;
  children: ElNode[];
}

export interface TextNode {
  type: "text";
  parent: ElNode;
}

export interface ElNode {
  type: "el";
  idx: number;
  tag: string;
  attrs: Map<string, string>;
  parent: ElNode | DocNode;
  children: Array<ElNode | TextNode>;
  prev: ElNode | null;
}

type AnyNode = DocNode | ElNode | TextNode;

export interface DecodedTree {
  quirks: boolean;
  doc: DocNode;
  elements: ElNode[];
}

export function decodeTree(t: CompactTree): DecodedTree {
  const doc: DocNode = { type: "doc", parent: null, children: [] };
  const elements: ElNode[] = [];
  const lastChild = new Map<AnyNode, ElNode>();
  for (let i = 0; i < t.n.length; i++) {
    const [tag, parentIdx, flat, flags] = t.n[i];
    const parent = parentIdx < 0 ? doc : elements[parentIdx];
    const attrs = new Map<string, string>();
    for (let k = 0; k < flat.length; k += 2) attrs.set(flat[k], flat[k + 1]);
    const el: ElNode = { type: "el", idx: i, tag, attrs, parent, children: [], prev: lastChild.get(parent) ?? null };
    lastChild.set(parent, el);
    (parent.children as ElNode[]).push(el);
    elements.push(el);
    if (flags & FLAG_HAS_TEXT) el.children.push({ type: "text", parent: el });
  }
  return { quirks: t.quirks, doc, elements };
}

export const treeAdapter: Adapter<AnyNode, ElNode> = {
  isTag: (n): n is ElNode => n.type === "el",
  getAttributeValue: (el, name) => el.attrs.get(name),
  getChildren: (n) => (n.type === "text" ? [] : n.children),
  getName: (el) => el.tag,
  getParent: (el) => el.parent,
  getSiblings: (n) => (n.parent ? n.parent.children : [n]),
  prevElementSibling: (n) => (n.type === "el" ? n.prev : null),
  getText: (n) => (n.type === "text" ? "x" : ""),
  hasAttrib: (el, name) => el.attrs.has(name),
  removeSubsets(nodes) {
    let idx = nodes.length;
    while (--idx >= 0) {
      const node = nodes[idx];
      if (idx > 0 && nodes.lastIndexOf(node, idx - 1) >= 0) {
        nodes.splice(idx, 1);
        continue;
      }
      for (let a: AnyNode | null = node.parent; a; a = a.parent) {
        if (nodes.includes(a)) {
          nodes.splice(idx, 1);
          break;
        }
      }
    }
    return nodes;
  },
  equals: (a, b) => a === b,
};

export type Compiled = ((el: ElNode) => boolean) | { error: string };

const compiled = new Map<string, Compiled>();

/** Compiles a relaxed selector for the tree; unsupported syntax yields an error. */
export function compileFor(key: string, quirks: boolean): Compiled {
  const ck = (quirks ? "Q" : "S") + key;
  let c = compiled.get(ck);
  if (!c) {
    try {
      c = compile<AnyNode, ElNode>(key, { adapter: treeAdapter, quirksMode: quirks, cacheResults: false }) as (el: ElNode) => boolean;
    } catch (err: any) {
      c = { error: String(err?.message ?? err) };
    }
    if (compiled.size > 20_000) compiled.clear();
    compiled.set(ck, c);
  }
  return c;
}

/** First matching element, or null. Throws if the selector is unsupported. */
export function firstMatch(tree: DecodedTree, key: string): ElNode | null {
  const c = compileFor(key, tree.quirks);
  if (typeof c !== "function") throw new Error(c.error);
  for (const el of tree.elements) if (c(el)) return el;
  return null;
}

export function allMatches(tree: DecodedTree, key: string, limit = 500): ElNode[] {
  const c = compileFor(key, tree.quirks);
  if (typeof c !== "function") throw new Error(c.error);
  const out: ElNode[] = [];
  for (const el of tree.elements) {
    if (c(el)) {
      out.push(el);
      if (out.length >= limit) break;
    }
  }
  return out;
}

/** Short CSS-like path for display: main.article > div:nth-of-type(2) > p.lead */
export function elementPath(el: ElNode): string {
  const parts: string[] = [];
  for (let n: ElNode | DocNode = el; n.type === "el"; n = n.parent) {
    const id = n.attrs.get("id");
    const cls = (n.attrs.get("class") ?? "").trim().split(/\s+/).filter(Boolean).slice(0, 2);
    let part = n.tag + (id ? `#${id}` : "") + cls.map((c) => `.${c}`).join("");
    const sameTag = n.parent.children.filter((s) => s.type === "el" && s.tag === n.tag) as ElNode[];
    if (!id && sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(n) + 1})`;
    parts.unshift(part);
    if (id) break;
  }
  return parts.join(" > ");
}
