// Straightening of bent or skewed staff lines (oemer's dewarp.py). The vertical mapping
// oemer gets from scipy's griddata over staff-line samples is approximated here by
// interpolating, column by column, between the sampled lines above and below.
import { dilate, label, ones, open, roundEven, u8, type Box, type Img } from "./ndimage";
import { mean, pyRound, slope, sortedBy } from "./py";
import { PySet } from "./sci";

interface Grid {
  bbox: Box;
}
const yc = (g: Grid) => (g.bbox[1] + g.bbox[3]) / 2;

interface GridGroup {
  id: number;
  regId: number;
  bbox: Box;
  gids: number[];
  split: number;
}

function buildGrid(pred: Img<Uint8Array>, unit = 11): { map: Int32Array; grids: Grid[] } {
  const { w, h, d } = pred;
  const map = new Int32Array(w * h).fill(-1);
  const grids: Grid[] = [];
  const on = (y: number, x0: number) => {
    let s = 0;
    for (let x = x0; x < Math.min(w, x0 + unit); x++) s += d[y * w + x];
    return s > Math.floor(unit / 2);
  };
  for (let i = 0; i < w; i += unit) {
    let cur = 0;
    let last = 0;
    let stat = on(0, i);
    while (cur < h) {
      while (cur < h && stat === on(cur, i)) cur++;
      if (stat && cur - last < unit) {
        for (let y = last; y < cur; y++) for (let x = i; x < Math.min(w, i + unit); x++) map[y * w + x] = grids.length;
        grids.push({ bbox: [i, last, i + unit, cur] });
      }
      stat = !stat;
      last = cur;
    }
  }
  return { map, grids };
}

function buildGroups(map: Int32Array, w: number, h: number, grids: Grid[]): { gg: Int32Array; groups: GridGroup[] } {
  const reg = label({ w, h, d: Int32Array.from(map, (v) => v + 1) });
  const ids = new Map<number, Set<number>>();
  for (let i = 0; i < map.length; i++) {
    const r = reg.map.d[i];
    if (!r) continue;
    if (!ids.has(r)) ids.set(r, new Set());
    ids.get(r)!.add(map[i]);
  }
  let groups: GridGroup[] = [];
  for (let r = 1; r <= reg.n; r++) {
    const gids = [...ids.get(r)!].sort((a, b) => a - b);
    const l = grids[gids[0]].bbox;
    const rb = grids[gids[gids.length - 1]].bbox;
    groups.push({ id: 0, regId: r, gids, bbox: [Math.min(l[0], rb[0]), Math.min(l[1], rb[1]), Math.max(l[2], rb[2]), Math.max(l[3], rb[3])], split: l[2] - l[0] });
  }
  groups = sortedBy(groups, (g) => g.bbox[2] - g.bbox[0], true);
  const idOf = new Int32Array(reg.n + 1).fill(-1);
  groups.forEach((g, idx) => {
    g.id = idx;
    idOf[g.regId] = idx;
    g.regId = idx;
  });
  const gg = Int32Array.from(reg.map.d, (r) => (r ? idOf[r] : -1));
  return { gg, groups };
}

// numpy slice of rows/cols, negative starts counting from the end.
function slice(start: number, stop: number, len: number): [number, number] {
  const s = start < 0 ? Math.max(0, start + len) : Math.min(start, len);
  const e = stop < 0 ? Math.max(0, stop + len) : Math.min(stop, len);
  return [s, Math.max(s, e)];
}

function connect(gg: Int32Array, w: number, h: number, groups: GridGroup[], map: Int32Array, grids: Grid[], refCount = 8, maxStep = 20): Int32Array {
  const out = gg.slice();
  if (!groups.length) return out;
  let refGids = groups[0].gids.slice(0, refCount);
  let g = groups[0];
  const remaining = new PySet(groups.map((_, i) => i));
  while (remaining.size) {
    if (!remaining.has(g.id)) {
      g = groups[remaining.pop()];
      refGids = g.gids.slice(0, refCount);
    } else remaining.delete(g.id);
    if (refGids.length < 2) continue;
    const step = g.split;
    let centers = refGids.map((id) => yc(grids[id]));
    const xs = centers.map((_, i) => i * step);
    const a = slope(xs, centers);
    const b = mean(centers) - a * mean(xs);
    const ref = grids[refGids[0]].bbox;
    let endX = ref[0];
    const gh = ref[3] - ref[1];
    let cands: Box[] = [];
    for (let i = 0; i < maxStep; i++) {
      const cy = a * ((-i - 1) * step) + b;
      const y = Math.trunc(pyRound(cy - gh / 2));
      const [y0, y1] = slice(y, y + gh, h);
      const [x0, x1] = slice(endX - step, endX, w);
      const counts = new Map<number, number>();
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
        const v = out[yy * w + xx];
        counts.set(v, (counts.get(v) ?? 0) + 1);
      }
      const labels = [...counts.keys()].filter((v) => v !== -1);
      cands.push([endX - step, y, endX, y + gh]);
      if (!labels.length) {
        endX -= step;
        continue;
      }
      cands = cands.slice(0, -1);
      let lab: number;
      if (labels.length > 1) lab = sortedBy([...counts].sort((p, q) => p[0] - q[0]), (e) => e[1], true)[0][0];
      else lab = labels[0];
      // A -1 majority picks the last group, as numpy's negative index does.
      if (lab < 0) lab += groups.length;
      const tar = groups[lab]?.bbox;
      if (!tar || tar[2] > endX) break;
      // The grid of that group under the probe, by majority.
      const gc = new Map<number, number>();
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) if (out[yy * w + xx] === lab) gc.set(map[yy * w + xx], (gc.get(map[yy * w + xx]) ?? 0) + 1);
      let gid = -1;
      let best = -1;
      for (const [k, c] of [...gc].sort((p, q) => p[0] - q[0])) if (c > best) {
        best = c;
        gid = k;
      }
      if (gid < 0 || !grids[gid]) break;
      centers = [yc(grids[gid]), centers[0]];
      const ids: number[] = [];
      cands.forEach((box, bi) => {
        // interp1d between x = -i-1 and x = 0.
        const t = (-bi - 1 - (-i - 1)) / (0 - (-i - 1));
        const iy = pyRound(centers[0] + (centers[1] - centers[0]) * t - gh / 2);
        const nb: Box = [box[0], iy, box[2], iy + gh];
        ids.push(grids.length);
        g.gids.push(grids.length);
        g.bbox = [Math.min(g.bbox[0], nb[0]), Math.min(g.bbox[1], nb[1]), Math.max(g.bbox[2], nb[2]), Math.max(g.bbox[3], nb[3])].map(Math.trunc) as Box;
        grids.push({ bbox: nb });
        const [ya, yb] = slice(nb[1], nb[3], h);
        const [xa, xb] = slice(nb[0], nb[2], w);
        for (let yy = ya; yy < yb; yy++) for (let xx = xa; xx < xb; xx++) out[yy * w + xx] = g.id;
      });
      g = groups[lab];
      refGids = [...g.gids, ...ids.reverse()].slice(0, refCount);
      break;
    }
  }
  return out;
}

/** Source row for every output pixel (oemer's coords_y), or null when no staff line spans the page. */
export function estimateCoords(staff: Img): Float32Array | null {
  const { w, h } = staff;
  const pred = open(dilate(u8(staff), ones(6, 1)), ones(1, 6));
  const { map, grids } = buildGrid(pred);
  const { gg, groups } = buildGroups(map, w, h, grids);
  const conn = connect(gg, w, h, groups, map, grids);
  // Sampled rows: per wide region, its mean row and every tenth column's centre row.
  const reg = label({ w, h, d: Int32Array.from(conn, (v) => v + 1) });
  const stats = new Map<number, { sy: number; n: number; minX: number; maxX: number; cols: Map<number, [number, number]> }>();
  for (let i = 0; i < conn.length; i++) {
    const r = reg.map.d[i];
    if (!r) continue;
    const x = i % w;
    const y = (i - x) / w;
    let s = stats.get(r);
    if (!s) stats.set(r, (s = { sy: 0, n: 0, minX: x, maxX: x, cols: new Map() }));
    s.sy += y;
    s.n++;
    s.minX = Math.min(s.minX, x);
    s.maxX = Math.max(s.maxX, x);
    const c = s.cols.get(x) ?? [0, 0];
    c[0] += y;
    c[1]++;
    s.cols.set(x, c);
  }
  const rows: { y: number; xs: number[]; vs: number[] }[] = [];
  for (let r = 1; r <= reg.n; r++) {
    const s = stats.get(r)!;
    if (s.maxX - s.minX < w * 0.4) continue;
    const ty = pyRound(s.sy / s.n);
    const xs: number[] = [];
    const vs: number[] = [];
    [...s.cols.keys()].sort((p, q) => p - q).forEach((x, ii) => {
      if (ii % 10) return;
      const c = s.cols.get(x)!;
      xs.push(x);
      vs.push(pyRound(c[0] / c[1]));
    });
    if (ty > 0 && ty < h - 1) rows.push({ y: ty, xs, vs });
  }
  return coordsFromRows(rows, w, h);
}

/** A sampled line: the row it is straightened to, and its centre row at some columns. */
export interface SampledLine {
  y: number;
  xs: number[];
  vs: number[];
}

/** Source row for every output pixel, from lines sampled along the page. */
export function coordsFromRows(rows: SampledLine[], w: number, h: number): Float32Array | null {
  if (!rows.length) return null;
  rows.sort((p, q) => p.y - q.y);
  const coords = new Float32Array(w * h);
  // Past a line's ends its end value carries on, about what the triangulation gives.
  const at = (r: { xs: number[]; vs: number[] }, x: number): number | null => {
    const { xs, vs } = r;
    if (x <= xs[0]) return vs[0];
    if (x >= xs[xs.length - 1]) return vs[vs.length - 1];
    let k = 0;
    while (k + 1 < xs.length && xs[k + 1] < x) k++;
    if (xs[k] === x || k + 1 >= xs.length) return vs[k];
    return vs[k] + ((vs[k + 1] - vs[k]) * (x - xs[k])) / (xs[k + 1] - xs[k]);
  };
  // Columns past the sampled stretch fade to no shift at the page edge, as the triangulation does.
  const first = Math.min(...rows.map((r) => r.xs[0]));
  const last = Math.max(...rows.map((r) => r.xs[r.xs.length - 1]));
  const column = (x: number) => {
    const anchors: [number, number][] = [[0, 0]];
    for (const r of rows) anchors.push([r.y, at(r, x)! - r.y]);
    anchors.push([h - 1, 0]);
    const out = new Float64Array(h);
    let k = 0;
    for (let y = 0; y < h; y++) {
      while (k + 1 < anchors.length - 1 && anchors[k + 1][0] <= y) k++;
      const [y0, v0] = anchors[k];
      const [y1, v1] = anchors[k + 1];
      out[y] = y1 === y0 ? v0 : v0 + ((v1 - v0) * (y - y0)) / (y1 - y0);
    }
    return out;
  };
  const left = column(first);
  const right = column(last);
  for (let x = 0; x < w; x++) {
    let shift: Float64Array;
    let f = 1;
    if (x < first) {
      shift = left;
      f = first > 0 ? x / first : 1;
    } else if (x > last) {
      shift = right;
      f = last < w - 1 ? (w - 1 - x) / (w - 1 - last) : 1;
    } else shift = column(x);
    for (let y = 0; y < h; y++) coords[y * w + x] = y + shift[y] * f;
  }
  return coords;
}

function cubicWeights(t: number): [number, number, number, number] {
  const A = -0.75;
  const w0 = ((A * (t + 1) - 5 * A) * (t + 1) + 8 * A) * (t + 1) - 4 * A;
  const w1 = ((A + 2) * t - (A + 3)) * t * t + 1;
  const w2 = ((A + 2) * (1 - t) - (A + 3)) * (1 - t) * (1 - t) + 1;
  return [Math.fround(w0), Math.fround(w1), Math.fround(w2), Math.fround(1 - w0 - w1 - w2)];
}

/** cv2.remap(img, column index, coords, INTER_CUBIC): rows resampled, coordinates in 1/32 pixel steps. */
export function dewarp(a: Img, coords: Float32Array): Img {
  const { w, h } = a;
  const out = new Float32Array(w * h);
  const tab: [number, number, number, number][] = [];
  for (let k = 0; k < 32; k++) tab.push(cubicWeights(k / 32));
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const f = roundEven(coords[y * w + x] * 32);
      const iy = f >> 5;
      const wt = tab[f & 31];
      let s = 0;
      for (let k = 0; k < 4; k++) {
        const sy = iy - 1 + k;
        if (sy >= 0 && sy < h) s += wt[k] * a.d[sy * w + x];
      }
      out[y * w + x] = Math.fround(s);
    }
  return { w, h, d: out };
}
