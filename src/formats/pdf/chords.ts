// Chord symbols as plain text: Sibelius chord fonts by character, and chords other engravers
// build from a text-font root plus an accidental from the music font (LilyPond, Finale).
import type { PdfGlyph } from "./extract";
import type { MusicSymbol, TextRun } from "./normalize";

export interface ChordPiece {
  text: string;
  sup: boolean;
}

/** Chord text in ASCII: # and b for accidentals, dim, m7b5, maj7, with superscript ranges. */
export function asciiChord(pieces: ChordPiece[]): { str: string; superscript: [number, number][] } {
  let str = "";
  const sup: boolean[] = [];
  const put = (t: string, s: boolean) => {
    str += t;
    for (let i = 0; i < t.length; i++) sup.push(s);
  };
  for (let i = 0; i < pieces.length; i++) {
    const { text, sup: s } = pieces[i];
    const next = pieces[i + 1]?.text;
    if (text === "ø") {
      put("m7b5", s);
      if (next === "7") i++;
    } else if (text === "Δ") {
      put("maj7", s);
      if (next === "7") i++;
    } else if (text === "°") put("dim", s);
    else put(text.replace(/♯/g, "#").replace(/♭/g, "b").replace(/𝄪/g, "##").replace(/𝄫/g, "bb").replace(/♮/g, ""), s);
  }
  const superscript: [number, number][] = [];
  for (let i = 0; i < sup.length; i++) {
    if (!sup[i]) continue;
    const last = superscript[superscript.length - 1];
    if (last && last[1] === i) last[1] = i + 1;
    else superscript.push([i, i + 1]);
  }
  return { str, superscript };
}

/** Chord text of an accidental or chord-sign symbol from a music font. */
const SYMBOL_TEXT: Record<number, string> = {
  0xe262: "♯", 0xe260: "♭", 0xe261: "♮", 0xe263: "𝄪", 0xe264: "𝄫",
  0xed62: "♯", 0xed60: "♭", 0xed61: "♮", 0xed63: "𝄪", 0xed64: "𝄫",
  0xe870: "°", 0xe871: "ø", 0xe872: "+", 0xe873: "Δ",
};

const ROOT = /^[A-G]$/;
/** A glyph's own width: some engravers space chords with character spacing, which inflates the advance. */
export const width = (g: PdfGlyph, cap = 0.75) => Math.min(g.advance, g.size * cap);
/** What ASCII chord text may look like: root, quality and extensions, bass. */
export const CHORD_TEXT = /^[A-G](?:#|b)?(?:maj|min|dim|aug|sus|add|alt|omit|no|m|M|[0-9]|[#b+\-()/,]|[A-G])*$/;

interface Seed {
  g: PdfGlyph;
  piece: ChordPiece;
  /** Whether the run may take in neighbouring text glyphs (a root set in a text font). */
  grow: boolean;
}

type Item = { g: PdfGlyph; piece: ChordPiece | null };

/**
 * Builds chord runs from chord-font glyphs and from music-font accidentals that sit right after a
 * root letter; other roots on the line of such a chord follow. Returns the runs, and the text
 * glyphs and symbols they used up.
 */
export function chordRuns(
  chordGlyphs: { g: PdfGlyph; piece: ChordPiece }[],
  textGlyphs: PdfGlyph[],
  symbols: MusicSymbol[],
): { runs: TextRun[]; usedGlyphs: Set<PdfGlyph>; usedSymbols: Set<MusicSymbol> } {
  const seeds: Seed[] = chordGlyphs.map((c) => ({ ...c, grow: false }));
  const usedSymbols = new Set<MusicSymbol>();
  for (const s of symbols) {
    const text = SYMBOL_TEXT[s.cp];
    if (!text) continue;
    // An accidental drawn right after a capital A to G on its baseline belongs to a chord name.
    const root = textGlyphs.find((t) => ROOT.test(t.unicode) && Math.abs(t.y - s.y) < t.size * 0.5 && s.x - (t.x + width(t)) > -t.size * 0.25 && s.x - (t.x + width(t)) < t.size * 0.35);
    if (!root) continue;
    usedSymbols.add(s);
    const g: PdfGlyph = { code: 0, unicode: text, font: root.font, fontId: root.fontId, x: s.x, y: root.y, size: root.size, advance: root.size * 0.4 };
    seeds.push({ g, piece: { text, sup: false }, grow: true });
  }
  const pool = new Set<PdfGlyph>(textGlyphs);
  const usedGlyphs = new Set<PdfGlyph>();
  const runs: TextRun[] = [];
  const lines: TextRun[] = [];
  const accepted = new Set<Seed>();

  // Chord fonts set each glyph at its advance; text glyphs may carry character spacing.
  const fontGlyphs = new Set(chordGlyphs.map((c) => c.g));
  const w = (g: PdfGlyph) => (fontGlyphs.has(g) ? g.advance : width(g));
  const build = (list: Seed[], check: boolean) => {
    const used = new Set<Seed>();
    const sorted = [...list].sort((a, b) => a.g.y - b.g.y || a.g.x - b.g.x);
    for (const seed of sorted) {
      if (used.has(seed)) continue;
      used.add(seed);
      const items: Item[] = [seed];
      const taken: PdfGlyph[] = [];
      const mine: Seed[] = [seed];
      let base = seed.g;
      const near = (g: PdfGlyph) => Math.abs(g.y - base.y) < base.size * 0.7;
      // Extend right, then left, taking the nearest glyph on the line each time.
      for (const dir of [1, -1] as const) {
        for (;;) {
          const edge = dir === 1 ? items[items.length - 1].g : items[0].g;
          const gap = (g: PdfGlyph) => (dir === 1 ? g.x - (edge.x + w(edge)) : edge.x - (g.x + w(g)));
          let best: { seed?: Seed; g: PdfGlyph } | null = null;
          for (const s of sorted) {
            if (used.has(s) || !near(s.g)) continue;
            const d = gap(s.g);
            if (d > -base.size * 0.3 && d < base.size * 0.2 && (!best || d < gap(best.g))) best = { seed: s, g: s.g };
          }
          if (seed.grow) {
            for (const g of pool) {
              if (!near(g)) continue;
              const d = gap(g);
              if (d > -base.size * 0.3 && d < base.size * 0.35 && (!best || d < gap(best.g))) best = { g };
            }
          }
          if (!best) break;
          // A spaced root after a finished chord starts the next chord ("Bm7 F#7"), a slash bass does not.
          const text = (i: { g: PdfGlyph; piece?: ChordPiece | null }) => i.piece?.text ?? i.g.unicode;
          const [a, b] = dir === 1 ? [items[items.length - 1], { g: best.g, piece: best.seed?.piece }] : [{ g: best.g, piece: best.seed?.piece }, items[0]];
          if (gap(best.g) > base.size * 0.1 && ROOT.test(text(b)) && text(a) !== "/") break;
          if (best.seed) {
            used.add(best.seed);
            mine.push(best.seed);
          } else {
            pool.delete(best.g);
            taken.push(best.g);
          }
          const item = { g: best.g, piece: best.seed?.piece ?? null };
          if (dir === 1) items.push(item);
          else items.unshift(item);
        }
        base = items.find((i) => ROOT.test(i.piece?.text ?? i.g.unicode))?.g ?? items[0].g;
      }
      const pieces = items.map(({ g, piece }) => {
        const raised = base.y - g.y > base.size * 0.2 || g.size < base.size * 0.8;
        return { text: piece?.text ?? g.unicode, sup: (piece?.sup ?? false) || raised };
      });
      const { str, superscript } = asciiChord(pieces);
      if (!str.trim() || (check && !CHORD_TEXT.test(str))) {
        for (const g of taken) pool.add(g);
        continue;
      }
      for (const g of taken) usedGlyphs.add(g);
      for (const s of mine) accepted.add(s);
      const f = items[0].g;
      const last = items[items.length - 1].g;
      // A chord is one word, from its root to the end of its last glyph.
      const words = [{ str, x: f.x, x1: last.x + width(last) }];
      const run: TextRun = { str, x: f.x, y: base.y, size: base.size, font: base.font, bold: /bold|black|heavy/i.test(base.font), italic: /italic|oblique/i.test(base.font), words, kind: "chord", superscript };
      runs.push(run);
      if (seed.grow) lines.push(run);
    }
  };
  build(seeds, false);
  // Roots in the same font on the baseline of a chord found above are chords too (Cm, G7/D).
  const more: Seed[] = [];
  for (const g of pool) {
    if (!ROOT.test(g.unicode) || !lines.some((l) => l.font === g.font && Math.abs(l.y - g.y) < l.size * 0.2)) continue;
    const left = [...pool].some((o) => o !== g && Math.abs(o.y - g.y) < g.size * 0.2 && g.x - (o.x + width(o)) > -g.size * 0.1 && g.x - (o.x + width(o)) < g.size * 0.3);
    if (!left) more.push({ g, piece: { text: g.unicode, sup: false }, grow: true });
  }
  for (const s of more) pool.delete(s.g);
  build(more, true);
  for (const s of more) {
    if (accepted.has(s)) usedGlyphs.add(s.g);
    else pool.add(s.g);
  }
  return { runs, usedGlyphs, usedSymbols };
}
