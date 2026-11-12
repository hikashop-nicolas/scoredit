// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { ScoreDoc } from "../model/score";
import { text } from "../model/xml";
import { instrument } from "../model/instruments";
import { ScoreEditor } from "./editor";
import { readMeasure } from "./measure";

const note = (step: string, dur: number, type: string) => `<note><pitch><step>${step}</step><octave>4</octave></pitch><duration>${dur}</duration><voice>1</voice><type>${type}</type></note>`;
const score = (...measures: string[]) =>
  new ScoreDoc(`<?xml version="1.0"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Flute</part-name></score-part></part-list><part id="P1">${measures
    .map((m, i) => `<measure number="${i + 1}">${i === 0 ? `<attributes><divisions>1</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>` : ""}${m}</measure>`)
    .join("")}</part></score-partwise>`);
const flute = () => score(note("C", 4, "whole"), note("D", 4, "whole"));

describe("Instrument order and staves", () => {
  it("moves an instrument, its part-list entry and edit marks with it, and back on undo", () => {
    const s = flute();
    const ed = new ScoreEditor(s);
    ed.addPart(instrument("violin")!, "Violin");
    ed.addPart(instrument("cello")!, "Cello");
    s.partOrigins = [0, 1, 2];
    s.dirty.clear();
    s.dirty.add("0:1");
    ed.movePart(0, 2);
    expect(s.parts.map((p) => p.name)).toEqual(["Violin", "Cello", "Flute"]);
    expect(Array.from(s.root.getElementsByTagName("score-part")).map((x) => x.getElementsByTagName("part-name")[0].textContent)).toEqual(["Violin", "Cello", "Flute"]);
    expect(s.partOrigins).toEqual([1, 2, 0]);
    expect([...s.dirty]).toEqual(["2:1"]);
    ed.movePart(2, 1);
    expect(s.parts.map((p) => p.name)).toEqual(["Violin", "Flute", "Cello"]);
    ed.undo();
    ed.undo();
    expect(s.parts.map((p) => p.name)).toEqual(["Flute", "Violin", "Cello"]);
  });

  it("changes a piano into a violin (one staff) and a flute into a piano (two)", () => {
    const s = flute();
    const ed = new ScoreEditor(s);
    ed.addPart(instrument("piano")!, "Piano");
    // The piano's left hand holds a note: refused.
    ed.enter({ part: 1, measure: 0, staff: 2, voice: ed.voiceId(1, 2, 1), pos: 0 }, { pitches: [{ step: "C", alter: 0, octave: 3 }], quarters: 1 });
    expect(ed.changePart(1, instrument("violin")!, "Violin")).toBe(null);
    ed.undo();
    expect(ed.changePart(1, instrument("violin")!, "Violin")).not.toBe(null);
    expect(s.measures[1][0].getElementsByTagName("staves")).toHaveLength(0);
    expect(s.measures[1][0].getElementsByTagName("staff")).toHaveLength(0);
    expect(Array.from(s.measures[1][0].getElementsByTagName("sign")).map((x) => x.textContent)).toEqual(["G"]);
    expect(readMeasure(s.measures[1][0]).voices.size).toBe(1);
    // The flute becomes a piano: a second staff of rests, in the bass clef.
    expect(ed.changePart(0, instrument("piano")!, "Piano")).not.toBe(null);
    expect(text(s.measures[0][0].getElementsByTagName("attributes")[0], "staves")).toBe("2");
    expect(Array.from(s.measures[0][0].getElementsByTagName("sign")).map((x) => x.textContent)).toEqual(["G", "F"]);
    expect([...readMeasure(s.measures[0][1]).voices.keys()].sort()).toEqual(["1|1", "2|5"]);
    const first = readMeasure(s.measures[0][0]).voices.get("1|1")!;
    expect(first.map((e) => text(e.notes[0].getElementsByTagName("pitch")[0], "step"))).toEqual(["C"]);
  });
});
