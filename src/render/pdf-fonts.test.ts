// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyFonts, planFonts, scoreText, scriptsFor, visualOrder } from "./pdf-fonts";

const dir = join(process.cwd(), "demo/fixtures/fonts/");
const fixture = (f: string) => new Uint8Array(readFileSync(dir + f));

describe("scriptsFor", () => {
  it("needs nothing for Western European text and music symbols", () => {
    expect(scriptsFor("Für Elise – Poco moto, ½ “dolce” €5 ")).toEqual([]);
  });
  it("names the font each kind of text needs", () => {
    expect(scriptsFor("Скрипка Ήσυχα لاط לאט 교향곡 Łódź")).toEqual(["cyrillic", "greek", "arabic", "hebrew", "korean", "latin"]);
  });
  it("reads Han as Japanese beside kana, as Chinese without", () => {
    expect(scriptsFor("春の歌")).toEqual(["japanese"]);
    expect(scriptsFor("春歌")).toEqual(["chinese"]);
  });
});

describe("scoreText", () => {
  it("keeps what is drawn and leaves the encoding out", () => {
    const doc = new DOMParser().parseFromString("<score-partwise><work><work-title>春の歌</work-title></work><identification><encoding><software>Программа</software></encoding></identification></score-partwise>", "application/xml");
    expect(scoreText(doc.documentElement).trim()).toBe("春の歌");
  });
});

describe("planFonts", () => {
  it("fetches only the fonts the text needs, once per source", async () => {
    const asked: string[] = [];
    const src = (name: string, file: string) => () => (asked.push(name), fixture(file));
    const sans = src("sans", "test-sans.ttf");
    const plan = await planFonts("Скрипка Ήσυχα", { cyrillic: sans, greek: sans, japanese: src("japanese", "test-japanese.ttf"), arabic: "" });
    expect(asked).toEqual(["sans"]);
    expect(plan.fonts.length).toBe(1);
    expect(plan.fontOf.get("Ή".codePointAt(0)!)).toBe(plan.fonts[0]);
  });

  it("falls back to the standard fonts when a font is missing or broken", async () => {
    const warn = console.warn;
    console.warn = () => {};
    try {
      const plan = await planFonts("Скрипка 春", { cyrillic: () => new Uint8Array([1, 2, 3, 4]), japanese: null });
      expect(plan.fonts).toEqual([]);
    } finally {
      console.warn = warn;
    }
  });
});

describe("applyFonts", () => {
  const svg = (inner: string) => new DOMParser().parseFromString(`<svg xmlns="http://www.w3.org/2000/svg">${inner}</svg>`, "image/svg+xml").documentElement;

  it("sets the font of a text one font draws whole, and leaves Latin text alone", async () => {
    const plan = await planFonts("春の歌 Op. 5", { japanese: fixture("test-japanese.ttf") });
    const page = svg('<text font-family="Times New Roman" font-weight="bold">春の歌 Op. 5</text><text font-family="Times New Roman">Allegro</text>');
    applyFonts(page, plan);
    const [a, b] = [...page.querySelectorAll("text")];
    expect([a.getAttribute("font-family"), a.getAttribute("font-weight"), a.textContent]).toEqual(["scoredit-japanese", "normal", "春の歌 Op. 5"]);
    expect(b.getAttribute("font-family")).toBe("Times New Roman");
  });

  it("splits text into runs where its fonts change", async () => {
    const plan = await planFonts("慢板 第一乐章", { chinese: fixture("test-chinese.ttf") });
    const page = svg('<text font-family="Times New Roman">慢板 第一乐章 (Adagio)</text>');
    applyFonts(page, plan);
    const runs = [...page.querySelector("text")!.childNodes].map((n) => [(n as Element).getAttribute?.("font-family") ?? "", n.textContent]);
    // The Chinese font has no space or Latin letters: those keep the standard font.
    expect(runs).toEqual([
      ["scoredit-chinese", "慢板"],
      ["", " "],
      ["scoredit-chinese", "第一乐章"],
      ["", " (Adagio)"],
    ]);
  });
});

describe("visualOrder", () => {
  it("reverses right-to-left text and keeps numbers and Latin text left to right", () => {
    expect(visualOrder("לאט")).toBe("טאל");
    expect(visualOrder("שיר השירים")).toBe("םירישה ריש");
    expect(visualOrder("Allegro (לאט) 12")).toBe("Allegro (טאל) 12");
    expect(visualOrder("לאט 12 שיר")).toBe("ריש 12 טאל");
    expect(visualOrder("(לאט)")).toBe("(טאל)");
    expect(visualOrder("Plain text")).toBe("Plain text");
  });
});
