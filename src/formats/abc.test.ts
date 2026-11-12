// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { kid, kids, text } from "../model/xml";
import { detectFormat } from "./detect";
import { loadScore } from "./load";
import { ScoreDoc } from "../model/score";
import { playOrder } from "../play/timeline";
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

const voice = (n: Element) => text(n, "voice");
const inVoice = (m: Element, v: string) => notes(m).filter((n) => voice(n) === v && !kid(n, "grace"));
const stems = (m: Element, v: string) => inVoice(m, v).map((n) => text(n, "stem"));
const backups = (m: Element) => kids(m, "backup").map((b) => Number(text(b, "duration")) / DIV);

describe("ABC voice overlay", () => {
  it("puts the music after & in a second voice of the same bar", () => {
    const doc = readAbc(tune("CDEF GABc & C4 E4|d8|"));
    const [m1, m2] = measures(doc);
    expect(measures(doc).length).toBe(2);
    expect(inVoice(m1, "1").map(pitchOf)).toEqual(["C4", "D4", "E4", "F4", "G4", "A4", "B4", "C5"]);
    expect(inVoice(m1, "2").map(pitchOf)).toEqual(["C4", "E4"]);
    expect(backups(m1)).toEqual([4]);
    expect(stems(m1, "1").every((s) => s === "up")).toBe(true);
    expect(stems(m1, "2")).toEqual(["down", "down"]);
    // The bar after is one voice again, with free stems.
    expect(notes(m2).map(voice)).toEqual(["1"]);
    expect(stems(m2, "1")).toEqual([""]);
  });
  it("stacks a voice for each &", () => {
    const m = measures(readAbc(tune("c8 & e8 & g8|")))[0];
    expect(notes(m).map((n) => `${voice(n)}${pitchOf(n)}`)).toEqual(["1C5", "2E5", "3G5"]);
    expect(backups(m)).toEqual([4, 4]);
  });
  it("sets the time back one bar per & after a bar line (the standard's && example)", () => {
    const doc = readAbc(tune("g4 f4 | e6 e2 |\n&& (d8 | c6) c2|\nw: ha-la-| lu-yoh"));
    const [m1, m2] = measures(doc);
    expect(measures(doc).length).toBe(2);
    expect(inVoice(m1, "2").map(pitchOf)).toEqual(["D5"]);
    expect(inVoice(m2, "2").map(pitchOf)).toEqual(["C5", "C5"]);
    // Lyrics go to the voice's own notes, not to the overlay.
    const sung = (m: Element) => inVoice(m, "1").map((n) => text(n.getElementsByTagName("lyric")[0], "text"));
    expect(sung(m1)).toEqual(["ha", "la"]);
    expect(sung(m2)).toEqual(["lu", "yoh"]);
  });
  it("reads (& ... & ... &) over several bars, from mid-bar with a forward", () => {
    const doc = readAbc(tune("C4 (& c4 | d8 & E4 | F8 &) | g8 |"));
    const [m1, m2, m3] = measures(doc);
    expect(measures(doc).length).toBe(3);
    expect(inVoice(m1, "1").map(pitchOf)).toEqual(["C4", "C5"]);
    const fw = kids(m1, "forward")[0];
    expect(Number(text(fw, "duration")) / DIV).toBe(2);
    expect(text(fw, "voice")).toBe("2");
    expect(inVoice(m1, "2").map(pitchOf)).toEqual(["E4"]);
    expect(inVoice(m2, "2").map(pitchOf)).toEqual(["F4"]);
    expect(notes(m3).map(voice)).toEqual(["1"]);
  });
  it("keeps the accidentals of an overlay to itself", () => {
    const m = measures(readAbc(tune("^F4 F4 & F4 F4|")))[0];
    expect(inVoice(m, "1").map(pitchOf)).toEqual(["F#4", "F#4"]);
    expect(inVoice(m, "2").map(pitchOf)).toEqual(["F4", "F4"]);
  });
  it("ends a bar's overlay at a repeat sign", () => {
    const ms = measures(readAbc(tune("C8 :| D8 & c8 |: E8 :|")));
    expect(ms.length).toBe(3);
    expect(inVoice(ms[1], "2").map(pitchOf)).toEqual(["C5"]);
    expect(kids(ms[2], "barline")[0].getElementsByTagName("repeat")[0].getAttribute("direction")).toBe("forward");
  });
});

const SATB = (score: string) => `X:1
T:Chorale
M:4/4
L:1/4
${score}
V:S name="Soprano"
V:A name="Alto"
V:T clef=bass name="Tenor"
V:B clef=bass name="Bass"
K:C
V:S
e d c2|
V:A
c B G2|
V:T
G, G, E,2|
V:B
C, G,, C,2|
`;

describe("ABC %%score and %%staves", () => {
  it("puts voices in parentheses on one staff, as voices 1 and 2 with stems up and down", () => {
    const doc = readAbc(SATB("%%score (S A) (T B)"));
    expect(doc.getElementsByTagName("part").length).toBe(2);
    const m = measures(doc, 0)[0];
    expect(inVoice(m, "1").map(pitchOf)).toEqual(["E5", "D5", "C5"]);
    expect(inVoice(m, "2").map(pitchOf)).toEqual(["C5", "B4", "G4"]);
    expect(stems(m, "1")).toEqual(["up", "up", "up"]);
    expect(stems(m, "2")).toEqual(["down", "down", "down"]);
    expect(backups(m)).toEqual([4]);
    expect(text(measures(doc, 1)[0].getElementsByTagName("clef")[0], "sign")).toBe("F");
    expect([...doc.getElementsByTagName("part-name")].map((p) => p.textContent)).toEqual(["Soprano", "Tenor"]);
  });
  it("drops the voices it does not list and follows its order", () => {
    const doc = readAbc(SATB("%%score B S"));
    expect([...doc.getElementsByTagName("part-name")].map((p) => p.textContent)).toEqual(["Bass", "Soprano"]);
  });
  it("makes a brace of staves one part with two staves (a piano)", () => {
    const doc = readAbc(`X:1
T:Piano
M:2/4
L:1/4
%%score {(RH1 RH2) | LH}
V:RH1 name="Piano"
V:RH2
V:LH clef=bass
K:C
V:RH1
e d|
V:RH2
c B|
V:LH
C, G,,|
`);
    expect(doc.getElementsByTagName("part").length).toBe(1);
    const m = measures(doc)[0];
    const attrs = kid(m, "attributes")!;
    expect(text(attrs, "staves")).toBe("2");
    expect([...attrs.getElementsByTagName("clef")].map((c) => `${c.getAttribute("number")}${text(c, "sign")}`)).toEqual(["1G", "2F"]);
    expect(inVoice(m, "5").map((n) => `${pitchOf(n)}/${text(n, "staff")}`)).toEqual(["C3/2", "G2/2"]);
    expect(inVoice(m, "2").map((n) => text(n, "staff"))).toEqual(["1", "1"]);
    expect(backups(m)).toEqual([2, 2]);
    expect(stems(m, "5")).toEqual(["", ""]);
  });
  it("brackets parts, with | or %%staves for bar lines through the staves", () => {
    const group = (score: string) => {
      const list = readAbc(SATB(score)).getElementsByTagName("part-list")[0];
      return kids(list).map((e) => (e.tagName === "part-group" ? `${e.getAttribute("type")}${e.getAttribute("type") === "start" ? `:${text(e, "group-symbol")}:${text(e, "group-barline")}` : ""}` : "part"));
    };
    expect(group("%%score [S A T B]")).toEqual(["start:bracket:no", "part", "part", "part", "part", "stop"]);
    expect(group("%%score [S | A | T | B]")).toEqual(["start:bracket:yes", "part", "part", "part", "part", "stop"]);
    expect(group("%%staves [S A T B]")).toEqual(["start:bracket:yes", "part", "part", "part", "part", "stop"]);
    expect(group("%%score S [A T] B")).toEqual(["part", "start:bracket:no", "part", "part", "stop", "part"]);
  });
  it("keeps a brace over named staves as separate parts (the standard's string section)", () => {
    const list = readAbc(SATB("%%score [{S | A} | T | B]")).getElementsByTagName("part-list")[0];
    expect(kids(list, "score-part").length).toBe(4);
    expect(kids(list, "part-group").map((g) => text(g, "group-symbol"))).toEqual(["bracket", "brace", "", ""]);
  });
  it("puts a floating voice on the staff before it, and reads I:score", () => {
    const doc = readAbc(SATB("I:score (S A) *T B"));
    expect(doc.getElementsByTagName("part").length).toBe(2);
    expect(inVoice(measures(doc, 0)[0], "3").map(pitchOf)).toEqual(["G3", "G3", "E3"]);
  });
  it("brings voices back in step at a %%score in the body", () => {
    const doc = readAbc(`X:1
T:Entries
M:4/4
L:1/4
K:C
V:1
c4|d4|
%%score 1 2
V:2
C4|
V:1
e4|
`);
    expect(measures(doc, 0).length).toBe(3);
    expect(pitches(measures(doc, 1)[2])).toEqual(["C4"]);
    expect(kid(notes(measures(doc, 1)[0])[0], "rest")).toBeTruthy();
  });
});

describe("ABC voice properties", () => {
  it("reads +8/-8 clefs and octave= as heard, the clef showing the 8", () => {
    const doc = readAbc(`X:1
T:Tenor
M:4/4
L:1/4
V:T clef=treble-8
V:B clef=bass octave=-1
K:C
V:T
c4|
V:B
c4|
`);
    const clef = measures(doc, 0)[0].getElementsByTagName("clef")[0];
    expect(text(clef, "clef-octave-change")).toBe("-1");
    expect(pitches(measures(doc, 0)[0])).toEqual(["C4"]);
    expect(pitches(measures(doc, 1)[0])).toEqual(["C4"]);
  });
  it("reads transpose= as a written-to-sounding interval", () => {
    const doc = readAbc(tune("c4 d4|", "M:4/4\nL:1/8\nV:1 transpose=-2\nK:D"));
    const t = doc.getElementsByTagName("transpose")[0];
    expect([text(t, "chromatic"), text(t, "diatonic")]).toEqual(["-2", "-1"]);
    const oct = readAbc(tune("c4 d4|", "M:4/4\nL:1/8\nV:1 transpose=-14\nK:D")).getElementsByTagName("transpose")[0];
    expect([text(oct, "chromatic"), text(oct, "octave-change")]).toEqual(["-2", "-1"]);
  });
  it("reads names and subnames, written in any spelling", () => {
    const doc = readAbc(`X:1
T:Names
M:4/4
L:1/4
V:1 clef=treble name="Soprano"sname="S."
V:2 nm="Alto" snm="A."
K:C
V:1
c4|
V:2
A4|
`);
    expect([...doc.getElementsByTagName("part-name")].map((p) => p.textContent)).toEqual(["Soprano", "Alto"]);
    expect([...doc.getElementsByTagName("part-abbreviation")].map((p) => p.textContent)).toEqual(["S.", "A."]);
  });
  it("forces stems with stem= and applies V:* to every voice", () => {
    const doc = readAbc(`X:1
T:Stems
M:4/4
L:1/4
V:* clef=bass
V:1 stem=down
V:2 clef=treble
K:C
V:1
C,4|
V:2
c4|
`);
    expect(text(notes(measures(doc, 0)[0])[0], "stem")).toBe("down");
    expect(text(measures(doc, 0)[0].getElementsByTagName("clef")[0], "sign")).toBe("F");
    expect(text(measures(doc, 1)[0].getElementsByTagName("clef")[0], "sign")).toBe("G");
  });
  it("changes clef from a V: or K: in the body, not when the clef is the same", () => {
    const doc = readAbc(`X:1
T:Clefs
M:4/4
L:1/4
V:1 clef=treble
K:G
V:1 clef=treble
c4|
V:1 clef=bass
C,4|
[K:clef=treble] c4|
`);
    const ms = measures(doc);
    expect(ms[0].getElementsByTagName("clef").length).toBe(1);
    expect(text(ms[1].getElementsByTagName("clef")[0], "sign")).toBe("F");
    expect(text(ms[2].getElementsByTagName("clef")[0], "sign")).toBe("G");
    // K: with only a clef keeps the key.
    expect(ms[2].getElementsByTagName("key").length).toBe(0);
  });
  it("carries a voice on across tune parts and inline [V:] fields", () => {
    const doc = readAbc(`X:1
T:Parts
M:2/4
L:1/4
K:C
P:A
[V:1] c d|e2|
[V:2] C D|E2|
P:B
[V:1] f g|a2|]
[V:2] F G|A2|]
`);
    expect(measures(doc, 0).map(pitches)).toEqual([["C5", "D5"], ["E5"], ["F5", "G5"], ["A5"]]);
    expect(measures(doc, 1).map(pitches)).toEqual([["C4", "D4"], ["E4"], ["F4", "G4"], ["A4"]]);
  });
  it("keeps the header meter at the start when the body changes it", () => {
    const doc = readAbc(tune("C8|[M:3/4]C6|"));
    expect(text(measures(doc)[0].getElementsByTagName("time")[0], "beats")).toBe("4");
  });
});

describe("ABC files as found", () => {
  it("ends a tune at an empty line, so text after it is not music", () => {
    const doc = readAbc("X:1\nT:A\nM:4/4\nL:1/4\nK:C\nc4|\n\nSome words about the tune.\n");
    expect(measures(doc).length).toBe(1);
  });
  it("applies the file header to every tune", () => {
    const file = "%abc-2.1\nL:1/4\nU:s=!staccato!\n\nX:1\nT:A\nM:4/4\nK:C\nsc4|\n\nX:2\nT:B\nM:4/4\nK:C\nC D E F|\n";
    expect(durations(measures(readAbc(file, { tune: 2 }))[0])).toEqual([1, 1, 1, 1]);
    expect(readAbc(file).getElementsByTagName("staccato").length).toBe(1);
  });
  it("decodes text mnemonics and entities", () => {
    const doc = readAbc(`X:1\nT:Si Mh\\'or &amp; Caf&eacute; \\u00e0 la \\"uber\nM:2/4\nL:1/4\nK:C\nc d|\nw:\\ss\\aa \\oo\n`);
    expect(text(doc.documentElement, "work")).toBe("Si Mh\u00f3r & Caf\u00e9 \u00e0 la \u00fcber");
    expect([...doc.getElementsByTagName("lyric")].map((l) => text(l, "text"))).toEqual(["\u00df\u00e5", "\u00f8"]);
    expect(abcTunes(`X:1\nT:Caf\\'e\nK:C\n`)[0].title).toBe("Caf\u00e9");
  });
  it("reads verses, bar skips, held and lone hyphen syllables and +: continuations", () => {
    const doc = readAbc(tune("CDEF|GABc|\nw:one two three_ |four - five\n+:six\nw:un deux", "M:4/4\nL:1/4\nK:C"));
    const sung = [...doc.getElementsByTagName("note")].map((n) => [...n.getElementsByTagName("lyric")].map((l) => `${l.getAttribute("number")}:${text(l, "text")}:${text(l, "syllabic")}`).join(" "));
    expect(sung).toEqual(["1:one:single 2:un:single", "1:two:single 2:deux:single", "1:three:single", "", "1:four:begin", "", "1:five:end", "1:six:single"]);
  });
  it("takes lyrics under a music line continued with \\", () => {
    const doc = readAbc(tune("CD|\\\nEF|\nw:a b c d", "M:2/4\nL:1/4\nK:C"));
    expect([...doc.getElementsByTagName("lyric")].map((l) => text(l, "text"))).toEqual(["a", "b", "c", "d"]);
  });
  it("ties chords", () => {
    const [m1, m2] = measures(readAbc(tune("[CE]8-|[CE]8|")));
    expect(notes(m1).map((n) => kids(n, "tie").map((t) => t.getAttribute("type")).join())).toEqual(["start", "start"]);
    expect(notes(m2).map((n) => kids(n, "tie").map((t) => t.getAttribute("type")).join())).toEqual(["stop", "stop"]);
  });
  it("puts the fermata of a lower voice below", () => {
    const m = measures(readAbc(tune("Hc8 & HC8|")))[0];
    expect(inVoice(m, "2")[0].getElementsByTagName("fermata")[0].getAttribute("type")).toBe("inverted");
    expect(inVoice(m, "1")[0].getElementsByTagName("fermata")[0].getAttribute("type")).toBe("upright");
  });
});

describe("ABC middle= and stafflines=", () => {
  const clefOf = (m: Element) => {
    const c = m.getElementsByTagName("clef")[0];
    return c ? `${text(c, "sign")}${text(c, "line")}` : "";
  };
  it("moves the notes by octaves so the middle= pitch sits on the middle line", () => {
    const doc = readAbc(tune("d c B,|", "M:3/4\nL:1/4\nV:1 clef=bass middle=d\nK:C"));
    const m = measures(doc)[0];
    expect(clefOf(m)).toBe("F4");
    expect(pitches(m)).toEqual(["D3", "C3", "B1"]);
  });
  it("moves the clef line when middle= is not whole octaves from the clef's own", () => {
    const m = measures(readAbc(tune("d B|", "M:2/4\nL:1/4\nK:C middle=d")))[0];
    expect(clefOf(m)).toBe("G1");
    expect(pitches(m)).toEqual(["D5", "B4"]);
    // The default middle changes nothing.
    expect(clefOf(measures(readAbc(tune("B|", "M:1/4\nL:1/4\nV:1 clef=treble middle=B\nK:C")))[0])).toBe("G2");
  });
  it("changes middle= in the body, a later clef= without it resetting the shift", () => {
    const doc = readAbc(tune("c|[K:bass middle=d]d|[K:clef=bass]D,|", "M:1/4\nL:1/4\nK:C"));
    const ms = measures(doc);
    expect(ms.map(pitches)).toEqual([["C5"], ["D3"], ["D3"]]);
    expect(ms.map(clefOf)).toEqual(["G2", "F4", ""]);
  });
  it("writes stafflines= as staff-lines, at the start and where it changes", () => {
    const doc = readAbc(`X:1\nT:Drums\nM:2/4\nL:1/4\nV:1 clef=perc stafflines=1\nV:2\nK:C\nV:1\nB B|B B|\nV:2\nc d|[V:2 stafflines=3]e f|\n`);
    const lines = (p: number, m: number) => [...measures(doc, p)[m].getElementsByTagName("staff-lines")].map((e) => e.textContent);
    expect(lines(0, 0)).toEqual(["1"]);
    expect(lines(0, 1)).toEqual([]);
    expect(lines(1, 0)).toEqual([]);
    expect(lines(1, 1)).toEqual(["3"]);
    const attrs = measures(doc, 0)[0].getElementsByTagName("attributes")[0];
    expect(kids(attrs, "staff-details").length).toBe(1);
    expect(kids(attrs, "clef")[0].nextElementSibling?.tagName).toBe("staff-details");
  });
});

describe("ABC %%score later in the tune", () => {
  const head = "X:1\nT:Regroup\nM:4/4\nL:1/4\nV:1\nV:2\nV:3\nV:4\n";
  it("adds the voices a later %%score brings onto the staff of a voice they share", () => {
    const doc = readAbc(`${head}%%score 1 2\nK:C\nV:1\nc4|\nV:2\nC4|\n%%score (1 3) 2\nV:1\nd4|\nV:3\nB4|\nV:2\nD4|\n`);
    expect(doc.getElementsByTagName("part").length).toBe(2);
    const m = measures(doc, 0)[1];
    expect(inVoice(m, "1").map(pitchOf)).toEqual(["D5"]);
    expect(inVoice(m, "2").map(pitchOf)).toEqual(["B4"]);
    expect(pitches(measures(doc, 1)[1])).toEqual(["D4"]);
  });
  it("gives a voice new to a later %%score its staff, in place, with the group it is in", () => {
    const doc = readAbc(`${head}%%score 1 2\nK:C\nV:1\nc4|\nV:2\nC4|\n%%score 1 [2 4]\nV:1\nd4|\nV:2\nD4|\nV:4\nE,4|\n`);
    expect(doc.getElementsByTagName("part").length).toBe(3);
    expect(pitches(measures(doc, 2)[1])).toEqual(["E3"]);
    expect(kid(notes(measures(doc, 2)[0])[0], "rest")).toBeTruthy();
    const list = doc.getElementsByTagName("part-list")[0];
    expect([...list.children].map((e) => (e.tagName === "part-group" ? `${e.getAttribute("type")}:${text(e, "group-symbol")}` : e.tagName))).toEqual(["score-part", "start:bracket", "score-part", "score-part", "stop:"]);
  });
  it("keeps every voice when a later %%score leaves some out", () => {
    const doc = readAbc(`${head}%%score 1 2 3\nK:C\nV:1\nc4|\nV:2\nC4|\nV:3\nE4|\n%%score 3 1\nV:3\nF4|\nV:1\nd4|\n`);
    expect(doc.getElementsByTagName("part").length).toBe(3);
    expect(measures(doc, 1).length).toBe(2);
  });
});

describe("ABC s: symbol lines", () => {
  it("puts decorations, chord symbols and annotations on the notes, as w: places syllables", () => {
    const doc = readAbc(tune('CDE z|FGAB|\ns:!trill! * "Am"!f! | "^loud" !fermata!', "M:4/4\nL:1/4\nK:C"));
    const ns = [...doc.getElementsByTagName("note")];
    expect(ns[0].getElementsByTagName("trill-mark").length).toBe(1);
    expect(ns[1].getElementsByTagName("notations").length).toBe(0);
    const [m1, m2] = measures(doc);
    expect(text(m1.getElementsByTagName("harmony")[0].getElementsByTagName("root")[0], "root-step")).toBe("A");
    expect(m1.getElementsByTagName("dynamics")[0].firstElementChild?.tagName).toBe("f");
    // The harmony and the dynamic come just before the third note.
    expect(m1.getElementsByTagName("direction")[0].nextElementSibling).toBe(notes(m1)[2]);
    expect(text(m2.getElementsByTagName("direction")[0].getElementsByTagName("direction-type")[0], "words")).toBe("loud");
    expect(notes(m2)[1].getElementsByTagName("fermata").length).toBe(1);
  });
  it("starts each s: line from the first note again and goes on with +:", () => {
    const doc = readAbc(tune("CDEF|\ns:!accent!\ns:* !staccato!\n+:!tenuto!\nw:a b c d", "M:4/4\nL:1/4\nK:C"));
    const ns = notes(measures(doc)[0]);
    expect(ns.map((n) => [...(n.getElementsByTagName("articulations")[0]?.children ?? [])].map((e) => e.tagName).join())).toEqual(["accent", "staccato", "tenuto", ""]);
    expect(ns.map((n) => text(n.getElementsByTagName("lyric")[0], "text"))).toEqual(["a", "b", "c", "d"]);
  });
});

describe("ABC P: parts and play order", () => {
  const AB = (order: string) => `X:1\nT:Parts\nM:2/4\nL:1/4\n${order}K:C\nP:A\nc c|d d|\nP:B\ne e:|\n[P:C]f f|]\n`;
  it("marks each part with a rehearsal mark and keeps the score as written", () => {
    const doc = readAbc(AB("P:ABAC\n"));
    const ms = measures(doc);
    expect(ms.length).toBe(4);
    expect(ms.map((m) => m.getElementsByTagName("rehearsal")[0]?.textContent ?? "")).toEqual(["A", "", "B", "C"]);
    const field = doc.getElementsByTagName("miscellaneous-field")[0];
    expect(field.getAttribute("name")).toBe("play-order");
    expect(field.textContent).toBe("A B A C");
  });
  it("plays the parts in the P: order, each with its own repeats", () => {
    expect(playOrder(new ScoreDoc(readAbc(AB("P:ABAC\n"))))).toEqual([0, 1, 2, 2, 0, 1, 3]);
    // Repeat counts and groups: (AB)2C.
    expect(playOrder(new ScoreDoc(readAbc(AB("P:(A.B)2C\n"))))).toEqual([0, 1, 2, 2, 0, 1, 2, 2, 3]);
  });
  it("plays as written without a header order, or with a one-letter header P:", () => {
    for (const order of ["", "P:A\n"]) {
      const doc = readAbc(AB(order));
      expect(doc.getElementsByTagName("miscellaneous-field").length).toBe(0);
      expect(playOrder(new ScoreDoc(doc))).toEqual([0, 1, 2, 0, 1, 2, 3]);
    }
  });
});
