import type { SessionTotal } from "./protocol";

/** Leading notification, followed by at most one merged notice per interval. */
export class ExternalNoticeBatch {
  private readonly pending = new Set<string>();
  private session?: SessionTotal;
  private nextAt = 0;

  add(files: string[], session: SessionTotal): void {
    for (const file of files) this.pending.add(file);
    if (!this.session || (session.indexRevision ?? -1) > (this.session.indexRevision ?? -1)
      || (session.indexRevision === this.session.indexRevision && session.editRevision >= this.session.editRevision)) {
      this.session = session;
    }
  }

  take(now: number): { files: string[]; session: SessionTotal } | undefined {
    if (now < this.nextAt || !this.pending.size || !this.session) return undefined;
    const result = { files: [...this.pending], session: this.session };
    this.pending.clear();
    this.session = undefined;
    this.nextAt = now + 10_000;
    return result;
  }

  delay(now: number): number {
    return Math.max(0, this.nextAt - now);
  }

  clear(): void {
    this.pending.clear();
    this.session = undefined;
  }
}
