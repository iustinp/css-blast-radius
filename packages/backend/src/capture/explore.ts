// Interaction exploration (#5, J2): after a page loads, try what a visitor
// could do on it (click, hover, type, pick) and record which same-site
// script code runs after each action. The walk is depth-first from the loaded
// page, within depth, action and time budgets:
// - an action's children are the candidates it reveals (absent before it);
// - a state already seen (by structure, not text) isn't expanded again;
// - a family of look-alike elements (e.g. carousel dots) is dropped once 3 of
//   them in a row ran nothing new, and a revealed level after 4 dry tries;
// - siblings are tried in the page as it is when they're still actionable,
//   else the page is reloaded and the path to their parent replayed.
// Shared templates (a header menu on every page) are learned: once the same
// first action ran the same code on 3 pages with no disagreement, later pages
// inherit its outcome without trying it.

import { createHash } from "node:crypto";
import type { Page } from "playwright-core";
import { subtractSegments, unionSegments, type Segments } from "../util/coverage.js";
import { CANDIDATES_SCRIPT, STATE_SCRIPT } from "./inPage.js";

export type ActionKind = "click" | "hover" | "type" | "select";

export interface ExploreLimits {
  /** Actions in a row from the loaded page (1: only what's there at load). */
  depth: number;
  /** Actions tried per page and device (inherited ones aren't counted). */
  actions: number;
  timeMs: number;
}

/** One interaction on a page (`PageRow.explored.actions` blob, JSON array). */
export interface ExploredAction {
  /** Variant id. */
  v: number;
  /** The action before it in the same array (-1: done on the loaded page). */
  parent: number;
  kind: ActionKind;
  /** CSS selector of the element. */
  target: string;
  label: string;
  /** 1: done on the loaded page. */
  depth: number;
  /** Same-site scripts' code that ran after it: URL path → ran offsets. */
  ran: Record<string, Segments>;
  /** Not tried here: the same action ran this on other pages of the template. */
  inherited?: true;
}

export interface ExploreStats {
  tried: number;
  /** Actions that ran code not run before on the page. */
  found: number;
  inherited: number;
  resets: number;
  ms: number;
  stopped?: "actions" | "time";
}

/** What the explorer needs from the capture of one page variant. */
export interface ExploreEnv {
  page: Page;
  variant: number;
  profile: string;
  limits: ExploreLimits;
  /** Same-site scripts' code run since the last call. */
  delta(): Promise<Map<string, Segments>>;
  /** Loads the page again and lets it settle (false: it didn't load). */
  reload(): Promise<boolean>;
  /** Waits for requests and DOM changes to stop. */
  settle(): Promise<void>;
  /** What ran at load: not new. */
  base: Map<string, Segments>;
  /** The page's same-site files (path → blob id), filled as they load. */
  loaded: Record<string, string>;
  memo: ExploreMemo;
}

interface Candidate {
  kind: ActionKind;
  target: string;
  label: string;
  family: string;
  key: string;
}

const TRIAL_MS = 400;
const ACT_MS = 1_500;
const MAX_RESETS = 5;
const FAMILY_DRY = 3;
const LEVEL_DRY = 4;
const LEVEL_MAX = 6;
/** Pages that must agree before a first action's outcome is inherited. */
const AGREE = 3;

interface Outcome {
  hash: string;
  ran: Record<string, Segments>;
  /** Path → blob id the offsets are in. */
  blobs: Record<string, string>;
}

/**
 * First actions' outcomes across the pages of one scan, by signature
 * (device, kind, element family, label): the code their subtree ran beyond
 * the page's load, with the file versions it ran in.
 */
export class ExploreMemo {
  private readonly bySig = new Map<string, { outcome: Outcome; pages: number } | null>();

  /** The outcome to inherit, when trusted and in the same file versions as the page's. */
  inherit(sig: string, loaded: Record<string, string>): Outcome | undefined {
    const m = this.bySig.get(sig);
    if (!m || m.pages < AGREE) return undefined;
    for (const [path, blob] of Object.entries(m.outcome.blobs)) if (loaded[path] !== undefined && loaded[path] !== blob) return undefined;
    return m.outcome;
  }

  record(sig: string, ran: Record<string, Segments>, loaded: Record<string, string>): void {
    const blobs: Record<string, string> = {};
    for (const p of Object.keys(ran)) blobs[p] = loaded[p] ?? "";
    const entries = Object.keys(ran)
      .sort()
      .map((p) => [p, blobs[p], ran[p]]);
    const hash = createHash("sha1").update(JSON.stringify(entries)).digest("hex");
    const m = this.bySig.get(sig);
    if (m === null) return;
    if (!m) this.bySig.set(sig, { outcome: { hash, ran, blobs }, pages: 1 });
    else if (m.outcome.hash === hash) m.pages++;
    else this.bySig.set(sig, null);
  }
}

export async function explore(env: ExploreEnv): Promise<{ actions: ExploredAction[]; stats: ExploreStats }> {
  const t0 = Date.now();
  const { page, limits } = env;
  const actions: ExploredAction[] = [];
  const stats: ExploreStats = { tried: 0, found: 0, inherited: 0, resets: 0, ms: 0 };
  const seen = new Map(env.base);
  const states = new Set<string>();
  const familyDry = new Map<string, number>();
  const triedKeys = new Set<string>();
  /** Where the page is: the last action done since it loaded (-1: none). */
  let at = -1;
  let broken = false;

  const over = (): boolean => {
    if (stats.tried >= limits.actions) stats.stopped = "actions";
    else if (Date.now() - t0 >= limits.timeMs) stats.stopped = "time";
    return !!stats.stopped || broken;
  };
  const chain = (i: number): number[] => {
    const out: number[] = [];
    for (let k = i; k >= 0; k = actions[k].parent) out.unshift(k);
    return out;
  };
  const within = (i: number, root: number): boolean => root < 0 || chain(i).includes(root);

  const candidates = async (): Promise<Candidate[]> => {
    try {
      const raw = (await page.evaluate(CANDIDATES_SCRIPT)) as Array<[ActionKind, string, string, string, number]>;
      return raw.map(([kind, target, label, family]) => ({ kind, target, label, family, key: `${family}|${label}` }));
    } catch {
      return [];
    }
  };
  const stateHash = async (): Promise<string | undefined> => {
    try {
      return (await page.evaluate(STATE_SCRIPT)) as string;
    } catch {
      return undefined;
    }
  };
  const actionable = async (c: Pick<Candidate, "kind" | "target">): Promise<boolean> => {
    const loc = page.locator(c.target).first();
    try {
      if (c.kind === "hover") await loc.hover({ trial: true, timeout: TRIAL_MS });
      else if (c.kind === "select") return (await loc.isVisible()) && (await loc.isEnabled());
      else await loc.click({ trial: true, timeout: TRIAL_MS });
      return true;
    } catch {
      return false;
    }
  };
  const act = async (c: ReplayStep): Promise<boolean> => {
    if (!(await doAction(page, c))) return false;
    await env.settle();
    return true;
  };
  /** Reloads the page and replays the actions leading to `to` (-1: the loaded page). */
  const restore = async (to: number): Promise<boolean> => {
    if (stats.resets >= MAX_RESETS || Date.now() - t0 >= limits.timeMs) return false;
    stats.resets++;
    at = -1;
    if (!(await env.reload())) {
      broken = true;
      return false;
    }
    for (const i of chain(to)) {
      if (!(await act(actions[i]))) {
        await env.delta();
        return false;
      }
      at = i;
    }
    await env.delta();
    return true;
  };

  /** The code `ran` has that the page hadn't run yet; adds it to what's seen. */
  const fresh = (ran: Map<string, Segments>): boolean => {
    let any = false;
    for (const [path, segs] of ran) {
      const before = seen.get(path) ?? [];
      if (subtractSegments(segs, before).length) any = true;
      seen.set(path, unionSegments(before, segs));
    }
    return any;
  };

  /** Tries `cands` (the children of action `parent`, at `depth`). */
  const level = async (parent: number, cands: Candidate[], known: Set<string>, depth: number): Promise<void> => {
    let dry = 0;
    let tried = 0;
    for (const c of cands) {
      if (over()) return;
      if (depth > 1 && (tried >= LEVEL_MAX || dry >= LEVEL_DRY)) return;
      if (triedKeys.has(c.key) || (familyDry.get(c.family) ?? 0) >= FAMILY_DRY) continue;

      // Template reuse, for actions on the loaded page.
      const sig = `${env.profile}|${c.key}`;
      if (depth === 1) {
        const o = env.memo.inherit(sig, env.loaded);
        if (o) {
          triedKeys.add(c.key);
          stats.inherited++;
          for (const [path, blob] of Object.entries(o.blobs)) if (blob && env.loaded[path] === undefined) env.loaded[path] = blob;
          if (Object.keys(o.ran).length) {
            actions.push({ v: env.variant, parent: -1, kind: c.kind, target: c.target, label: c.label, depth, ran: o.ran, inherited: true });
            fresh(new Map(Object.entries(o.ran)));
          }
          continue;
        }
      }

      if (!within(at, parent) && !(await restore(parent))) return;
      if (!(await actionable(c))) {
        // Not doable as the page is now: maybe from a clean `parent` state.
        if (at === parent) continue;
        if (!(await restore(parent))) {
          if (broken || depth > 1) return;
          continue;
        }
        if (!(await actionable(c))) continue;
      }
      // What's on the page just before: an earlier sibling may have revealed more than `known`.
      const here = at === parent ? known : new Set((await candidates()).map((x) => x.key));
      triedKeys.add(c.key);
      stats.tried++;
      tried++;
      const ok = await act(c);
      const delta = await env.delta();
      if (!ok) continue;
      const ran: Record<string, Segments> = {};
      for (const [path, segs] of delta) if (segs.length) ran[path] = segs;
      const index = actions.push({ v: env.variant, parent, kind: c.kind, target: c.target, label: c.label, depth, ran }) - 1;
      at = index;
      if (fresh(delta)) {
        stats.found++;
        familyDry.set(c.family, 0);
        dry = 0;
      } else {
        familyDry.set(c.family, (familyDry.get(c.family) ?? 0) + 1);
        dry++;
      }

      if (depth < limits.depth) {
        const h = await stateHash();
        if (h !== undefined && !states.has(h)) {
          states.add(h);
          const now = await candidates();
          // Doing the same again (closing what it opened) goes last, after what it revealed.
          const chain = new Set<string>();
          for (let k = index; k >= 0; k = actions[k].parent) chain.add(actions[k].target);
          const revealed = now.filter((x) => !here.has(x.key));
          revealed.sort((a, b) => Number(chain.has(a.target)) - Number(chain.has(b.target)));
          if (revealed.length) await level(index, revealed, new Set(now.map((x) => x.key)), depth + 1);
        }
      }

      if (depth === 1 && !stats.stopped && !broken) {
        // The first action's whole subtree, beyond the load, for later pages.
        const sub: Record<string, Segments> = {};
        for (let k = index; k < actions.length; k++) {
          if (!within(k, index) || actions[k].inherited) continue;
          for (const [path, segs] of Object.entries(actions[k].ran)) sub[path] = unionSegments(sub[path] ?? [], segs);
        }
        for (const path of Object.keys(sub)) {
          const rest = subtractSegments(sub[path], env.base.get(path) ?? []);
          if (rest.length) sub[path] = rest;
          else delete sub[path];
        }
        env.memo.record(sig, sub, env.loaded);
      }
    }
  };

  const root = await candidates();
  const h = await stateHash();
  if (h !== undefined) states.add(h);
  await level(-1, root, new Set(root.map((c) => c.key)), 1);
  stats.ms = Date.now() - t0;
  return { actions, stats };
}

/** What a recorded action needs to be done again. */
export type ReplayStep = Pick<ExploredAction, "kind" | "target" | "label"> & {
  /** Inherited, and no page found with the steps after it: the edited code may run only after one of them. */
  more?: true;
};

/** Does one action on the page as the explorer does (false: it couldn't be done). */
export async function doAction(page: Page, c: Pick<ExploredAction, "kind" | "target">): Promise<boolean> {
  const loc = page.locator(c.target).first();
  try {
    switch (c.kind) {
      case "click":
        await loc.click({ timeout: ACT_MS });
        break;
      case "hover":
        await loc.hover({ timeout: ACT_MS });
        break;
      case "type":
        await loc.click({ timeout: ACT_MS });
        await loc.pressSequentially("test", { timeout: ACT_MS });
        break;
      case "select": {
        // A Function, not source text: Playwright evaluates a string as an expression without calling it.
        const index = await loc.evaluate(PICK as (el: Element) => number);
        if (index < 0) return false;
        await loc.selectOption({ index }, { timeout: ACT_MS });
        break;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/** A select's first enabled option other than the selected one (-1: none). */
const PICK = new Function("el", "return Array.from(el.options).findIndex((o, k) => k !== el.selectedIndex && !o.disabled);");

/** "click “Menu”" */
export function stepText(a: Pick<ExploredAction, "kind" | "label">): string {
  const verb = a.kind === "type" ? "type in" : a.kind === "select" ? "pick in" : a.kind;
  return `${verb} “${a.label}”`;
}
