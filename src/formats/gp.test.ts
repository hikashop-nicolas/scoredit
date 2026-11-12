// @vitest-environment happy-dom
import { strToU8, zipSync } from "fflate";
import { parseGuitarPro } from "guitarpro-parser";
import { describe, expect, it } from "vitest";
import { gpFile } from "../../scripts/gp-fixture.mjs";
import { ScoreEditor } from "../edit/editor";
import { kid, kids, text } from "../model/xml";
import { buildTimeline } from "../play/timeline";
import { detectFormat } from "./detect";
import { songToMusicXml } from "./gp";
import { loadScore } from "./load";

const file = (): Uint8Array => gpFile();
const all = (doc: Document, tag: string) => Array.from(doc.getElementsByTagName(tag));
const notesOf = (doc: Document, part: number, staff: string) =>
  kids(all(doc, "part")[part], "measure").flatMap((m) => kids(m, "note").filter((n) => (text(n, "staff") || "1") === staff));

describe("Guitar Pro detection", () => {
  it("knows GP7 zips, GP6 containers and GP3 to 5 headers", () => {
    expect(detectFormat(file())).toBe("guitarpro");
    expect(detectFormat(strToU8("BCFZ\0\0\0\0"))).toBe("guitarpro");
    expect(detectFormat(strToU8("BCFS\0\0\0\0"))).toBe("guitarpro");
    const gp5 = new Uint8Array(32);
    gp5[0] = 24;
    gp5.set(strToU8("FICHIER GUITAR PRO v5.00"), 1);
    expect(detectFormat(gp5)).toBe("guitarpro");
    expect(detectFormat(zipSync({ "score.xml": strToU8("<score-partwise/>") }))).toBe("mxl");
  });
});

describe("Guitar Pro reader", () => {
  const loaded = loadScore(file());
  const doc = loaded.score.doc;

  it("opens read-only, with a tab staff under the fretted part", () => {
    expect(loaded.format).toBe("guitarpro");
    expect(loaded.save).toBeUndefined();
    expect(loaded.fretted).toBe(true);
    expect(loaded.tab).toBe(true);
    expect(all(doc, "part-name").map((e) => e.textContent)).toEqual(["Guitar", "Drums"]);
    expect(text(all(doc, "work-title")[0])).toBe("Riff study");
    expect(new ScoreEditor(loaded.score).fretted(0)).toEqual({ tuning: [40, 45, 50, 55, 59, 64], notation: 1, tab: 2 });
  });

  it("writes the same notes on both staves, string and fret on the tab", () => {
    const pitches = (ns: Element[]) => ns.filter((n) => kid(n, "pitch")).map((n) => `${text(kid(n, "pitch"), "step")}${text(kid(n, "pitch"), "octave")}`);
    expect(pitches(notesOf(doc, 0, "1"))).toEqual(pitches(notesOf(doc, 0, "2")));
    const first = notesOf(doc, 0, "2")[0];
    expect([text(first, "voice"), text(kid(first, "notations")!, "technical")]).toEqual(["5", "60"]);
    expect(all(doc, "staff-tuning")).toHaveLength(6);
  });

  it("reads rhythm, ties, grace notes and tuplets", () => {
    const tab = notesOf(doc, 0, "2");
    expect(tab.filter((n) => kid(n, "time-modification"))).toHaveLength(3);
    expect(tab.filter((n) => kid(n, "grace")?.getAttribute("slash") === "yes")).toHaveLength(1);
    expect(tab.flatMap((n) => kids(n, "tie").map((t) => t.getAttribute("type")))).toEqual(["start", "stop"]);
    expect(tab.filter((n) => kid(n, "dot"))).toHaveLength(6); // the dotted G chord
    expect(tab.filter((n) => n.getElementsByTagName("tuplet").length)).toHaveLength(2);
  });

  it("reads guitar effects", () => {
    const tab = notesOf(doc, 0, "2");
    const notation = notesOf(doc, 0, "1");
    const has = (ns: Element[], tag: string) => ns.filter((n) => n.getElementsByTagName(tag).length);
    expect(has(tab, "hammer-on").map((n) => n.getElementsByTagName("hammer-on")[0].getAttribute("type"))).toEqual(["start", "stop"]);
    expect(has(tab, "slide")).toHaveLength(2);
    expect(has(tab, "bend").map((n) => text(n.getElementsByTagName("bend")[0], "bend-alter"))).toEqual(["2"]);
    expect(has(notation, "bend")).toHaveLength(0);
    expect(has(tab, "natural")).toHaveLength(1);
    expect(has(tab, "wavy-line")).toHaveLength(1);
    expect(notation.filter((n) => text(n, "notehead") === "x")).toHaveLength(1);
    expect(notation.filter((n) => kid(n, "notehead")?.getAttribute("parentheses") === "yes")).toHaveLength(1);
    expect(has(notation, "arpeggiate")).toHaveLength(6);
    expect(has(notation, "accent")).toHaveLength(1);
    expect(has(notation, "staccato")).toHaveLength(1);
    expect(has(notation, "fermata")).toHaveLength(1);
    const words = all(doc, "words").map((w) => w.textContent);
    expect(words).toEqual(expect.arrayContaining(["Intro", "Intro riff", "let ring", "P.M."]));
  });

  it("reads bars: key, repeats, voltas, tempo, chords, dynamics, lyrics", () => {
    expect(text(all(doc, "fifths")[0])).toBe("1");
    expect(all(doc, "repeat").map((r) => r.getAttribute("direction"))).toEqual(["forward", "backward", "forward", "backward"]);
    expect(all(doc, "ending").map((e) => `${e.getAttribute("number")}:${e.getAttribute("type")}`)).toEqual(["1:start", "1:stop", "2:start", "2:discontinue", "1:start", "1:stop", "2:start", "2:discontinue"]);
    expect(all(doc, "per-minute").map((e) => e.textContent)).toEqual(["96", "80"]);
    expect(all(doc, "harmony").map((h) => `${text(kid(h, "root"), "root-step")}${kid(h, "kind")?.getAttribute("text")}`)).toEqual(["Em", "G"]);
    expect(all(doc, "dynamics").map((d) => d.firstElementChild?.tagName)).toEqual(["ff", "p"]);
    expect(all(doc, "lyric").map((l) => `${text(l, "text")}/${text(l, "syllabic")}`)).toEqual(["Hel/begin", "lo/end", "there/single"]);
  });

  it("writes drums as unpitched notes of their General MIDI sounds", () => {
    const drums = notesOf(doc, 1, "1").filter((n) => kid(n, "unpitched"));
    expect(new Set(drums.map((n) => kid(n, "instrument")?.getAttribute("id")))).toEqual(new Set(["P2-I37", "P2-I39", "P2-I43"]));
    expect(all(doc, "midi-unpitched").map((e) => e.textContent)).toEqual(["37", "39", "43"]);
  });

  it("plays: once per note, repeats unrolled, drums on the kit", () => {
    const tl = buildTimeline(loaded.score);
    const guitar = tl.events.filter((e) => e.part === 0);
    const drums = tl.events.filter((e) => e.part === 1);
    expect(drums.every((e) => e.program === 128)).toBe(true);
    // Bars 1, 2 (ending 1), 1 again, 3 (ending 2), 4: the tab staff is not played twice.
    expect(guitar.length).toBeGreaterThan(20);
    expect(guitar.length).toBeLessThan(40);
  });

  it("leaves the tab out when asked", () => {
    const { doc: plain, tab, fretted } = songToMusicXml(parseGuitarPro(file()), { tab: "never" });
    expect([tab, fretted]).toEqual([false, true]);
    expect(all(plain, "staves")).toHaveLength(0);
    expect(all(plain, "fret").length).toBeGreaterThan(0);
  });

  it("starts a pickup bar where its notes start", () => {
    const song = parseGuitarPro(file());
    song.masterBars[0].anacrusis = true;
    for (const t of song.tracks) t.bars[0].voices[0].beats.shift();
    const { doc: d } = songToMusicXml(song);
    const m0 = kids(all(d, "part")[0], "measure")[0];
    expect([m0.getAttribute("number"), m0.getAttribute("implicit")]).toEqual(["0", "yes"]);
    expect(kid(m0, "forward")).toBeNull();
    expect(kids(all(d, "part")[0], "measure")[1].getAttribute("number")).toBe("1");
  });
});
