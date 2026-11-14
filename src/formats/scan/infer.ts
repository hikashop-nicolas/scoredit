// Runs oemer's two segmentation networks over a page, tile by tile, as oemer's inference.py
// does: 256 or 288 pixel windows every 128 pixels, predictions averaged, then argmax.

/** The part of onnxruntime's API the reader uses (onnxruntime-web or onnxruntime-node). */
export interface OrtLike {
  InferenceSession: { create(model: Uint8Array, opts?: Record<string, unknown>): Promise<OrtSession> };
  Tensor: new (type: "uint8", data: Uint8Array, dims: number[]) => unknown;
  env?: { wasm?: { wasmPaths?: unknown; numThreads?: number } };
}

export interface OrtSession {
  inputNames: readonly string[];
  outputNames: readonly string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: unknown; dims: readonly number[] }>>;
  release?(): Promise<void>;
}

export interface TileProgress {
  model: string;
  done: number;
  total: number;
}

/** Tile origins along one axis, oemer's way (the last ones clamp, so some repeat). */
function origins(size: number, win: number, step: number): number[] {
  const out: number[] = [];
  for (let v = 0; v < size; v += step) out.push(v + win > size ? size - win : v);
  return out;
}

/** Origins of `win` windows covering [lo, hi) at most `stride` apart, kept inside [0, size). */
function spread(lo: number, hi: number, size: number, win: number, stride: number): number[] {
  lo = Math.max(0, Math.floor(lo));
  hi = Math.min(size, Math.ceil(hi));
  const clamp = (v: number) => Math.min(Math.max(0, v), size - win);
  if (hi - lo <= win) return [clamp(Math.floor((lo + hi) / 2) - (win >> 1))];
  const n = Math.ceil((hi - lo - win) / stride) + 1;
  return Array.from({ length: n }, (_, i) => clamp(Math.round(lo + (i * (hi - lo - win)) / (n - 1))));
}

/** A staff as the tiler needs it: its x extent and the rows of its top and bottom lines. */
export interface StaffBox {
  x0: number;
  x1: number;
  top: number;
  bot: number;
}

/**
 * Tile origins [y, x] covering only the staffs, `margin` line spacings above and below each
 * (ledger lines, clefs), staffs whose bands touch sharing rows. Most pages need half the tiles.
 */
export function staffTiles(staffs: StaffBox[], spacing: number, w: number, h: number, win: number, margin = 4, overlap = 32): [number, number][] {
  const m = margin * spacing;
  const bands = staffs.map((s) => [s.top - m, s.bot + m, s.x0 - 2 * spacing, s.x1 + 2 * spacing]).sort((a, b) => a[0] - b[0]);
  const merged: number[][] = [];
  for (const b of bands) {
    const c = merged[merged.length - 1];
    if (c && b[0] <= c[1]) {
      c[1] = Math.max(c[1], b[1]);
      c[2] = Math.min(c[2], b[2]);
      c[3] = Math.max(c[3], b[3]);
    } else merged.push([...b]);
  }
  const out: [number, number][] = [];
  for (const [y0, y1, x0, x1] of merged)
    for (const y of spread(y0, y1, h, win, win - overlap)) for (const x of spread(x0, x1, w, win, win - overlap)) out.push([y, x]);
  return out;
}

/**
 * Per-pixel class (argmax of the averaged softmax) for an interleaved 3-channel image.
 * `win` is the model's window, `classes` its output channels. With `tiles`, only those
 * windows run and pixels outside them are background (class 0).
 */
export async function segment(
  ort: OrtLike,
  session: OrtSession,
  img: Uint8Array,
  w: number,
  h: number,
  win: number,
  classes: number,
  opts: { step?: number; batch?: number; name?: string; tiles?: [number, number][]; progress?: (p: TileProgress) => void } = {},
): Promise<Uint8Array> {
  const step = opts.step ?? 128;
  const batch = opts.batch ?? 1;
  let tiles: [number, number][] = [];
  if (opts.tiles) tiles = opts.tiles;
  else for (const y of origins(h, win, step)) for (const x of origins(w, win, step)) tiles.push([y, x]);
  // Repeated windows are run once and added as many times as they occur.
  const uniq = new Map<string, { y: number; x: number; n: number }>();
  for (const [y, x] of tiles) {
    const k = y + "," + x;
    const u = uniq.get(k);
    if (u) u.n++;
    else uniq.set(k, { y, x, n: 1 });
  }
  const todo = [...uniq.values()];
  const sum = new Float32Array(w * h * classes);
  const cnt = new Uint8Array(w * h);
  const inName = session.inputNames[0];
  const outName = session.outputNames[0];
  opts.progress?.({ model: opts.name ?? "", done: 0, total: todo.length });
  for (let i = 0; i < todo.length; i += batch) {
    const part = todo.slice(i, i + batch);
    const data = new Uint8Array(part.length * win * win * 3);
    part.forEach((t, b) => {
      for (let r = 0; r < win; r++) {
        const src = ((t.y + r) * w + t.x) * 3;
        data.set(img.subarray(src, src + win * 3), (b * win + r) * win * 3);
      }
    });
    const res = await session.run({ [inName]: new ort.Tensor("uint8", data, [part.length, win, win, 3]) });
    const out = res[outName].data as Float32Array;
    part.forEach((t, b) => {
      for (let r = 0; r < win; r++) {
        const row = t.y + r;
        for (let c = 0; c < win; c++) {
          const p = row * w + t.x + c;
          const o = ((b * win + r) * win + c) * classes;
          for (let k = 0; k < classes; k++) sum[p * classes + k] += out[o + k] * t.n;
          cnt[p] += t.n;
        }
      }
    });
    opts.progress?.({ model: opts.name ?? "", done: Math.min(i + batch, todo.length), total: todo.length });
  }
  const map = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) {
    if (!cnt[p]) continue;
    let best = 0;
    let bv = -Infinity;
    for (let k = 0; k < classes; k++) {
      const v = Math.fround(sum[p * classes + k] / cnt[p]);
      if (v > bv) {
        bv = v;
        best = k;
      }
    }
    map[p] = best;
  }
  return map;
}
