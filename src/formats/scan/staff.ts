// Staff line extraction (oemer's staffline_extraction.py).
import { findLines } from "./geom";
import { dilate, erode, getBbox, ones, u8, type Box, type Img } from "./ndimage";
import { mean, pyRound, slope, std } from "./py";
import { findPeaks } from "./sci";

export class Line {
  ys: number[] = [];
  xs: number[] = [];
  label = -1;
  private c: Record<string, number> = {};
  add(y: number, x: number) {
    this.ys.push(y);
    this.xs.push(x);
    this.c = {};
  }
  private memo(k: string, f: () => number) {
    return (this.c[k] ??= f());
  }
  get yCenter() {
    return this.memo("yc", () => mean(this.ys));
  }
  get yUpper() {
    return this.memo("yu", () => Math.min(...this.ys));
  }
  get yLower() {
    return this.memo("yl", () => Math.max(...this.ys));
  }
  get xCenter() {
    return this.memo("xc", () => mean(this.xs));
  }
  get xLeft() {
    return this.memo("xl", () => Math.min(...this.xs));
  }
  get xRight() {
    return this.memo("xr", () => Math.max(...this.xs));
  }
  get slope() {
    return this.memo("s", () => slope(this.xs, this.ys));
  }
}

export class Staff {
  lines: Line[] = [];
  track = 0;
  group = 0;
  isInterp = false;
  private c: Record<string, number> = {};
  add(l: Line) {
    this.lines.push(l);
    this.c = {};
  }
  private memo(k: string, f: () => number) {
    return (this.c[k] ??= f());
  }
  get yCenter() {
    return this.memo("yc", () => mean(this.lines.map((l) => l.yCenter)));
  }
  get yUpper() {
    return this.memo("yu", () => Math.min(...this.lines.map((l) => l.yUpper)));
  }
  get yLower() {
    return this.memo("yl", () => Math.max(...this.lines.map((l) => l.yLower)));
  }
  get xCenter() {
    return this.memo("xc", () => mean(this.lines.map((l) => l.xCenter)));
  }
  get xLeft() {
    return this.memo("xl", () => Math.min(...this.lines.map((l) => l.xLeft)));
  }
  get xRight() {
    return this.memo("xr", () => Math.max(...this.lines.map((l) => l.xRight)));
  }
  get unitSize() {
    return this.memo("u", () => {
      const c = this.lines.map((l) => l.yCenter);
      const gaps: number[] = [];
      for (let i = 1; i < c.length; i++) gaps.push(c[i] - c[i - 1]);
      return mean(gaps);
    });
  }
  duplicate(xo = 0, yo = 0): Staff {
    const st = new Staff();
    for (const l of this.lines) {
      const n = new Line();
      for (let i = 0; i < l.ys.length; i++) n.add(l.ys[i] + yo, l.xs[i] + xo);
      st.add(n);
    }
    return st;
  }
  dist(x: number, y: number) {
    return Math.sqrt((x - this.xCenter) ** 2 + (y - this.yCenter) ** 2);
  }
}

/** Column ranges oemer splits the page into: [start, end) pairs. */
export type Zone = [number, number];

function initZones(staff: Img, splits: number): Zone[] {
  const { w, h, d } = staff;
  let minX = Infinity;
  let maxX = -Infinity;
  const accum = new Float64Array(w);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = d[y * w + x];
      accum[x] += v;
      if (v > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
      }
    }
  const m = mean(accum);
  for (let x = 0; x < w; x++) accum[x] /= m;
  const half = pyRound(w / 2);
  let right = Math.min(maxX + 50, w);
  let left = Math.max(minX - 50, 0);
  for (let i = half + 10; i < w; i++)
    if (mean(accum.subarray(i - 10, i)) < 0.1) {
      right = i;
      break;
    }
  for (let i = half - 10; i > 0; i--)
    if (mean(accum.subarray(i, i + 10)) < 0.1) {
      left = i;
      break;
    }
  const step = pyRound((right - left) / splits);
  const zones: Zone[] = [];
  for (let start = left; start < right; start += step) {
    let end = start + step;
    if (right - end < step) {
      end = right;
      zones.push([start, end]);
      break;
    }
    zones.push([start, end]);
  }
  return zones;
}

function filterLinePeaks(peaks: number[], norm: Float64Array, maxGapRatio = 1.5): { valid: boolean[]; groups: number[] } {
  const valid = peaks.map((p) => !(norm[p] > 15));
  const gaps = peaks.slice(1).map((p, i) => p - peaks[i]);
  let count = Math.max(5, pyRound(peaks.length * 0.2));
  const approx = mean([...gaps].sort((a, b) => a - b).slice(0, count));
  const maxGap = approx * maxGapRatio;
  const ext = [peaks[0] - maxGap - 1, ...peaks];
  const groups: number[] = [];
  let group = -1;
  for (let i = 1; i < ext.length; i++) {
    if (ext[i] - ext[i - 1] > maxGap) group++;
    groups.push(group);
  }
  groups.push(groups[groups.length - 1] + 1);
  let cur = groups[0];
  count = 1;
  for (let idx = 1; idx < groups.length; idx++) {
    const g = groups[idx];
    if (g === cur) {
      count++;
      continue;
    }
    if (count < 5) for (let k = idx - count; k < idx; k++) valid[k] = false;
    else if (count > 5) {
      const cand = peaks.slice(idx - count, idx);
      const head = cand.slice(0, 5).reduce((s, p) => s + norm[p], 0);
      const tail = cand.slice(-5).reduce((s, p) => s + norm[p], 0);
      if (head > tail) for (let k = idx - count + 5; k < idx; k++) valid[k] = false;
      else for (let k = idx - count; k < idx - 5; k++) valid[k] = false;
    }
    cur = g;
    count = 1;
  }
  return { valid, groups: groups.slice(0, -1) };
}

function extractLine(staff: Img, zone: Zone, lineThreshold: number): Line[] {
  const { w, h, d } = staff;
  const count = new Float64Array(h + 2);
  const rowsPx: number[][] = [];
  for (let y = 0; y < h; y++) {
    const xs: number[] = [];
    for (let x = zone[0]; x < zone[1]; x++) if (d[y * w + x] > 0) xs.push(x - zone[0]);
    rowsPx.push(xs);
    count[y + 1] = xs.length & 0xffff;
  }
  const m = mean(count);
  const s = std(count);
  const full = Float64Array.from(count, (v) => (v - m) / s);
  const centers = findPeaks(full, lineThreshold, 8, 1).map((c) => c - 1);
  const norm = full.subarray(1, h + 1);
  if (!centers.length) return [];
  const { valid, groups } = filterLinePeaks(centers, norm);
  const cc = centers.filter((_, i) => valid[i]);
  const diffs = cc.slice(1).map((c, i) => c - cc[i]).sort((a, b) => a - b);
  const maxGap = mean(diffs.slice(0, 3));
  const lines = centers.map(() => new Line());
  for (let y = 0; y < h; y++) {
    if (!rowsPx[y].length) continue;
    let best = 0;
    for (let k = 1; k < centers.length; k++) if (Math.abs(centers[k] - y) < Math.abs(centers[best] - y)) best = k;
    if (valid[best] && norm[y] > Math.min(lineThreshold, 1.2) && Math.abs(y - centers[best]) < maxGap)
      for (const x of rowsPx[y]) lines[best].add(y, x + zone[0]);
  }
  // Labels 0..4 within each group of peaks, in order down the page.
  let last = groups[0];
  let id = 0;
  centers.forEach((_, i) => {
    if (!valid[i]) return;
    if (groups[i] !== last) {
      id = 0;
      last = groups[i];
    }
    lines[i].label = id++;
  });
  return lines.filter((_, i) => valid[i]);
}

function extractPart(staff: Img, zone: Zone, lineThreshold: number): Staff[] | null {
  const lines = extractLine(staff, zone, lineThreshold);
  if (lines.length < 5) return null;
  const staffs: Staff[] = [];
  let buf: Line[] = [];
  lines.forEach((l, idx) => {
    const lid = idx % 5;
    if (l.label !== lid) throw new ScanError(`staff line labels out of order at ${idx}`);
    if (lid === 0 && buf.length) {
      const st = new Staff();
      for (const b of buf) st.add(b);
      staffs.push(st);
      buf = [];
    }
    buf.push(l);
  });
  const st = new Staff();
  for (const b of buf) st.add(b);
  staffs.push(st);
  return staffs;
}

export class ScanError extends Error {}

function alignStaffs(parts: Staff[][], maxDistRatio = 3): Staff[][] {
  const lens = new Set(parts.map((p) => p.length));
  if (lens.size === 1) return parts;
  const maxLen = Math.max(...lens);
  const grid: (Staff | null)[][] = parts.map((p) => (p.length === maxLen ? [...p] : new Array(maxLen).fill(null)));
  // Column i of the grid, read live: staffs filled in for earlier zones count as neighbours.
  const nearby = (j: number, i: number) => {
    const idxs = grid.map((_, k) => k).sort((a, b) => Math.abs(a - j) - Math.abs(b - j) || a - b);
    const out: [number, Staff][] = [];
    for (const k of idxs) {
      if (grid[k][i]) out.push([k, grid[k][i]!]);
      if (out.length >= 2) break;
    }
    return out;
  };
  for (let i = 0; i < maxLen; i++) {
    grid.forEach((_, j) => {
      if (grid[j][i]) return;
      const ori = parts[j];
      const sts = nearby(j, i);
      if (!sts.length) throw new ScanError("no staff to align with");
      const maxDist = sts[0][1].unitSize * maxDistRatio;
      const near = ori.find((st) => Math.abs(st.yCenter - sts[0][1].yCenter) < maxDist);
      if (near) {
        grid[j][i] = near;
        return;
      }
      let st: Staff;
      if (sts.length === 1) {
        const [ri, ref] = sts[0];
        st = ref.duplicate((ref.xRight - ref.xLeft) * (j - ri));
      } else {
        let [[i1, r1], [i2, r2]] = sts;
        if (i1 > i2) [i1, r1, i2, r2] = [i2, r2, i1, r1];
        if (j < i1) {
          const a = i1 - j;
          const b = i2 - i1;
          st = r1.duplicate(-(r2.xCenter - r1.xCenter) * (a / b), -(r2.yCenter - r1.yCenter) * (a / b));
        } else if (j < i2) {
          const a = j - i1;
          const b = i2 - i1;
          st = r1.duplicate((r2.xCenter - r1.xCenter) * (a / b), (r2.yCenter - r1.yCenter) * (a / b));
        } else {
          const a = i2 - i1;
          const b = j - i2;
          st = r2.duplicate((r2.xCenter - r1.xCenter) * (b / a), (r2.yCenter - r1.yCenter) * (b / a));
        }
      }
      st.isInterp = true;
      grid[j][i] = st;
    });
  }
  return grid as Staff[][];
}

export interface Layers {
  staff: Img;
  symbols: Img;
  stems: Img;
  notehead: Img;
  clefs: Img;
}

function naiveUnitSize(flat: Staff[], x: number, y: number) {
  let best = flat[0];
  let bd = Infinity;
  for (const st of flat) {
    const d = (st.xCenter - x) ** 2 + (st.yCenter - y) ** 2;
    if (d < bd) {
      bd = d;
      best = st;
    }
  }
  return best.unitSize;
}

function inferTrackNums(L: Layers, staffs: Staff[][], minDegree: number): number {
  const { w, h } = L.symbols;
  const mix = { w, h, d: new Float32Array(w * h) };
  for (let i = 0; i < w * h; i++) mix.d[i] = Math.max(0, L.symbols.d[i] - L.stems.d[i] - L.notehead.d[i] - L.clefs.d[i]);
  const flat = staffs.flat();
  let minY = 9999999;
  let minX = 9999999;
  let maxY = 0;
  let maxX = 0;
  for (const st of flat) {
    minY = Math.min(minY, st.yUpper);
    minX = Math.min(minX, st.xLeft);
    maxY = Math.max(maxY, st.yLower);
    maxX = Math.max(maxX, st.xRight);
  }
  const lines = findLines(u8(mix)).filter((l) => {
    const deg = (Math.atan2(l[3] - l[1], l[2] - l[0]) * 180) / Math.PI;
    return !(deg < minDegree) && !(l[1] < minY || l[3] > maxY || l[0] < minX || l[2] > maxX);
  });
  const bmap = { w, h, d: new Float32Array(w * h) };
  for (const l of lines) {
    const x2 = l[2] - l[0] === 0 ? l[2] + 1 : l[2];
    for (let y = l[1]; y < l[3]; y++) for (let x = l[0]; x < x2; x++) bmap.d[y * w + x] += L.symbols.d[y * w + x];
  }
  for (let i = 0; i < w * h; i++) {
    let v = bmap.d[i] > 1 ? 1 : bmap.d[i];
    v += L.stems.d[i];
    bmap.d[i] = v > 1 ? 1 : v;
  }
  const ker = ones(5, 2);
  const boxes = getBbox(erode(dilate(u8(bmap), ker), ker));
  const ratios: number[] = [];
  for (const b of boxes) {
    const bh = b[3] - b[1];
    const unit = naiveUnitSize(flat, pyRound((b[0] + b[2]) / 2), pyRound((b[1] + b[3]) / 2));
    if (bh > unit) ratios.push(bh / unit);
  }
  let n = 1;
  for (let i = 1; i < 10; i++) {
    const valid = ratios.filter((r) => r > 10 * i).length;
    if (valid * (i + 1) > staffs[0].length) n++;
    else break;
  }
  return n;
}

/** Staffs per zone (columns of the page) and the zones. */
export function extractStaffs(L: Layers, issues: string[] = [], opts: { splits?: number; lineThreshold?: number } = {}): { staffs: Staff[][]; zones: Zone[] } {
  const zones = initZones(L.staff, opts.splits ?? 8);
  const parts: Staff[][] = [];
  for (const z of zones) {
    const st = extractPart(L.staff, z, opts.lineThreshold ?? 0.8);
    if (st) parts.push(st);
  }
  if (!parts.length) throw new ScanError("no staff found");
  const staffs = alignStaffs(parts);
  const tracks = inferTrackNums(L, staffs, 75);
  for (const col of staffs)
    col.forEach((st, idx) => {
      st.track = idx % tracks;
      st.group = Math.floor(idx / tracks);
    });
  const norm = (xs: number[]) => {
    const m = mean(xs);
    return xs.map((v) => Math.abs(v / m - 1));
  };
  for (let i = 0; i < staffs[0].length; i++) {
    const row = staffs.map((c) => c[i]);
    // oemer stops on these; the port notes them and carries on.
    if (new Set(row.map((s) => s.lines.length)).size !== 1) issues.push(`staff ${i}: parts with other than five lines`);
    if (!norm(row.map((s) => s.yCenter)).every((v) => v < 0.1)) issues.push(`staff ${i}: parts not aligned`);
    if (!norm(row.map((s) => s.unitSize)).every((v) => v < 0.1)) issues.push(`staff ${i}: unit sizes inconsistent`);
  }
  return { staffs, zones };
}

/** Lookups on the extracted staffs (oemer's utils.py). */
export class Staffs {
  flat: Staff[];
  constructor(public grid: Staff[][], public zones: Zone[]) {
    this.flat = grid.flat();
  }
  closest(x: number, y: number): [Staff, Staff] {
    const d = this.flat.map((st, i) => [st.dist(x, y), i] as const).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const by = d.map(([, i]) => this.flat[i]);
    if (by.length === 1) return [by[0], by[0]];
    if (by.length === 2) return [by[0], by[1]];
    const [first, second, third] = by;
    if (Math.abs(first.yLower - y) <= Math.abs(first.yUpper - y)) {
      if (second.yCenter > first.yCenter) return [first, second];
      if (third.yCenter > first.yCenter) return [first, third];
      return [first, first];
    }
    if (second.yCenter < first.yCenter) return [first, second];
    if (third.yCenter < first.yCenter) return [first, third];
    return [first, first];
  }
  unitSize(x: number, y: number): number {
    const [s1, s2] = this.closest(x, y);
    if (s1.yCenter === s2.yCenter) return s1.unitSize;
    if (s1.yUpper <= y && y <= s1.yLower) return s1.unitSize;
    const d1 = Math.abs(y - s1.yCenter);
    const d2 = Math.abs(y - s2.yCenter);
    return (d1 / (d1 + d2)) * s1.unitSize + (d2 / (d1 + d2)) * s2.unitSize;
  }
  globalUnitSize(): number {
    return mean(this.flat.map((s) => s.unitSize));
  }
  tracks(): number {
    return new Set(this.flat.map((s) => s.track)).size;
  }
  /** zones[0][0] and zones[-1][-1] (the last column inside the last zone). */
  get minX() {
    return this.zones[0][0];
  }
  get maxX() {
    return this.zones[this.zones.length - 1][1] - 1;
  }
}

export const center = (b: Box): [number, number] => [pyRound((b[0] + b[2]) / 2), pyRound((b[1] + b[3]) / 2)];
