// L0 (§6.1–6.4): classified CSS changes → page counts from bitmaps.
// Pure set algebra over the published index plus whatever L1 has resolved
// so far; the same function produces the refined (level 1) answer once L1
// results are cached.

import { createHash } from "node:crypto";
import { urlsForFile, type CbrConfig } from "../config.js";
import type { CssChange } from "../css/diff.js";
import type { StyleRule, StylesheetModel } from "../css/model.js";
import { isRootLike, type ComplexSelector } from "../css/selectors.js";
import type { SiteIndex } from "../index/siteIndex.js";
import { PageSet } from "../util/pageSet.js";
import { REASON, Sets, tokenLabel, type ChangeAnswer, type Count, type Freshness, type RuleCount } from "./contract.js";

export interface L1Entry {
  /** Candidate pages L1 found a match on. */
  matched: PageSet;
  /** Candidate pages L1 has resolved (matched or not). */
  checked: PageSet;
  /** Set when the fast matcher can't evaluate this selector. */
  unsupported?: string;
}

/** L1 results per relaxed selector key, valid for one index revision. */
export class L1Cache {
  readonly entries = new Map<string, L1Entry>();
  constructor(
    readonly revision: number,
    readonly size: number,
  ) {}

  get(key: string): L1Entry | undefined {
    return this.entries.get(key);
  }

  record(key: string, checked: Iterable<number>, matched: Iterable<number>, unsupported?: string): void {
    if (this.entries.size > 50_000) this.entries.clear();
    let e = this.entries.get(key);
    if (!e) this.entries.set(key, (e = { matched: PageSet.empty(this.size), checked: PageSet.empty(this.size) }));
    for (const id of checked) e.checked.add(id);
    for (const id of matched) e.matched.add(id);
    if (unsupported) e.unsupported = unsupported;
  }
}

export interface Candidates {
  mapped: boolean;
  urls: string[];
  /** Pages that load the stylesheet (every captured page when unmapped), within the scope. */
  pages: PageSet;
  /** Why there are no candidate pages at all. */
  emptyReason?: string;
}

/** Selector key → candidate pages L1 should resolve. */
export type PendingWork = Map<string, PageSet>;

/** Shared state for one analyze/ruleCounts call (fixed candidate set). */
class Call {
  readonly memo = new Map<string, { sets: Sets; reasons: string[] }>();
  readonly pending: PendingWork = new Map();
  readonly okC: PageSet;
  readonly unknownC: PageSet;
  constructor(
    readonly C: PageSet,
    index: SiteIndex,
  ) {
    this.okC = C.and(index.ok);
    this.unknownC = C.and(index.failed);
  }
}

/** Per-change scratch: reasons and hints shown with one count. */
class Ctx {
  readonly reasons = new Set<string>();
  readonly hints: string[] = [];
  constructor(readonly call: Call) {}
  get C(): PageSet {
    return this.call.C;
  }
}

export interface Analysis {
  changes: ChangeAnswer[];
  sets: Sets[];
  gained: Array<Sets | undefined>;
  lost: Array<Sets | undefined>;
  total: Sets;
  totalCount: Count;
  totalReasons: string[];
  pending: PendingWork;
  candidates: Candidates;
}

const ZERO_EXPLAINED = new Set<string>([REASON.customPropertyUnused, REASON.definitionUnused, REASON.notLinked, REASON.noScope, REASON.outsideScope]);

export class L0Engine {
  private readonly ubCache = new Map<string, PageSet>();

  /** Pages counts are limited to (the linked page groups); undefined = every page. */
  private scope?: PageSet;
  private readonly keysFor: (file: string) => string[];

  constructor(
    readonly index: SiteIndex,
    readonly cfg: CbrConfig,
    readonly l1: L1Cache,
    opts: { keysFor?: (file: string) => string[]; scope?: PageSet } = {},
  ) {
    // Default: the explicit mapping, resolved to the captured keys (the page may link the file with different letter case).
    this.keysFor = opts.keysFor ?? ((file) => [...new Set(urlsForFile(cfg, file).map((u) => index.sheetKey(u) ?? u))]);
    this.setScope(opts.scope);
  }

  get size(): number {
    return this.index.size;
  }

  setScope(scope: PageSet | undefined): void {
    this.scope = scope ? scope.and(this.index.all) : undefined;
  }

  get scoped(): PageSet {
    return this.scope ?? this.index.all;
  }

  candidates(file: string): Candidates {
    const urls = this.keysFor(file);
    const noScope = this.scope?.isEmpty() ? REASON.noScope : undefined;
    if (urls.length === 0) return { mapped: false, urls, pages: this.scoped.clone(), emptyReason: noScope };
    const pages = PageSet.empty(this.size);
    for (const u of urls) {
      const s = this.index.sheets.get(u);
      if (s) pages.orInPlace(s.pages);
    }
    pages.andInPlace(this.index.all);
    const linked = !pages.isEmpty();
    if (this.scope) pages.andInPlace(this.scope);
    const emptyReason = !pages.isEmpty() ? undefined : noScope ?? (linked ? REASON.outsideScope : REASON.notLinked);
    return { mapped: true, urls, pages, emptyReason };
  }

  freshness(cand: Candidates, baseText: string | undefined): Freshness {
    const rev = this.index.revision;
    let stale = false;
    if (baseText !== undefined) {
      const h = createHash("sha256").update(baseText).digest("hex");
      for (const u of cand.urls) {
        const s = this.index.sheets.get(u);
        if (s?.hash && s.hash !== h) stale = true;
      }
    }
    return { revision: rev.id, capturedAt: rev.createdAt, ageMs: Date.now() - Date.parse(rev.createdAt), stale };
  }

  /** Captured pages containing every token: the L0 bound for an unevaluated selector. */
  private tokenUpperBound(tokens: string[]): PageSet {
    const ck = tokens.join(" ");
    const hit = this.ubCache.get(ck);
    if (hit) return hit;
    const idx = this.index;
    const ub = idx.ok.clone();
    // Quirks mode matches classes and ids case-insensitively: don't filter on them there.
    const quirk = idx.quirks.and(idx.ok);
    for (const t of tokens) {
      const posting = idx.token(t);
      if (posting) ub.andInPlace(posting);
      else ub.clear();
      if (t[0] !== "c" && t[0] !== "i") {
        if (posting) quirk.andInPlace(posting);
        else quirk.clear();
      }
    }
    ub.orInPlace(quirk);
    if (this.ubCache.size > 10_000) this.ubCache.clear();
    this.ubCache.set(ck, ub);
    return ub;
  }

  private selectorSets(cs: ComplexSelector, ctx: Ctx): Sets {
    // Selectors sharing a relaxed key differ in whether the key is only an upper bound.
    const mk = `${cs.key}\u0000${cs.invalid ?? cs.unanalyzable ?? ""}\u0000${cs.upperBound ? 1 : 0}`;
    const memo = ctx.call.memo.get(mk);
    if (memo) {
      for (const r of memo.reasons) ctx.reasons.add(r);
      return memo.sets;
    }
    const reasons: string[] = [];
    const sets = this.computeSelectorSets(cs, ctx.call, reasons);
    ctx.call.memo.set(mk, { sets, reasons });
    for (const r of reasons) ctx.reasons.add(r);
    return sets;
  }

  private computeSelectorSets(cs: ComplexSelector, call: Call, reasons: string[]): Sets {
    const idx = this.index;
    const C = call.C;
    const okC = call.okC;
    const unknown = call.unknownC.clone();
    if (cs.invalid) {
      reasons.push(REASON.invalid(cs.invalid));
      return Sets.empty(this.size);
    }
    if (cs.unanalyzable) {
      reasons.push(REASON.unanalyzable);
      return new Sets(PageSet.empty(this.size), okC.clone(), unknown).normalize();
    }
    const entry = idx.selector(cs.key);
    const l1 = this.l1.get(cs.key);
    const exact = PageSet.empty(this.size);
    const covered = PageSet.empty(this.size);
    if (entry) {
      exact.orInPlace(entry.matches).andNotInPlace(entry.rejected);
      covered.orInPlace(entry.evaluated);
      if (!entry.rejected.and(C).isEmpty()) reasons.push(REASON.chromiumRejects);
    }
    if (l1) {
      exact.orInPlace(l1.matched);
      covered.orInPlace(l1.checked);
    }
    exact.andInPlace(okC);
    const possible = okC.andNot(covered);
    if (!possible.isEmpty()) {
      possible.andInPlace(this.tokenUpperBound(cs.tokens));
      if (!possible.isEmpty()) {
        const unsupported = l1?.unsupported ?? cs.features.find((f) => idx.unsupportedFeatures.has(f));
        if (unsupported) reasons.push(REASON.unsupported(unsupported));
        else {
          reasons.push(REASON.newSelector);
          const prev = call.pending.get(cs.key);
          if (prev) prev.orInPlace(possible);
          else call.pending.set(cs.key, possible.clone());
        }
      }
    }
    if (cs.upperBound && !exact.isEmpty()) {
      // Relaxed away a pseudo we can't model: a match is only a possible reach.
      reasons.push(REASON.upperBound);
      possible.orInPlace(exact);
      exact.clear();
    }
    return new Sets(exact, possible, unknown).normalize();
  }

  ruleSets(rule: StyleRule, ctx: Ctx): Sets {
    const out = Sets.empty(this.size);
    if (rule.invalid) {
      ctx.reasons.add(REASON.invalid(rule.invalid));
      return out;
    }
    for (const cs of rule.complex) out.orInPlace(this.selectorSets(cs, ctx));
    return out;
  }

  /** Explains a zero: never-seen or script-only tokens, otherwise a proven no-match. */
  private explainZero(rule: StyleRule, ctx: Ctx): void {
    if (rule.invalid) return;
    for (const r of ctx.reasons) if (ZERO_EXPLAINED.has(r) || r.startsWith("invalid-selector:")) return;
    const idx = this.index;
    let tokenReason = false;
    for (const cs of rule.complex) {
      if (cs.invalid) continue;
      const missing = cs.tokens.filter((t) => !idx.token(t));
      if (missing.length === 0) continue;
      tokenReason = true;
      const js = missing.some((t) => idx.runtimeTokens.has(t));
      for (const t of missing) ctx.reasons.add(idx.runtimeTokens.has(t) ? REASON.addedByJs(t) : REASON.tokenNeverSeen(t));
      const without = this.tokenUpperBound(cs.tokens.filter((t) => !missing.includes(t))).and(ctx.C).count();
      const labels = missing.map(tokenLabel).join(", ");
      ctx.hints.push(`${labels} never in captured markup${js ? " (added by JS)" : ""} · up to ${without} page${without === 1 ? "" : "s"} without it`);
    }
    if (!tokenReason) ctx.reasons.add(REASON.neverMatches);
  }

  private conditionsOf(...rules: Array<StyleRule | undefined>): string[] {
    const out = new Set<string>();
    for (const r of rules) {
      if (!r) continue;
      for (const c of r.conditions) if (c.kind !== "layer") out.add(c.text);
      for (const cs of r.complex) for (const d of cs.dropped) out.add(d);
    }
    return [...out];
  }

  /**
   * Pages where something uses `usageKey`: index postings, rules of the
   * edited file, and users of edited-file definitions (@keyframes,
   * @position-try) whose declarations use it.
   */
  private usersOf(usageKey: string, models: StylesheetModel[], ctx: Ctx, via = new Set<string>()): Sets {
    const out = Sets.empty(this.size);
    via.add(usageKey);
    const fromIndex = this.index.usage.get(usageKey);
    if (fromIndex) out.exact.orInPlace(fromIndex).andInPlace(this.index.ok);
    const seen = new Set<string>();
    for (const m of models) {
      for (const i of m.usage.get(usageKey) ?? []) {
        const r = m.rules[i];
        if (!r || seen.has(r.selectorText)) continue;
        seen.add(r.selectorText);
        out.orInPlace(this.ruleSets(r, ctx));
      }
      for (const d of m.defs) {
        if (via.has(d.usageKey) || !d.uses.includes(usageKey)) continue;
        out.orInPlace(this.usersOf(d.usageKey, models, ctx, via));
      }
    }
    return out.normalize();
  }

  /** `props` plus every custom property derived from them (--a: var(--b)), transitively. */
  varClosure(props: string[], models: StylesheetModel[]): string[] {
    const out = new Set(props);
    const queue = [...props];
    while (queue.length) {
      const v = queue.pop()!;
      const next = new Set(this.index.varDependents.get(v) ?? []);
      for (const m of models) for (const [a, refs] of m.varEdges) if (refs.has(v)) next.add(a);
      for (const n of next) {
        if (out.has(n)) continue;
        out.add(n);
        queue.push(n);
      }
    }
    return [...out];
  }

  private varUsers(props: string[], models: StylesheetModel[], ctx: Ctx): Sets {
    const users = Sets.empty(this.size);
    for (const p of props) users.orInPlace(this.usersOf(`var:${p}`, models, ctx));
    return users;
  }

  private customPropertySets(rule: StyleRule, props: string[], models: StylesheetModel[], ctx: Ctx): Sets {
    const rs = this.ruleSets(rule, ctx);
    const closure = this.varClosure(props, models);
    // The rule itself consumes the property: its pages are affected directly.
    if (closure.some((p) => rule.uses.includes(`var:${p}`))) return rs.clone();
    const users = this.varUsers(closure, models, ctx);
    const reach = users.exact.or(users.possible);
    if (reach.isEmpty()) {
      ctx.reasons.add(REASON.customPropertyUnused);
      return new Sets(PageSet.empty(this.size), PageSet.empty(this.size), rs.unknown.clone());
    }
    const ruleReach = rs.exact.or(rs.possible);
    if (rule.complex.every(isRootLike)) {
      return new Sets(rs.exact.and(users.exact), ruleReach.andInPlace(reach), rs.unknown.clone()).normalize();
    }
    // Inherited below the matched elements; page-level co-occurrence is only a bound.
    ctx.reasons.add(REASON.customPropertyScope);
    return new Sets(PageSet.empty(this.size), ruleReach.andInPlace(reach), rs.unknown.clone()).normalize();
  }

  /** @font-face, @keyframes, @property… → pages that consume the name. */
  private definitionSets(usageKey: string, models: StylesheetModel[], ctx: Ctx): Sets {
    const sep = usageKey.indexOf(":");
    const kind = usageKey.slice(0, sep);
    const name = usageKey.slice(sep + 1);
    if (kind === "var") return this.varUsers(this.varClosure([name], models), models, ctx);
    const s = this.usersOf(usageKey, models, ctx);
    // Named only inside a custom property value: consumed if that property is used.
    const indirect = this.usersOf(`ind:${name}`, models, ctx);
    s.possible.orInPlace(indirect.exact).orInPlace(indirect.possible);
    return s.normalize();
  }

  private declarationSets(rule: StyleRule, props: string[] | undefined, models: StylesheetModel[], ctx: Ctx): Sets {
    const list = props ?? [];
    const custom = list.filter((p) => p.startsWith("--"));
    const out = Sets.empty(this.size);
    if (custom.length < list.length || list.length === 0) out.orInPlace(this.ruleSets(rule, ctx));
    if (custom.length) out.orInPlace(this.customPropertySets(rule, custom, models, ctx));
    return out;
  }

  /** An unmapped file: nothing is proven, everything reachable is only possible. */
  private unmap(s: Sets | undefined, ctx: Ctx): void {
    if (!s) return;
    s.possible.orInPlace(s.exact);
    s.exact.clear();
    s.normalize();
    ctx.reasons.add(REASON.notMapped);
  }

  analyze(file: string, base: StylesheetModel, cur: StylesheetModel, changes: CssChange[]): Analysis {
    const cand = this.candidates(file);
    const call = new Call(cand.pages, this.index);
    const idx = this.index;
    const models = [cur, base];
    const answers: ChangeAnswer[] = [];
    const sets: Sets[] = [];
    const gainedSets: Array<Sets | undefined> = [];
    const lostSets: Array<Sets | undefined> = [];
    const total = Sets.empty(this.size);
    const totalReasons = new Set<string>();
    const unknownC = call.unknownC;

    changes.forEach((ch, i) => {
      const ctx = new Ctx(call);
      let s: Sets;
      let gained: Sets | undefined;
      let lost: Sets | undefined;
      const b = ch.before;
      const a = ch.after;
      switch (ch.kind) {
        case "declarations":
          s = this.declarationSets(a!, ch.changedProps, models, ctx);
          break;
        case "moved":
          s = this.ruleSets(a!, ctx).clone();
          break;
        case "condition":
          s = this.ruleSets(a!, ctx).clone().orInPlace(this.ruleSets(b!, ctx));
          break;
        case "selector": {
          const oldS = this.ruleSets(b!, ctx);
          const newS = this.ruleSets(a!, ctx);
          s = oldS.clone().orInPlace(newS);
          gained = newS.minus(oldS);
          lost = oldS.minus(newS);
          break;
        }
        case "added":
          s = this.ruleSets(a!, ctx).clone();
          gained = s.clone();
          break;
        case "removed":
          s = this.ruleSets(b!, ctx).clone();
          lost = s.clone();
          break;
        case "definition":
          s = this.definitionSets(ch.def!.usageKey, models, ctx);
          s.exact.andInPlace(cand.pages);
          s.possible.andInPlace(cand.pages);
          if (s.exact.isEmpty() && s.possible.isEmpty()) ctx.reasons.add(REASON.definitionUnused);
          break;
        case "layer-order":
          s = Sets.empty(this.size);
          for (const m of models) for (const r of m.rules) if (r.layer) s.orInPlace(this.ruleSets(r, ctx));
          break;
        default:
          ctx.reasons.add(REASON.global(ch.kind));
          s = new Sets(PageSet.empty(this.size), cand.pages.and(idx.ok), PageSet.empty(this.size));
      }
      s.unknown.orInPlace(unknownC);
      s.normalize();
      if (cand.emptyReason) ctx.reasons.add(cand.emptyReason);
      if (s.exact.isEmpty() && s.possible.isEmpty() && (a || b)) this.explainZero((a ?? b)!, ctx);
      if (!cand.mapped) {
        this.unmap(s, ctx);
        this.unmap(gained, ctx);
        this.unmap(lost, ctx);
      }
      if (!unknownC.isEmpty()) ctx.reasons.add(REASON.captureFailed(unknownC.count()));

      const pendingHere = [...(a?.complex ?? []), ...(b?.complex ?? [])].some((cs) => call.pending.has(cs.key));
      answers.push({
        id: `${ch.kind}:${ch.line}:${i}`,
        kind: ch.kind,
        line: ch.line,
        selector: (a ?? b)?.selectorText,
        oldSelector: ch.kind === "selector" ? b?.selectorText : undefined,
        changedProps: ch.changedProps,
        definition: ch.def ? { kind: ch.def.kind, name: ch.def.name, change: ch.def.change } : undefined,
        pages: s.count(pendingHere),
        gained: gained?.count(pendingHere),
        lost: lost?.count(pendingHere),
        conditions: this.conditionsOf(a, b),
        reasons: [...ctx.reasons],
        hint: ctx.hints[0],
        detail: ch.detail,
      });
      sets.push(s);
      gainedSets.push(gained);
      lostSets.push(lost);
      total.orInPlace(s);
      for (const r of ctx.reasons) totalReasons.add(r);
    });

    if (changes.length === 0) totalReasons.add(REASON.noEffectiveChange);
    return {
      changes: answers,
      sets,
      gained: gainedSets,
      lost: lostSets,
      total,
      totalCount: total.count(call.pending.size > 0),
      totalReasons: [...totalReasons],
      pending: call.pending,
      candidates: cand,
    };
  }

  /** Per-rule reach for the whole file (CodeLens). */
  ruleCounts(file: string, model: StylesheetModel): { rules: RuleCount[]; pending: PendingWork } {
    const cand = this.candidates(file);
    const call = new Call(cand.pages, this.index);
    this.index.prefetch(model.rules.flatMap((r) => r.complex.map((cs) => cs.key)));
    const rules: RuleCount[] = [];
    for (const r of model.rules) {
      const { s, ctx } = this.oneRule(r, call, cand);
      rules.push({
        line: r.line,
        endLine: r.endLine,
        selector: r.selectorText,
        pages: s.count(r.complex.some((cs) => call.pending.has(cs.key))),
        conditions: this.conditionsOf(r),
        reasons: [...ctx.reasons],
      });
    }
    return { rules, pending: call.pending };
  }

  /** Pages the rule starting at `line` reaches (the CodeLens "show" list). */
  rulePages(file: string, model: StylesheetModel, line: number): { sets: Sets; pending: PendingWork; rule: StyleRule } | undefined {
    const rule = model.rules.find((r) => r.line === line);
    if (!rule) return undefined;
    const cand = this.candidates(file);
    const call = new Call(cand.pages, this.index);
    this.index.prefetch(rule.complex.map((cs) => cs.key));
    const { s } = this.oneRule(rule, call, cand);
    return { sets: s, pending: call.pending, rule };
  }

  private oneRule(r: StyleRule, call: Call, cand: Candidates): { s: Sets; ctx: Ctx } {
    const ctx = new Ctx(call);
    const s = this.ruleSets(r, ctx).clone();
    s.unknown.orInPlace(call.unknownC);
    s.normalize();
    if (cand.emptyReason) ctx.reasons.add(cand.emptyReason);
    if (s.exact.isEmpty() && s.possible.isEmpty()) this.explainZero(r, ctx);
    if (!cand.mapped) this.unmap(s, ctx);
    return { s, ctx };
  }
}
