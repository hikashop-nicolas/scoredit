// The OpenCV and scipy.ndimage operations oemer uses, on row-major single-channel images.

/** A single-channel image. */
export interface Img<T extends Float32Array | Int32Array | Uint8Array = Float32Array> {
  w: number;
  h: number;
  d: T;
}

export type Box = [number, number, number, number]; // x1, y1, x2, y2 (exclusive ends)

export const img = (w: number, h: number): Img => ({ w, h, d: new Float32Array(w * h) });

/** numpy's float to uint8 cast (truncation, wrapping), then >0 as 1 for morphology inputs. */
export function u8(a: Img): Img<Uint8Array> {
  const d = new Uint8Array(a.d.length);
  for (let i = 0; i < d.length; i++) d[i] = Math.trunc(a.d[i]) & 255;
  return { w: a.w, h: a.h, d };
}

export function toF(a: Img<Uint8Array | Int32Array>): Img {
  return { w: a.w, h: a.h, d: Float32Array.from(a.d) };
}

/** A structuring element as rows of 0/1, cv2.getStructuringElement style: size is (width, height). */
export interface Kernel {
  kw: number;
  kh: number;
  k: Uint8Array;
}

export function rectKernel(kw: number, kh: number): Kernel {
  return { kw, kh, k: new Uint8Array(kw * kh).fill(1) };
}

export function ellipseKernel(kw: number, kh: number): Kernel {
  if (kw === 1 && kh === 1) return rectKernel(1, 1);
  const k = new Uint8Array(kw * kh);
  const r = Math.floor(kh / 2);
  const c = Math.floor(kw / 2);
  const inv = r ? 1 / (r * r) : 0;
  for (let i = 0; i < kh; i++) {
    const dy = i - r;
    if (Math.abs(dy) > r) continue;
    const dx = roundEven(c * Math.sqrt((r * r - dy * dy) * inv));
    const j1 = Math.max(c - dx, 0);
    const j2 = Math.min(c + dx + 1, kw);
    for (let j = j1; j < j2; j++) k[i * kw + j] = 1;
  }
  return { kw, kh, k };
}

/** cvRound: nearest, halves to even. */
export function roundEven(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

// Grey erosion (min) or dilation (max) with the kernel anchored at its centre; outside pixels never win.
function morph(a: Img<Uint8Array>, ker: Kernel, dilate: boolean): Img<Uint8Array> {
  const { w, h } = a;
  const ax = Math.floor(ker.kw / 2);
  const ay = Math.floor(ker.kh / 2);
  // Each kernel row is a run [j1, j2); runs of equal span share one horizontal pass.
  const rows: { dy: number; j1: number; j2: number }[] = [];
  for (let i = 0; i < ker.kh; i++) {
    let j1 = -1;
    let j2 = -1;
    for (let j = 0; j < ker.kw; j++) {
      if (ker.k[i * ker.kw + j]) {
        if (j1 < 0) j1 = j;
        j2 = j + 1;
      }
    }
    if (j1 >= 0) {
      for (let j = j1; j < j2; j++) if (!ker.k[i * ker.kw + j]) throw new Error("non-convex kernel row");
      rows.push({ dy: i - ay, j1: j1 - ax, j2: j2 - ax });
    }
  }
  const pass = new Map<string, Uint8Array>();
  const horiz = (lo: number, hi: number) => {
    const key = lo + ":" + hi;
    let out = pass.get(key);
    if (out) return out;
    out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        let v = dilate ? 0 : 255;
        const s = Math.max(0, x + lo);
        const e = Math.min(w, x + hi);
        if (dilate) {
          for (let j = s; j < e; j++) if (a.d[row + j] > v) v = a.d[row + j];
        } else {
          for (let j = s; j < e; j++) if (a.d[row + j] < v) v = a.d[row + j];
        }
        out[row + x] = v;
      }
    }
    pass.set(key, out);
    return out;
  };
  const out = new Uint8Array(w * h).fill(dilate ? 0 : 255);
  for (const r of rows) {
    const hp = horiz(r.j1, r.j2);
    for (let y = 0; y < h; y++) {
      const sy = y + r.dy;
      if (sy < 0 || sy >= h) continue;
      const o = y * w;
      const s = sy * w;
      if (dilate) {
        for (let x = 0; x < w; x++) if (hp[s + x] > out[o + x]) out[o + x] = hp[s + x];
      } else {
        for (let x = 0; x < w; x++) if (hp[s + x] < out[o + x]) out[o + x] = hp[s + x];
      }
    }
  }
  return { w, h, d: out };
}

export const erode = (a: Img<Uint8Array>, k: Kernel) => morph(a, k, false);
export const dilate = (a: Img<Uint8Array>, k: Kernel) => morph(a, k, true);
/** numpy-shaped kernel (rows, cols) of ones, as in np.ones((rows, cols)). */
export const ones = (rows: number, cols: number) => rectKernel(cols, rows);
export const open = (a: Img<Uint8Array>, k: Kernel) => dilate(erode(a, k), k);
export const close = (a: Img<Uint8Array>, k: Kernel) => erode(dilate(a, k), k);

/** scipy.ndimage.label with the default cross: labels 1..n in raster order of first pixel. */
export function label(a: Img<Float32Array | Int32Array | Uint8Array>): { map: Img<Int32Array>; n: number } {
  const { w, h } = a;
  const lab = new Int32Array(w * h);
  const parent: number[] = [0];
  const find = (x: number) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!a.d[i]) continue;
      const l = x > 0 ? lab[i - 1] : 0;
      const u = y > 0 ? lab[i - w] : 0;
      if (!l && !u) {
        parent.push(parent.length);
        lab[i] = parent.length - 1;
      } else if (l && u) {
        const rl = find(l);
        const ru = find(u);
        if (rl !== ru) parent[Math.max(rl, ru)] = Math.min(rl, ru);
        lab[i] = Math.min(rl, ru);
      } else lab[i] = l || u;
    }
  }
  const final = new Int32Array(parent.length);
  let n = 0;
  for (let i = 0; i < lab.length; i++) {
    if (!lab[i]) continue;
    const r = find(lab[i]);
    if (!final[r]) final[r] = ++n;
    lab[i] = final[r];
  }
  return { map: { w, h, d: lab }, n };
}

/** 8-connected components of the non-zero pixels; and 4-connected holes. */
function components(a: Img<Uint8Array>, eight: boolean, fg: boolean): { lab: Int32Array; n: number } {
  const { w, h } = a;
  const lab = new Int32Array(w * h);
  let n = 0;
  const stack: number[] = [];
  for (let s = 0; s < w * h; s++) {
    if (lab[s] || (a.d[s] !== 0) !== fg) continue;
    lab[s] = ++n;
    stack.push(s);
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % w;
      const y = (p - x) / w;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          if (!eight && dx && dy) continue;
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const q = yy * w + xx;
          if (!lab[q] && (a.d[q] !== 0) === fg) {
            lab[q] = n;
            stack.push(q);
          }
        }
      }
    }
  }
  return { lab, n };
}

export interface Contour {
  box: Box;
  hole: boolean;
  // Raster position where cv2.findContours starts tracing it.
  start: number;
  // Pixels whose convex hull is the contour's (component pixels, or hole pixels grown by one).
  label: number;
}

/**
 * The contours cv2.findContours(RETR_TREE) finds: one per 8-connected component, one per
 * hole (4-connected background not touching the border), with their bounding boxes.
 */
export function contours(a: Img<Uint8Array>): { list: Contour[]; fg: Int32Array; bg: Int32Array } {
  const { w, h } = a;
  const fg = components(a, true, true);
  const bg = components(a, false, false);
  const boxes = new Map<string, { x1: number; y1: number; x2: number; y2: number; start: number }>();
  const touch = new Uint8Array(bg.n + 1);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const isFg = a.d[i] !== 0;
      const l = isFg ? fg.lab[i] : bg.lab[i];
      if (!isFg && (x === 0 || y === 0 || x === w - 1 || y === h - 1)) touch[l] = 1;
      const key = (isFg ? "f" : "b") + l;
      const b = boxes.get(key);
      if (!b) boxes.set(key, { x1: x, y1: y, x2: x, y2: y, start: isFg ? i : i - 1 });
      else {
        if (x < b.x1) b.x1 = x;
        if (x > b.x2) b.x2 = x;
        if (y > b.y2) b.y2 = y;
      }
    }
  }
  // cv2's RETR_TREE list: siblings latest-found first, each followed by its children.
  const kids = new Map<string, Contour[]>();
  for (const [key, b] of boxes) {
    const hole = key[0] === "b";
    const lab = Number(key.slice(1));
    if (hole && touch[lab]) continue;
    const box: Box = hole ? [b.x1 - 1, b.y1 - 1, b.x2 + 2, b.y2 + 2] : [b.x1, b.y1, b.x2 + 1, b.y2 + 1];
    // A hole belongs to the component left of its first pixel; a component to the hole left of its own.
    let parent = "root";
    if (hole) parent = "f" + fg.lab[b.start];
    else if (b.start % w > 0 && !touch[bg.lab[b.start - 1]]) parent = "b" + bg.lab[b.start - 1];
    const c = { box, hole, start: b.start, label: lab };
    kids.set(parent, [...(kids.get(parent) ?? []), c]);
  }
  const list: Contour[] = [];
  const walk = (key: string) => {
    const cs = (kids.get(key) ?? []).sort((p, q) => q.start - p.start);
    for (const c of cs) {
      list.push(c);
      walk((c.hole ? "b" : "f") + c.label);
    }
  };
  walk("root");
  return { list, fg: fg.lab, bg: bg.lab };
}

/** Bounding boxes of everything cv2.findContours(RETR_TREE) would trace (oemer's get_bbox). */
export function getBbox(a: Img<Uint8Array>): Box[] {
  return contours(a).list.map((c) => c.box);
}
