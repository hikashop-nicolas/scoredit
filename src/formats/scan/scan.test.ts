// The Python, numpy, scipy, sklearn, OpenCV and Pillow behaviours the oemer port copies,
// checked against values those libraries gave for the same inputs.
import { describe, expect, it } from "vitest";
import { fillConvex, houghLinesP } from "./geom";
import { getBbox, type Img } from "./ndimage";
import { resizeBicubic } from "./resample";
import { findPeaks, uniqueSet, wardLabels } from "./sci";
import { classicStaffMap } from "./stafflines";
import { scanToMusicXml, type ScanReply, type ScanRequest } from "./index";
import { segment, staffStrips, staffTiles, type OrtLike } from "./infer";
import { handleScan } from "./scan-worker";

const grid = (w: number, h: number, on: (x: number, y: number) => boolean): Img<Uint8Array> => {
  const d = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d[y * w + x] = on(x, y) ? 1 : 0;
  return { w, h, d };
};
const inside = (x: number, y: number, x0: number, x1: number, y0: number, y1: number) => x >= x0 && x < x1 && y >= y0 && y < y1;

describe("scan port primitives", () => {
  it("iterates and pops sets in CPython's order", () => {
    const cases: [number[], number[], number][] = [
      [[0, 17, 10], [17, 10], 17],
      [[0, 9, 20, 12], [9, 12, 20], 9],
      [[-1, 0, 3, 8, 16, 24, 33], [33, 3, 8, 16, 24, -1], 33],
      [[-1, 2, 5, 8, 11, 14, 17, 20, 23, 26, 29, 32, 35, 38], [32, 2, 35, 5, 38, 8, 11, 14, 17, 20, 23, 26, 29, -1], 32],
      [[0, 1000, 37, 512, 8, 64], [64, 512, 37, 8, 1000], 64],
    ];
    for (const [input, order, pop] of cases) {
      expect([...uniqueSet(input, 0)]).toEqual(order);
      expect(uniqueSet(input, 0).pop()).toBe(pop);
    }
  });

  it("finds peaks as scipy does", () => {
    const x = [0, 1, 3, 3, 2, 5, 9, 9, 9, 4, 1, 0, 6, 2, 8, 8, 1, 0, 0, 7, 0];
    expect(findPeaks(x, 2, 3, 1)).toEqual([2, 7, 14, 19]);
  });

  it("labels ward clusters as sklearn does", () => {
    const pts: [number, number][] = [
      [7.6, 6.0], [9.3, 11.3], [13.4, 10.3], [8.3, 7.6], [12.2, 14.9], [10.8, 6.3], [37.1, 16.8], [40.6, 6.8],
      [39.7, 8.5], [38.1, 10.5], [37.9, 13.7], [39.8, 10.2], [13.2, 52.5], [7.1, 49.2], [9.1, 49.5], [8.1, 50.1],
      [11.9, 49.1], [8.9, 48.8], [56.7, 55.9], [60.7, 56.7], [63.5, 62.1], [54.0, 60.8], [56.7, 60.1], [60.1, 54.0],
    ];
    expect(wardLabels(pts, 15)).toEqual([1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 2, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3]);
  });

  it("resizes as Pillow's bicubic resize does", () => {
    const src = Uint8Array.from({ length: 13 * 9 }, (_, i) => (i * 37) % 256);
    expect([...resizeBicubic(src, 9, 13, 1, 4, 7)]).toEqual([
      69, 144, 125, 72, 147, 96, 114, 148, 108, 152, 131, 99, 150, 106, 138, 169, 125, 171, 136, 121, 108, 127, 139, 111, 139, 136, 83, 123,
    ]);
  });

  it("lists contour boxes in cv2.findContours(RETR_TREE) order", () => {
    const m = grid(40, 40, (x, y) => {
      if (inside(x, y, 2, 13, 2, 13)) return !inside(x, y, 5, 9, 5, 9);
      if (inside(x, y, 20, 31, 5, 31)) return !inside(x, y, 23, 28, 8, 28) || inside(x, y, 24, 26, 12, 15);
      return inside(x, y, 3, 30, 33, 36);
    });
    expect(getBbox(m)).toEqual([
      [3, 33, 30, 36], [20, 5, 31, 31], [22, 7, 29, 29], [24, 12, 26, 15], [2, 2, 13, 13], [4, 4, 10, 10],
    ]);
  });

  it("finds the segments cv2.HoughLinesP finds", () => {
    const m = grid(80, 60, (x, y) => (y === 5 && x >= 5 && x < 70) || (x === 10 && y >= 5 && y < 50) || (x >= 40 && x < 70 && y === 90 - x));
    expect(houghLinesP(m, 20, 10, 5)).toEqual([
      [5, 5, 69, 5], [10, 49, 10, 6], [40, 50, 64, 26],
    ]);
  });

  it("fills a polygon as cv2.fillPoly does", () => {
    const px: number[] = [];
    fillConvex([[31, 59], [66, 55], [67, 65], [32, 69]], 100, 100, (x, y) => px.push(y * 100 + x));
    px.sort((a, b) => a - b);
    expect(px.length).toBe(400);
    expect(px[0]).toBe(55 * 100 + 62);
    expect(px[px.length - 1]).toBe(69 * 100 + 36);
  });
});

describe("classic staff lines", () => {
  // Two five-line staffs, a little skewed, with a filled notehead and a stem on the first.
  const w = 600;
  const h = 300;
  const bgr = new Uint8Array(w * h * 3).fill(235);
  const ink = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    bgr.fill(20, (y * w + x) * 3, (y * w + x) * 3 + 3);
  };
  for (const top of [60, 180])
    for (let k = 0; k < 5; k++)
      for (let x = 40; x < 560; x++) {
        const y = Math.round(top + k * 14 + x * 0.02);
        ink(x, y);
        ink(x, y + 1);
      }
  for (let y = -6; y <= 6; y++) for (let x = -8; x <= 8; x++) if ((x * x) / 64 + (y * y) / 36 <= 1) ink(300 + x, 94 + y);
  for (let y = 50; y < 94; y++) ink(307, y);

  it("finds both staffs, their thickness and spacing", () => {
    const { map, info } = classicStaffMap(bgr, w, h);
    expect(info.staffs.length).toBe(2);
    expect(info.thickness).toBe(2);
    expect(info.spacing).toBe(14);
    expect(info.lines.length).toBe(10);
    // A bare stretch of line is staff only; the notehead is symbol; a line under it is both.
    expect(map[Math.round(60 + 100 * 0.02) * w + 100] & 3).toBe(1);
    expect(map[94 * w + 296] & 2).toBe(2);
    expect(map[Math.round(60 + 28 + 300 * 0.02) * w + 300]).toBe(3);
  });
});

describe("staff tiles", () => {
  // A grand staff (two close staffs) and a lone staff far below, on a 1600 x 2300 page.
  const staffs = [
    { x0: 150, x1: 1450, top: 300, bot: 352 },
    { x0: 150, x1: 1450, top: 420, bot: 472 },
    { x0: 150, x1: 1450, top: 1200, bot: 1252 },
  ];

  it("covers each band of staffs with one row of tiles and skips the rest", () => {
    const t = staffTiles(staffs, 13, 1600, 2300, 288);
    const rows = [...new Set(t.map(([y]) => y))].sort((a, b) => a - b);
    expect(rows.length).toBe(2);
    for (const s of staffs) expect(rows.some((y) => y <= s.top - 52 && y + 288 >= s.bot + 52)).toBe(true);
    const xs = t.filter(([y]) => y === rows[0]).map(([, x]) => x);
    expect(Math.min(...xs)).toBeLessThanOrEqual(150 - 26);
    expect(Math.max(...xs) + 288).toBeGreaterThanOrEqual(1450 + 26);
    expect(t.length).toBeLessThan(2 * 7);
  });

  it("covers each band of staffs with one strip, sized in multiples of 16", () => {
    const t = staffStrips(staffs, 13, 1600, 2300);
    const rows = [...new Set(t.map(([y]) => y))];
    expect(rows.length).toBe(2);
    for (const [y, x, th = 0, tw = 0] of t) {
      expect(th % 16).toBe(0);
      expect(tw % 16).toBe(0);
      expect(tw).toBeLessThanOrEqual(640);
      expect(y >= 0 && x >= 0 && y + th <= 2300 && x + tw <= 1600).toBe(true);
    }
    for (const s of staffs) expect(t.some(([y, , th = 0]) => y <= s.top - 52 && y + th >= s.bot + 52)).toBe(true);
    const first = t.filter(([y]) => y === Math.min(...rows));
    expect(Math.min(...first.map(([, x]) => x))).toBeLessThanOrEqual(150 - 26);
    expect(Math.max(...first.map(([, x, , tw = 0]) => x + tw))).toBeGreaterThanOrEqual(1450 + 26);
  });

  it("leaves pixels outside the tiles as background", async () => {
    // A fake network that calls every pixel a notehead.
    const ort = { InferenceSession: { create: async () => session }, Tensor: class { constructor(public type: string, public data: Uint8Array, public dims: number[]) {} } };
    const session = {
      inputNames: ["input"],
      outputNames: ["output"],
      run: async (f: Record<string, { dims: number[] }>) => {
        const [b, th, tw] = f.input.dims;
        const out = new Float32Array(b * th * tw * 4);
        for (let p = 0; p < b * th * tw; p++) out[p * 4 + 2] = 1;
        return { output: { data: out, dims: [b, th, tw, 4] } };
      },
    };
    const w = 600, h = 700;
    const map = await segment(ort as unknown as OrtLike, session, new Uint8Array(w * h * 3), w, h, 288, 4, { tiles: [[100, 0]] });
    expect(map[150 * w + 10]).toBe(2);
    expect(map[50 * w + 10]).toBe(0);
    expect(map[150 * w + 400]).toBe(0);
    const strip = await segment(ort as unknown as OrtLike, session, new Uint8Array(w * h * 3), w, h, 288, 4, { tiles: [[100, 0, 64, 512]] });
    expect(strip[150 * w + 500]).toBe(2);
    expect(strip[170 * w + 10]).toBe(0);
  });
});

describe("scan worker", () => {
  // Stands in for a module worker: the same handler, with the message cloned as postMessage would.
  class FakeWorker {
    onmessage: ((e: { data: ScanReply }) => void) | null = null;
    onerror: ((e: { message: string }) => void) | null = null;
    terminated = false;
    postMessage(req: ScanRequest) {
      void handleScan(structuredClone(req), (r) => this.onmessage?.({ data: r }));
    }
    terminate() {
      this.terminated = true;
    }
  }
  const image = { width: 4, height: 4, data: new Uint8ClampedArray(64).fill(255) } as unknown as ImageData;

  it("posts the request, relays the worker's error and terminates it", async () => {
    const fake = new FakeWorker();
    const run = scanToMusicXml(image, {
      models: { symbols: new Uint8Array(4), classifiers: async () => new TextEncoder().encode("not json") },
      worker: () => fake as unknown as Worker,
    });
    await expect(run).rejects.toThrow(/JSON/);
    expect(fake.terminated).toBe(true);
  });

  it("does not start when already aborted", async () => {
    const ac = new AbortController();
    ac.abort(new Error("stopped"));
    const run = scanToMusicXml(image, { models: { symbols: "a", classifiers: "b" }, worker: () => new FakeWorker() as unknown as Worker, signal: ac.signal });
    await expect(run).rejects.toThrow("stopped");
  });
});
