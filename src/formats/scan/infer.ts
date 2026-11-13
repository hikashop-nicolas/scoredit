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

/**
 * Per-pixel class (argmax of the averaged softmax) for an interleaved 3-channel image.
 * `win` is the model's window, `classes` its output channels.
 */
export async function segment(
  ort: OrtLike,
  session: OrtSession,
  img: Uint8Array,
  w: number,
  h: number,
  win: number,
  classes: number,
  opts: { step?: number; batch?: number; name?: string; progress?: (p: TileProgress) => void } = {},
): Promise<Uint8Array> {
  const step = opts.step ?? 128;
  const batch = opts.batch ?? 1;
  const ys = origins(h, win, step);
  const xs = origins(w, win, step);
  const tiles: [number, number][] = [];
  for (const y of ys) for (const x of xs) tiles.push([y, x]);
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
