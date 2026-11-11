// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { ScoreDoc } from "../model/score";
import { kids, text } from "../model/xml";
import { buildTimeline } from "../play/timeline";
import { ScoreEditor, type Caret } from "./editor";
import { readMeasure, voiceKey } from "./measure";
import { bendsOf, otherTechnical, techValue, fingeringOf, lyricsOf, marksOf, readPitch, slursOf, spansOf, tremoloOf, type Pitch } from "./notes";

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

  it("makes a triplet and fills its slots", () => {
    const s = score(rest);
    const ed = new ScoreEditor(s);
    ed.tuplet(at(0, 0), 1);
    let c = at(0, 0);
    // In the model a length is actual time: a third of a beat each.
    for (const step of "CDE") c = ed.enter(c, { pitches: [P(step)], quarters: 1 / 3 }).caret;
    expect(c.pos).toBeCloseTo(1, 6);
    const notes = Array.from(s.measures[0][0].getElementsByTagName("note")).slice(0, 3);
    expect(notes.map((n) => [text(n, "type"), n.getElementsByTagName("actual-notes")[0]?.textContent])).toEqual([
      ["eighth", "3"],
      ["eighth", "3"],
      ["eighth", "3"],
    ]);
    expect(notes.map((n) => n.getElementsByTagName("tuplet")[0]?.getAttribute("type") ?? "")).toEqual(["start", "", "stop"]);
    expect(buildTimeline(s).events.map((e) => Math.round(e.onset * 300) / 300)).toEqual([0, 1 / 3, 2 / 3].map((x) => Math.round(x * 300) / 300));
  });

  it("copies a range and pastes it as one undo step", () => {
    const s = score(note("C", 1, "quarter") + note("D", 1, "quarter") + note("E", 2, "half"), rest);
    const ed = new ScoreEditor(s);
    const clip = ed.copy(at(0, 0), at(0, 1));
    ed.paste(at(1, 0), clip);
    expect(show(s, 1)).toBe("C4:1 D4:1 r:2");
    ed.undo();
    expect(show(s, 1)).toBe("r:4");
  });

  it("enters a drum as the part draws it", () => {
    const kit = new ScoreDoc(`<?xml version="1.0"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Drums</part-name><score-instrument id="P1-I39"><instrument-name>Acoustic Snare</instrument-name></score-instrument><midi-instrument id="P1-I39"><midi-unpitched>39</midi-unpitched></midi-instrument></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>percussion</sign></clef></attributes><note><unpitched><display-step>C</display-step><display-octave>5</display-octave></unpitched><duration>4</duration><instrument id="P1-I39"/><voice>1</voice><type>whole</type></note></measure></part></score-partwise>`);
    const ed = new ScoreEditor(kit);
    const snare = ed.drumAt(0, "C", 5)!;
    expect(ed.drumName(snare.instrument)).toBe("Acoustic Snare");
    ed.enter(at(0, 0), { pitches: [snare], quarters: 1 });
    expect(buildTimeline(kit).events.map((e) => [e.midi, e.onset, e.program])).toEqual([[38, 0, 128]]);
  });

  it("writes a guitar's tab staff from its notation staff, with string and fret", () => {
    const tuning = [["E", 2], ["A", 2], ["D", 3], ["G", 3], ["B", 3], ["E", 4]].map(([st, o], i) => `<staff-tuning line="${i + 1}"><tuning-step>${st}</tuning-step><tuning-octave>${o}</tuning-octave></staff-tuning>`).join("");
    const g = new ScoreDoc(`<?xml version="1.0"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Guitar</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time><staves>2</staves><clef number="1"><sign>G</sign><line>2</line><clef-octave-change>-1</clef-octave-change></clef><clef number="2"><sign>TAB</sign><line>5</line></clef><staff-details number="2"><staff-lines>6</staff-lines>${tuning}</staff-details></attributes><note><rest measure="yes"/><duration>4</duration><voice>1</voice><staff>1</staff></note><backup><duration>4</duration></backup><note><rest measure="yes"/><duration>4</duration><voice>5</voice><staff>2</staff></note></measure></part></score-partwise>`);
    const ed = new ScoreEditor(g);
    expect(ed.fretted(0)).toMatchObject({ notation: 1, tab: 2, tuning: [40, 45, 50, 55, 59, 64] });
    ed.enter({ part: 0, measure: 0, staff: 1, voice: "1", pos: 0 }, { pitches: [P("A", 3)], quarters: 1 });
    const tabNotes = Array.from(g.measures[0][0].getElementsByTagName("note")).filter((n) => text(n, "staff") === "2" && n.getElementsByTagName("pitch").length);
    expect(tabNotes.map((n) => [text(n, "voice"), n.getElementsByTagName("string")[0]?.textContent, n.getElementsByTagName("fret")[0]?.textContent])).toEqual([["5", "3", "2"]]);
    expect(buildTimeline(g).events).toHaveLength(1);
  });

  it("adds and removes marks, slurs, grace notes and lyrics, all undoable", () => {
    const s = score(note("C", 1, "quarter") + note("D", 1, "quarter") + note("E", 1, "quarter") + note("F", 1, "quarter"));
    const ed = new ScoreEditor(s);
    const notes = () => Array.from(s.measures[0][0].getElementsByTagName("note")).filter((n) => !n.getElementsByTagName("grace").length);
    ed.mark(at(0, 0), "staccato");
    ed.mark(at(0, 1), "accent");
    ed.mark(at(0, 3), "fermata");
    ed.mark(at(0, 2), "trill-mark");
    expect(notes().map((n) => marksOf(n).join(","))).toEqual(["staccato", "accent", "trill-mark", "fermata"]);
    ed.mark(at(0, 0), "staccato");
    expect(marksOf(notes()[0])).toEqual([]);
    ed.slur(at(0, 0), at(0, 2));
    expect(notes().map((n) => slursOf(n).map((x) => x.type).join())).toEqual(["start", "", "stop", ""]);
    ed.slur(at(0, 0), at(0, 2));
    expect(notes().map((n) => slursOf(n).length)).toEqual([0, 0, 0, 0]);
    const { grace } = ed.addGrace(at(0, 1), P("E"));
    expect(grace && readPitch(grace)).toMatchObject({ step: "E" });
    expect(readMeasure(s.measures[0][0]).voices.get(voiceKey(1, "1"))![1].graces).toHaveLength(1);
    ed.lyric(at(0, 0), "Hel", "begin");
    ed.lyric(at(0, 1), "lo", "end");
    expect(notes().slice(0, 2).map((n) => lyricsOf(n)[0]?.text)).toEqual(["Hel", "lo"]);
    // Playback still sounds the four notes and the grace note.
    expect(buildTimeline(s).events.map((e) => e.midi)).toContain(64);
    for (let i = 0; i < 10; i++) ed.undo();
    expect(notes().map((n) => marksOf(n).length + slursOf(n).length + lyricsOf(n).length)).toEqual([0, 0, 0, 0]);
  });

  it("keeps a split note's marks on its first piece only", () => {
    const s = score(rest, rest);
    const ed = new ScoreEditor(s);
    ed.enter(at(0, 3), { pitches: [P("C")], quarters: 1 });
    ed.mark(at(0, 3), "accent");
    ed.lyric(at(0, 3), "la");
    ed.setLength(at(0, 3), 2);
    const pieces = Array.from(s.root.getElementsByTagName("note")).filter((n) => n.getElementsByTagName("pitch").length);
    expect(pieces.map((n) => [marksOf(n).join(), lyricsOf(n).length])).toEqual([["accent", 1], ["", 0]]);
  });

  it("adds tremolos, arpeggios, glissandos, trill lines, fingerings and bowings", () => {
    const s = score(note("C", 1, "quarter") + note("D", 1, "quarter") + note("E", 1, "quarter") + note("F", 1, "quarter"));
    const ed = new ScoreEditor(s);
    const notes = () => Array.from(s.measures[0][0].getElementsByTagName("note"));
    ed.tremolo(at(0, 0), 3);
    ed.span("glissando", at(0, 1), null, { value: "wavy" });
    ed.span("trill line", at(0, 2), at(0, 3));
    ed.fingering(notes()[3], "4");
    ed.mark(at(0, 3), "up-bow");
    expect(tremoloOf(notes()[0])).toBe(3);
    expect(notes().map((n) => spansOf(n).map((x) => `${x.kind} ${x.type}`).join())).toEqual(["", "glissando start", "glissando stop,trill line start", "trill line stop"]);
    expect(marksOf(notes()[2])).toContain("trill-mark");
    expect([fingeringOf(notes()[3]), marksOf(notes()[3]).join()]).toEqual(["4", "up-bow"]);
    ed.addToChord(at(0, 0), P("E"));
    ed.mark(at(0, 0), "arpeggiate");
    expect(notes().filter((n) => marksOf(n).includes("arpeggiate"))).toHaveLength(2);
    ed.span("glissando", at(0, 1), null);
    expect(spansOf(notes()[2]).filter((x) => x.kind === "glissando")).toHaveLength(0);
  });

  it("adds hammer-ons, pull-offs and bends, which playback bends", () => {
    const s = score(note("C", 1, "quarter") + note("D", 1, "quarter") + note("E", 1, "quarter") + note("F", 1, "quarter"));
    const ed = new ScoreEditor(s);
    const notes = () => Array.from(s.measures[0][0].getElementsByTagName("note"));
    ed.span("hammer-on", at(0, 0), null);
    ed.span("pull-off", at(0, 1), null);
    ed.bends(notes()[3], [{ alter: 2 }, { alter: 2, release: true }]);
    expect(notes().map((n) => spansOf(n).map((x) => `${x.kind} ${x.type}`).join())).toEqual(["hammer-on start", "hammer-on stop,pull-off start", "pull-off stop", ""]);
    expect(bendsOf(notes()[3])).toEqual([{ alter: 2 }, { alter: 2, release: true }]);
    expect(buildTimeline(s).events[3].bend).toBeTruthy();
    ed.bends(notes()[3], []);
    expect(bendsOf(notes()[3])).toEqual([]);
  });

  it("sets plucks, holes and arrows, and copies any other technical sign", () => {
    const s = score(note("C", 1, "quarter") + note("D", 1, "quarter") + note("E", 1, "quarter") + note("F", 1, "quarter"));
    const ed = new ScoreEditor(s);
    const notes = () => Array.from(s.measures[0][0].getElementsByTagName("note"));
    ed.techValue(notes()[0], "pluck", "m");
    ed.techValue(notes()[1], "hole", "half");
    ed.techValue(notes()[2], "arrow", "down");
    ed.addTechnical(notes()[3], "<handbell>damp</handbell>");
    expect([techValue(notes()[0], "pluck"), techValue(notes()[1], "hole"), techValue(notes()[2], "arrow")]).toEqual(["m", "half", "down"]);
    expect(otherTechnical(notes()[3])).toEqual(["<handbell>damp</handbell>"]);
    ed.techValue(notes()[0], "pluck", "");
    expect(techValue(notes()[0], "pluck")).toBe("");
  });
});
