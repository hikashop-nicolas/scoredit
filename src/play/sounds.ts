// Recorded instrument sounds downloaded when a score needs them: a SoundFont per instrument
// (or per group of instruments sharing recordings) listed in an index.json, the layout of
// the scoredit-sounds repository. Files are kept in the browser's Cache Storage, so a sound
// downloaded once plays offline afterwards. The host decides whether a download may happen.

/** What a download request covers, for the host's question to the user. */
export interface SoundRequest {
  /** Instrument names, as the sound files call them. */
  names: string[];
  bytes: number;
  host: string;
}

/** A source of recorded instrument sounds. */
export interface SoundDownloads {
  /** SoundFont files covering these General MIDI programs (128 = drums), each file once. */
  fetch(programs: number[]): Promise<ArrayBuffer[]>;
}

export interface RemoteSoundsOptions {
  /** Folder URL holding index.json and the files, ending with "/". */
  base: string;
  /** Asked before anything not already kept is downloaded; false: play without it. */
  ask?(req: SoundRequest): Promise<boolean>;
  /** Cache Storage name (default "scoredit-sounds"); null: do not keep the files. */
  cacheName?: string | null;
}

/** scoredit-sounds v1 (MuseScore_General, MIT) on jsDelivr. */
export const SOUNDS_CDN = "https://cdn.jsdelivr.net/gh/hikashop-nicolas/scoredit-sounds@v1/gm/";

interface IndexEntry {
  name: string;
  file: string;
  bytes: number;
}

export function remoteSounds(opts: RemoteSoundsOptions): SoundDownloads {
  const cacheName = opts.cacheName === undefined ? "scoredit-sounds" : opts.cacheName;
  let index: Promise<Record<string, IndexEntry>> | null = null;
  const served = new Set<string>(); // files already handed to this page's player

  const open = async () => {
    try {
      return cacheName && typeof caches !== "undefined" ? await caches.open(cacheName) : null;
    } catch {
      return null;
    }
  };
  // From the cache when kept, else from the network (and kept).
  const get = async (url: string, keep: boolean): Promise<Response | null> => {
    const cache = await open();
    const hit = await cache?.match(url);
    if (hit) return hit;
    if (!keep) return null;
    const res = await fetch(url);
    if (!res.ok) return null;
    await cache?.put(url, res.clone()).catch(() => undefined);
    return res;
  };

  return {
    async fetch(programs) {
      index ??= get(opts.base + "index.json", true)
        .then((r) => (r ? r.json() : {}))
        .catch(() => ({}));
      const idx = await index;
      const entries = new Map<string, IndexEntry>();
      for (const p of programs) {
        const e = idx[p === 128 ? "drums" : String(p)];
        if (e && !served.has(e.file)) entries.set(e.file, e);
      }
      if (!entries.size) return [];
      // What is not kept yet needs a yes first.
      const cache = await open();
      const missing: IndexEntry[] = [];
      for (const e of entries.values()) if (!(await cache?.match(opts.base + e.file))) missing.push(e);
      let allowed = true;
      if (missing.length && opts.ask) {
        const names = [...new Set(programs.map((p) => idx[p === 128 ? "drums" : String(p)]?.name).filter((n): n is string => !!n))];
        allowed = await opts.ask({ names, bytes: missing.reduce((s, e) => s + e.bytes, 0), host: new URL(opts.base, location.href).host });
      }
      const out: ArrayBuffer[] = [];
      for (const e of entries.values()) {
        const res = await get(opts.base + e.file, allowed).catch(() => null);
        if (!res) continue;
        out.push(await res.arrayBuffer());
        served.add(e.file);
      }
      return out;
    },
  };
}
