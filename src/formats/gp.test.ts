// @vitest-environment happy-dom
import { strToU8, zipSync } from "fflate";
import { parseGuitarPro } from "guitarpro-parser";
import { describe, expect, it } from "vitest";
import { gpFile, gpif } from "../../scripts/gp-fixture.mjs";
import { ScoreEditor } from "../edit/editor";
import { kid, kids, text } from "../model/xml";
import { buildTimeline } from "../play/timeline";
import { detectFormat } from "./detect";
import { readGuitarPro, songToMusicXml } from "./gp";
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

// Small scores written here: one guitar track (or a GP6 piano), bars of beats.
// A beat: [rhythm index, fret on the low E string, or null for a rest].
interface MiniBar {
  time?: string;
  beats: [number, number | null][];
  simile?: string;
  endings?: string;
  repeat?: string;
}
const RH = ["<NoteValue>Quarter</NoteValue>", `<NoteValue>16th</NoteValue><PrimaryTuplet num="13" den="8"/>`, "<NoteValue>Whole</NoteValue>", "<NoteValue>Eighth</NoteValue>"];
function mini(bars: MiniBar[], gp6 = false): string {
  const voices: string[] = [];
  const beats: string[] = [];
  const notes: string[] = [];
  const barEls: string[] = [];
  const masters: string[] = [];
  for (const b of bars) {
    const ids: number[] = [];
    for (let s = 0; s < (gp6 ? 2 : 1); s++) {
      const id = barEls.length;
      ids.push(id);
      if (b.simile || !b.beats.length) {
        barEls.push(`<Bar id="${id}">${b.simile ? `<SimileMark>${b.simile}</SimileMark>` : ""}<Voices>-1 -1 -1 -1</Voices></Bar>`);
        continue;
      }
      const bs = b.beats.map(([r, f]) => {
        const n = notes.length;
        if (f !== null) {
          const pitch = gp6 ? `<Property name="Midi"><Number>${60 - 12 * s + f}</Number></Property>` : `<Property name="String"><String>0</String></Property><Property name="Fret"><Fret>${f}</Fret></Property>`;
          notes.push(`<Note id="${n}"><Properties>${pitch}</Properties></Note>`);
        }
        beats.push(`<Beat id="${beats.length}"><Rhythm ref="${r}"/>${f !== null ? `<Dynamic>MF</Dynamic><Notes>${n}</Notes>` : ""}</Beat>`);
        return beats.length - 1;
      });
      voices.push(`<Voice id="${voices.length}"><Beats>${bs.join(" ")}</Beats></Voice>`);
      barEls.push(`<Bar id="${id}"><Voices>${voices.length - 1} -1 -1 -1</Voices></Bar>`);
    }
    masters.push(`<MasterBar><Key><AccidentalCount>0</AccidentalCount><Mode>Major</Mode></Key><Time>${b.time ?? "4/4"}</Time><Bars>${ids.join(" ")}</Bars>${b.repeat ?? ""}${b.endings ? `<AlternateEndings>${b.endings}</AlternateEndings>` : ""}</MasterBar>`);
  }
  const track = gp6
    ? `<Track id="0"><Name>Piano</Name><Instrument ref="a-piano-gs"/></Track>`
    : `<Track id="0"><Name>Guitar</Name><InstrumentSet><Type>electricGuitar</Type><Elements/></InstrumentSet><GeneralMidi><Program>29</Program></GeneralMidi><Staves><Staff><Properties><Property name="Tuning"><Pitches>40 45 50 55 59 64</Pitches></Property></Properties></Staff></Staves></Track>`;
  return `<?xml version="1.0" encoding="utf-8"?><GPIF><GPVersion>${gp6 ? 6 : 7}</GPVersion><Score><Title>Mini</Title></Score><MasterTrack><Tracks>0</Tracks></MasterTrack><Tracks>${track}</Tracks><MasterBars>${masters.join("")}</MasterBars><Bars>${barEls.join("")}</Bars><Voices>${voices.join("")}</Voices><Beats>${beats.join("")}</Beats><Notes>${notes.join("")}</Notes><Rhythms>${RH.map((r, i) => `<Rhythm id="${i}">${r}</Rhythm>`).join("")}</Rhythms></GPIF>`;
}
const gp7 = (xml: string) => zipSync({ "Content/score.gpif": strToU8(xml) });

/** A Guitar Pro 6 container holding score.gpif, compressed as literal runs only. */
function gpx(xml: string): Uint8Array {
  const content = strToU8(xml);
  const sectors = Math.ceil(content.length / 4096);
  // Sector 0 is a header; then the file's blocks, its entry, and a spare sector.
  const fs = new Uint8Array((sectors + 3) * 4096);
  fs.set(content, 4096);
  const entry = (sectors + 1) * 4096;
  const view = new DataView(fs.buffer);
  view.setUint32(entry, 2, true);
  fs.set(strToU8("score.gpif"), entry + 4);
  view.setUint32(entry + 0x8c, content.length, true);
  for (let k = 0; k < sectors; k++) view.setUint32(entry + 0x94 + 4 * k, k + 1, true);
  const bcfs = new Uint8Array(fs.length + 4);
  bcfs.set(strToU8("BCFS"));
  bcfs.set(fs, 4);
  const bits: number[] = [];
  const put = (v: number, n: number, reversed = false) => {
    for (let i = 0; i < n; i++) bits.push(reversed ? (v >> i) & 1 : (v >> (n - 1 - i)) & 1);
  };
  for (let i = 0; i < bcfs.length; i += 3) {
    const run = bcfs.subarray(i, i + 3);
    put(0, 1);
    put(run.length, 2, true);
    for (const b of run) put(b, 8);
  }
  const out = new Uint8Array(8 + Math.ceil(bits.length / 8));
  out.set(strToU8("BCFZ"));
  new DataView(out.buffer).setUint32(4, bcfs.length, true);
  bits.forEach((b, i) => (out[8 + (i >> 3)] |= b << (7 - (i & 7))));
  return out;
}

describe("Guitar Pro files guitarpro-parser refuses or misreads", () => {
  const measures = (d: Document) => kids(all(d, "part")[0], "measure");
  const sounding = (m: Element) => kids(m, "note").filter((n) => !kid(n, "rest") && (text(n, "staff") || "1") === "1");

  it("reads a GP6 file whose compressed stream stops short, with a grand staff track", () => {
    const whole = gpx(mini([{ beats: [[0, 0], [0, 2], [0, 4], [0, 5]] }], true));
    // The stream's tail only fills the spare sector with zeros.
    const cut = whole.subarray(0, whole.length - 600);
    expect(() => parseGuitarPro(cut)).toThrow();
    const { doc: d } = readGuitarPro(cut);
    expect(all(d, "score-part")).toHaveLength(1);
    expect(text(all(d, "staves")[0])).toBe("2");
    expect(sounding(measures(d)[0])).toHaveLength(4);
  });

  it("leaves out a drum note that names no drum", () => {
    const file = gp7(gpif().replace(/(<Note id="\d+">)<InstrumentArticulation>0</, "$1<InstrumentArticulation>-1<"));
    expect(() => parseGuitarPro(file)).toThrow();
    const drums = (d: Document) => all(d, "unpitched").length;
    expect(drums(readGuitarPro(file).doc)).toBe(drums(readGuitarPro(gpFile()).doc) - 1);
  });

  it("fills a bar marked to repeat the bar before", () => {
    const [a, b] = measures(readGuitarPro(gp7(mini([{ beats: [[0, 0], [0, 1], [0, 2], [0, 3]] }, { beats: [], simile: "Simple" }]))).doc);
    const pitches = (m: Element) => sounding(m).map((n) => `${text(kid(n, "pitch"), "step")}${text(kid(n, "pitch"), "alter")}`);
    expect(pitches(b)).toHaveLength(4);
    expect(pitches(b)).toEqual(pitches(a));
  });

  it("writes the simile bar as a measure repeat", () => {
    const [a, b] = measures(readGuitarPro(gp7(mini([{ beats: [[0, 0]] }, { beats: [], simile: "Simple" }]))).doc);
    expect(a.getElementsByTagName("measure-repeat")).toHaveLength(0);
    const rep = b.getElementsByTagName("measure-repeat")[0];
    expect([rep.getAttribute("type"), rep.textContent]).toEqual(["start", "1"]);
  });

  it("plays a tempo change from where it sits in the bar", () => {
    const xml = mini([{ beats: [[0, 0], [0, 0], [0, 0], [0, 0]] }]).replace(
      "<MasterTrack><Tracks>0</Tracks>",
      "<MasterTrack><Tracks>0</Tracks><Automations><Automation><Type>Tempo</Type><Linear>false</Linear><Bar>0</Bar><Position>0</Position><Value>60 2</Value></Automation><Automation><Type>Tempo</Type><Linear>false</Linear><Bar>0</Bar><Position>0.5</Position><Value>120 2</Value></Automation></Automations>",
    );
    const loaded = loadScore(gp7(xml));
    expect(all(loaded.score.doc, "offset")).toHaveLength(0);
    const times = buildTimeline(loaded.score).events.filter((e) => e.staff === 0 || e.staff === 1).map((e) => e.time);
    // Two beats at 60, then two at 120.
    expect([...new Set(times)].map((t) => Math.round(t * 100) / 100)).toEqual([0, 1, 2, 2.5]);
  });

  it("draws ottava lines over the notes they cover", () => {
    const xml = mini([{ beats: [[0, 0], [0, 0], [0, 0], [0, 0]] }]).replace(/<Beat id="([12])"><Rhythm ref="0"\/>/g, `<Beat id="$1"><Ottavia>8va</Ottavia><Rhythm ref="0"/>`);
    const shifts = all(readGuitarPro(gp7(xml)).doc, "octave-shift").map((o) => `${o.getAttribute("type")}${o.getAttribute("size")}`);
    expect(shifts).toEqual(["down8", "stop8"]);
  });

  it("leaves out beats past the end of an overfull bar", () => {
    const notes = sounding(measures(readGuitarPro(gp7(mini([{ time: "3/4", beats: [[0, 0], [0, 1], [0, 2], [0, 3]] }]))).doc)[0]);
    expect(notes.map((n) => text(n, "duration"))).toEqual(["10080", "10080", "10080"]);
  });

  it("keeps the thirteen notes of a 13:8 tuplet inside their bar", () => {
    const beats = Array.from({ length: 13 }, (): [number, number] => [1, 0]);
    const durs = sounding(measures(readGuitarPro(gp7(mini([{ time: "2/4", beats }]))).doc)[0]).map((n) => Number(text(n, "duration")));
    expect(durs).toHaveLength(13);
    expect(durs.reduce((a, b) => a + b, 0)).toBe(2 * 10080);
    // All alike but the last, which takes up the rounding.
    expect(new Set(durs.slice(0, 12)).size).toBe(1);
    expect(Math.abs(durs[12] - durs[0])).toBeLessThanOrEqual(13);
  });

  it("beams eighths by the beat: quarters in 4/4, dotted quarters in 6/8", () => {
    const e = (n: number, rest = -1) => Array.from({ length: n }, (_, i): [number, number | null] => [3, i === rest ? null : 0]);
    const d = readGuitarPro(gp7(mini([{ beats: e(8, 5) }, { time: "6/8", beats: e(6) }]))).doc;
    const beams = (m: Element) => sounding(m).map((n) => kids(n, "beam").map((b) => b.textContent).join() || "-");
    expect(beams(measures(d)[0])).toEqual(["begin", "end", "begin", "end", "-", "begin", "end"]);
    expect(beams(measures(d)[1])).toEqual(["begin", "continue", "end", "begin", "continue", "end"]);
  });

  it("drops a volta number an earlier volta of the same repeat took", () => {
    const q: [number, number][] = [[2, 0]];
    const end = `<Repeat start="false" end="true" count="2"/>`;
    const d = readGuitarPro(gp7(mini([{ beats: q, repeat: `<Repeat start="true" end="false" count="0"/>` }, { beats: q, endings: "1 2 3", repeat: end }, { beats: q, endings: "4", repeat: end }, { beats: q, endings: "1 2 3 5" }]))).doc;
    const starts = all(d, "ending").filter((e) => e.getAttribute("type") === "start");
    expect(starts.map((e) => e.getAttribute("number"))).toEqual(["1,2,3", "4", "5"]);
  });
});
