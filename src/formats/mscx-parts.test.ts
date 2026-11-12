// @vitest-environment happy-dom
import { strFromU8, strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { ScoreEditor } from "../edit/editor";
import { noteList } from "../edit/rebuild";
import { instrument } from "../model/instruments";
import { loadScore } from "./load";

// A flute and a two-staff piano, a title frame on the first staff.
const chord = (pitch: number, tpc: number) => `<Chord><durationType>whole</durationType><Note><pitch>${pitch}</pitch><tpc>${tpc}</tpc></Note></Chord>`;
const bars = (head: string, p: number, t: number) => `<Measure><voice>${head}${chord(p, t)}</voice></Measure>\n      <Measure><voice>${chord(p + 2, t + 2)}</voice></Measure>`;
const TS = (clef: string) => `<Clef><concertClefType>${clef}</concertClefType><transposingClefType>${clef}</transposingClefType><isHeader>1</isHeader></Clef><TimeSig><sigN>4</sigN><sigD>4</sigD></TimeSig>`;
const source = `<?xml version="1.0" encoding="UTF-8"?>
<museScore version="4.50">
  <Score>
    <Division>480</Division>
    <Part id="1">
      <Staff id="1"><StaffType group="pitched"/></Staff>
      <trackName>Flute</trackName>
      <Instrument id="flute"><longName>Flute</longName><trackName>Flute</trackName><instrumentId>wind.flutes.flute</instrumentId></Instrument>
      </Part>
    <Part id="2">
      <Staff id="2"><StaffType group="pitched"/><bracket type="1" span="2" col="0"/><barLineSpan>1</barLineSpan></Staff>
      <Staff id="3"><StaffType group="pitched"/><defaultClef>F</defaultClef></Staff>
      <trackName>Piano</trackName>
      <Instrument id="piano"><longName>Piano</longName><trackName>Piano</trackName><instrumentId>keyboard.piano</instrumentId></Instrument>
      </Part>
    <Staff id="1">
      <VBox><height>10</height><Text><style>title</style><text>Duo</text></Text></VBox>
      ${bars(TS("G"), 72, 14)}
      </Staff>
    <Staff id="2">
      ${bars(TS("G"), 67, 15)}
      </Staff>
    <Staff id="3">
      <Measure><voice>${TS("F")}<Rest><durationType>measure</durationType><duration>4/4</duration></Rest></voice></Measure>
      <Measure><voice><Rest><durationType>measure</durationType><duration>4/4</duration></Rest></voice></Measure>
      </Staff>
    </Score>
  </museScore>
`;

const parts = (s: string) => [...s.matchAll(/<Part id="(\d+)">[\s\S]*?<trackName>([^<]*)<\/trackName>/g)].map((m) => `${m[1]}:${m[2]}`);
const bodies = (s: string) => [...s.matchAll(/\n    <Staff id="(\d+)">([\s\S]*?)\n      <\/Staff>/g)].map((m) => ({ id: m[1], frame: m[2].includes("<VBox>"), pitches: [...m[2].matchAll(/<pitch>(\d+)/g)].map((x) => x[1]).join(",") }));

describe("Instrument order and staves in a MuseScore file", () => {
  it("moves the piano first: its definition and staves first, the title frame on the new first staff", () => {
    const loaded = loadScore(strToU8(source));
    const ed = new ScoreEditor(loaded.score);
    ed.movePart(1, 0);
    const saved = strFromU8(loaded.save!().bytes);
    // Part ids stay; staves are numbered again in the new order.
    expect(parts(saved)).toEqual(["2:Piano", "1:Flute"]);
    expect(bodies(saved)).toEqual([
      { id: "1", frame: true, pitches: "67,69" },
      { id: "2", frame: false, pitches: "" },
      { id: "3", frame: false, pitches: "72,74" },
    ]);
    expect(saved).toMatch(/<Part id="2">\s*<Staff id="1">[\s\S]*<Staff id="2">/);
    expect(noteList(loadScore(strToU8(saved)).score)).toEqual(noteList(loaded.score));
  });

  it("changes the piano into a violin (one staff) and the flute into a piano (two)", () => {
    const loaded = loadScore(strToU8(source));
    const ed = new ScoreEditor(loaded.score);
    expect(ed.changePart(1, instrument("violin")!, "Violin")).not.toBe(null);
    let saved = strFromU8(loaded.save!().bytes);
    expect(bodies(saved).map((b) => b.pitches)).toEqual(["72,74", "67,69"]);
    const violin = /<Part id="2">[\s\S]*?<\/Part>/.exec(saved)![0];
    expect(violin.match(/<Staff /g)).toHaveLength(1);
    expect(violin).not.toContain('<bracket type="1"');
    expect(noteList(loadScore(strToU8(saved)).score)).toEqual(noteList(loaded.score));
    expect(ed.changePart(0, instrument("piano")!, "Piano")).not.toBe(null);
    saved = strFromU8(loaded.save!().bytes);
    const piano = /<Part id="1">[\s\S]*?<\/Part>/.exec(saved)![0];
    expect(piano.match(/<Staff /g)).toHaveLength(2);
    expect(piano).toContain('<bracket type="1" span="2" col="0"/>');
    expect(bodies(saved).map((b) => b.id)).toEqual(["1", "2", "3"]);
    expect(bodies(saved)[1].pitches).toBe("");
    expect(noteList(loadScore(strToU8(saved)).score)).toEqual(noteList(loaded.score));
  });
});
