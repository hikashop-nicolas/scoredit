// Module worker entry: reads one page off the main thread (networks and post-processing).
// The page posts a ScanRequest; the worker posts progress, then the result or the error.
import type { ScanReply, ScanRequest } from "./index";
import { scanInThread } from "./read";

/** Runs one request, posting replies through `post`. */
export async function handleScan(req: ScanRequest, post: (r: ScanReply) => void): Promise<void> {
  try {
    const result = await scanInThread(req.image, { ...req.opts, progress: (progress) => post({ type: "progress", progress }) });
    post({ type: "done", result });
  } catch (e) {
    post({ type: "error", message: e instanceof Error ? e.message : String(e) });
  }
}

const scope = globalThis as unknown as { WorkerGlobalScope?: unknown; postMessage(m: unknown): void; onmessage: unknown };
if (typeof scope.WorkerGlobalScope !== "undefined") scope.onmessage = (e: MessageEvent<ScanRequest>) => handleScan(e.data, (r) => scope.postMessage(r));
