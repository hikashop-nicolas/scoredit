import { looksLikeSheetMusic } from "./detect";

// A white picture with black rectangles drawn on it.
function page(w: number, h: number, rects: [number, number, number, number][]) {
  const data = new Uint8ClampedArray(w * h * 4).fill(255);
  for (const [x, y, rw, rh] of rects)
    for (let yy = y; yy < y + rh; yy++)
      for (let xx = x; xx < x + rw; xx++) data.fill(0, (yy * w + xx) * 4, (yy * w + xx) * 4 + 3);
  return { width: w, height: h, data, colorSpace: "srgb" } as ImageData;
}

const staff = (top: number) => Array.from({ length: 5 }, (_, i) => [40, top + i * 10, 720, 1] as [number, number, number, number]);
const noteheads = (top: number) => Array.from({ length: 24 }, (_, i) => [60 + i * 28, top + (i % 9) * 5 - 3, 9, 7] as [number, number, number, number]);

describe("looksLikeSheetMusic", () => {
  it("finds staves with notes on them", async () => {
    const r = await looksLikeSheetMusic(page(800, 600, [...staff(100), ...noteheads(100), ...staff(300), ...noteheads(300)]));
    expect(r.sheetMusic).toBe(true);
    expect(r.staves).toBe(2);
  });

  it("does not take lines of text for staves", async () => {
    // Rows of letter-sized blocks: tall strokes with gaps, evenly spaced like a staff.
    const text: [number, number, number, number][] = [];
    for (let row = 0; row < 20; row++) for (let i = 0; i < 60; i++) if (i % 7 !== 3) text.push([40 + i * 12, 60 + row * 24, 7, 12]);
    expect((await looksLikeSheetMusic(page(800, 600, text))).sheetMusic).toBe(false);
  });

  it("does not take a ruled table for staves", async () => {
    const rules = Array.from({ length: 14 }, (_, i) => [40, 60 + i * 30, 720, 1] as [number, number, number, number]);
    expect((await looksLikeSheetMusic(page(800, 600, rules))).sheetMusic).toBe(false);
  });
});
