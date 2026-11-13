// Reading one page on the current thread: image to class maps (onnxruntime-web, loaded on
// first use) to MusicXML. index.ts adds the worker path on top.
import { segment, type OrtLike, type OrtSession, type TileProgress } from "./infer";
import { layersOf, recognise } from "./pipeline";
import { modelSize, resizeBicubic } from "./resample";
import type { SampledLine } from "./dewarp";
import { classicStaffMap } from "./stafflines";
import { classifiers, type ClassifiersJson } from "./svm";

export type { OrtLike, TileProgress };

/** A model file: its URL, its bytes, or a function fetching them. */
export type ModelSource = string | URL | ArrayBuffer | Uint8Array | (() => Promise<ArrayBuffer | Uint8Array>);

export interface ScanModels {
  /** oemer's seg_net network (stems and rests, noteheads, clefs and accidentals), ONNX. */
  symbols: ModelSource;
  /** oemer's four SVM classifiers as JSON (clef, rests, rests_above8, sfn). */
  classifiers: ModelSource;
  /**
   * oemer's unet_big network (staff lines and symbols), ONNX: only used with
   * staffLines: "unet", for comparison. By default staff lines are found without a network.
   */
  staff?: ModelSource;
}

export interface ScanOptions {
  models: ScanModels;
  /** The onnxruntime module to use (default: onnxruntime-web, imported on first use). */
  ort?: OrtLike;
  /** Options for InferenceSession.create, e.g. { executionProviders: ["webgpu", "wasm"] }. */
  session?: Record<string, unknown>;
  /** Where onnxruntime-web finds its .wasm files (its env.wasm.wasmPaths), when the bundler does not serve them. */
  wasmPaths?: string;
  /** onnxruntime-web CPU threads (needs a cross-origin isolated page for more than 1). */
  threads?: number;
  /** Tiles per network run (default 1). */
  batch?: number;
  /** Distance between tiles in pixels (oemer: 128; larger is faster, a little less sure). */
  step?: number;
  /** Progress: network tiles ("symbols", "staff"), then "lines" and "post" (post-processing) as 0 or 1 of 1. */
  progress?: (p: TileProgress) => void;
  /**
   * Run the whole scan in a module worker, off the main thread: true for scoredit's own
   * scan-worker.js next to this module (bundlers that follow new URL(..., import.meta.url)),
   * a URL of it, or a function making the Worker (e.g. Vite's "scoredit/scan-worker?worker").
   * The worker imports onnxruntime-web itself: `ort` is not used then.
   */
  worker?: true | string | URL | (() => Worker);
  /** Stops the scan; with a worker, the worker is terminated. */
  signal?: AbortSignal;
  /** "classic" (default): staff lines found by projection, no network; "unet": oemer's unet_big (needs models.staff). */
  staffLines?: "classic" | "unet";
  /** Straighten the page along its staff lines first (default: on with unet_big, as oemer; off with classic, which follows skew itself and reads better without). */
  deskew?: boolean;
  title?: string;
}

export interface ScanResult {
  xml: string;
  /** Places where oemer itself would have stopped with an error; the port carried on. */
  issues: string[];
}

/** The onnxruntime-web version the scan runs on, for a host serving its wasm files (e.g. from a CDN). */
export async function scanEngineVersion(): Promise<string> {
  const ort = await import("onnxruntime-web");
  return ort.env.versions.web;
}

export async function bytesOf(src: ModelSource): Promise<Uint8Array> {
  if (typeof src === "function") src = await src();
  if (src instanceof Uint8Array) return src;
  if (src instanceof ArrayBuffer) return new Uint8Array(src);
  const res = await fetch(src);
  if (!res.ok) throw new Error(`model download failed: ${res.status} ${String(src)}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Interleaved BGR at the size oemer's networks expect, the alpha composed over white. */
async function prepare(image: ImageData | Blob): Promise<{ bgr: Uint8Array; w: number; h: number }> {
  let data: ImageData;
  if (typeof Blob !== "undefined" && image instanceof Blob) {
    const bmp = await createImageBitmap(image);
    const canvas = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, bmp.width, bmp.height);
    ctx.drawImage(bmp, 0, 0);
    data = ctx.getImageData(0, 0, bmp.width, bmp.height);
  } else data = image as ImageData;
  const { width: w, height: h } = data;
  const src = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    const a = data.data[i * 4 + 3] / 255;
    for (let c = 0; c < 3; c++) src[i * 3 + 2 - c] = Math.round(data.data[i * 4 + c] * a + 255 * (1 - a));
  }
  const [tw, th] = modelSize(w, h);
  return { bgr: resizeBicubic(src, w, h, 3, tw, th), w: tw, h: th };
}

let ortModule: Promise<OrtLike> | null = null;
const loadOrt = () => (ortModule ??= import("onnxruntime-web") as unknown as Promise<OrtLike>);

/** Class maps for a prepared BGR image: staff/symbol (classic or unet_big) and seg_net's. */
export async function classMaps(bgr: Uint8Array, w: number, h: number, opts: ScanOptions) {
  const ort = opts.ort ?? (await loadOrt());
  if (ort.env?.wasm) {
    if (opts.wasmPaths) ort.env.wasm.wasmPaths = opts.wasmPaths;
    if (opts.threads) ort.env.wasm.numThreads = opts.threads;
  }
  const run = async (src: ModelSource, win: number, classes: number, name: string) => {
    const session: OrtSession = await ort.InferenceSession.create(await bytesOf(src), opts.session);
    try {
      return await segment(ort, session, bgr, w, h, win, classes, { batch: opts.batch, step: opts.step, name, progress: opts.progress });
    } finally {
      await session.release?.();
    }
  };
  let unet: Uint8Array;
  let lines: SampledLine[] | undefined;
  if (opts.staffLines === "unet") {
    if (!opts.models.staff) throw new Error('staffLines "unet" needs models.staff');
    unet = await run(opts.models.staff, 256, 3, "staff");
  } else {
    opts.progress?.({ model: "lines", done: 0, total: 1 });
    const c = classicStaffMap(bgr, w, h);
    unet = c.map;
    lines = c.info.lines;
    opts.progress?.({ model: "lines", done: 1, total: 1 });
  }
  opts.signal?.throwIfAborted();
  const seg = await run(opts.models.symbols, 288, 4, "symbols");
  return { w, h, unet, seg, lines };
}

/** Reads one page on this thread (the scan worker runs this). */
export async function scanInThread(image: ImageData | Blob, opts: ScanOptions): Promise<ScanResult> {
  const cls = classifiers(JSON.parse(new TextDecoder().decode(await bytesOf(opts.models.classifiers))) as ClassifiersJson);
  const { bgr, w, h } = await prepare(image);
  const maps = await classMaps(bgr, w, h, opts);
  opts.progress?.({ model: "post", done: 0, total: 1 });
  const r = recognise(layersOf(maps, opts.deskew ?? opts.staffLines === "unet"), cls, opts.title);
  opts.progress?.({ model: "post", done: 1, total: 1 });
  return { xml: r.xml, issues: r.issues };
}
