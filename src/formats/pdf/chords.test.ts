import { describe, expect, it } from "vitest";
import { asciiChord, CHORD_TEXT } from "./chords";
import type { PdfGlyph, PdfPage } from "./extract";
import { normalizePage } from "./normalize";

const g = (font: string, unicode: string, x: number, y = 100, size = 10, advance = 6): PdfGlyph => ({ code: 1, unicode, font, fontId: font, x, y, size, advance });
const page = (glyphs: PdfGlyph[]): PdfPage => ({ width: 600, height: 800, glyphs, segments: [], shapes: [], images: 0 });
const chords = (glyphs: PdfGlyph[]) => normalizePage(page(glyphs), new Map()).texts.filter((t) => t.kind === "chord");

/** Glyphs of one word side by side, each `adv` wide. */
const word = (font: string, s: string, x: number, adv = 6, y = 100, size = 10) => [...s].map((ch, i) => g(font, ch, x + i * adv, y, size, adv));

describe("chord text", () => {
  it("spells chords in ASCII with superscript ranges", () => {
    const p = (text: string, sup = false) => ({ text, sup });
    expect(asciiChord([p("F"), p("♯"), p("ø", true), p("7", true)])).toEqual({ str: "F#m7b5", superscript: [[2, 6]] });
    expect(asciiChord([p("B"), p("♭"), p("Δ", true)])).toEqual({ str: "Bbmaj7", superscript: [[2, 6]] });
    expect(asciiChord([p("A"), p("°", true), p("7", true)]).str).toBe("Adim7");
    expect(CHORD_TEXT.test("C7(b9)")).toBe(true);
    expect(CHORD_TEXT.test("Andante")).toBe(false);
  });

  it("reads Sibelius's Opus Chords characters", () => {
    // G‹(Œ„Š7) is Gm(maj7); the font draws the bracketed part raised.
    const out = chords([...word("OpusChordsStd", "G‹(Œ„Š7)", 50), ...word("OpusChordsStd", "F©Ø7", 150), ...word("OpusChordsStd", "B(“4)", 250)]);
    expect(out.map((c) => c.str)).toEqual(["Gm(maj7)", "F#m7b5", "B(sus4)"]);
    expect(out[0].superscript).toEqual([[2, 8]]);
  });

  it("builds a chord from a text root and a music-font accidental, and its line-mates", () => {
    // LilyPond: E, a flat from the music font, a raised 7; then Cm7 on the same line with no accidental.
    const glyphs = [
      g("C059-Roman", "E", 100),
      g("OpusStd", "b", 106.5, 100, 20),
      g("C059-Roman", "7", 111, 96, 7, 4),
      ...word("C059-Roman", "Cm", 200),
      g("C059-Roman", "7", 212, 96, 7, 4),
      ...word("C059-Roman", "Coda", 300, 6, 150),
    ];
    const withFlat = normalizePage(page(glyphs), new Map());
    const cs = withFlat.texts.filter((t) => t.kind === "chord");
    expect(cs.map((c) => c.str)).toEqual(["Eb7", "Cm7"]);
    expect(cs[0].superscript).toEqual([[2, 3]]);
    expect(withFlat.symbols).toHaveLength(0);
    expect(withFlat.texts.find((t) => !t.kind)?.str).toBe("Coda");
  });

  it("keeps chords apart when character spacing inflates the advances (Finale)", () => {
    const glyphs = [g("Helvetica", "B", 100, 100, 10, 60), g("Helvetica", "m", 106.5, 100, 10, 50), g("Helvetica", "7", 114, 100, 10, 40), g("Helvetica", "F", 125, 100, 10, 30), g("Maestro", "#", 131.5, 98, 20, 4.5), g("Helvetica", "7", 136, 100, 10, 5)];
    const texts = normalizePage(page(glyphs), new Map()).texts;
    expect(texts.filter((t) => t.kind === "chord").map((c) => c.str)).toEqual(["F#7", "Bm7"]);
  });
});
