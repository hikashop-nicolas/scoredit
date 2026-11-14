// Fonts embedded with jsPDF, read back with pdf.js: the right characters, in reading order.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { jsPDF } from "jspdf";
import { readFace, subsetFace } from "./font-subset";
import { planFonts, registerFonts, type PdfFonts } from "./pdf-fonts";

// The test text, and the cut-down OFL fonts in demo/fixtures/fonts/ that draw it.
export const TEXTS = {
  japanese: ["春の歌", "作者不詳", "さくら さくら やよいの そらは", "見わたす かぎり"],
  cyrillic: ["Скрипка", "Виолончель", "Скр.", "Влч."],
  greek: ["Ήσυχα"],
  arabic: ["بهدوء", "موسيقى جميلة"],
  hebrew: ["לאט", "שיר השירים"],
  chinese: ["慢板第一乐章", "这是乐谱"],
};
const ASCII = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join("");
const shape = (jsPDF.API as unknown as { processArabic(s: string): string }).processArabic;
// BIZ UDPGothic and Omnitext Hans (a Noto Sans CJK SC subset, CFF) as Omnitext serves them; Noto Sans,
// Noto Sans Arabic and Noto Sans Hebrew from craft-fonts. All SIL OFL 1.1 without reserved names.
const FIXTURES = [
  { file: "test-japanese.ttf", from: "BIZUDPGothic-Regular.ttf", text: TEXTS.japanese.join("") + ASCII },
  { file: "test-chinese.ttf", from: "OmnitextHans-Regular.otf", text: TEXTS.chinese.join("") },
  { file: "test-sans.ttf", from: "NotoSans-Regular.ttf", text: TEXTS.cyrillic.join("") + TEXTS.greek.join("") + ASCII },
  { file: "test-arabic.ttf", from: "NotoSansArabic.ttf", text: TEXTS.arabic.join("") + shape(TEXTS.arabic.join(" ")) + " ()" },
  { file: "test-hebrew.ttf", from: "NotoSansHebrew-Regular.ttf", text: TEXTS.hebrew.join("") + " ()" },
];
const dir = join(process.cwd(), "demo/fixtures/fonts/");
const fixture = (f: string) => new Uint8Array(readFileSync(join(dir, f)));
const cps = (s: string) => [...s].map((c) => c.codePointAt(0)!);

// SCOREDIT_FONTS=<folder with the fonts above> npx vitest run src/render/pdf-fonts-pdf.test.ts
const source = process.env.SCOREDIT_FONTS;
describe.skipIf(!source)("fixture fonts", () => {
  it("are cut from the original fonts", () => {
    for (const f of FIXTURES) writeFileSync(join(dir, f.file), subsetFace(readFace(new Uint8Array(readFileSync(join(source!, f.from)))), cps(f.text)));
  });

  it("converts CFF outlines to TrueType ones", () => {
    const cff = readFace(new Uint8Array(readFileSync(join(source!, "OmnitextHans-Regular.otf"))));
    expect(cff.tables.has("CFF ")).toBe(true);
    const out = readFace(subsetFace(cff, cps("乐谱")));
    expect(out.tables.has("glyf") && !out.tables.has("CFF ")).toBe(true);
    // Both glyphs have outlines: their glyf records are not empty.
    const v = out.view;
    const loca = out.tables.get("loca")!.off;
    for (const ch of "乐谱") {
      const g = out.glyph(ch.codePointAt(0)!);
      expect(v.getUint32(loca + g * 4 + 4) - v.getUint32(loca + g * 4)).toBeGreaterThan(40);
    }
  });
});

async function pdfText(pdf: Uint8Array): Promise<string[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const g = globalThis as { pdfjsWorker?: unknown };
  if (!g.pdfjsWorker) g.pdfjsWorker = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
  const task = pdfjs.getDocument({ data: pdf.slice(), useSystemFonts: false });
  const doc = await task.promise;
  const page = await doc.getPage(1);
  const content = await page.getTextContent();
  await task.destroy();
  const lines: string[] = [];
  for (const it of content.items) if ("str" in it && it.str.trim()) lines.push(it.str.normalize("NFKC"));
  return lines;
}

describe("embedded fonts", () => {
  const fonts: PdfFonts = {
    japanese: () => fixture("test-japanese.ttf"),
    chinese: () => fixture("test-chinese.ttf"),
    cyrillic: () => fixture("test-sans.ttf"),
    greek: () => fixture("test-sans.ttf"),
    arabic: () => fixture("test-arabic.ttf"),
    hebrew: () => fixture("test-hebrew.ttf"),
  };

  it("draws each script as text pdf.js reads back, right-to-left in reading order", async () => {
    const all = Object.values(TEXTS).flat();
    const plan = await planFonts(all.join(" "), fonts, shape);
    const doc = new jsPDF({ unit: "pt", compress: true });
    registerFonts(doc, plan);
    let y = 40;
    for (const s of all) {
      const f = plan.fontOf.get(s.codePointAt(0)!)!;
      doc.setFont(f.name);
      doc.text(s, 40, y);
      y += 24;
    }
    const lines = await pdfText(new Uint8Array(doc.output("arraybuffer")));
    expect(lines).toEqual(all);
  }, 30000);

  it("keeps fonts small: only the glyphs used are embedded", async () => {
    const plan = await planFonts("春の歌", fonts, shape);
    const doc = new jsPDF({ unit: "pt", compress: true });
    registerFonts(doc, plan);
    doc.setFont(plan.fonts[0].name);
    doc.text("春の歌", 40, 40);
    const base = new jsPDF({ unit: "pt", compress: true });
    base.text("Score", 40, 40);
    expect(doc.output("arraybuffer").byteLength - base.output("arraybuffer").byteLength).toBeLessThan(8000);
  });

  it("asks for no font, and embeds none, for Western European text", async () => {
    let asked = 0;
    const plan = await planFonts("Für Elise, Allegro \u2014 Violoncello", { japanese: () => (asked++, fixture("test-japanese.ttf")) }, shape);
    expect(asked).toBe(0);
    expect(plan.fonts).toEqual([]);
  });

  it("reads Han text as Japanese next to kana, as Chinese without", async () => {
    const j = await planFonts("春の歌 乐", fonts, shape);
    expect(j.fontOf.get("春".codePointAt(0)!)?.script).toBe("japanese");
    // 乐 is not in the Japanese fixture: it falls to the Chinese font.
    expect(j.fontOf.get("乐".codePointAt(0)!)?.script).toBe("chinese");
    const c = await planFonts("慢板", fonts, shape);
    expect(c.fontOf.get("慢".codePointAt(0)!)?.script).toBe("chinese");
  });
});
