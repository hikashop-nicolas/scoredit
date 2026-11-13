// Engravers' PDFs read through the font tables. The PDFs are not in the repository: put them in
// corpus/pdf (or point SCOREDIT_PDF_SAMPLES at a folder); each test is skipped when its file is missing.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractPdf } from "./extract";
import { normalizePage } from "./normalize";

const dir = process.env.SCOREDIT_PDF_SAMPLES ?? join(__dirname, "../../../corpus/pdf");

interface Expect {
  file: string;
  /** Share of the music fonts' glyphs mapped to SMuFL, at least. */
  coverage: number;
  /** Exact counts of some symbols over the whole document. */
  counts: Record<number, number>;
}

const SAMPLES: Expect[] = [
  // Sibelius 7.1, Opus fonts (Wikimedia Commons: Odeon, Ernesto Nazareth, guitar).
  { file: "c2.pdf", coverage: 0.95, counts: { 0xe0a4: 1398, 0xe4e7: 170, 0xe262: 100, 0xe050: 29, 0xe240: 68 } },
  // Sibelius via PDFsam (Commons: Baroque Prog Suite, Eduardo Feld).
  { file: "c1.pdf", coverage: 0.94, counts: { 0xe0a4: 3645, 0xe0a3: 816, 0xe050: 157, 0xe263: 57, 0xe07d: 120 } },
  // LilyPond 2.12 (Mutopia: Ode to Joy).
  { file: "lily-ode-a4.pdf", coverage: 1, counts: { 0xe0a4: 231, 0xe0a3: 15, 0xe050: 3, 0xe062: 3, 0xe08a: 2 } },
  // LilyPond 2.18 (Mutopia: Bach, cello suite 6 transposed).
  { file: "lily-bwv1012_transposed-a4.pdf", coverage: 1, counts: { 0xe0a4: 3848, 0xe566: 11, 0xe05c: 55 } },
  // LilyPond 2.18, voice and piano with lyrics (Mutopia: Mozart, Notte e giorno).
  { file: "lily-NotteEGiorno-a4.pdf", coverage: 1, counts: { 0xe0a4: 979, 0xe4e5: 128, 0xe522: 20, 0xe000: 20 } },
  // LilyPond 2.10, numbered accidentals (Commons: Flohwalzer).
  { file: "cm-Flohwalzer.pdf", coverage: 1, counts: { 0xe0a4: 197, 0xe260: 36, 0xe000: 3 } },
  // LilyPond 2.24 examples in its own manual (Commons: LilyPond 2.24.4 Changes).
  { file: "cm-LilyPond_2_24_4_Changes.pdf", coverage: 0.97, counts: {} },
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
      for (const p of doc.pages) {
        const n = normalizePage(p, doc.fonts);
        mapped += n.symbols.length;
        for (const sy of n.symbols) hist.set(sy.cp, (hist.get(sy.cp) ?? 0) + 1);
        missed += Object.values(n.unmapped).reduce((a, b) => a + b, 0);
        for (const f of n.unknownFonts) missed += p.glyphs.filter((g) => g.font === f).length;
      }
      expect(mapped / (mapped + missed)).toBeGreaterThanOrEqual(s.coverage);
      for (const [cp, count] of Object.entries(s.counts)) expect(hist.get(Number(cp)) ?? 0, `U+${Number(cp).toString(16)}`).toBe(count);
    }, 60000);
  }
});
