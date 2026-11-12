// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { kid, kids, text } from "../model/xml";
import { detectFormat } from "./detect";
import { loadScore } from "./load";
import { abcTunes, readAbc } from "./abc";

const DIV = 10080;
const enc = (s: string) => new TextEncoder().encode(s);
const tune = (body: string, head = "M:4/4\nL:1/8\nK:C") => `X:1\nT:Test\n${head}\n${body}\n`;
const measures = (doc: Document, part = 0) => kids(doc.getElementsByTagName("part")[part], "measure");
const notes = (m: Element) => kids(m, "note");
const pitchOf = (n: Element) => {
  const p = kid(n, "pitch");
  return p ? `${text(p, "step")}${({ 1: "#", 2: "##", [-1]: "b", [-2]: "bb" } as Record<string, string>)[text(p, "alter")] ?? ""}${text(p, "octave")}` : "rest";
};
const pitches = (m: Element) => notes(m).filter((n) => !kid(n, "grace")).map(pitchOf);
const durations = (m: Element) => notes(m).filter((n) => !kid(n, "grace") && !kid(n, "chord")).map((n) => Number(text(n, "duration")) / DIV);

// Traditional tunes (public domain), typed for these tests.
const SPEED = `X:1
T:The Speed the Plough
C:Trad.
M:C|
L:1/8
Q:1/2=100
R:reel
K:G
|:GABc dedB|dedB dedB|c2ec B2dB|c2A2 A2BA|
GABc dedB|dedB dedB|c2ec B2dB|A2F2 G4:|
|:g2gf gdBd|g2f2 e2d2|c2ec B2dB|c2A2 A2df|
g2gf g2Bd|g2f2 e2d2|c2ec B2dB|A2F2 G4:|
`;

const SCARB = `X:2
T:A Waltz
M:3/4
L:1/4
K:Edor
E E/F/ G|[1 A B c:|[2 B2 z|]
w:a two-syl la-ble
`;

describe("ABC detection", () => {
  it("knows ABC by an X: line followed by K:", () => {
    expect(detectFormat(enc(SPEED))).toBe("abc");
    expect(detectFormat(enc("%abc-2.1\nX:3\nK:D\nDEF|\n"))).toBe("abc");
  });
  it("does not take other text for ABC", () => {
    expect(detectFormat(enc("Hello\nX: marks the spot\nK: not a key\n"))).toBeNull();
    expect(detectFormat(enc("X:1\nT:only a header\n"))).toBeNull();
    expect(detectFormat(enc("MThd...."))).toBeNull();
  });
  it("loads read-only", () => {
    const loaded = loadScore(enc(SPEED));
    expect(loaded.format).toBe("abc");
    expect(loaded.save).toBeUndefined();
    expect(loaded.score.doc.getElementsByTagName("measure").length).toBe(16);
  });
});

describe("ABC header", () => {
  it("reads title, composer, meter, key and tempo", () => {
    const doc = readAbc(SPEED);
    expect(text(doc.documentElement, "work")).toBe("The Speed the Plough");
    expect(doc.getElementsByTagName("creator")[0].textContent).toBe("Trad.");
    const time = doc.getElementsByTagName("time")[0];
    expect(time.getAttribute("symbol")).toBe("cut");
    expect([text(time, "beats"), text(time, "beat-type")]).toEqual(["2", "2"]);
    expect(text(doc.getElementsByTagName("key")[0], "fifths")).toBe("1");
    expect(doc.getElementsByTagName("beat-unit")[0].textContent).toBe("half");
    expect(doc.getElementsByTagName("per-minute")[0].textContent).toBe("100");
    expect(doc.getElementsByTagName("sound")[0].getAttribute("tempo")).toBe("200");
  });
  it("reads common time and modes", () => {
    expect(readAbc(tune("C8|", "M:C\nL:1/8\nK:C")).getElementsByTagName("time")[0].getAttribute("symbol")).toBe("common");
    const fifths = (k: string) => text(readAbc(tune("C8|", `M:4/4\nK:${k}`)).getElementsByTagName("key")[0], "fifths");
    expect(fifths("Am")).toBe("0");
    expect(fifths("Edor")).toBe("2");
    expect(fifths("D mix")).toBe("1");
    expect(fifths("Bb")).toBe("-2");
    expect(fifths("F#m")).toBe("3");
    expect(fifths("G lydian")).toBe("2");
  });
  it("defaults the unit length from the meter", () => {
    expect(durations(measures(readAbc(tune("CDEF GABc|", "M:4/4\nK:C")))[0])).toEqual([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
    expect(durations(measures(readAbc(tune("CDEF GABc|", "M:2/4\nK:C")))[0])).toEqual(Array(8).fill(0.25));
  });
  it("reads a clef from K: and V:", () => {
    const doc = readAbc(tune("C,8|", "M:4/4\nL:1/8\nK:C clef=bass"));
    expect(text(doc.getElementsByTagName("clef")[0], "sign")).toBe("F");
  });
});

describe("ABC notes", () => {
  it("reads octaves and lengths", () => {
    const m = measures(readAbc(tune("C, c c' C2 C/ C/2 C3/2 C//|", "M:4/4\nL:1/4\nK:C")))[0];
    expect(pitches(m).slice(0, 3)).toEqual(["C3", "C5", "C6"]);
    expect(durations(m)).toEqual([1, 1, 1, 2, 0.5, 0.5, 1.5, 0.25]);
    expect(text(notes(m)[6], "type")).toBe("quarter");
    expect(kid(notes(m)[6], "dot")).toBeTruthy();
  });
  it("carries accidentals through the bar, not past it", () => {
    const doc = readAbc(tune("^F F =F F | F f ^f F|", "M:4/4\nL:1/4\nK:G"));
    const [a, b] = measures(doc);
    expect(pitches(a)).toEqual(["F#4", "F#4", "F4", "F4"]);
    expect(notes(a).map((n) => text(n, "accidental"))).toEqual(["sharp", "", "natural", ""]);
    expect(pitches(b)).toEqual(["F#4", "F#5", "F#5", "F#4"]);
    expect(text(notes(b)[2], "accidental")).toBe("sharp");
  });
  it("reads broken rhythm", () => {
    expect(durations(measures(readAbc(tune("A>B c<d e>>f g2|")))[0])).toEqual([0.75, 0.25, 0.25, 0.75, 0.875, 0.125, 1]);
  });
  it("reads rests and multi-bar rests", () => {
    const doc = readAbc(tune("z4 C4|Z2|D8|"));
    const ms = measures(doc);
    expect(ms.length).toBe(4);
    expect(pitches(ms[0])).toEqual(["rest", "C4"]);
    expect(kid(notes(ms[1])[0], "rest")?.getAttribute("measure")).toBe("yes");
    expect(kid(notes(ms[2])[0], "rest")?.getAttribute("measure")).toBe("yes");
  });
  it("reads chords with their length", () => {
    const m = measures(readAbc(tune("[CEG]4 [C2E2G2] [ce]2|")))[0];
    expect(notes(m).map(pitchOf)).toEqual(["C4", "E4", "G4", "C4", "E4", "G4", "C5", "E5"]);
    expect(notes(m).map((n) => !!kid(n, "chord"))).toEqual([false, true, true, false, true, true, false, true]);
    expect(durations(m)).toEqual([2, 1, 1]);
  });
  it("splits lengths that are no single note value into tied notes", () => {
    const m = measures(readAbc(tune("C5 D3|")))[0];
    expect(notes(m).map((n) => text(n, "type"))).toEqual(["half", "eighth", "quarter"]);
    expect(kids(notes(m)[0], "tie").map((t) => t.getAttribute("type"))).toEqual(["start"]);
    expect(kids(notes(m)[1], "tie").map((t) => t.getAttribute("type"))).toEqual(["stop"]);
  });
  it("reads ties and slurs", () => {
    const m = measures(readAbc(tune("(CD E2-) E4|")))[0];
    const slurs = (n: Element) => [...n.getElementsByTagName("slur")].map((s) => s.getAttribute("type"));
    expect(slurs(notes(m)[0])).toEqual(["start"]);
    expect(slurs(notes(m)[2])).toEqual(["stop"]);
    expect(kids(notes(m)[2], "tie").map((t) => t.getAttribute("type"))).toEqual(["start"]);
    expect(kids(notes(m)[3], "tie").map((t) => t.getAttribute("type"))).toEqual(["stop"]);
  });
  it("reads triplets and general tuplets", () => {
    const m = measures(readAbc(tune("(3CDE (3:2:2G4 c2 (5CDEFG|")))[0];
    const ns = notes(m);
    expect(durations(m).slice(0, 3).map((d) => +d.toFixed(4))).toEqual([0.3333, 0.3333, 0.3333]);
    expect(text(kid(ns[0], "time-modification")!, "actual-notes")).toBe("3");
    expect(ns[0].getElementsByTagName("tuplet")[0].getAttribute("type")).toBe("start");
    expect(ns[2].getElementsByTagName("tuplet")[0].getAttribute("type")).toBe("stop");
    expect(text(ns[3], "type")).toBe("half");
    expect(durations(m)[3]).toBeCloseTo(4 / 3);
    expect(text(kid(ns[5], "time-modification")!, "normal-notes")).toBe("2");
  });
  it("reads grace notes", () => {
    const m = measures(readAbc(tune("{g}A2 {/ag}B2 c4|")))[0];
    const graces = notes(m).filter((n) => kid(n, "grace"));
    expect(graces.map(pitchOf)).toEqual(["G5", "A5", "G5"]);
    expect(kid(graces[1], "grace")?.getAttribute("slash")).toBe("yes");
    expect(graces.every((g) => !kid(g, "duration"))).toBe(true);
  });
  it("beams notes written together", () => {
    const m = measures(readAbc(tune("CDEF G A B/c/ d|")))[0];
    const beam = (n: Element) => kids(n, "beam").map((b) => b.textContent);
    const ns = notes(m);
    expect(ns.slice(0, 4).map(beam)).toEqual([["begin"], ["continue"], ["continue"], ["end"]]);
    expect(beam(ns[4])).toEqual([]);
    expect(beam(ns[6])).toEqual(["begin", "begin"]);
    expect(beam(ns[7])).toEqual(["end", "end"]);
  });
});

describe("ABC decorations and text", () => {
  it("reads decorations", () => {
    const m = measures(readAbc(tune(".C ~D !trill!E !fermata!F !accent!G Hc !tenuto!d2|")))[0];
    const marks = (n: Element) => [...n.getElementsByTagName("notations")[0]?.querySelectorAll("*") ?? []].map((e) => e.tagName);
    const ns = notes(m);
    expect(marks(ns[0])).toContain("staccato");
    expect(marks(ns[1])).toContain("turn");
    expect(marks(ns[2])).toContain("trill-mark");
    expect(marks(ns[3])).toContain("fermata");
    expect(marks(ns[4])).toContain("accent");
    expect(marks(ns[5])).toContain("fermata");
    expect(marks(ns[6])).toContain("tenuto");
  });
  it("reads dynamics, hairpins, chord symbols and annotations", () => {
    const doc = readAbc(tune('!p!"Am"A2 !crescendo(!B2 c2 d2 !crescendo)!|"^Slowly"e8|'));
    expect(doc.getElementsByTagName("dynamics")[0].firstElementChild?.tagName).toBe("p");
    const h = doc.getElementsByTagName("harmony")[0];
    expect(text(kid(h, "root")!, "root-step")).toBe("A");
    expect(text(h, "kind")).toBe("minor");
    expect([...doc.getElementsByTagName("wedge")].map((w) => w.getAttribute("type"))).toEqual(["crescendo", "stop"]);
    expect(doc.getElementsByTagName("words")[0].textContent).toBe("Slowly");
  });
  it("puts w: lyrics under the notes of the line before", () => {
    const doc = readAbc(SCARB);
    const lyrics = [...doc.getElementsByTagName("lyric")].map((l) => [text(l, "text"), text(l, "syllabic")]);
    expect(lyrics).toEqual([
      ["a", "single"],
      ["two", "begin"],
      ["syl", "end"],
      ["la", "begin"],
      ["ble", "end"],
    ]);
  });
});

describe("ABC structure", () => {
  it("reads repeats, endings and a pickup", () => {
    const doc = readAbc(tune("G2|:c4 d4|[1 e8:|[2 f8|]", "M:4/4\nL:1/8\nK:C"));
    const ms = measures(doc);
    expect(ms[0].getAttribute("implicit")).toBe("yes");
    expect(ms[0].getAttribute("number")).toBe("0");
    expect(ms[1].getAttribute("number")).toBe("1");
    const bar = (m: Element, loc: string) => kids(m, "barline").find((b) => b.getAttribute("location") === loc);
    expect(bar(ms[1], "left")?.getElementsByTagName("repeat")[0].getAttribute("direction")).toBe("forward");
    expect(bar(ms[2], "left")?.getElementsByTagName("ending")[0].getAttribute("number")).toBe("1");
    expect(bar(ms[2], "right")?.getElementsByTagName("repeat")[0].getAttribute("direction")).toBe("backward");
    expect(bar(ms[2], "right")?.getElementsByTagName("ending")[0].getAttribute("type")).toBe("stop");
    expect(bar(ms[3], "left")?.getElementsByTagName("ending")[0].getAttribute("number")).toBe("2");
    expect(text(bar(ms[3], "right")!, "bar-style")).toBe("light-heavy");
    expect(bar(ms[3], "right")?.getElementsByTagName("ending")[0].getAttribute("type")).toBe("discontinue");
  });
  it("reads :: as an end and a start repeat", () => {
    const ms = measures(readAbc(tune("C8::D8:|")));
    expect(ms[0].getElementsByTagName("repeat")[0].getAttribute("direction")).toBe("backward");
    expect(ms[1].getElementsByTagName("repeat")[0].getAttribute("direction")).toBe("forward");
  });
  it("reads inline key and meter changes", () => {
    const doc = readAbc(tune("C8|[M:3/4][K:D]F6|"));
    const ms = measures(doc);
    expect(text(ms[1].getElementsByTagName("time")[0], "beats")).toBe("3");
    expect(text(ms[1].getElementsByTagName("key")[0], "fifths")).toBe("2");
    expect(pitches(ms[1])).toEqual(["F#4"]);
  });
  it("makes a part of each voice", () => {
    const doc = readAbc(`X:1
T:Two voices
M:2/4
L:1/8
V:1 name="Upper"
V:2 clef=bass name="Lower"
K:C
V:1
cdef|g4|
V:2
C,4|G,,4|
`);
    expect(doc.getElementsByTagName("part").length).toBe(2);
    expect([...doc.getElementsByTagName("part-name")].map((p) => p.textContent)).toEqual(["Upper", "Lower"]);
    expect(pitches(measures(doc, 1)[0])).toEqual(["C3"]);
    expect(text(measures(doc, 1)[0].getElementsByTagName("clef")[0], "sign")).toBe("F");
    expect(measures(doc, 0).length).toBe(measures(doc, 1).length);
  });
  it("lists the tunes and opens one by X:", () => {
    const file = `${SPEED}\n${SCARB}`;
    expect(abcTunes(file)).toEqual([
      { x: 1, title: "The Speed the Plough" },
      { x: 2, title: "A Waltz" },
    ]);
    expect(text(readAbc(file).documentElement, "work")).toBe("The Speed the Plough");
    expect(text(readAbc(file, { tune: 2 }).documentElement, "work")).toBe("A Waltz");
    expect(text(loadScore(enc(file), { tune: 2 }).score.doc.documentElement, "work")).toBe("A Waltz");
  });
  it("keeps every measure full in a whole tune", () => {
    const doc = readAbc(SPEED);
    for (const m of measures(doc)) expect(durations(m).reduce((a, b) => a + b, 0)).toBe(4);
  });
});
