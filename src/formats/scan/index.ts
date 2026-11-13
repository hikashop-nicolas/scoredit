// Scanned or photographed sheet music to MusicXML: a TypeScript port of oemer
// (https://github.com/BreezeWhite/oemer, MIT). Staff lines are found without machine
// learning; the host supplies oemer's symbol network and classifiers, nothing of them ships
// with scoredit. Runs on the calling thread, or in a module worker (scan-worker.ts).
import type { TileProgress } from "./infer";
import { bytesOf, scanInThread, type ModelSource, type ScanModels, type ScanOptions, type ScanResult } from "./read";

export type { OrtLike, TileProgress } from "./infer";
export { classMaps } from "./read";
export type { ModelSource, ScanModels, ScanOptions, ScanResult };

/** Reads one page of printed music from a scan or photo into MusicXML text. */
export async function scanToMusicXml(image: ImageData | Blob, opts: ScanOptions): Promise<ScanResult> {
  return opts.worker ? inWorker(image, opts) : scanInThread(image, opts);
}

/** What the page posts to the scan worker: the options less what cannot be cloned. */
export interface ScanRequest {
  image: ImageData | Blob;
  opts: Omit<ScanOptions, "ort" | "progress" | "worker" | "signal" | "models"> & { models: { [K in keyof ScanModels]: ScanModels[K] & (string | Uint8Array) } };
}

/** What the scan worker posts back. */
export type ScanReply = { type: "progress"; progress: TileProgress } | { type: "done"; result: ScanResult } | { type: "error"; message: string };

// Models go as absolute URLs (the worker fetches them) or as bytes; fetch functions run here.
async function cloneable(src: ModelSource): Promise<string | Uint8Array> {
  if (typeof src === "string" || src instanceof URL) return new URL(src, typeof location === "undefined" ? undefined : location.href).href;
  return bytesOf(src);
}

async function inWorker(image: ImageData | Blob, opts: ScanOptions): Promise<ScanResult> {
  const { ort: _o, progress, worker: spec, signal, models, ...rest } = opts;
  signal?.throwIfAborted();
  const m: ScanRequest["opts"]["models"] = { symbols: await cloneable(models.symbols), classifiers: await cloneable(models.classifiers) };
  if (models.staff) m.staff = await cloneable(models.staff);
  // Written out whole so that bundlers (Vite, webpack 5) see the worker and emit it.
  const worker =
    typeof spec === "function" ? spec() : spec === true ? new Worker(new URL("./scan-worker.js", import.meta.url), { type: "module" }) : new Worker(spec!, { type: "module" });
  const req: ScanRequest = { image, opts: { ...rest, models: m } };
  try {
    return await new Promise<ScanResult>((resolve, reject) => {
      const abort = () => reject(signal!.reason);
      signal?.addEventListener("abort", abort, { once: true });
      worker.onmessage = (e: MessageEvent<ScanReply>) => {
        const r = e.data;
        if (r.type === "progress") progress?.(r.progress);
        else {
          signal?.removeEventListener("abort", abort);
          if (r.type === "done") resolve(r.result);
          else reject(new Error(r.message));
        }
      };
      worker.onerror = (e) => reject(new Error(e.message || "scan worker failed to load"));
      worker.postMessage(req);
    });
  } finally {
    worker.terminate();
  }
}

/** Reads one page of printed music from a scan or photo into a MusicXML document. */
export async function readScanScore(image: ImageData | Blob, opts: ScanOptions): Promise<Document> {
  const { xml } = await scanToMusicXml(image, opts);
  return new DOMParser().parseFromString(xml, "application/xml");
}
