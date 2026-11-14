// @vitest-environment happy-dom
// Engravers' PDFs read through the font tables. The PDFs are not in the repository: put them in
// corpus/pdf (or point SCOREDIT_PDF_SAMPLES at a folder); each test is skipped when its file is missing.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractPdf } from "./extract";
import { normalizePage } from "./normalize";
import { readPdfScore } from "./read";

const dir = process.env.SCOREDIT_PDF_SAMPLES ?? join(__dirname, "../../../corpus/pdf");

interface Expect {
  file: string;
  /** Share of the music fonts' glyphs mapped to SMuFL, at least. */
  coverage: number;
  /** Exact counts of some symbols over the whole document. */
  counts: Record<number, number>;
  /** Chord symbols that must be read (as ASCII chord text). */
  chords?: string[];
  /** Chord symbols written as <harmony> by the reader. */
  harmonies?: number;
}

const SAMPLES: Expect[] = [
  // Sibelius 7.1, Opus fonts (Wikimedia Commons: Odeon, Ernesto Nazareth, guitar).
  { file: "c2.pdf", coverage: 1, counts: { 0xe0a4: 1398, 0xe4e7: 170, 0xe262: 100, 0xe050: 29, 0xe240: 68 }, chords: ["F#m7b5", "B(sus4)", "Am/G", "Bbdim", "Am11"], harmonies: 55 },
  // Sibelius via PDFsam (Commons: Baroque Prog Suite, Eduardo Feld).
  { file: "c1.pdf", coverage: 1, counts: { 0xe0a4: 3645, 0xe0a3: 816, 0xe050: 157, 0xe263: 57, 0xe07d: 120, 0xe1e7: 354, 0xe564: 12 }, chords: ["Gm(maj7)", "G#maj7", "F#maj7(sus4)", "D#m7/D"], harmonies: 252 },
  // Sibelius 7.1 with add9 chords and strum arrows (Commons: Escuridao).
  { file: "cm-Escuridao_partitura.pdf", coverage: 1, counts: { 0xe0a4: 295, 0xeb7c: 12 }, chords: ["Dmaj7(add9)", "Dm7/G", "C#dim", "A7(sus4)"], harmonies: 72 },
  // Sibelius 7.1, choir with tuplet ratios and x heads (Commons: Orestes chorus).
  { file: "cm-Orestes_Chorus_Score.pdf", coverage: 1, counts: { 0xe0a4: 636, 0xe88a: 20, 0xe0a9: 11, 0xe4cf: 7 } },
  // Finale 2002 (Maestro) with chord symbols in Helvetica (Commons: Internationale piano arrangement).
  { file: "cm-Internationale_piano_arrangement_2001.pdf", coverage: 1, counts: { 0xe0a4: 768, 0xe250: 8 }, chords: ["F#m", "C#7", "Bm7", "F#7", "Cm7b5", "Bb7"], harmonies: 100 },
  // Finale 2007 (Maestro) and Finale on macOS (Commons: Anna Bon flute sonatas; Hino patriotico).
  { file: "cm-6_Flute_Sonatas_Op_1_IA_imslp_flute_sona.pdf", coverage: 1, counts: { 0xe0a4: 10818, 0xe566: 110, 0xe56c: 22 } },
  { file: "cm-Hino_patri_tico_da_Na_o_Portuguesa_Marco.pdf", coverage: 1, counts: { 0xe0a4: 2609, 0xe52f: 42, 0xe4ac: 25 } },
  // LilyPond 2.12 (Mutopia: Ode to Joy).
  { file: "lily-ode-a4.pdf", coverage: 1, counts: { 0xe0a4: 231, 0xe0a3: 15, 0xe050: 3, 0xe062: 3, 0xe08a: 2 } },
  // LilyPond 2.18 (Mutopia: Bach, cello suite 6 transposed).
  { file: "lily-bwv1012_transposed-a4.pdf", coverage: 1, counts: { 0xe0a4: 3848, 0xe566: 11, 0xe05c: 55 } },
  // LilyPond 2.18, voice and piano with lyrics (Mutopia: Mozart, Notte e giorno).
  { file: "lily-NotteEGiorno-a4.pdf", coverage: 1, counts: { 0xe0a4: 979, 0xe4e5: 128, 0xe522: 20, 0xe000: 20 } },
  // LilyPond 2.10, numbered accidentals (Commons: Flohwalzer).
  { file: "cm-Flohwalzer.pdf", coverage: 1, counts: { 0xe0a4: 197, 0xe260: 36, 0xe000: 3 } },
  // LilyPond 2.24 examples in its own manual (Commons: LilyPond 2.24.4 Changes).
  { file: "cm-LilyPond_2_24_4_Changes.pdf", coverage: 1, counts: { 0xe939: 3 }, chords: ["Bb", "Eb7", "A7/C#", "Bbm7", "Cm7", "Em7"] },
  // LilyPond guitar sheets with chord names in plain text (the last draws its music as outlines) (Commons: Kiefer Wolfowitz's tuning charts).
  { file: "cm-Sevenths_chords_on_C_M3_tuning.pdf", coverage: 1, counts: {}, harmonies: 5 },
  { file: "cm-Major_thirds_tuning_guitar_chords_1.pdf", coverage: 1, counts: {}, harmonies: 7 },
  { file: "cm-New_Standard_Tuning_-_C_major_scale_harmonized_in_sevenths_and_triads__arpeggios.pdf", coverage: 1, counts: {}, harmonies: 46 },
  // LilyPond 1.x feta fonts through dvips (Commons: BWV 269).
  { file: "cm-Johann_Sebastian_Bach_BWV_269_Aus_meines.pdf", coverage: 1, counts: { 0xe0a4: 184, 0xe0a3: 45 } },
];

describe("sample PDFs", () => {
  for (const s of SAMPLES) {
    const path = join(dir, s.file);
    it.skipIf(!existsSync(path))(s.file, async () => {
      const doc = await extractPdf(new Uint8Array(readFileSync(path)));
      let mapped = 0;
      let missed = 0;
      const hist = new Map<number, number>();
      const chords = new Set<string>();
      for (const p of doc.pages) {
        const n = normalizePage(p, doc.fonts);
        mapped += n.symbols.length;
        for (const sy of n.symbols) hist.set(sy.cp, (hist.get(sy.cp) ?? 0) + 1);
        for (const t of n.texts) if (t.kind === "chord") chords.add(t.str);
        missed += Object.values(n.unmapped).reduce((a, b) => a + b, 0);
        for (const f of n.unknownFonts) missed += p.glyphs.filter((g) => g.font === f).length;
      }
      if (mapped + missed) expect(mapped / (mapped + missed)).toBeGreaterThanOrEqual(s.coverage);
      for (const [cp, count] of Object.entries(s.counts)) expect(hist.get(Number(cp)) ?? 0, `U+${Number(cp).toString(16)}`).toBe(count);
      for (const c of s.chords ?? []) expect([...chords]).toContain(c);
      if (s.harmonies !== undefined) expect((await readPdfScore(new Uint8Array(readFileSync(path)))).getElementsByTagName("harmony").length).toBe(s.harmonies);
    }, 60000);
  }
});
