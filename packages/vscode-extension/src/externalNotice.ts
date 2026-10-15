import type { Count, SessionTotal } from "./protocol";
import { sameCount } from "./format";

/** Leading notification, followed by at most one merged notice per interval. */
export class ExternalNoticeBatch {
  private readonly pending = new Set<string>();
  private session?: SessionTotal;
  /** The total before the batch's first change. */
  private before?: Count;
  private nextAt = 0;

  add(files: string[], session: SessionTotal, before?: Count): void {
    if (!this.pending.size) this.before = before;
    for (const file of files) this.pending.add(file);
    if (!this.session || (session.indexRevision ?? -1) > (this.session.indexRevision ?? -1)
      || (session.indexRevision === this.session.indexRevision && session.editRevision >= this.session.editRevision)) {
      this.session = session;
    }
  }

  /** Changes are waiting for the next notice. */
  get waiting(): boolean {
    return this.pending.size > 0;
  }

  take(now: number): { files: string[]; session: SessionTotal; before?: Count } | undefined {
    if (now < this.nextAt || !this.pending.size || !this.session) return undefined;
    const result = { files: [...this.pending], session: this.session, before: this.before };
    this.clear();
    // Changed and changed back: nothing to tell.
    if (result.before && sameCount(result.before, result.session.total)) return undefined;
    this.nextAt = now + 10_000;
    return result;
  }

  delay(now: number): number {
    return Math.max(0, this.nextAt - now);
  }

  clear(): void {
    this.pending.clear();
    this.session = undefined;
    this.before = undefined;
  }
}
