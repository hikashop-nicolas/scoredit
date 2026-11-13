// @vitest-environment happy-dom
// A score attached to a PDF (as exportPdf does) is found by isScorePdf and read back as is.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { jsPDF } from "jspdf";
import { describe, expect, it } from "vitest";
import { ScoreDoc } from "../../model/score";
import { embedScore } from "../../render/pdf-export";
import { loadScore } from "../load";
import { isScorePdf } from "../sniff";
import { attachFile } from "./embed";
import { readPdfScore } from "./read";

const fixtures = join(__dirname, "../../../demo/fixtures");
const corpus = join(__dirname, "../../../corpus");

// A plain jsPDF document, as exportPdf makes before attaching the score.
function plainPdf(title: string, pages = 2): Uint8Array {
  const doc = new jsPDF({ unit: "pt", format: [595.28, 841.89], compress: true });
  doc.setProperties({ title, creator: "scoredit" });
  for (let i = 0; i < pages; i++) {
    if (i) doc.addPage([595.28, 841.89]);
    doc.text(`${title}, page ${i + 1}`, 72, 72);
    doc.line(72, 100, 500, 100);
  }
  return new Uint8Array(doc.output("arraybuffer"));
}

// The MusicXML without its declaration, which the test DOM writes out differently once parsed.
const body = (s: ScoreDoc | Document) => (s instanceof ScoreDoc ? s : new ScoreDoc(s)).serialize().replace(/^<\?xml[^>]*>\s*/, "");

// pdf.js opens and draws every page without complaint.
async function renders(bytes: Uint8Array): Promise<number> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const g = globalThis as { pdfjsWorker?: unknown };
  if (!g.pdfjsWorker && !pdfjs.GlobalWorkerOptions.workerSrc) g.pdfjsWorker = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
  const task = pdfjs.getDocument({ data: bytes.slice(), stopAtErrors: true });
  const doc = await task.promise;
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const ops = await page.getOperatorList();
    expect(ops.fnArray.length).toBeGreaterThan(0);
  }
  const files = await doc.getAttachments();
  const n = doc.numPages;
  await task.destroy();
  expect(files?.size).toBe(1);
  return n;
}

async function roundTrip(score: ScoreDoc) {
  const plain = plainPdf(score.title || "Score");
  const pdf = embedScore(plain, score);
  expect(isScorePdf(plain)).toBe(false);
  expect(isScorePdf(pdf)).toBe(true);
  expect(await renders(pdf)).toBe(2);
  const back = await readPdfScore(pdf);
  expect(body(back)).toBe(body(score));
  return pdf.length - plain.length;
}

describe("a score attached to a PDF", () => {
  it("reads back the melody fixture exactly", async () => {
    await roundTrip(loadScore(readFileSync(join(fixtures, "melody.musicxml"))).score);
  });

  it("writes the file spec as PDF/A-3 associated files are", async () => {
    const pdf = attachFile(plainPdf("x"), { name: "Für (Elise).mxl", data: new Uint8Array([1, 2]), mime: "application/vnd.recordare.musicxml" });
    const text = new TextDecoder("latin1").decode(pdf);
    expect(text).toContain("/F (F_r \\(Elise\\).mxl)");
    expect(text).toContain("/Subtype /application#2Fvnd.recordare.musicxml");
    expect(text).toContain("/AFRelationship /Source");
    expect(text).toMatch(/\/AF \[\d+ 0 R\]/);
  });

  it("leaves a PDF with a non-score attachment to the visual reader", async () => {
    const pdf = attachFile(plainPdf("x"), { name: "notes.txt", data: new TextEncoder().encode("hello"), mime: "text/plain" });
    expect(isScorePdf(pdf)).toBe(false);
    await expect(readPdfScore(pdf)).rejects.toThrow();
  });

  it("accepts a plain .musicxml attachment from another tool", async () => {
    const xml = readFileSync(join(fixtures, "melody.musicxml"));
    const pdf = attachFile(plainPdf("x"), { name: "melody.musicxml", data: new Uint8Array(xml), mime: "application/vnd.recordare.musicxml+xml" });
    expect(isScorePdf(pdf)).toBe(true);
    const back = await readPdfScore(pdf);
    expect(body(back)).toBe(body(loadScore(xml).score));
  });

  for (const [what, file] of [
    ["Für Elise", "musescore-com/fur-elise-beethoven.mxl"],
    ["a long string quartet", "openscore/sq_sq10328092.mscx"],
  ]) {
    it.skipIf(!existsSync(join(corpus, file)))(`reads back ${what} from the corpus`, async () => {
      const extra = await roundTrip(loadScore(readFileSync(join(corpus, file))).score);
      expect(extra).toBeGreaterThan(0);
    }, 60_000);
  }
});
