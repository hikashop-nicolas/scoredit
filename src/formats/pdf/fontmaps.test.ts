import { describe, expect, it } from "vitest";
import { EMMENTALER, emmentalerName, isEmmentaler } from "./emmentaler";
import type { PdfGlyph, PdfPage, PdfShape } from "./extract";
import { lines, normalizePage } from "./normalize";
import { DROP, smufl } from "./smufl";
import { SONATA, SONATA_SPECIAL, SONATA_TEXT, sonataKind, sonataMapper } from "./sonata";

const glyph = (font: string, unicode: string, x = 0): PdfGlyph => ({ code: 1, unicode, font, fontId: font, x, y: 100, size: 20, advance: 6 });
const pua = (cp: number) => cp >= 0xe000 && cp <= 0xf8ff;

describe("font tables", () => {
  it("name only SMuFL glyphs that exist", () => {
    for (const table of [SONATA, SONATA_SPECIAL, SONATA_TEXT, EMMENTALER]) {
      for (const [k, name] of Object.entries(table)) expect(pua(smufl(name)), `${k} -> ${name}`).toBe(true);
    }
  });

  it("read the Sonata layout like Finale's Maestro map", () => {
    const cp = (ch: string) => smufl(SONATA[ch]);
    expect(cp("œ")).toBe(0xe0a4);
    expect(cp("˙")).toBe(0xe0a3);
    expect(cp("w")).toBe(0xe0a2);
    expect(cp("&")).toBe(0xe050);
    expect(cp("?")).toBe(0xe062);
    expect(cp("B")).toBe(0xe05c);
    expect(cp("#")).toBe(0xe262);
    expect(cp("b")).toBe(0xe260);
    expect(cp("n")).toBe(0xe261);
    expect(cp("‹")).toBe(0xe263);
    expect(cp("∫")).toBe(0xe264);
    expect(cp("∑")).toBe(0xe4e3);
    expect(cp("Ó")).toBe(0xe4e4);
    expect(cp("Œ")).toBe(0xe4e5);
    expect(cp("‰")).toBe(0xe4e6);
    expect(cp("≈")).toBe(0xe4e7);
    expect(cp("j")).toBe(0xe240);
    expect(cp("J")).toBe(0xe241);
    expect(cp("c")).toBe(0xe08a);
    expect(cp("C")).toBe(0xe08b);
    expect(cp("3")).toBe(0xe083);
    expect(cp("U")).toBe(0xe4c0);
    expect(cp("%")).toBe(0xe047);
  });

  it("tells the Sonata font kinds apart by name", () => {
    expect(sonataKind("OpusStd")).toBe("main");
    expect(sonataKind("ABCDEF+Maestro")).toBe("main");
    expect(sonataKind("Inkpen2")).toBe("main");
    expect(sonataKind("OpusSpecialStd")).toBe("special");
    expect(sonataKind("OpusTextStd")).toBe("text");
    expect(sonataKind("OpusChordsStd")).toBe("plain");
    expect(sonataKind("JazzText")).toBe("plain");
    expect(sonataKind("OpusPercussionStd")).toBe("unknown");
    expect(sonataKind("PlantinMTStd-Regular")).toBeNull();
  });

  it("maps per kind: unknown music glyphs dropped, text kept", () => {
    expect(sonataMapper(glyph("OpusStd", "œ"), undefined)).toBe(0xe0a4);
    expect(sonataMapper(glyph("OpusStd", "Ð"), undefined)).toBe(DROP);
    expect(sonataMapper(glyph("OpusTextStd", "f"), undefined)).toBe(0xe522);
    expect(sonataMapper(glyph("OpusTextStd", "("), undefined)).toBeNull();
    expect(sonataMapper(glyph("OpusSpecialStd", "{"), undefined)).toBe(0xe000);
    expect(sonataMapper(glyph("OpusChordsStd", "G"), undefined)).toBeNull();
  });

  it("resolves Emmentaler name variants", () => {
    expect(emmentalerName("noteheads.s2")).toBe(0xe0a4);
    expect(emmentalerName("flags.u4")).toBe(0xe242);
    expect(emmentalerName("rests.3")).toBe(0xe4e6);
    expect(emmentalerName("timesig.C44")).toBe(0xe08a);
    expect(emmentalerName("fattened.fixedwidth.seven.alt")).toBe(0xe087);
    expect(emmentalerName("accidentals.natural.figbass")).toBe(0xe261);
    expect(emmentalerName("accidentals.M2")).toBe(0xe260);
    expect(emmentalerName("brace217")).toBe(0xe000);
    expect(emmentalerName("quarthead")).toBe(0xe0a4);
    expect(emmentalerName("noteheads.s0mensural")).toBeUndefined();
    expect(isEmmentaler("Emmentaler-20")).toBe(true);
    expect(isEmmentaler("GNU-LilyPond-feta-20")).toBe(true);
    expect(isEmmentaler("Emmentaler-SMuFL")).toBe(false);
  });
});

const rect = (x0: number, y0: number, x1: number, y1: number, filled: boolean, width = 0): PdfShape => ({
  points: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]],
  box: { x0, y0, x1, y1 },
  filled,
  stroked: !filled,
  curved: false,
  width,
});

describe("normalized geometry", () => {
  it("folds LilyPond's filled-then-stroked rounded boxes into one line or shape", () => {
    // A stem 0.25 wide with a 0.4 pen (rounded ends), and a beam, each painted twice.
    const stemF = rect(10, 50, 10.25, 80, true);
    const stemS = rect(10, 50, 10.25, 80, false, 0.4);
    const beamF: PdfShape = { ...rect(10, 48, 40, 51, true), points: [[10, 48], [40, 46], [40, 49], [10, 51]] };
    const beamS: PdfShape = { ...beamF, filled: false, stroked: true, width: 0.4 };
    const { segments, shapes } = lines([], [stemF, stemS, beamF, beamS]);
    expect(segments).toHaveLength(1);
    expect(segments[0].width).toBeCloseTo(0.65);
    expect(segments[0].y0).toBeCloseTo(49.8);
    expect(segments[0].y1).toBeCloseTo(80.2);
    expect(shapes).toHaveLength(1);
    expect(shapes[0]).toMatchObject({ filled: true, stroked: true, width: 0.4 });
  });

  it("keeps a thin stroked frame that is not a rectangle as a shape", () => {
    const open: PdfShape = { ...rect(0, 0, 0.5, 20, false, 0.3), points: [[0, 0], [0.5, 5], [0, 10], [0.5, 20]] };
    expect(lines([], [open]).shapes).toHaveLength(1);
  });

  it("reports dropped glyphs and nameless fonts", () => {
    const page: PdfPage = {
      width: 600,
      height: 800,
      glyphs: [glyph("OpusStd", "œ"), glyph("OpusStd", "Ð"), glyph("CairoFont-2-0", "�"), glyph("Plantin", "A"), glyph("Plantin", "b", 6)],
      segments: [],
      shapes: [],
      images: 0,
    };
    const n = normalizePage(page, new Map());
    expect(n.symbols.map((s) => s.cp)).toEqual([0xe0a4]);
    expect(n.unmapped).toEqual({ "OpusStd U+00D0": 1 });
    expect(n.unknownFonts).toEqual(["CairoFont-2-0"]);
    expect(n.texts.map((t) => t.str)).toEqual(["Ab"]);
  });
});
