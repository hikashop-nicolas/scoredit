import { describe, expect, it } from "vitest";
import type { PdfSegment, PdfShape } from "./extract";
import { beamY, findBarlines, findBeams, findStaves, findSystems, horizontals, mergeVerticals, verticals, type VLine } from "./geometry";

const h = (y: number, x0: number, x1: number, width = 0.5): PdfSegment => ({ x0, y0: y, x1, y1: y, width });
const v = (x: number, y0: number, y1: number, width = 0.9): PdfSegment => ({ x0: x, y0, x1: x, y1, width });
// Five lines from top, drawn in measure pieces.
const staff = (top: number, sp: number, pieces: [number, number][]) => pieces.flatMap(([a, b]) => [0, 1, 2, 3, 4].map((i) => h(top + i * sp, a, b)));

describe("staves", () => {
  it("joins the pieces of a staff drawn measure by measure", () => {
    const segs = staff(100, 5, [
      [40, 120],
      [120, 200],
      [200, 300],
    ]);
    const st = findStaves(horizontals(segs));
    expect(st).toHaveLength(1);
    expect(st[0]).toMatchObject({ top: 100, bottom: 120, space: 5, x0: 40, x1: 300, lines: 5 });
  });

  it("tells two staves on the same x apart, and ignores ledger lines", () => {
    const segs = [...staff(100, 5, [[40, 300]]), ...staff(150, 5, [[40, 300]]), h(130, 80, 90, 0.8), h(135, 80, 90, 0.8)];
    const st = findStaves(horizontals(segs));
    expect(st.map((s) => s.top)).toEqual([100, 150]);
  });

  it("finds six-line tablature staves", () => {
    const segs = [0, 1, 2, 3, 4, 5].map((i) => h(200 + i * 6, 40, 300));
    expect(findStaves(horizontals(segs))[0]).toMatchObject({ lines: 6, space: 6 });
  });
});

describe("systems and barlines", () => {
  const segs = [...staff(100, 5, [[40, 300]]), ...staff(150, 5, [[40, 300]]), ...staff(300, 5, [[40, 300]])];
  const staves = findStaves(horizontals(segs));

  it("ties staves by their left barline, drawn in pieces", () => {
    const vl = mergeVerticals(verticals([v(40, 100, 120), v(40, 120, 150), v(40, 150, 170)]));
    expect(vl).toHaveLength(1);
    expect(findSystems(staves, vl, [])).toEqual([[0, 1], [2]]);
  });

  it("ties staves by a brace", () => {
    expect(findSystems(staves, [], [{ cp: 0xe000, x: 34, y: 170, size: 70, w: 4 }])).toEqual([[0, 1], [2]]);
  });

  it("finds barlines, groups double and final ones and skips stems", () => {
    const lines: VLine[] = mergeVerticals(
      verticals([v(120, 100, 120), v(120, 150, 170), v(200, 100, 120), v(203, 100, 120, 2.7), v(250, 102, 120, 0.5), v(296, 100, 120), v(299, 100, 120, 2.7)]),
    );
    const isStem = (l: VLine) => l.x === 250;
    const bars = findBarlines(staves, [0, 1], lines, isStem);
    expect(bars.map((b) => [Math.round(b.x0), b.kinds.join("-"), b.staves.join(",")])).toEqual([
      [120, "thin", "0,1"],
      [200, "thin-thick", "0"],
      [296, "thin-thick", "0"],
    ]);
  });
});

describe("beams", () => {
  const quad = (x0: number, y0: number, x1: number, y1: number, t: number): PdfShape => {
    const points: [number, number][] = [
      [x0, y0],
      [x1, y1],
      [x1, y1 + t],
      [x0, y0 + t],
      [x0, y0],
    ];
    return { points, box: { x0, y0: Math.min(y0, y1), x1, y1: Math.max(y0, y1) + t }, filled: true, stroked: false, curved: false, width: 0 };
  };

  it("reads slanted filled quadrilaterals half a space thick", () => {
    const b = findBeams([quad(100, 50, 140, 46, 2.5), quad(0, 0, 595, 842, 842)], [], 5);
    expect(b).toHaveLength(1);
    expect(beamY(b[0], 120)).toBeCloseTo(49.25);
  });

  it("reads thick segments as beams", () => {
    expect(findBeams([], [{ x0: 10, y0: 20, x1: 30, y1: 22, width: 2.4 }], 5)).toHaveLength(1);
  });
});
