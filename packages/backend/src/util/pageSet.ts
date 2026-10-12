// Dense page-ID bitset. A revision with 10,000 pages needs 1.25 KB per set,
// so union/intersection/count are a few hundred word operations
// (microseconds). The architecture doc mentions roaring bitmaps; dense sets
// are simpler and fast enough at the target scale. Swap only if measured
// memory demands it.

export class PageSet {
  readonly size: number;
  readonly words: Uint32Array;

  constructor(size: number, words?: Uint32Array) {
    this.size = size;
    this.words = words ?? new Uint32Array((size + 31) >>> 5);
  }

  static empty(size: number): PageSet {
    return new PageSet(size);
  }

  static full(size: number): PageSet {
    const s = new PageSet(size);
    s.words.fill(0xffffffff);
    const tail = size & 31;
    if (tail && s.words.length) s.words[s.words.length - 1] = (1 << tail) - 1;
    return s;
  }

  static fromIds(size: number, ids: Iterable<number>): PageSet {
    const s = new PageSet(size);
    for (const id of ids) s.add(id);
    return s;
  }

  static fromBuffer(size: number, buf: Uint8Array): PageSet {
    const words = new Uint32Array((size + 31) >>> 5);
    new Uint8Array(words.buffer).set(buf.subarray(0, words.byteLength));
    return new PageSet(size, words);
  }

  toBuffer(): Buffer {
    return Buffer.from(this.words.buffer, this.words.byteOffset, this.words.byteLength);
  }

  clone(): PageSet {
    return new PageSet(this.size, this.words.slice());
  }

  has(id: number): boolean {
    return (this.words[id >>> 5] & (1 << (id & 31))) !== 0;
  }

  add(id: number): this {
    this.words[id >>> 5] |= 1 << (id & 31);
    return this;
  }

  delete(id: number): this {
    this.words[id >>> 5] &= ~(1 << (id & 31));
    return this;
  }

  or(other: PageSet): PageSet {
    return this.clone().orInPlace(other);
  }

  and(other: PageSet): PageSet {
    return this.clone().andInPlace(other);
  }

  andNot(other: PageSet): PageSet {
    return this.clone().andNotInPlace(other);
  }

  orInPlace(other: PageSet): this {
    const a = this.words;
    const b = other.words;
    for (let i = 0; i < a.length; i++) a[i] |= b[i];
    return this;
  }

  andInPlace(other: PageSet): this {
    const a = this.words;
    const b = other.words;
    for (let i = 0; i < a.length; i++) a[i] &= b[i];
    return this;
  }

  andNotInPlace(other: PageSet): this {
    const a = this.words;
    const b = other.words;
    for (let i = 0; i < a.length; i++) a[i] &= ~b[i];
    return this;
  }

  count(): number {
    let n = 0;
    const w = this.words;
    for (let i = 0; i < w.length; i++) {
      let v = w[i];
      if (v === 0) continue;
      v = v - ((v >>> 1) & 0x55555555);
      v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
      n += (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
    }
    return n;
  }

  isEmpty(): boolean {
    const w = this.words;
    for (let i = 0; i < w.length; i++) if (w[i] !== 0) return false;
    return true;
  }

  equals(other: PageSet): boolean {
    if (other.size !== this.size) return false;
    for (let i = 0; i < this.words.length; i++) if (this.words[i] !== other.words[i]) return false;
    return true;
  }

  *ids(): IterableIterator<number> {
    const w = this.words;
    for (let i = 0; i < w.length; i++) {
      let v = w[i];
      while (v !== 0) {
        const t = v & -v;
        yield (i << 5) + (31 - Math.clz32(t));
        v ^= t;
      }
    }
  }

  toArray(): number[] {
    return [...this.ids()];
  }

  clear(): this {
    this.words.fill(0);
    return this;
  }
}

export function unionAll(size: number, sets: Iterable<PageSet>): PageSet {
  const out = PageSet.empty(size);
  for (const s of sets) out.orInPlace(s);
  return out;
}
