// One vocabulary for every engraver: music symbols as SMuFL code points, words as text runs,
// thin filled bars as line segments. The notation reader only sees this.
import type { PdfFontInfo, PdfGlyph, PdfPage, PdfSegment, PdfShape } from "./extract";

export interface MusicSymbol {
  /** SMuFL code point (U+E000 to U+F8FF): noteheadBlack is 0xE0A4. */
  cp: number;
  x: number;
  y: number;
  /** Font size in points: a SMuFL font's em is four staff spaces. */
  size: number;
}

export interface TextRun {
  str: string;
  x: number;
  y: number;
  size: number;
  font: string;
  bold: boolean;
  italic: boolean;
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
}

/** Maps a glyph of a music font to a SMuFL code point, or null when it is not a music symbol. */
export type FontMapper = (g: PdfGlyph, font: PdfFontInfo | undefined) => number | null;

const isPua = (cp: number) => cp >= 0xe000 && cp <= 0xf8ff;
const SMUFL_FONTS = /^(Bravura|Leland|Petaluma|Finale ?(Maestro|Broadway|Jazz|Ash|Engraver|Legacy)|Sebastian|Gootville|Leipzig|MuseJazz|Emmentaler-SMuFL|Ekmelos|Golden Age|Academico)/i;

/** SMuFL fonts (MuseScore, Dorico, newer Sibelius and Finale): the Unicode is the symbol. */
export const smuflMapper: FontMapper = (g) => {
  const cp = g.unicode.codePointAt(0) ?? 0;
  return isPua(cp) ? cp : null;
};

/** Mappers tried in order for a font, by name; the first that knows the font wins. */
const MAPPERS: { test: (font: string, glyphs: PdfGlyph[]) => boolean; map: FontMapper }[] = [
  { test: (f, gs) => SMUFL_FONTS.test(f) || gs.filter((g) => isPua(g.unicode.codePointAt(0) ?? 0)).length > gs.length / 2, map: smuflMapper },
];

/** Adds a mapper for another family of music fonts (Sonata-compatible, Emmentaler...). */
export function registerFontMapper(test: (font: string, glyphs: PdfGlyph[]) => boolean, map: FontMapper): void {
  MAPPERS.push({ test, map });
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
  for (const [font, glyphs] of byFont) {
    const mapper = MAPPERS.find((m) => m.test(font, glyphs))?.map;
    if (!mapper) {
      if (MUSIC_FONT.test(font)) unknownFonts.push(font);
      else textGlyphs.push(...glyphs);
      continue;
    }
    for (const g of glyphs) {
      const cp = mapper(g, fonts.get(g.fontId));
      if (cp !== null) symbols.push({ cp, x: g.x, y: g.y, size: g.size });
      else if (g.unicode.trim()) textGlyphs.push(g);
    }
  }
  // Thin filled rectangles are lines drawn as shapes (some engravers draw stems that way).
  const segments = [...page.segments];
  const shapes: PdfShape[] = [];
  for (const s of page.shapes) {
    const w = s.box.x1 - s.box.x0;
    const h = s.box.y1 - s.box.y0;
    const thin = Math.min(w, h);
    if (s.filled && !s.curved && thin > 0 && thin < 1.6 && Math.max(w, h) > 3 * thin && s.points.length <= 5) {
      const mid = (a: number, b: number) => (a + b) / 2;
      if (w < h) segments.push({ x0: mid(s.box.x0, s.box.x1), y0: s.box.y0, x1: mid(s.box.x0, s.box.x1), y1: s.box.y1, width: w });
      else segments.push({ x0: s.box.x0, y0: mid(s.box.y0, s.box.y1), x1: s.box.x1, y1: mid(s.box.y0, s.box.y1), width: h });
    } else shapes.push(s);
  }
  return { width: page.width, height: page.height, symbols, texts: textRuns(textGlyphs), segments, shapes, images: page.images, unknownFonts };
}

/** Glyphs of one font on one baseline, side by side, joined into runs of text. */
function textRuns(glyphs: PdfGlyph[]): TextRun[] {
  const sorted = [...glyphs].sort((a, b) => a.font.localeCompare(b.font) || a.y - b.y || a.x - b.x);
  const runs: TextRun[] = [];
  let cur: (TextRun & { end: number }) | null = null;
  for (const g of sorted) {
    if (cur && cur.font === g.font && Math.abs(cur.y - g.y) < g.size * 0.2 && g.x - cur.end < g.size * 0.8 && g.x >= cur.x - 0.5) {
      // A gap wider than a fifth of the size was a space.
      cur.str += (g.x - cur.end > g.size * 0.18 ? " " : "") + g.unicode;
      cur.end = g.x + g.advance;
      continue;
    }
    if (cur) runs.push(strip(cur));
    cur = { str: g.unicode, x: g.x, y: g.y, size: g.size, font: g.font, bold: /bold|black|heavy/i.test(g.font), italic: /italic|oblique/i.test(g.font), end: g.x + g.advance };
  }
  if (cur) runs.push(strip(cur));
  return runs.filter((r) => r.str.trim());

  function strip(r: TextRun & { end: number }): TextRun {
    const { end: _end, ...run } = r;
    return { ...run, str: run.str.replace(/\s+/g, " ").trim() };
  }
}
