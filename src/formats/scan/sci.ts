// scipy.signal.find_peaks, sklearn's ward AgglomerativeClustering and CPython's set
// ordering, as far as oemer depends on them.

/** find_peaks(x, height, distance, prominence) with scipy's order of filters. */
export function findPeaks(x: ArrayLike<number>, height: number, distance: number, prominence: number): number[] {
  const n = x.length;
  let peaks: number[] = [];
  let i = 1;
  const iMax = n - 1;
  while (i < iMax) {
    if (x[i - 1] < x[i]) {
      let ahead = i + 1;
      while (ahead < iMax && x[ahead] === x[i]) ahead++;
      if (x[ahead] < x[i]) {
        peaks.push((i + ahead - 1) >> 1);
        i = ahead;
      }
    }
    i++;
  }
  peaks = peaks.filter((p) => x[p] >= height);
  // Distance: keep the highest, drop neighbours closer than distance.
  const d = Math.ceil(distance);
  const keep = peaks.map(() => true);
  const order = peaks.map((_, k) => k).sort((a, b) => x[peaks[a]] - x[peaks[b]] || a - b);
  for (let k = order.length - 1; k >= 0; k--) {
    const j = order[k];
    if (!keep[j]) continue;
    for (let m = j - 1; m >= 0 && peaks[j] - peaks[m] < d; m--) keep[m] = false;
    for (let m = j + 1; m < peaks.length && peaks[m] - peaks[j] < d; m++) keep[m] = false;
  }
  peaks = peaks.filter((_, k) => keep[k]);
  return peaks.filter((p) => {
    let leftMin = x[p];
    for (let k = p; k >= 0 && x[k] <= x[p]; k--) if (x[k] < leftMin) leftMin = x[k];
    let rightMin = x[p];
    for (let k = p; k < n && x[k] <= x[p]; k++) if (x[k] < rightMin) rightMin = x[k];
    return x[p] - Math.max(leftMin, rightMin) >= prominence;
  });
}

// heapq on numbers.
function siftDown(heap: number[], start: number, pos: number) {
  const item = heap[pos];
  while (pos > start) {
    const parent = (pos - 1) >> 1;
    if (item < heap[parent]) {
      heap[pos] = heap[parent];
      pos = parent;
    } else break;
  }
  heap[pos] = item;
}
function siftUp(heap: number[], pos: number) {
  const end = heap.length;
  const start = pos;
  const item = heap[pos];
  let child = 2 * pos + 1;
  while (child < end) {
    const right = child + 1;
    if (right < end && !(heap[child] < heap[right])) child = right;
    heap[pos] = heap[child];
    pos = child;
    child = 2 * pos + 1;
  }
  heap[pos] = item;
  siftDown(heap, start, pos);
}
function heappush(heap: number[], v: number) {
  heap.push(v);
  siftDown(heap, 0, heap.length - 1);
}
function heappushpop(heap: number[], v: number) {
  if (heap.length && heap[0] < v) {
    const r = heap[0];
    heap[0] = v;
    siftUp(heap, 0);
    return r;
  }
  return v;
}

/**
 * AgglomerativeClustering(n_clusters=None, distance_threshold=t) with ward linkage:
 * a cluster label per point, numbered as sklearn numbers them.
 */
export function wardLabels(pts: [number, number][], threshold: number): number[] {
  const n = pts.length;
  if (n < 2) return pts.map(() => 0);
  const ci = (i: number, j: number) => (i < j ? n * i - (i * (i + 1)) / 2 + (j - i - 1) : n * j - (j * (j + 1)) / 2 + (i - j - 1));
  const D = new Float64Array((n * (n - 1)) / 2);
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) { const dx = pts[i][0] - pts[j][0]; const dy = pts[i][1] - pts[j][1]; D[ci(i, j)] = Math.sqrt(dx * dx + dy * dy); }
  const size = new Array<number>(n).fill(1);
  const chain: number[] = [];
  const Z: [number, number, number][] = [];
  for (let k = 0; k < n - 1; k++) {
    if (!chain.length) for (let i = 0; i < n; i++) if (size[i] > 0) {
      chain.push(i);
      break;
    }
    let x = 0;
    let y = 0;
    let cur = 0;
    for (;;) {
      x = chain[chain.length - 1];
      if (chain.length > 1) {
        y = chain[chain.length - 2];
        cur = D[ci(x, y)];
      } else cur = Infinity;
      for (let i = 0; i < n; i++) {
        if (!size[i] || x === i) continue;
        const dist = D[ci(x, i)];
        if (dist < cur) {
          cur = dist;
          y = i;
        }
      }
      if (chain.length > 1 && y === chain[chain.length - 2]) break;
      chain.push(y);
    }
    chain.length -= 2;
    if (x > y) [x, y] = [y, x];
    const nx = size[x];
    const ny = size[y];
    Z.push([x, y, cur]);
    size[x] = 0;
    size[y] = nx + ny;
    for (let i = 0; i < n; i++) {
      const ni = size[i];
      if (!ni || i === y) continue;
      const t = 1 / (nx + ny + ni);
      const dxi = D[ci(i, x)];
      const dyi = D[ci(i, y)];
      D[ci(i, y)] = Math.sqrt((ni + nx) * t * dxi * dxi + (ni + ny) * t * dyi * dyi - ni * t * cur * cur);
    }
  }
  // Sort by distance (stable) and relabel the merges the way scipy's linkage does.
  const order = Z.map((_, i) => i).sort((a, b) => Z[a][2] - Z[b][2] || a - b);
  const parent = new Array<number>(2 * n - 1).fill(0).map((_, i) => i);
  const find = (v: number) => {
    let r = v;
    while (parent[r] !== r) r = parent[r];
    while (parent[v] !== r) {
      const nx2 = parent[v];
      parent[v] = r;
      v = nx2;
    }
    return r;
  };
  const children: [number, number][] = [];
  const dists: number[] = [];
  let next = n;
  for (const o of order) {
    const [a, b, dist] = Z[o];
    const ra = find(a);
    const rb = find(b);
    children.push(ra < rb ? [ra, rb] : [rb, ra]);
    dists.push(dist);
    parent[ra] = next;
    parent[rb] = next;
    next++;
  }
  const nClusters = dists.filter((v) => v >= threshold).length + 1;
  const nodes = [-(Math.max(...children[children.length - 1]) + 1)];
  for (let c = 0; c < nClusters - 1; c++) {
    const these = children[-nodes[0] - n];
    heappush(nodes, -these[0]);
    heappushpop(nodes, -these[1]);
  }
  const labels = new Array<number>(n).fill(0);
  nodes.forEach((node, li) => {
    const stack = [-node];
    while (stack.length) {
      const v = stack.pop()!;
      if (v < n) labels[v] = li;
      else stack.push(...children[v - n]);
    }
  });
  return labels;
}

const DUMMY = Symbol("dummy");

/** A CPython set of ints: iteration and pop() follow CPython's hash table order. */
export class PySet {
  private keys: (number | null | typeof DUMMY)[] = new Array(8).fill(null);
  private fill = 0;
  private used = 0;
  private finger = 0;

  constructor(items: Iterable<number> = []) {
    for (const v of items) this.add(v);
  }

  get size(): number {
    return this.used;
  }

  private static hash(v: number): bigint {
    return BigInt(v === -1 ? -2 : v);
  }

  private probe(v: number, stopAtDummy: boolean): number {
    const mask = this.keys.length - 1;
    const h = PySet.hash(v);
    let perturb = BigInt.asUintN(64, h);
    let i = Number(BigInt.asUintN(64, h) & BigInt(mask));
    let free = -1;
    for (;;) {
      const probes = i + 9 <= mask ? 9 : 0;
      for (let k = 0, e = i; k <= probes; k++, e++) {
        const key = this.keys[e];
        if (key === null) return free >= 0 && !stopAtDummy ? free : e;
        if (key === v) return e;
        if (key === DUMMY && free < 0) free = e;
      }
      perturb >>= 5n;
      i = Number((BigInt(i) * 5n + 1n + perturb) & BigInt(mask));
    }
  }

  has(v: number): boolean {
    return this.keys[this.probe(v, true)] === v;
  }

  add(v: number): void {
    const e = this.probe(v, false);
    const key = this.keys[e];
    if (key === v) return;
    this.used++;
    this.keys[e] = v;
    if (key === DUMMY) return;
    this.fill++;
    const mask = this.keys.length - 1;
    if (this.fill * 5 >= mask * 3) this.resize(this.used > 50000 ? this.used * 2 : this.used * 4);
  }

  private resize(minused: number) {
    let size = 8;
    while (size <= minused) size <<= 1;
    const old = this.keys;
    this.keys = new Array(size).fill(null);
    this.fill = this.used;
    for (const k of old) {
      if (k === null || k === DUMMY) continue;
      const mask = size - 1;
      const h = PySet.hash(k);
      let perturb = BigInt.asUintN(64, h);
      let i = Number(BigInt.asUintN(64, h) & BigInt(mask));
      for (;;) {
        if (this.keys[i] === null) break;
        let found = -1;
        if (i + 9 <= mask) for (let j = 1; j <= 9; j++) if (this.keys[i + j] === null) {
          found = i + j;
          break;
        }
        if (found >= 0) {
          i = found;
          break;
        }
        perturb >>= 5n;
        i = Number((BigInt(i) * 5n + 1n + perturb) & BigInt(mask));
      }
      this.keys[i] = k;
    }
  }

  delete(v: number): boolean {
    const e = this.probe(v, true);
    if (this.keys[e] !== v) return false;
    this.keys[e] = DUMMY;
    this.used--;
    return true;
  }

  pop(): number {
    if (!this.used) throw new Error("pop from an empty set");
    const mask = this.keys.length - 1;
    let e = this.finger & mask;
    while (this.keys[e] === null || this.keys[e] === DUMMY) e = e + 1 > mask ? 0 : e + 1;
    const v = this.keys[e] as number;
    this.keys[e] = DUMMY;
    this.used--;
    this.finger = e + 1;
    return v;
  }

  *[Symbol.iterator](): IterableIterator<number> {
    for (const k of this.keys) if (k !== null && k !== DUMMY) yield k;
  }

  /** set.intersection: walks the smaller set, keeps what the other holds. */
  intersection(other: PySet): PySet {
    const [a, b] = other.size > this.size ? [this as PySet, other] : [other, this as PySet];
    const out = new PySet();
    for (const v of a) if (b.has(v)) out.add(v);
    return out;
  }

  update(items: Iterable<number>): void {
    for (const v of items) this.add(v);
  }
}

/** set(np.unique(values)), then .remove(drop) when it is there. */
export function uniqueSet(values: Iterable<number>, drop?: number): PySet {
  const s = new PySet([...new Set(values)].sort((a, b) => a - b));
  if (drop !== undefined) s.delete(drop);
  return s;
}
