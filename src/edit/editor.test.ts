// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { ScoreDoc } from "../model/score";
import { kids, text } from "../model/xml";
import { buildTimeline } from "../play/timeline";
import { ScoreEditor, type Caret } from "./editor";
import { readMeasure, voiceKey } from "./measure";
import type { Pitch } from "./notes";

const note = (step: string, dur: number, type: string, extra = "") => `<note><pitch><step>${step}</step><octave>4</octave></pitch><duration>${dur}</duration><voice>1</voice><type>${type}</type>${extra}</note>`;
const rest = `<note><rest measure="yes"/><duration>4</duration><voice>1</voice></note>`;
const score = (...measures: string[]) =>
  new ScoreDoc(`<?xml version="1.0"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Flute</part-name></score-part></part-list><part id="P1">${measures
    .map((m, i) => `<measure number="${i + 1}">${i === 0 ? `<attributes><divisions>1</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>` : ""}${m}</measure>`)
    .join("")}</part></score-partwise>`);

const P = (step: string, octave = 4, alter = 0): Pitch => ({ step, alter, octave });
const at = (measure: number, quarters: number, _s?: ScoreDoc, voice = "1"): Caret => ({ part: 0, measure, staff: 1, voice, pos: quarters });

/** A measure's first voice as "C4:1" (pitch:quarters), "r:1" for rests, "~" marking ties out. */
function show(s: ScoreDoc, m: number): string {
  const per = Number(s.measures[0][0].getElementsByTagName("divisions")[0].textContent);
  const evs = readMeasure(s.measures[0][m]).voices.get(voiceKey(1, "1")) ?? [];
  return evs
    .map((e) => {
      const name = e.rest ? "r" : e.notes.map((n) => text(n, "pitch") ? `${text(n.getElementsByTagName("pitch")[0], "step")}${text(n.getElementsByTagName("pitch")[0], "alter") === "1" ? "#" : text(n.getElementsByTagName("pitch")[0], "alter") === "-1" ? "b" : ""}${text(n.getElementsByTagName("pitch")[0], "octave")}` : "?").join("+");
      const tied = !e.rest && kids(e.notes[0], "tie").some((t) => t.getAttribute("type") === "start") ? "~" : "";
      return `${name}:${e.dur / per}${tied}`;
    })
    .join(" ");
}

describe("Entering notes", () => {
  it("writes over a rest and fills the bar with rests", () => {
    const s = score(rest, rest);
    const ed = new ScoreEditor(s);
    const r = ed.enter(at(0, 0, s), { pitches: [P("C")], quarters: 1 });
    expect(show(s, 0)).toBe("C4:1 r:1 r:2");
    expect(r.caret).toMatchObject({ measure: 0, pos: at(0, 1, s).pos });
  });

  it("moves to the next bar when one is full, and ties over the barline", () => {
    const s = score(rest, rest);
    const ed = new ScoreEditor(s);
    let c = at(0, 0, s);
    for (const step of "CDE") c = ed.enter(c, { pitches: [P(step)], quarters: 1 }).caret;
    c = ed.enter(c, { pitches: [P("F")], quarters: 2 }).caret;
    expect(show(s, 0)).toBe("C4:1 D4:1 E4:1 F4:1~");
    expect(show(s, 1)).toBe("F4:1 r:1 r:2");
    expect(c).toMatchObject({ measure: 1, pos: at(1, 1, s).pos });
    expect(buildTimeline(s).events.map((e) => [e.midi, e.onset, e.measure])).toEqual([
      [60, 0, 0],
      [62, 1, 0],
      [64, 2, 0],
      [65, 3, 0],
    ]);
  });

  it("adds a bar at the end when the music runs past it", () => {
    const s = score(rest);
    const ed = new ScoreEditor(s);
    ed.enter(at(0, 3, s), { pitches: [P("G")], quarters: 2 });
    expect(s.measureCount).toBe(2);
    expect(show(s, 1)).toBe("G4:1 r:1 r:2");
    ed.undo();
    expect(s.measureCount).toBe(1);
    expect(show(s, 0)).toBe("r:4");
  });

  it("writes over part of a longer note, which leaves a rest", () => {
    const s = score(note("C", 2, "half") + note("E", 2, "half"));
    const ed = new ScoreEditor(s);
    ed.enter(at(0, 0, s), { pitches: [P("D")], quarters: 1 });
    expect(show(s, 0)).toBe("D4:1 r:1 E4:2");
  });

  it("inserts, pushing the rest of the voice into the next bar's rests", () => {
    const s = score(note("C", 1, "quarter") + note("D", 1, "quarter") + note("E", 1, "quarter") + note("F", 1, "quarter"), rest);
    const ed = new ScoreEditor(s);
    const r = ed.enter(at(0, 1, s), { pitches: [P("G")], quarters: 1 }, { insert: true });
    expect(show(s, 0)).toBe("C4:1 G4:1 D4:1 E4:1");
    expect(show(s, 1)).toBe("F4:1 r:1 r:2");
    expect(r.caret).toMatchObject({ measure: 0, pos: at(0, 2, s).pos });
  });

  it("enters chords and rests, and lengthens a note in place", () => {
    const s = score(rest);
    const ed = new ScoreEditor(s);
    const c = ed.enter(at(0, 0, s), { pitches: [P("C"), P("E")], quarters: 1 }).caret;
    ed.enter(c, { pitches: null, quarters: 1 });
    ed.addToChord(at(0, 0, s), P("G"));
    expect(show(s, 0)).toBe("C4+E4+G4:1 r:1 r:2");
    ed.addToChord(at(0, 0, s), P("B"));
    expect(show(s, 0)).toBe("C4+E4+G4+B4:1 r:1 r:2");
    ed.setLength(at(0, 0, s), 2);
    expect(show(s, 0)).toBe("C4+E4+G4+B4:2 r:2");
  });

  it("undoes and redoes", () => {
    const s = score(rest);
    const ed = new ScoreEditor(s);
    ed.enter(at(0, 0, s), { pitches: [P("C")], quarters: 1 });
    ed.enter(at(0, 1, s), { pitches: [P("D")], quarters: 1 });
    ed.undo();
    expect(show(s, 0)).toBe("C4:1 r:1 r:2");
    ed.undo();
    expect(show(s, 0)).toBe("r:4");
    ed.redo();
    ed.redo();
    expect(show(s, 0)).toBe("C4:1 D4:1 r:2");
    expect(ed.canRedo).toBe(false);
  });

  it("moves a note and the notes tied to it, spelled for the key", () => {
    const s = score(rest, rest);
    const ed = new ScoreEditor(s);
    ed.enter(at(0, 3, s), { pitches: [P("C")], quarters: 2 });
    const first = Array.from(s.measures[0][0].getElementsByTagName("note")).find((n) => n.getElementsByTagName("pitch").length)!;
    ed.transpose(first, 1);
    expect(show(s, 0)).toBe("r:2 r:1 C#4:1~");
    expect(show(s, 1)).toBe("C#4:1 r:1 r:2");
  });

  it("removes a note, and beams eighths by the beat", () => {
    const s = score(rest);
    const ed = new ScoreEditor(s);
    let c = at(0, 0, s);
    for (const step of "CDEF") c = ed.enter(c, { pitches: [P(step)], quarters: 0.5 }).caret;
    const beams = Array.from(s.measures[0][0].getElementsByTagName("beam")).map((b) => b.textContent);
    expect(beams).toEqual(["begin", "end", "begin", "end"]);
    ed.remove(at(0, 0.5, s));
    expect(show(s, 0)).toBe("C4:0.5 r:0.5 E4:0.5 F4:0.5 r:2");
  });
});
