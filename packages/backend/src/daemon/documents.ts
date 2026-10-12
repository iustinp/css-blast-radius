// Editor documents (§6.1, §12): text kept in sync from incremental changes,
// plus the last model that parsed cleanly so a half-typed rule doesn't make
// the count jump around.

import { createHash } from "node:crypto";
import { assemble, hasInvalidRules, parseChunks, withoutInvalidRules, withRules, type Chunk, type StylesheetModel } from "../css/model.js";

export interface Position {
  line: number;
  character: number;
}

export interface TextChange {
  /** Omitted: `text` replaces the whole document. */
  range?: { start: Position; end: Position };
  text: string;
}

export class ResyncNeeded extends Error {
  readonly code = -32001;
  constructor(path: string, have: number, got: number) {
    super(`document ${path} is at version ${have}, change is for ${got}: resend the full text`);
  }
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** UTF-16 offset of an LSP position; positions past the end clamp. */
function offsetAt(text: string, starts: number[], p: Position): number {
  if (p.line >= starts.length) return text.length;
  const lineStart = starts[p.line];
  const lineEnd = p.line + 1 < starts.length ? starts[p.line + 1] : text.length;
  return Math.min(lineStart + Math.max(0, p.character), lineEnd);
}

function lineStarts(text: string): number[] {
  const out = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) out.push(i + 1);
  return out;
}

export function applyChanges(text: string, changes: TextChange[]): string {
  for (const c of changes) {
    if (!c.range) {
      text = c.text;
      continue;
    }
    const starts = lineStarts(text);
    const a = offsetAt(text, starts, c.range.start);
    const b = offsetAt(text, starts, c.range.end);
    text = text.slice(0, Math.min(a, b)) + c.text + text.slice(Math.max(a, b));
  }
  return text;
}

export interface CurrentModel {
  model: StylesheetModel;
  /** The CSS that `model` describes (what L2 renders). */
  text: string;
  /** The text doesn't parse (or has a dropped rule) and isn't saved: the broken part keeps its last valid version. */
  editing: boolean;
  /** Reasons to show with the answer (e.g. a rule still invalid on save). */
  notes: string[];
}

export class Doc {
  version: number;
  text: string;
  savedHash: string;
  private lastValid?: Chunk[];

  constructor(
    readonly path: string,
    text: string,
    version: number,
    diskText: string | undefined,
  ) {
    this.text = text;
    this.version = version;
    this.savedHash = sha256(diskText ?? text);
  }

  change(version: number, changes: TextChange[]): void {
    const full = changes.length > 0 && changes.every((c) => !c.range);
    if (!full && version !== this.version + 1) throw new ResyncNeeded(this.path, this.version, version);
    this.text = applyChanges(this.text, changes);
    this.version = version;
  }

  save(text: string | undefined): void {
    if (text !== undefined) this.text = text;
    this.savedHash = sha256(this.text);
  }

  get saved(): boolean {
    return sha256(this.text) === this.savedHash;
  }

  /**
   * The model to analyze. Saved text is read the way browsers read it:
   * malformed statements and invalid rules are dropped (they count as removed).
   * While typing, only the broken part keeps its last valid version, so a
   * half-typed rule doesn't make the count jump and edits elsewhere still show.
   */
  current(): CurrentModel {
    const chunks = parseChunks(this.text);
    const model = assemble(chunks, this.text);
    const notes: string[] = [];
    if (!model.parseError && !hasInvalidRules(model)) {
      this.lastValid = chunks;
      return { model, text: this.text, editing: false, notes };
    }
    if (this.saved) {
      if (model.parseError) notes.push(`parse-error:line ${model.parseError.line ?? "?"}`);
      for (const r of model.rules) if (r.invalid) notes.push(`invalid-on-save:line ${r.line}`);
      return { model: withoutInvalidRules(model), text: this.text, editing: false, notes };
    }
    let m = model;
    let text = this.text;
    if (model.parseError && this.lastValid) {
      const patched = patchBroken(chunks, this.lastValid);
      text = patched.map((c) => c.body).join("");
      m = assemble(patched, text);
    }
    if (hasInvalidRules(m)) {
      // A half-typed selector: keep that rule's last valid version (same start line).
      const prev = new Map((this.lastValid ? assemble(this.lastValid).rules : []).map((r) => [r.line, r]));
      m = withRules(m, m.rules.flatMap((r) => (r.invalid ? (prev.has(r.line) ? [prev.get(r.line)!] : []) : [r])));
    }
    return { model: m, text, editing: true, notes };
  }
}

const chunkKeys = (c: Chunk): string[] => [...c.part.rules.map((r) => r.key), ...c.part.defs.map((d) => d.usageKey)];

/**
 * Replaces the chunks that don't parse with their last valid counterparts:
 * the chunks between the unchanged prefix and suffix whose rules aren't
 * already present (edited) in a chunk that does parse.
 */
function patchBroken(cur: Chunk[], prev: Chunk[]): Chunk[] {
  let p = 0;
  while (p < cur.length && p < prev.length && cur[p].body === prev[p].body) p++;
  let s = 0;
  while (s < cur.length - p && s < prev.length - p && cur[cur.length - 1 - s].body === prev[prev.length - 1 - s].body) s++;
  const mid = cur.slice(p, cur.length - s);
  const live = new Set(mid.filter((c) => !c.part.parseError).flatMap(chunkKeys));
  const restore = prev.slice(p, prev.length - s).filter((c) => !chunkKeys(c).some((k) => live.has(k)));
  const out = cur.slice(0, p);
  let restored = false;
  for (const c of mid) {
    if (!c.part.parseError) {
      out.push(c);
      continue;
    }
    if (restored) continue;
    restored = true;
    const shift = restore.length ? c.line - restore[0].line : 0;
    for (const r of restore) out.push({ ...r, line: r.line + shift });
  }
  out.push(...cur.slice(cur.length - s));
  return out;
}
