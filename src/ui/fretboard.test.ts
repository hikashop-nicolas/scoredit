// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { ScoreDoc } from "../model/score";
import { buildTimeline, type NoteEvent } from "../play/timeline";
import { GUITAR, fretTuning, position } from "./fretboard";

const ev = (midi: number, extra: Partial<NoteEvent> = {}) => ({ midi, ...extra }) as NoteEvent;
const doc = (part: string, body = "") =>
  new ScoreDoc(`<score-partwise><part-list><score-part id="P1"><part-name>${part}</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions>${body}</attributes></measure></part></score-partwise>`);

describe("fretboard", () => {
  it("takes the tuning from a tab staff, else guesses guitar or bass from the part", () => {
    const tab = `<staff-details><staff-lines>4</staff-lines><staff-tuning line="1"><tuning-step>E</tuning-step><tuning-octave>1</tuning-octave></staff-tuning><staff-tuning line="2"><tuning-step>A</tuning-step><tuning-octave>1</tuning-octave></staff-tuning><staff-tuning line="3"><tuning-step>D</tuning-step><tuning-octave>2</tuning-octave></staff-tuning><staff-tuning line="4"><tuning-step>G</tuning-step><tuning-octave>2</tuning-octave></staff-tuning></staff-details>`;
    expect(fretTuning(doc("Anything", tab), [])).toEqual([28, 33, 38, 43]);
    expect(fretTuning(doc("Nylon Guitar"), [])).toEqual(GUITAR);
    expect(fretTuning(doc("Bass"), [])).toEqual([28, 33, 38, 43]);
    expect(fretTuning(doc("Flute"), [])).toBeNull();
  });

  it("uses the score's string and fret, else the lowest fret that reaches the note", () => {
    expect(position(ev(64, { string: 2, fret: 5 }), GUITAR)).toEqual({ string: 2, fret: 5 });
    expect(position(ev(64), GUITAR)).toEqual({ string: 1, fret: 0 });
    expect(position(ev(41), GUITAR)).toEqual({ string: 6, fret: 1 });
    expect(position(ev(30), GUITAR)).toBeNull();
  });

  it("reads string, fret and bends into the timeline", () => {
    const note = `<note><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><notations><technical><string>2</string><fret>5</fret><bend><bend-alter>1</bend-alter></bend><bend><bend-alter>1</bend-alter><release/></bend></technical></notations></note>`;
    const s = new ScoreDoc(`<score-partwise><part-list><score-part id="P1"><part-name>G</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions></attributes>${note}</measure></part></score-partwise>`);
    const e = buildTimeline(s).events[0];
    expect([e.string, e.fret]).toEqual([2, 5]);
    expect(e.bend).toEqual({ alter: 1, release: true, pre: false });
  });
});
