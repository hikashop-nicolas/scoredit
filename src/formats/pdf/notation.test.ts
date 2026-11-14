// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { detectFormat } from "../detect";
import type { PdfSegment, PdfShape } from "./extract";
import type { MusicSymbol, NormPage } from "./normalize";
import { readPage } from "./notation";

// One treble staff, top line at y 100, space 5, from x 40 to 400, barlines at 220 and 400.
function page(symbols: MusicSymbol[], extra: PdfSegment[] = [], shapes: PdfShape[] = []): NormPage {
  const lines = [0, 1, 2, 3, 4].map((i) => ({ x0: 40, y0: 100 + 5 * i, x1: 400, y1: 100 + 5 * i, width: 0.5 }));
  const bars = [220, 400].map((x) => ({ x0: x, y0: 100, x1: x, y1: 120, width: 0.9 }));
  return { width: 595, height: 842, symbols, texts: [], segments: [...lines, ...bars, ...extra], shapes, images: 0, unknownFonts: [], unmapped: {} } as NormPage;
}
const sym = (cp: number, x: number, y: number, w = 5.9): MusicSymbol => ({ cp, x, y, size: 20, w });
// A black notehead with its stem up.
const quarter = (x: number, y: number): [MusicSymbol, PdfSegment] => [sym(0xe0a4, x, y), { x0: x + 5.6, y0: y - 17.5, x1: x + 5.6, y1: y - 0.5, width: 0.55 }];

describe("notation", () => {
  it("reads clef, time signature, pitches and durations", () => {
    const notes = [quarter(80, 120), quarter(120, 117.5), quarter(160, 115), quarter(195, 110)];
    const e1 = quarter(240, 115);
    const e2 = quarter(265, 112.5);
    // Two eighths: a beam over the stem tops.
    const beam: PdfShape = {
      points: [
        [245.6, 97.5],
        [270.6, 95],
        [270.6, 97.5],
        [245.6, 100],
        [245.6, 97.5],
      ],
      box: { x0: 245.6, y0: 95, x1: 270.6, y1: 100 },
      filled: true,
      stroked: false,
      curved: false,
      width: 0,
    };
    // A dotted half note.
    const half: MusicSymbol[] = [sym(0xe0a3, 300, 120), sym(0xe1e7, 309, 117.5, 2)];
    const halfStem: PdfSegment = { x0: 305.6, y0: 102.5, x1: 305.6, y1: 119.5, width: 0.55 };
    const p = page(
      [sym(0xe050, 45, 115, 13), sym(0xe084, 62, 105, 7), sym(0xe084, 62, 115, 7), ...notes.map((n) => n[0]), e1[0], e2[0], ...half],
      [...notes.map((n) => n[1]), e1[1], e2[1], halfStem],
      [beam],
    );
    const { systems } = readPage(p);
    expect(systems).toHaveLength(1);
    const [m1, m2] = systems[0].measures;
    expect(m1.attrs[0].map((a) => a.clef?.sign ?? a.time?.beats)).toEqual(["G", 4]);
    expect(m1.events[0].map((e) => [e.heads[0].pos, e.base])).toEqual([
      [8, 1],
      [7, 1],
      [6, 1],
      [4, 1],
    ]);
    expect(m2.events[0].map((e) => [e.base, e.dots])).toEqual([
      [0.5, 0],
      [0.5, 0],
      [2, 1],
    ]);
  });

  it("tells two voices apart by stems in one column", () => {
    const up = quarter(80, 105);
    const down: [MusicSymbol, PdfSegment] = [sym(0xe0a4, 80, 115), { x0: 80.3, y0: 115.5, x1: 80.3, y1: 132.5, width: 0.55 }];
    const { systems } = readPage(page([sym(0xe050, 45, 115, 13), up[0], down[0]], [up[1], down[1]]));
    expect(systems[0].measures[0].events[0].map((e) => e.voice).sort()).toEqual([1, 2]);
  });

  it("reads a multi-measure rest: a thick bar on the middle line and its number", () => {
    const notes = [quarter(80, 120), quarter(120, 117.5), quarter(160, 115), quarter(195, 110)];
    const bar: PdfSegment = { x0: 240, y0: 110, x1: 380, y1: 110, width: 3.5 };
    const serifs: PdfSegment[] = [240, 380].map((x) => ({ x0: x, y0: 105, x1: x, y1: 115, width: 1 }));
    const p = page([sym(0xe050, 45, 115, 13), ...notes.map((n) => n[0]), sym(0xe081, 302, 92.5, 5.5), sym(0xe082, 308, 92.5, 5.5)], [...notes.map((n) => n[1]), bar, ...serifs]);
    const [m1, m2] = readPage(p).systems[0].measures;
    expect(m1.multiRest).toBeUndefined();
    expect(m2.multiRest).toBe(12);
    expect(m2.events[0].map((e) => e.rest && e.measureRest)).toEqual([true]);
  });

  it("drops the note of a metronome mark and keeps the tempo", () => {
    const notes = [quarter(80, 120), quarter(120, 117.5), quarter(160, 115), quarter(195, 110)];
    const tempo: [MusicSymbol, PdfSegment] = [sym(0xe0a4, 80, 85), { x0: 85.6, y0: 67.5, x1: 85.6, y1: 84.5, width: 0.55 }];
    const p = page([sym(0xe050, 45, 115, 13), ...notes.map((n) => n[0]), tempo[0]], [...notes.map((n) => n[1]), tempo[1]]);
    p.texts = [{ str: "= 96", x: 90, y: 88, size: 10, font: "Serif", bold: false, italic: false, words: [{ str: "=", x: 90, x1: 95 }, { str: "96", x: 98, x1: 108 }] }];
    const m1 = readPage(p).systems[0].measures[0];
    expect(m1.events[0].map((e) => e.heads[0].pos)).toEqual([8, 7, 6, 4]);
    expect(m1.dirs.find((d) => d.metronome)?.metronome).toEqual({ unit: 1, dots: 0, perMinute: 96 });
  });

  it("keeps a beam drawn across a grand staff in one staff's voice", () => {
    // Treble lines 100-120, bass lines 150-170, braced, barlines at 220 and 400.
    const lines = [100, 150].flatMap((top) => [0, 1, 2, 3, 4].map((i) => ({ x0: 40, y0: top + 5 * i, x1: 400, y1: top + 5 * i, width: 0.5 })));
    const bars = [220, 400].map((x) => ({ x0: x, y0: 100, x1: x, y1: 170, width: 0.9 }));
    const up = (x: number, y: number): [MusicSymbol, PdfSegment] => [sym(0xe0a4, x, y), { x0: x + 5.6, y0: 133, x1: x + 5.6, y1: y - 0.5, width: 0.55 }];
    const down = (x: number, y: number): [MusicSymbol, PdfSegment] => [sym(0xe0a4, x, y), { x0: x + 0.3, y0: y + 0.5, x1: x + 0.3, y1: 135.5, width: 0.55 }];
    const notes = [up(80, 165), up(100, 160), down(120, 115), down(140, 110)];
    const beam: PdfShape = {
      points: [
        [85.6, 133],
        [140.3, 133],
        [140.3, 135.5],
        [85.6, 135.5],
        [85.6, 133],
      ],
      box: { x0: 85.6, y0: 133, x1: 140.3, y1: 135.5 },
      filled: true,
      stroked: false,
      curved: false,
      width: 0,
    };
    const p = page([{ cp: 0xe000, x: 30, y: 170, size: 70, w: 6 }, sym(0xe050, 45, 115, 13), sym(0xe062, 45, 155, 13), ...notes.map((n) => n[0]), sym(0xe0a2, 78, 172.5, 8)], [...notes.map((n) => n[1])], [beam]);
    p.segments = [...lines, ...bars, ...notes.map((n) => n[1])];
    const sys = readPage(p).systems[0];
    expect(sys.groups).toEqual([[0, 1]]);
    const m = sys.measures[0];
    expect(m.events[0].map((e) => e.heads.map((h) => h.staff))).toEqual([[1], [1], [0], [0]]);
    expect(m.events[0].every((e) => e.voice === m.events[0][0].voice && e.base === 0.5)).toBe(true);
    expect(m.events[1].map((e) => e.base)).toEqual([4]);
  });

  describe("tablature tunings", () => {
    // A tablature of n lines (top at 100, space 6), a TAB clef, fret numbers and extra texts.
    const tabPage = (n: number, texts: [string, number, number][]) => {
      const lines = Array.from({ length: n }, (_, i) => ({ x0: 40, y0: 100 + 6 * i, x1: 400, y1: 100 + 6 * i, width: 0.5 }));
      const bars = [220, 400].map((x) => ({ x0: x, y0: 100, x1: x, y1: 100 + 6 * (n - 1), width: 0.9 }));
      const run = (str: string, x: number, y: number, size = 9) => ({ str, x, y, size, font: "Sans", bold: false, italic: false, words: [{ str, x, x1: x + 5 * str.length }] });
      const frets = [0, 2, 3].map((f, i) => run(String(f), 80 + 40 * i, 100 + 6 * (n - 1) + 9 * 0.35));
      return { width: 595, height: 842, symbols: [{ cp: 0xe06d, x: 45, y: 100 + 3 * (n - 1), size: 24, w: 9 }], texts: [...frets, ...texts.map(([s, x, y]) => run(s, x, y))], segments: [...lines, ...bars], shapes: [], images: 0, unknownFonts: [], unmapped: {} } as NormPage;
    };
    const tuningOf = (p: NormPage) => readPage(p).systems[0].staves[0].tuning;

    it("reads note names at the left of the lines", () => {
      const names = ["E", "B", "G", "D", "A", "D"].map((s, i): [string, number, number] => [s, 30, 100 + 6 * i + 3.15]);
      expect(tuningOf(tabPage(6, names))).toEqual([64, 59, 55, 50, 45, 38]);
    });

    it("reads a tuning text above the first system", () => {
      expect(tuningOf(tabPage(6, [["Tuning: D A D G A D", 60, 60]]))).toEqual([62, 57, 55, 50, 45, 38]);
      expect(tuningOf(tabPage(6, [["6 = D 5 = G", 60, 60]]))).toEqual([64, 59, 55, 50, 43, 38]);
    });

    it("reads bass and seven-string tablatures", () => {
      expect(readPage(tabPage(5, [])).systems[0].staves[0].tab).toBe(true);
      expect(tuningOf(tabPage(4, [["4 = D", 60, 60]]))).toEqual([43, 38, 33, 26]);
      expect(tuningOf(tabPage(7, [["7 = A", 60, 60]]))).toEqual([64, 59, 55, 50, 45, 40, 33]);
    });
  });

  it("detects PDFs by their magic", () => {
    expect(detectFormat(new TextEncoder().encode("%PDF-1.7\n%âã"))).toBe("pdf");
  });
});
