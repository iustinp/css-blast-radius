// Editor methods answered by one project session (shared by the per-workspace
// daemon and the local server).

import type { Session } from "../daemon/session.js";
import { ERR, RpcError } from "./protocol.js";

/** Methods that change document/session state run strictly in arrival order. */
export const SERIAL = new Set(["document/open", "document/change", "document/save", "document/close", "session/setDiffBase", "session/setGroups"]);

/** Document methods: the edits changed (the diff viewer refreshes). */
export const EDITS = new Set(["document/open", "document/change", "document/save", "document/close", "session/setDiffBase"]);

export function need(p: any, k: string): any {
  if (p?.[k] === undefined) throw new RpcError(ERR.invalidParams, `missing parameter: ${k}`);
  return p[k];
}

/** undefined: not a session method. */
export function sessionMethod(session: Session, method: string, p: any): Promise<unknown> | undefined {
  const run = (fn: () => unknown) => Promise.resolve().then(fn);
  switch (method) {
    case "workspace/attach":
    case "index/getStatus":
      return run(() => session.status());
    case "document/open":
      return run(() => session.open(need(p, "path"), need(p, "text"), p.version ?? 0));
    case "document/change":
      return run(() => session.change(need(p, "path"), need(p, "version"), need(p, "changes")));
    case "document/save":
      return run(() => session.save(need(p, "path"), p.text));
    case "document/close":
      return run(() => session.close(need(p, "path")));
    case "session/setDiffBase":
      return run(() => session.setDiffBase(need(p, "base")));
    case "session/setSelection":
      return run(() => session.setSelection(p?.selection));
    case "analysis/queryImpacts":
      return run(() => {
        switch (p?.scope ?? "file") {
          case "session":
            return session.sessionTotal();
          case "rules":
            return session.ruleCounts(need(p, "path"));
          case "file":
            return session.fileAnswer(need(p, "path"));
          default:
            throw new RpcError(ERR.invalidParams, `unknown scope: ${p.scope}`);
        }
      });
    case "analysis/getPages":
      return run(() => session.getPages(p ?? {}));
    case "analysis/getDrilldown":
      return run(() => {
        need(p, "path");
        need(p, "url");
        return session.drilldown({ ...p, level: p.level === 2 ? 2 : 1 });
      });
    case "analysis/openLive":
      return run(() => {
        need(p, "path");
        need(p, "url");
        return session.openLive(p);
      });
    case "analysis/pageDiff":
      return run(() => session.pageDiff({ url: need(p, "url"), device: p.device, live: !!p.live }));
    case "analysis/assess":
      return run(() => session.assess(p ?? {}));
    default:
      return undefined;
  }
}

/** Session events → editor notifications. */
export const SESSION_NOTIFICATIONS: Array<[event: string, method: string]> = [
  ["refined", "analysis/refined"],
  ["publish", "analysis/publishImpact"],
  ["status", "index/statusChanged"],
  ["revision", "index/revisionSwitched"],
  ["captureProgress", "index/captureProgress"],
  ["degraded", "server/degraded"],
  ["externalChange", "analysis/externalChange"],
  ["assess", "analysis/assessProgress"],
];
