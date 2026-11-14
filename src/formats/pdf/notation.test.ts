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

  it("drops the note of a metronome mark and keeps the tempo", () => {
    const notes = [quarter(80, 120), quarter(120, 117.5), quarter(160, 115), quarter(195, 110)];
    const tempo: [MusicSymbol, PdfSegment] = [sym(0xe0a4, 80, 85), { x0: 85.6, y0: 67.5, x1: 85.6, y1: 84.5, width: 0.55 }];
    const p = page([sym(0xe050, 45, 115, 13), ...notes.map((n) => n[0]), tempo[0]], [...notes.map((n) => n[1]), tempo[1]]);
    p.texts = [{ str: "= 96", x: 90, y: 88, size: 10, font: "Serif", bold: false, italic: false, words: [{ str: "=", x: 90, x1: 95 }, { str: "96", x: 98, x1: 108 }] }];
    const m1 = readPage(p).systems[0].measures[0];
    expect(m1.events[0].map((e) => e.heads[0].pos)).toEqual([8, 7, 6, 4]);
    expect(m1.dirs.find((d) => d.metronome)?.metronome).toEqual({ unit: 1, dots: 0, perMinute: 96 });
  });

  it("detects PDFs by their magic", () => {
    expect(detectFormat(new TextEncoder().encode("%PDF-1.7\n%âã"))).toBe("pdf");
  });
});
