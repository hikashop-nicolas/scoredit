// One vocabulary for every engraver: music symbols as SMuFL code points, words as text runs,
// thin filled bars as line segments. The notation reader only sees this.
import { glyphNameLookup } from "./cff";
import { type ChordPiece, chordRuns, width } from "./chords";
import { emmentalerMapper, isEmmentaler } from "./emmentaler";
import type { PdfFontInfo, PdfGlyph, PdfPage, PdfSegment, PdfShape } from "./extract";
import { DROP } from "./smufl";
import { SONATA_CHORDS, sonataKind, sonataMapper } from "./sonata";

export interface MusicSymbol {
  /** SMuFL code point (U+E000 to U+F8FF): noteheadBlack is 0xE0A4. */
  cp: number;
  x: number;
  y: number;
  /** Font size in points: a SMuFL font's em is four staff spaces. */
  size: number;
  /** Advance width in points. */
  w: number;
}

export interface TextRun {
  str: string;
  x: number;
  y: number;
  size: number;
  font: string;
  bold: boolean;
  italic: boolean;
  /** The words of the run (split where a space was), with where each starts and ends. */
  words: { str: string; x: number; x1: number }[];
  /** "chord" for a chord symbol: str is ASCII chord text ("F#m7b5", "Bbmaj7", "C7(b9)"). */
  kind?: "chord";
  /** Ranges [start, end) of str set raised and small (a chord's extensions). */
  superscript?: [number, number][];
}

export interface NormPage {
  width: number;
  height: number;
  symbols: MusicSymbol[];
  texts: TextRun[];
  segments: PdfSegment[];
  shapes: PdfShape[];
  images: number;
  /** Music fonts met that no mapping covers (their glyphs are dropped). */
  unknownFonts: string[];
  /** Glyphs of mapped music fonts that no table knows, dropped: "font char" or "font glyph-name" to count. */
  unmapped: Record<string, number>;
}

/** Maps a glyph of a music font to a SMuFL code point, null when it is text, DROP when unknown. */
export type FontMapper = (g: PdfGlyph, font: PdfFontInfo | undefined) => number | null;
export { DROP };

const isPua = (cp: number) => cp >= 0xe000 && cp <= 0xf8ff;
const SMUFL_FONTS = /^(Bravura|Leland|Petaluma|Finale ?(Maestro|Broadway|Jazz|Ash|Engraver|Legacy)|Sebastian|Gootville|Leipzig|MuseJazz|Emmentaler-SMuFL|Ekmelos|Golden Age|Academico)/i;

/** SMuFL fonts (MuseScore, Dorico, newer Sibelius and Finale): the Unicode is the symbol. */
export const smuflMapper: FontMapper = (g) => {
  const cp = g.unicode.codePointAt(0) ?? 0;
  return isPua(cp) ? cp : null;
};

type GlyphLabel = (g: PdfGlyph, font: PdfFontInfo | undefined) => string;
const charLabel: GlyphLabel = (g) => (g.unicode ? `U+${(g.unicode.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}` : `code ${g.code}`);

/** Mappers tried in order for a font, by name; the first that knows the font wins. */
const MAPPERS: { test: (font: string, glyphs: PdfGlyph[]) => boolean; map: FontMapper; label: GlyphLabel }[] = [
  {
    test: (f, gs) => SMUFL_FONTS.test(f) || (sonataKind(f) === null && !isEmmentaler(f) && gs.filter((g) => isPua(g.unicode.codePointAt(0) ?? 0)).length > gs.length / 2),
    map: smuflMapper,
    label: charLabel,
  },
  { test: (f) => sonataKind(f) !== null, map: sonataMapper, label: charLabel },
  { test: (f) => isEmmentaler(f), map: emmentalerMapper, label: (g, f) => glyphNameLookup(f)?.(g.code) ?? `code ${g.code}` },
];

/** Adds a mapper for another family of music fonts; `label` names a glyph in the unmapped report. */
export function registerFontMapper(test: (font: string, glyphs: PdfGlyph[]) => boolean, map: FontMapper, label: GlyphLabel = charLabel): void {
  MAPPERS.push({ test, map, label });
}

const MUSIC_FONT = /bravura|leland|petaluma|maestro|opus|sonata|petrucci|emmentaler|feta|jazz|engraver|broadway|reprise|helsinki|norfolk|pori|tamburo|golden age|sebastian|gootville|leipzig|ekmelos|musescore|mscore|toccata|november|anastasia|lassus|august|campania/i;

export function normalizePage(page: PdfPage, fonts: Map<string, PdfFontInfo>): NormPage {
  const byFont = new Map<string, PdfGlyph[]>();
  for (const g of page.glyphs) {
    const list = byFont.get(g.font) ?? [];
    list.push(g);
    byFont.set(g.font, list);
  }
  const symbols: MusicSymbol[] = [];
  const textGlyphs: PdfGlyph[] = [];
  const unknownFonts: string[] = [];
  const unmapped: Record<string, number> = {};
  const chordGlyphs: { g: PdfGlyph; piece: ChordPiece }[] = [];
  for (const [font, glyphs] of byFont) {
    if (sonataKind(font) === "chord") {
      for (const g of glyphs) if (g.unicode.trim()) chordGlyphs.push({ g, piece: { sup: false, ...(SONATA_CHORDS[g.unicode] ?? { text: g.unicode }) } });
      continue;
    }
    const mapper = MAPPERS.find((m) => m.test(font, glyphs));
    if (!mapper) {
      // Glyphs without Unicode in an unnamed font (Cairo's "CairoFont-2-0") are symbols, not words.
      const blank = glyphs.filter((g) => !g.unicode || g.unicode === "\ufffd" || g.unicode < " ").length;
      if (MUSIC_FONT.test(font) || blank > glyphs.length / 2) unknownFonts.push(font);
      else textGlyphs.push(...glyphs);
      continue;
    }
    for (const g of glyphs) {
      const info = fonts.get(g.fontId);
      const cp = mapper.map(g, info);
      if (cp === DROP) {
        const key = `${font} ${mapper.label(g, info)}`;
        unmapped[key] = (unmapped[key] ?? 0) + 1;
      } else if (cp !== null) symbols.push({ cp, x: g.x, y: g.y, size: g.size, w: g.advance });
      else if (g.unicode.trim()) textGlyphs.push(g);
    }
  }
  const chords = chordRuns(chordGlyphs, textGlyphs, symbols);
  const texts = [...textRuns(textGlyphs.filter((g) => !chords.usedGlyphs.has(g))), ...chords.runs];
  const { segments, shapes } = lines(page.segments, page.shapes);
  return { width: page.width, height: page.height, symbols: symbols.filter((s) => !chords.usedSymbols.has(s)), texts, segments, shapes, images: page.images, unknownFonts, unmapped };
}

const samePoints = (a: PdfShape, b: PdfShape) => a.points.length === b.points.length && a.points.every((p, i) => Math.abs(p[0] - b.points[i][0]) < 0.01 && Math.abs(p[1] - b.points[i][1]) < 0.01);

/** Thin rectangles drawn as shapes become line segments (stems, staff and ledger lines). */
export function lines(pageSegments: PdfSegment[], pageShapes: PdfShape[]): { segments: PdfSegment[]; shapes: PdfShape[] } {
  // Ghostscript (LilyPond) paints a rounded box twice, filled then stroked: one shape.
  const merged: PdfShape[] = [];
  for (const s of pageShapes) {
    const prev = merged[merged.length - 1];
    if (prev && prev.filled !== s.filled && prev.stroked !== s.stroked && samePoints(prev, s)) {
      merged[merged.length - 1] = { ...prev, filled: true, stroked: true, width: prev.stroked ? prev.width : s.width };
    } else merged.push(s);
  }
  const segments = [...pageSegments];
  const shapes: PdfShape[] = [];
  for (const s of merged) {
    const w = s.box.x1 - s.box.x0;
    const h = s.box.y1 - s.box.y0;
    // A stroke widens the box by its line width (round joins give the rounded ends).
    const pen = s.stroked ? s.width : 0;
    const thin = Math.min(w, h) + pen;
    const onCorner = (p: [number, number]) => (Math.abs(p[0] - s.box.x0) < 0.01 || Math.abs(p[0] - s.box.x1) < 0.01) && (Math.abs(p[1] - s.box.y0) < 0.01 || Math.abs(p[1] - s.box.y1) < 0.01);
    const closedBox = s.points.length <= 5 && (s.filled || (s.points.length >= 4 && s.points.every(onCorner)));
    if (!s.curved && closedBox && thin > 0 && thin < 1.6 && Math.max(w, h) + pen > 3 * thin) {
      const mid = (a: number, b: number) => (a + b) / 2;
      if (w < h) segments.push({ x0: mid(s.box.x0, s.box.x1), y0: s.box.y0 - pen / 2, x1: mid(s.box.x0, s.box.x1), y1: s.box.y1 + pen / 2, width: thin });
      else segments.push({ x0: s.box.x0 - pen / 2, y0: mid(s.box.y0, s.box.y1), x1: s.box.x1 + pen / 2, y1: mid(s.box.y0, s.box.y1), width: thin });
    } else shapes.push(s);
  }
  return { segments, shapes };
}

/** Glyphs of one font on one baseline, side by side, joined into runs of text. */
function textRuns(glyphs: PdfGlyph[]): TextRun[] {
  const sorted = [...glyphs].sort((a, b) => a.font.localeCompare(b.font) || a.y - b.y || a.x - b.x);
  const runs: TextRun[] = [];
  let cur: (TextRun & { end: number }) | null = null;
  for (const g of sorted) {
    if (cur && cur.font === g.font && Math.abs(cur.y - g.y) < g.size * 0.2 && g.x - cur.end < g.size * 0.8 && g.x >= cur.x - 0.5) {
      // A gap wider than a fifth of the size was a space.
      const space = g.x - cur.end > g.size * 0.18 || !g.unicode.trim();
      cur.str += (g.x - cur.end > g.size * 0.18 ? " " : "") + g.unicode;
      const last = cur.words[cur.words.length - 1];
      const end = g.x + width(g, 1);
      if (!g.unicode.trim()) {
        if (last?.str) cur.words.push({ str: "", x: g.x, x1: g.x });
      } else if (last && !last.str) Object.assign(last, { str: g.unicode, x: g.x, x1: end });
      else if (space || !last) cur.words.push({ str: g.unicode, x: g.x, x1: end });
      else {
        last.str += g.unicode;
        last.x1 = end;
      }
      cur.end = end;
      continue;
    }
    if (cur) runs.push(strip(cur));
    const words = g.unicode.trim() ? [{ str: g.unicode, x: g.x, x1: g.x + width(g, 1) }] : [];
    cur = { str: g.unicode, x: g.x, y: g.y, size: g.size, font: g.font, bold: /bold|black|heavy/i.test(g.font), italic: /italic|oblique/i.test(g.font), words, end: g.x + width(g, 1) };
  }
  if (cur) runs.push(strip(cur));
  return runs.filter((r) => r.str.trim());

  function strip(r: TextRun & { end: number }): TextRun {
    const { end: _end, ...run } = r;
    return { ...run, str: run.str.replace(/\s+/g, " ").trim(), words: run.words.filter((w) => w.str) };
  }
}
