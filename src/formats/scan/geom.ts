// Line and polygon routines from OpenCV that oemer relies on: probabilistic Hough lines,
// minimum-area rectangles, polygon filling and line drawing.
import { roundEven, type Box, type Img } from "./ndimage";

const f = Math.fround;

// cv::RNG, a multiply-with-carry generator seeded with all ones.
class CvRng {
  private lo = 0xffffffff;
  private hi = 0xffffffff;
  next(): number {
    // state = (uint32)state * 4164903690 + (state >> 32)
    const prod = BigInt(this.lo) * 4164903690n + BigInt(this.hi);
    this.lo = Number(prod & 0xffffffffn);
    this.hi = Number(prod >> 32n);
    return this.lo;
  }
  uniform(a: number, b: number): number {
    return a === b ? a : (this.next() % (b - a)) + a;
  }
}

/** cv2.HoughLinesP(img, 1, pi/180, threshold, minLineLength, maxLineGap) as x1, y1, x2, y2. */
export function houghLinesP(a: Img<Uint8Array>, threshold: number, lineLength: number, lineGap: number): [number, number, number, number][] {
  const { w: width, h: height } = a;
  const theta = f(Math.PI / 180);
  const numangle = roundEven(Math.PI / theta);
  const numrho = roundEven((width + height) * 2 + 1);
  const accum = new Int32Array(numangle * numrho);
  const mask = new Uint8Array(width * height);
  const tab = new Float32Array(numangle * 2);
  for (let n = 0; n < numangle; n++) {
    tab[n * 2] = Math.cos(n * theta);
    tab[n * 2 + 1] = Math.sin(n * theta);
  }
  const nz: number[] = [];
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (a.d[y * width + x]) {
        mask[y * width + x] = 1;
        nz.push(y * width + x);
      }
  const rhoOf = (x: number, y: number, n: number) => roundEven(f(f(x * tab[n * 2]) + f(y * tab[n * 2 + 1]))) + ((numrho - 1) >> 1);
  const rng = new CvRng();
  const lines: [number, number, number, number][] = [];
  const shift = 16;
  for (let count = nz.length; count > 0; count--) {
    const idx = rng.uniform(0, count);
    let maxVal = threshold - 1;
    let maxN = 0;
    const p = nz[idx];
    const j = p % width;
    const i = (p - j) / width;
    nz[idx] = nz[count - 1];
    if (!mask[i * width + j]) continue;
    for (let n = 0; n < numangle; n++) {
      const r = rhoOf(j, i, n);
      const val = ++accum[n * numrho + r];
      if (maxVal < val) {
        maxVal = val;
        maxN = n;
      }
    }
    if (maxVal < threshold) continue;
    const aa = -tab[maxN * 2 + 1];
    const bb = tab[maxN * 2];
    let x0 = j;
    let y0 = i;
    let dx0: number;
    let dy0: number;
    let xflag: boolean;
    if (Math.abs(aa) > Math.abs(bb)) {
      xflag = true;
      dx0 = aa > 0 ? 1 : -1;
      dy0 = roundEven(f((bb * (1 << shift)) / Math.abs(aa)));
      y0 = (y0 << shift) + (1 << (shift - 1));
    } else {
      xflag = false;
      dy0 = bb > 0 ? 1 : -1;
      dx0 = roundEven(f((aa * (1 << shift)) / Math.abs(bb)));
      x0 = (x0 << shift) + (1 << (shift - 1));
    }
    const end = [
      [0, 0],
      [0, 0],
    ];
    for (let k = 0; k < 2; k++) {
      let gap = 0;
      let x = x0;
      let y = y0;
      const dx = k ? -dx0 : dx0;
      const dy = k ? -dy0 : dy0;
      for (; ; x += dx, y += dy) {
        const j1 = xflag ? x : x >> shift;
        const i1 = xflag ? y >> shift : y;
        if (j1 < 0 || j1 >= width || i1 < 0 || i1 >= height) break;
        if (mask[i1 * width + j1]) {
          gap = 0;
          end[k][1] = i1;
          end[k][0] = j1;
        } else if (++gap > lineGap) break;
      }
    }
    const good = Math.abs(end[1][0] - end[0][0]) >= lineLength || Math.abs(end[1][1] - end[0][1]) >= lineLength;
    for (let k = 0; k < 2; k++) {
      let x = x0;
      let y = y0;
      const dx = k ? -dx0 : dx0;
      const dy = k ? -dy0 : dy0;
      for (; ; x += dx, y += dy) {
        const j1 = xflag ? x : x >> shift;
        const i1 = xflag ? y >> shift : y;
        if (mask[i1 * width + j1]) {
          if (good) for (let n = 0; n < numangle; n++) accum[n * numrho + rhoOf(j1, i1, n)]--;
          mask[i1 * width + j1] = 0;
        }
        if (i1 === end[k][1] && j1 === end[k][0]) break;
      }
    }
    if (good) lines.push([end[0][0], end[0][1], end[1][0], end[1][1]]);
  }
  return lines;
}

/** oemer's find_lines: Hough segments as (min x, min y, max x, max y). */
export function findLines(a: Img<Uint8Array>, minLen = 10, maxGap = 20): Box[] {
  return houghLinesP(a, 50, minLen, maxGap).map(([x1, y1, x2, y2]) => [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)]);
}

type Pt = [number, number];

function cross(o: Pt, a: Pt, b: Pt): number {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

/** Convex hull (monotone chain), counter-clockwise in image coordinates. */
export function hull(pts: Pt[]): Pt[] {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const lower: Pt[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: Pt[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

export interface RotRect {
  cx: number;
  cy: number;
  w: number;
  h: number;
  corners: Pt[];
}

/** Minimum-area enclosing rectangle of a point set (cv2.minAreaRect plus cv2.boxPoints). */
export function minAreaRect(pts: Pt[]): RotRect {
  const hp = hull(pts);
  if (hp.length === 1) return { cx: hp[0][0], cy: hp[0][1], w: 0, h: 0, corners: [hp[0], hp[0], hp[0], hp[0]] };
  let best: RotRect | null = null;
  let bestArea = Infinity;
  for (let i = 0; i < hp.length; i++) {
    const a = hp[i];
    const b = hp[(i + 1) % hp.length];
    let ux = b[0] - a[0];
    let uy = b[1] - a[1];
    const len = Math.hypot(ux, uy);
    if (!len) continue;
    ux /= len;
    uy /= len;
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const p of hp) {
      const u = p[0] * ux + p[1] * uy;
      const v = -p[0] * uy + p[1] * ux;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const area = (maxU - minU) * (maxV - minV);
    if (area < bestArea - 1e-9) {
      bestArea = area;
      const at = (u: number, v: number): Pt => [f(u * ux - v * uy), f(u * uy + v * ux)];
      const corners = [at(minU, maxV), at(minU, minV), at(maxU, minV), at(maxU, maxV)];
      const cu = (minU + maxU) / 2;
      const cv = (minV + maxV) / 2;
      best = { cx: cu * ux - cv * uy, cy: cu * uy + cv * ux, w: maxU - minU, h: maxV - minV, corners };
    }
    if (hp.length === 2) break;
  }
  return best!;
}

/** Shoelace area of a polygon (cv2.contourArea, unsigned). */
export function polygonArea(p: Pt[]): number {
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i];
    const b = p[(i + 1) % p.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(s) / 2;
}

/** cv2.line with LINE_8 (drawn left to right, as cv2's Line does). */
export function line8(x1: number, y1: number, x2: number, y2: number, visit: (x: number, y: number) => void): void {
  if (x1 > x2) [x1, y1, x2, y2] = [x2, y2, x1, y1];
  const adx = Math.abs(x2 - x1);
  const ady = Math.abs(y2 - y1);
  const sx = x2 >= x1 ? 1 : -1;
  const sy = y2 >= y1 ? 1 : -1;
  const yMajor = ady > adx;
  const D = yMajor ? ady : adx;
  const d = yMajor ? adx : ady;
  let err = D - 2 * d;
  let x = x1;
  let y = y1;
  for (let i = 0; i <= D; i++) {
    visit(x, y);
    const minor = err < 0;
    err += -2 * d + (minor ? 2 * D : 0);
    if (yMajor) {
      y += sy;
      if (minor) x += sx;
    } else {
      x += sx;
      if (minor) y += sy;
    }
  }
}

/** Pixels cv2.fillPoly paints for a convex polygon with integer vertices: outline plus scanlines. */
export function fillConvex(p: Pt[], w: number, h: number, visit: (x: number, y: number) => void): void {
  const seen = new Set<number>();
  const put = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const k = y * w + x;
    if (!seen.has(k)) {
      seen.add(k);
      visit(x, y);
    }
  };
  const edges: { y0: number; y1: number; x: number; dx: number }[] = [];
  for (let i = 0; i < p.length; i++) {
    const a = p[(i + p.length - 1) % p.length];
    const b = p[i];
    line8(a[0], a[1], b[0], b[1], put);
    if (a[1] === b[1]) continue;
    const dx = Math.trunc(((b[0] - a[0]) * 65536) / (b[1] - a[1]));
    if (a[1] < b[1]) edges.push({ y0: a[1], y1: b[1], x: a[0] * 65536, dx });
    else edges.push({ y0: b[1], y1: a[1], x: b[0] * 65536, dx });
  }
  if (edges.length < 2) return;
  const y0 = Math.min(...edges.map((e) => e.y0));
  const y1 = Math.min(Math.max(...edges.map((e) => e.y1)), h);
  for (let y = y0; y < y1; y++) {
    const xs = edges.filter((e) => e.y0 <= y && y < e.y1).map((e) => e.x + (y - e.y0) * e.dx);
    if (xs.length < 2 || y < 0) continue;
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = Math.floor((xs[k] + 32768) / 65536);
      const xb = Math.floor(xs[k + 1] / 65536);
      for (let x = Math.max(0, xa); x <= Math.min(w - 1, xb); x++) put(x, y);
    }
  }
}

/** Pixels of a one pixel wide line (the full-intensity part of an anti-aliased cv2.line). */
export function line(x1: number, y1: number, x2: number, y2: number, visit: (x: number, y: number) => void): void {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const n = Math.max(Math.abs(dx), Math.abs(dy));
  for (let i = 0; i <= n; i++) {
    const t = n ? i / n : 0;
    visit(Math.round(x1 + dx * t), Math.round(y1 + dy * t));
  }
}
