// Classic staff-line detection, no machine learning: it gives the pipeline the staff and
// symbol map that oemer's first network (unet_big) gave. Binarise (Sauvola), measure line
// thickness and spacing from vertical run lengths, find lines by horizontal projection in
// vertical strips, keep groups of five, follow each line across the page. The staff layer
// is each line drawn at its thickness; the symbol layer is the ink less the lines' own runs.
import type { SampledLine } from "./dewarp";
import { label } from "./ndimage";

export interface StaffLineInfo {
  /** Line thickness and distance between line centres, in pixels. */
  thickness: number;
  spacing: number;
  /** Per staff, five lines; each line as centre rows sampled at strip centres. */
  staffs: { xs: number[]; ys: number[][] }[];
  /** Every line over its whole extent, sampled every ten columns, for deskewing. */
  lines: SampledLine[];
}

/** Grey levels (0..255) from interleaved BGR. */
export function grey(bgr: Uint8Array, w: number, h: number): Uint8Array {
  const g = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = (bgr[i * 3] * 29 + bgr[i * 3 + 1] * 150 + bgr[i * 3 + 2] * 77) >> 8;
  return g;
}

/** Sauvola threshold with a square window: 1 for ink. */
export function sauvola(g: Uint8Array, w: number, h: number, win = 31, k = 0.2, R = 128): Uint8Array {
  const W = w + 1;
  const s1 = new Float64Array(W * (h + 1));
  const s2 = new Float64Array(W * (h + 1));
  for (let y = 0; y < h; y++) {
    let r1 = 0;
    let r2 = 0;
    for (let x = 0; x < w; x++) {
      const v = g[y * w + x];
      r1 += v;
      r2 += v * v;
      s1[(y + 1) * W + x + 1] = s1[y * W + x + 1] + r1;
      s2[(y + 1) * W + x + 1] = s2[y * W + x + 1] + r2;
    }
  }
  const out = new Uint8Array(w * h);
  const r = win >> 1;
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w, x + r + 1);
      const n = (y1 - y0) * (x1 - x0);
      const a = s1[y1 * W + x1] - s1[y0 * W + x1] - s1[y1 * W + x0] + s1[y0 * W + x0];
      const b = s2[y1 * W + x1] - s2[y0 * W + x1] - s2[y1 * W + x0] + s2[y0 * W + x0];
      const m = a / n;
      const sd = Math.sqrt(Math.max(0, b / n - m * m));
      out[y * w + x] = g[y * w + x] < m * (1 + k * (sd / R - 1)) ? 1 : 0;
    }
  }
  return out;
}

/**
 * Keeps only ink darker than a point between the ink's grey and the local paper's (f = 0.5:
 * halfway), so blurred edges do not fatten symbols and close the gap between two beams.
 * The ink's grey is the darkest within r pixels (r > 0), else the page's dark core.
 */
export function halfway(g: Uint8Array, ink: Uint8Array, w: number, h: number, f = 0.5, r = 0, win = 31): void {
  const hist = new Array<number>(256).fill(0);
  let n = 0;
  for (let i = 0; i < ink.length; i++) if (ink[i]) hist[g[i]]++, n++;
  let level = 0;
  // The ink's own grey: its dark core (scans blur a large share of it lighter).
  for (let acc = 0; level < 255 && (acc += hist[level]) < n * 0.1; level++);
  // With r: the darkest grey within r instead, so thin faint strokes keep their core.
  const core = r > 0 ? minFilter(g, w, h, r) : null;
  // Local paper grey: the mean of the pixels around that are not ink.
  const W = w + 1;
  const s = new Float64Array(W * (h + 1));
  const c = new Float64Array(W * (h + 1));
  for (let y = 0; y < h; y++) {
    let r = 0;
    let k = 0;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!ink[i]) (r += g[i]), k++;
      s[(y + 1) * W + x + 1] = s[y * W + x + 1] + r;
      c[(y + 1) * W + x + 1] = c[y * W + x + 1] + k;
    }
  }
  const rr = win >> 1;
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - rr);
    const y1 = Math.min(h, y + rr + 1);
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!ink[i]) continue;
      const x0 = Math.max(0, x - rr);
      const x1 = Math.min(w, x + rr + 1);
      const cnt = c[y1 * W + x1] - c[y0 * W + x1] - c[y1 * W + x0] + c[y0 * W + x0];
      const paper = cnt > 0 ? (s[y1 * W + x1] - s[y0 * W + x1] - s[y1 * W + x0] + s[y0 * W + x0]) / cnt : 255;
      const lv = core ? core[i] : level;
      if (g[i] > lv + f * (paper - lv)) ink[i] = 0;
    }
  }
}

/** Minimum over a (2r+1) square, separably. */
function minFilter(g: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const a = new Uint8Array(w * h);
  const b = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let m = 255;
      for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) m = Math.min(m, g[y * w + k]);
      a[y * w + x] = m;
    }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let m = 255;
      for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) m = Math.min(m, a[k * w + x]);
      b[y * w + x] = m;
    }
  return b;
}

const mode = (hist: number[], from = 1) => {
  let best = from;
  for (let i = from; i < hist.length; i++) if (hist[i] > hist[best]) best = i;
  return best;
};

/**
 * Spacing: the most common ink run plus the gap after it, down the columns (staff lines
 * repeat at that pitch). Thickness: the most common ink run among those pairs, so specks of
 * noise do not count.
 */
export function runLengths(ink: Uint8Array, w: number, h: number): { thickness: number; spacing: number } {
  const pairs: [number, number][] = [];
  const pair = new Array<number>(128).fill(0);
  for (let x = 0; x < w; x += 2) {
    let y = 0;
    let lastBlack = -1;
    while (y < h) {
      const v = ink[y * w + x];
      let n = 0;
      while (y < h && ink[y * w + x] === v) {
        y++;
        n++;
      }
      if (v) lastBlack = n;
      else if (lastBlack > 0 && y < h && n + lastBlack < 128) {
        pair[n + lastBlack]++;
        pairs.push([lastBlack, n]);
      }
    }
  }
  const spacing = mode(pair, 4);
  const black = new Array<number>(64).fill(0);
  for (const [b, g] of pairs) if (Math.abs(b + g - spacing) <= 1 && b < 64) black[b]++;
  return { thickness: mode(black), spacing };
}

interface Peak {
  y: number; // centre row
  ink: number; // strongest row's ink count
}

// Line candidates in one strip: rows whose ink count passes the threshold, merged into centres.
function stripPeaks(ink: Uint8Array, w: number, h: number, x0: number, x1: number, th: number, maxRows: number): Peak[] {
  const peaks: Peak[] = [];
  let start = -1;
  let sum = 0;
  let wsum = 0;
  let top = 0;
  for (let y = 0; y <= h; y++) {
    let c = 0;
    if (y < h) for (let x = x0; x < x1; x++) c += ink[y * w + x];
    if (y < h && c >= th) {
      if (start < 0) start = y;
      sum += c;
      wsum += c * y;
      top = Math.max(top, c);
    } else if (start >= 0) {
      // Taller than a line (a beam, a slur along the strip) is not a staff line.
      if (y - start <= maxRows) peaks.push({ y: wsum / sum, ink: top });
      start = -1;
      sum = 0;
      wsum = 0;
      top = 0;
    }
  }
  return peaks;
}

// Groups of five evenly spaced peaks, as five centres each. A longer run (ledger lines)
// keeps the five with the most ink, staff lines being longer than ledger lines.
function fives(peaks: Peak[], d: number): number[][] {
  const out: number[][] = [];
  const tol = Math.max(2, d * 0.25);
  let i = 0;
  while (i < peaks.length) {
    const run = [peaks[i]];
    let j = i + 1;
    while (j < peaks.length) {
      const gap = peaks[j].y - run[run.length - 1].y;
      if (Math.abs(gap - d) <= tol) run.push(peaks[j]);
      else if (gap > d + tol) break;
      j++;
    }
    if (run.length >= 5) {
      let best = 0;
      let bs = -1;
      for (let k = 0; k + 5 <= run.length; k++) {
        const sc = run.slice(k, k + 5).reduce((a, p) => a + p.ink, 0);
        if (sc > bs) {
          bs = sc;
          best = k;
        }
      }
      out.push(run.slice(best, best + 5).map((p) => p.y));
      i = j;
    } else i++;
  }
  return out;
}

/** Finds the staffs: five lines each, sampled at strip centres and followed from strip to strip. */
export function findStaffLines(ink: Uint8Array, w: number, h: number): StaffLineInfo {
  const { thickness, spacing } = runLengths(ink, w, h);
  const d = spacing;
  const sw = Math.max(32, Math.round(d * 4));
  const strips: { cx: number; groups: number[][] }[] = [];
  for (let x0 = 0; x0 < w; x0 += sw) {
    const x1 = Math.min(w, x0 + sw);
    if (x1 - x0 < sw / 2) break;
    const peaks = stripPeaks(ink, w, h, x0, x1, (x1 - x0) * 0.5, Math.max(2 * thickness + 1, thickness + 3));
    strips.push({ cx: (x0 + x1 - 1) / 2, groups: fives(peaks, d) });
  }
  // Chains of groups across neighbouring strips, matched on the middle line.
  type Chain = { xs: number[]; ys: number[][] };
  const chains: Chain[] = [];
  strips.forEach((s) => {
    const used = new Set<Chain>();
    for (const g of s.groups) {
      let best: Chain | null = null;
      // Under a space: a group one line off (a ledger line taken in) starts its own chain.
      let bd = d * 0.6;
      for (const c of chains) {
        if (used.has(c)) continue;
        // Predicted from the chain's slope so far, across strips where the staff went unseen.
        const n = c.xs.length;
        const k = Math.max(0, n - 6);
        const sl = n > 1 ? (c.ys[n - 1][2] - c.ys[k][2]) / (c.xs[n - 1] - c.xs[k]) : 0;
        const dy = Math.abs(c.ys[n - 1][2] + sl * (s.cx - c.xs[n - 1]) - g[2]);
        if (dy < bd) {
          bd = dy;
          best = c;
        }
      }
      if (best) {
        best.xs.push(s.cx);
        best.ys.push(g);
        used.add(best);
      } else chains.push({ xs: [s.cx], ys: [g] });
    }
  });
  // Longest chains first: one on the same staff merges in, one overlapping it is a false group.
  const kept: Chain[] = [];
  for (const c of [...chains].sort((a, b) => b.xs.length - a.xs.length)) {
    let drop = false;
    for (const k of kept) {
      const lo = Math.max(c.xs[0], k.xs[0]);
      const hi = Math.min(c.xs[c.xs.length - 1], k.xs[k.xs.length - 1]);
      // Apart along the page: compare both, carried along their slopes, halfway across the gap.
      const x = (lo + hi) / 2;
      const dy = Math.abs(midRow(c, x) - midRow(k, x));
      if (dy < d / 2) {
        c.xs.forEach((cx, i) => {
          if (k.xs.includes(cx)) return;
          const at = k.xs.findIndex((v) => v > cx);
          const pos = at < 0 ? k.xs.length : at;
          k.xs.splice(pos, 0, cx);
          k.ys.splice(pos, 0, c.ys[i]);
        });
        drop = true;
        break;
      }
      if (dy < d * 4.5 && lo <= hi) {
        drop = true;
        break;
      }
    }
    if (!drop) kept.push(c);
  }
  const staffs = kept
    .filter((c) => c.xs.length >= 3)
    .map((c) => ({ xs: c.xs, ys: [0, 1, 2, 3, 4].map((k) => c.ys.map((g) => g[k])) }))
    .sort((a, b) => a.ys[2][0] - b.ys[2][0]);
  return { thickness, spacing, staffs, lines: [] };
}

/** Middle line of a chain at column x, carried past its ends along the slope of the last samples. */
function midRow(c: { xs: number[]; ys: number[][] }, x: number): number {
  const n = c.xs.length;
  const ys = c.ys.map((g) => g[2]);
  if (n < 2 || (x >= c.xs[0] && x <= c.xs[n - 1])) return rowAt(c.xs, ys, x);
  const [i0, i1] = x < c.xs[0] ? [0, Math.min(n - 1, 5)] : [Math.max(0, n - 6), n - 1];
  const sl = (ys[i1] - ys[i0]) / (c.xs[i1] - c.xs[i0]);
  const e = x < c.xs[0] ? 0 : n - 1;
  return ys[e] + sl * (x - c.xs[e]);
}

/** Row of a sampled line at column x: linear between samples, flat past the ends. */
function rowAt(xs: number[], ys: number[], x: number): number {
  if (x <= xs[0]) return ys[0];
  if (x >= xs[xs.length - 1]) return ys[ys.length - 1];
  let k = 0;
  while (xs[k + 1] < x) k++;
  return ys[k] + ((ys[k + 1] - ys[k]) * (x - xs[k])) / (xs[k + 1] - xs[k]);
}

/**
 * The map oemer's unet_big gives (0 background, 1 staff line, 2 symbol) for an interleaved
 * BGR page at the size the pipeline works at, plus 3 (staff and symbol) where a symbol
 * crosses a line: the line stays whole for the staff layer, the symbol whole for the other.
 */
export function classicStaffMap(
  bgr: Uint8Array,
  w: number,
  h: number,
  opts: { k?: number; lineK?: number; minArea?: number; mid?: number; midR?: number; keepSmall?: number } = {},
): { map: Uint8Array; info: StaffLineInfo } {
  // Faint lines need a lower threshold than symbols, which then pick up less noise.
  const g = grey(bgr, w, h);
  const ink = sauvola(g, w, h, 31, opts.lineK ?? 0.1);
  const inkS = sauvola(g, w, h, 31, opts.k ?? 0.2);
  const info = findStaffLines(ink, w, h);
  const { thickness: t, spacing: d } = info;
  // Symbols trimmed to their dark core (mid 0 keeps Sauvola's), as unet_big draws them.
  const mid = opts.mid ?? 0.4;
  if (mid > 0) {
    const ks = opts.keepSmall ?? 1;
    const before = ks ? inkS.slice() : null;
    halfway(g, inkS, w, h, mid, opts.midR ?? 2);
    // Blobs under a space squared (dots) stay whole: trimmed, they fall under oemer's dot area.
    if (before) {
      const lab = label({ w, h, d: before });
      const area = new Int32Array(lab.n + 1);
      for (let i = 0; i < before.length; i++) area[lab.map.d[i]]++;
      const max = d * d * ks;
      for (let i = 0; i < before.length; i++) if (before[i] && area[lab.map.d[i]] <= max) inkS[i] = 1;
    }
  }
  const map = new Uint8Array(w * h);
  for (let i = 0; i < map.length; i++) map[i] = inkS[i] ? 2 : 0;
  const maxRun = t + 2;
  const reach = Math.max(3, t + 1);
  const below = Math.floor((t - 1) / 2);
  // Ink within reach of row y in column x.
  const near = (x: number, y: number) => {
    const yc = Math.round(y);
    for (let dy = -reach; dy <= reach; dy++) if (yc + dy >= 0 && yc + dy < h && ink[(yc + dy) * w + x]) return true;
    return false;
  };
  for (const st of info.staffs) {
    const n = st.xs.length;
    // Slope at each end, to carry the lines a little past the outer samples.
    const end = (i0: number, i1: number) => st.ys.map((l) => (l[i1] - l[i0]) / (st.xs[i1] - st.xs[i0] || 1));
    const sl0 = end(0, Math.min(n - 1, 2));
    const sl1 = end(Math.max(0, n - 3), n - 1);
    const rows = (x: number) =>
      st.ys.map((l, k) => (x < st.xs[0] ? l[0] + sl0[k] * (x - st.xs[0]) : x > st.xs[n - 1] ? l[n - 1] + sl1[k] * (x - st.xs[n - 1]) : rowAt(st.xs, l, x)));
    // The staff's extent: out from the samples while three lines or more have ink, gaps under a space.
    const extent = (from: number, dir: number) => {
      let last = from;
      for (let x = from; x >= 0 && x < w && Math.abs(x - last) <= d; x += dir) if (rows(x).filter((y) => near(x, y)).length >= 3) last = x;
      return last;
    };
    const xa = extent(Math.round(st.xs[0]), -1);
    const xb = extent(Math.round(st.xs[n - 1]), 1);
    for (let k = 0; k < 5; k++) {
      const xs: number[] = [];
      const vs: number[] = [];
      for (let x = xa; x <= xb; x += 10) {
        xs.push(x);
        vs.push(rows(x)[k]);
      }
      info.lines.push({ y: Math.round(vs.reduce((a, v) => a + v, 0) / vs.length), xs, vs });
    }
    for (let x = xa; x <= xb; x++) {
      for (const y of rows(x)) {
        // The line as unet_big draws it: a band of the line's thickness, under symbols too.
        const y0 = Math.round(y) - below;
        for (let yy = Math.max(0, y0); yy < Math.min(h, y0 + t); yy++) map[yy * w + x] |= 1;
        // Ink of the line itself (a short run at the line) is staff, not symbol.
        const yc = Math.round(y);
        for (let dy = -reach; dy <= reach; dy++) {
          const yy = yc + dy;
          if (yy < 0 || yy >= h || !ink[yy * w + x]) continue;
          let top = yy;
          let bot = yy;
          while (top > 0 && ink[(top - 1) * w + x]) top--;
          while (bot < h - 1 && ink[(bot + 1) * w + x]) bot++;
          if (bot - top + 1 <= maxRun) for (let r = top; r <= bot; r++) map[r * w + x] = 1;
          dy = bot - yc;
        }
      }
    }
  }
  // Specks of noise are not symbols.
  const minArea = opts.minArea ?? Math.max(4, t * t);
  const sym = label({ w, h, d: Uint8Array.from(map, (v) => (v & 2 ? 1 : 0)) });
  const area = new Int32Array(sym.n + 1);
  for (let i = 0; i < map.length; i++) area[sym.map.d[i]]++;
  for (let i = 0; i < map.length; i++) if (map[i] & 2 && area[sym.map.d[i]] < minArea) map[i] &= 1;
  return { map, info };
}
