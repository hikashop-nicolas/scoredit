// @vitest-environment happy-dom
import { zipSync, strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { detectFormat } from "../formats/detect";
import { loadScore } from "../formats/load";
import { readMxl } from "../formats/mxl";
import { breakSystems, systemOf } from "../layout/systems";
import { ScoreDoc, abbreviate, partFamily } from "./score";
import { kids, parseXml } from "./xml";

const note = (step: string, dur = 1, extra = "") => `<note><pitch><step>${step}</step><octave>4</octave></pitch><duration>${dur}</duration>${extra}</note>`;

const XML = `<?xml version="1.0"?>
<score-partwise version="4.0">
  <work><work-title>Little tune</work-title></work>
  <identification><creator type="composer">Anon</creator></identification>
  <part-list>
    <score-part id="P1"><part-name>Flute</part-name><part-abbreviation>Fl.</part-abbreviation></score-part>
  </part-list>
  <part id="P1">
    <measure number="1"><attributes><divisions>1</divisions><key><fifths>1</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>${note("C")}${note("D")}${note("E")}${note("F")}</measure>
    <measure number="2"><print new-system="yes"/>${note("G", 4)}</measure>
    <measure number="3"><attributes><clef><sign>F</sign><line>4</line></clef></attributes>${note("A", 2)}${note("B", 2, "<chord/>")}${note("C", 2)}</measure>
    <measure number="4">${note("D", 4)}</measure>
  </part>
</score-partwise>`;

describe("ScoreDoc", () => {
  const s = new ScoreDoc(XML);

  it("reads parts, measures and header", () => {
    expect(s.parts).toEqual([{ id: "P1", name: "Flute", abbreviation: "Fl.", program: null }]);
    expect(s.measureCount).toBe(4);
    expect(s.title).toBe("Little tune");
    expect(s.composer).toBe("Anon");
  });

  it("knows the attributes in force at each measure", () => {
    const at = (m: number) => s.attributesAt(0, m).map((e) => e.tagName).sort();
    expect(at(0)).toEqual([]);
    expect(at(1)).toEqual(["clef", "divisions", "key", "time"]);
    const clef = s.attributesAt(0, 3).find((e) => e.tagName === "clef")!;
    expect(clef.textContent).toContain("F");
  });

  it("weighs a measure by its distinct onsets", () => {
    expect(s.measureWeight(0)).toBe(4);
    expect(s.measureWeight(1)).toBe(1);
    expect(s.measureWeight(2)).toBe(2); // the chord note shares an onset
  });

  it("slices measures with the attributes carried in and no source breaks", () => {
    const doc = parseXml(s.slice(1, 3));
    const ms = kids(doc.getElementsByTagName("part")[0], "measure");
    expect(ms.map((m) => m.getAttribute("number"))).toEqual(["2", "3"]);
    const at = kids(ms[0], "attributes")[0];
    expect(kids(at).map((e) => e.tagName)).toEqual(["divisions", "key", "time", "clef"]);
    expect(kids(at, "time")[0].getAttribute("print-object")).toBe("no");
    expect(kids(ms[0], "print")[0].hasAttribute("new-system")).toBe(false);
    expect(doc.getElementsByTagName("work").length).toBe(0);
    expect(parseXml(s.slice(0, 1, { header: true })).getElementsByTagName("work").length).toBe(1);
  });

  it("keeps a measure's own attributes and fills in the rest", () => {
    const doc = parseXml(s.slice(2, 4));
    const at = kids(kids(doc.getElementsByTagName("part")[0], "measure")[0], "attributes")[0];
    expect(kids(at).map((e) => e.tagName)).toEqual(["divisions", "key", "time", "clef"]);
    expect(kids(at, "clef")[0].textContent).toContain("F");
  });

  it("turns a timewise score into a partwise one", () => {
    const tw = `<score-timewise><part-list><score-part id="A"><part-name>A</part-name></score-part></part-list>
      <measure number="1"><part id="A"><attributes><divisions>1</divisions></attributes>${note("C", 4)}</part></measure>
      <measure number="2"><part id="A">${note("D", 4)}</part></measure></score-timewise>`;
    const t = new ScoreDoc(tw);
    expect(t.root.tagName).toBe("score-partwise");
    expect(t.measureCount).toBe(2);
    expect(t.measures[0][1].getAttribute("number")).toBe("2");
  });

  it("rejects what is not MusicXML", () => {
    expect(() => new ScoreDoc("<html/>")).toThrow();
    expect(() => new ScoreDoc("<score-partwise>")).toThrow();
  });
});

describe("formats", () => {
  const mxl = zipSync({
    "META-INF/container.xml": strToU8(`<container><rootfiles><rootfile full-path="score.xml"/></rootfiles></container>`),
    "score.xml": strToU8(XML),
  });

  it("detects formats from the bytes", () => {
    expect(detectFormat(strToU8(XML))).toBe("musicxml");
    expect(detectFormat(mxl)).toBe("mxl");
    expect(detectFormat(zipSync({ "a.mscx": strToU8("<museScore/>") }))).toBe("mscz");
    expect(detectFormat(strToU8(`<?xml version="1.0"?><museScore version="4.50"/>`))).toBe("mscx");
    expect(detectFormat(strToU8("hello"))).toBeNull();
  });

  it("reads compressed MusicXML", () => {
    expect(readMxl(mxl)).toContain("Little tune");
    expect(readMxl(zipSync({ "x.musicxml": strToU8(XML) }))).toContain("Little tune");
    expect(loadScore(mxl).score.measureCount).toBe(4);
  });
});

describe("breakSystems", () => {
  const o = { width: 100, measureBase: 10, perWeight: 5, systemStart: 10 };

  it("fills each system up to the width", () => {
    // 20 per measure: 10 + 4 measures fit in 100
    expect(breakSystems([2, 2, 2, 2, 2, 2], o)).toEqual([{ start: 0, end: 4 }, { start: 4, end: 6 }]);
  });

  it("puts a measure wider than a system on its own line", () => {
    expect(breakSystems([2, 40, 2], o)).toEqual([{ start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 3 }]);
  });

  it("finds the system of a measure", () => {
    const sys = breakSystems([2, 2, 2, 2, 2, 2, 2, 2, 2], o);
    expect(systemOf(sys, 0)).toBe(0);
    expect(systemOf(sys, 4)).toBe(1);
    expect(systemOf(sys, 8)).toBe(2);
  });
});

describe("Showing some parts", () => {
  const BAND = `<?xml version="1.0"?><score-partwise version="4.0"><part-list>
    <part-group type="start" number="1"/>
    <score-part id="P1"><part-name>Piano</part-name><midi-instrument id="P1-I1"><midi-program>1</midi-program></midi-instrument></score-part>
    <part-group type="stop" number="1"/>
    <score-part id="P2"><part-name>Kit</part-name><midi-instrument id="P2-I1"><midi-channel>10</midi-channel></midi-instrument></score-part>
  </part-list>
  <part id="P1"><measure number="1"><attributes><divisions>1</divisions></attributes><direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>90</per-minute></metronome></direction-type><sound tempo="90"/></direction>${note("C", 4)}</measure>
    <measure number="2">${note("D", 4)}<direction placement="above"><direction-type><words>D.C.</words></direction-type><sound dacapo="yes"/></direction></measure></part>
  <part id="P2"><measure number="1"><attributes><divisions>1</divisions></attributes>${note("E", 4)}</measure><measure number="2">${note("E", 4)}</measure></part>
</score-partwise>`;

  it("keeps the chosen parts and moves system text onto the first shown", () => {
    const full = new ScoreDoc(BAND);
    expect(full.parts.map(partFamily)).toEqual(["keys", "drums"]);
    const kit = full.only([1]);
    expect(kit.parts.map((p) => p.name)).toEqual(["Kit"]);
    expect(kit.doc.getElementsByTagName("part-group")).toHaveLength(0);
    const [m1, m2] = kit.measures[0];
    expect(kids(m1).map((e) => e.tagName)).toEqual(["attributes", "direction", "note"]);
    expect(kids(m2).map((e) => e.tagName)).toEqual(["note", "direction"]);
    expect(full.doc.getElementsByTagName("direction")).toHaveLength(2); // the full score is untouched
  });

  it("tells instrument families apart by name before program", () => {
    const f = (name: string, program: number | null = null) => partFamily({ id: "", name, abbreviation: "", program });
    expect([f("Alto Saxophone"), f("Tenor Trombone"), f("Double Bass"), f("Bass Guitar"), f("Soprano"), f("Contrabassoon"), f("", 33), f("Lead", 128)]).toEqual(["winds", "brass", "strings", "bass", "voice", "winds", "bass", "drums"]);
  });

  it("makes up short part names", () => {
    expect(["Piano", "Clarinetto in B♭ II", "Tamburo Militare", "Violin 2"].map(abbreviate)).toEqual(["Piano", "Clar. II", "Tamb.", "Violin 2"]);
  });

  it("saves as compressed MusicXML and reads it back", async () => {
    const { readMxl, writeMxl } = await import("../formats/mxl");
    const s = new ScoreDoc(XML);
    const back = new ScoreDoc(readMxl(writeMxl(s.serialize())));
    expect(back.title).toBe("Little tune");
    expect(back.measureCount).toBe(4);
    const again = new ScoreDoc(readMxl(writeMxl(back.serialize(), writeMxl(s.serialize()))));
    expect(again.measureCount).toBe(4);
  });
});

describe("Long text in a rendered system", () => {
  it("is drawn in lines, short text and the score itself left as they are", () => {
    const long = "The bells should be big; their intonation neutral; they should be struck so as to simulate festive ringing.";
    const xml = `<?xml version="1.0"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Bells</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions></attributes><direction><direction-type><words>${long}</words></direction-type></direction><direction><direction-type><words>pizz.</words></direction-type></direction><note><rest measure="yes"/><duration>4</duration><voice>1</voice></note></measure></part></score-partwise>`;
    const s = new ScoreDoc(xml);
    const out = new DOMParser().parseFromString(s.slice(0, 1), "application/xml");
    const words = Array.from(out.getElementsByTagName("words")).map((w) => w.textContent ?? "");
    expect(words[0].split("\n").every((line) => line.length <= 40)).toBe(true);
    expect(words[0].replace(/\n/g, " ")).toBe(long);
    expect(words[1]).toBe("pizz.");
    expect(s.root.getElementsByTagName("words")[0].textContent).toBe(long);
  });
});
