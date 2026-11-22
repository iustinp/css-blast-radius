// Script coverage at page load (#5, J1). V8's precise block coverage reports
// nested [start, end) ranges with call counts; the innermost range decides
// whether a character's code ran. A page's coverage of a script is kept as the
// sorted, disjoint runs of offsets (in the served text) that ran:
// [s0, e0, s1, e1, …].

export type Segments = number[];

export interface V8Function {
  ranges: Array<{ startOffset: number; endOffset: number; count: number }>;
}

/** The runs of offsets that ran, from one script's `Profiler.takePreciseCoverage` functions. */
export function executedSegments(functions: V8Function[]): Segments {
  const ranges = functions.flatMap((f) => f.ranges);
  if (!ranges.length) return [];
  const len = Math.max(...ranges.map((r) => r.endOffset));
  const ran = new Uint8Array(len);
  // Outer ranges first (start ascending, longer first): inner ones paint over them.
  ranges.sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset);
  for (const r of ranges) ran.fill(r.count > 0 ? 1 : 0, Math.max(0, r.startOffset), r.endOffset);
  return runs(ran);
}

/** Offsets that ran in either (several variants of one page). */
export function unionSegments(a: Segments, b: Segments): Segments {
  if (!a.length) return b;
  if (!b.length) return a;
  const pairs: Array<[number, number]> = [];
  for (const s of [a, b]) for (let i = 0; i < s.length; i += 2) pairs.push([s[i], s[i + 1]]);
  pairs.sort((x, y) => x[0] - y[0]);
  const out: Segments = [];
  for (const [s, e] of pairs) {
    if (out.length && s <= out[out.length - 1]) out[out.length - 1] = Math.max(out[out.length - 1], e);
    else out.push(s, e);
  }
  return out;
}

/** Whether any offset in [start, end) ran (end = start: the code at `start`). */
export function ranIn(segs: Segments, start: number, end: number): boolean {
  const to = Math.max(end, start + 1);
  // Binary search for the first run ending after `start`.
  let lo = 0;
  let hi = segs.length / 2;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (segs[mid * 2 + 1] <= start) lo = mid + 1;
    else hi = mid;
  }
  return lo < segs.length / 2 && segs[lo * 2] < to;
}

function runs(ran: Uint8Array): Segments {
  const out: Segments = [];
  let i = 0;
  while (i < ran.length) {
    if (!ran[i]) {
      i++;
      continue;
    }
    const s = i;
    while (i < ran.length && ran[i]) i++;
    out.push(s, i);
  }
  return out;
}
