// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { ScoreDoc } from "../model/score";
import { kids, text } from "../model/xml";
import { buildTimeline } from "../play/timeline";
import { ScoreEditor, type Caret } from "./editor";
import { readMeasure, voiceKey } from "./measure";
import { bendsOf, otherOrnaments, otherTechnical, techValue, fingeringOf, lyricsOf, marksOf, readPitch, slursOf, spansOf, tremoloOf, type Pitch } from "./notes";

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

  it("copies detailed and rare ornaments, and sets the accidental over one", () => {
    const s = score(note("C", 1, "quarter") + note("D", 1, "quarter") + note("E", 1, "quarter") + note("F", 1, "quarter"));
    const ed = new ScoreEditor(s);
    const notes = () => Array.from(s.measures[0][0].getElementsByTagName("note"));
    ed.addOrnament(notes()[0], '<mordent long="yes"/>');
    ed.addOrnament(notes()[1], "<inverted-vertical-turn/>");
    ed.mark(at(0, 2), "trill-mark");
    ed.ornamentAccidental(at(0, 2), "flat");
    expect(otherOrnaments(notes()[0])).toEqual(['<mordent long="yes"/>']);
    expect(otherOrnaments(notes()[2])).toEqual(['<accidental-mark placement="above">flat</accidental-mark>']);
    expect(marksOf(notes()[1])).toEqual(["inverted-vertical-turn"]);
    ed.ornamentAccidental(at(0, 2), "");
    expect(otherOrnaments(notes()[2])).toEqual([]);
  });
});

describe("Dynamics, hairpins, text and tempo", () => {
  const four = () => score(note("C", 1, "quarter") + note("D", 1, "quarter") + note("E", 1, "quarter") + note("F", 1, "quarter"), note("G", 4, "whole"));

  it("sets, replaces and takes off a dynamic at a beat", () => {
    const s = four();
    const ed = new ScoreEditor(s);
    ed.dynamic(at(0, 1), "p");
    expect(ed.directions(at(0, 1))).toEqual([{ kind: "dynamic", value: "p" }]);
    expect(ed.directions(at(0, 0))).toEqual([]);
    ed.dynamic(at(0, 1), "ff");
    expect(ed.directions(at(0, 1))).toEqual([{ kind: "dynamic", value: "ff" }]);
    // It sounds: playback reads its loudness.
    expect(s.measures[0][0].getElementsByTagName("sound")[0].getAttribute("dynamics")).toBe("124.44");
    ed.dynamic(at(0, 1), null);
    expect(ed.directions(at(0, 1))).toEqual([]);
    ed.undo();
    expect(ed.directions(at(0, 1))).toEqual([{ kind: "dynamic", value: "ff" }]);
    // The notes are untouched.
    expect(show(s, 0)).toBe("C4:1 D4:1 E4:1 F4:1");
  });

  it("draws a hairpin across the barline and takes it off", () => {
    const s = four();
    const ed = new ScoreEditor(s);
    ed.hairpin(at(0, 2), at(1, 0), "crescendo");
    expect(ed.directions(at(0, 2))).toEqual([{ kind: "wedge", type: "crescendo", number: 1 }]);
    // The stop stands at the end of the last note: the end of bar 2, the last one.
    const stops = readMeasure(s.measures[0][1]).others.filter((o) => o.el.tagName === "direction");
    expect(stops.map((o) => o.pos)).toEqual([4]);
    // Ending on a barline with a bar after: at that bar's start, as MuseScore keeps it.
    ed.hairpin(at(0, 0), at(0, 3), "diminuendo");
    expect(ed.directions(at(1, 0))).toEqual([{ kind: "wedge", type: "stop", number: 2 }]);
    ed.hairpin(at(0, 0), null, null);
    ed.hairpin(at(0, 2), null, null);
    expect(s.root.getElementsByTagName("wedge")).toHaveLength(0);
    ed.undo();
    expect(s.root.getElementsByTagName("wedge")).toHaveLength(2);
  });

  it("writes text of each kind and a tempo mark", () => {
    const s = four();
    const ed = new ScoreEditor(s);
    ed.text(at(0, 0), "staff", "pizz.");
    ed.text(at(0, 0), "expression", "dolce");
    ed.text(at(0, 0), "rehearsal", "A");
    ed.tempo(at(0, 0), 72, "Adagio");
    expect(ed.directions(at(0, 0))).toEqual(
      expect.arrayContaining([
        { kind: "text", text: "staff", words: "pizz." },
        { kind: "text", text: "expression", words: "dolce" },
        { kind: "text", text: "rehearsal", words: "A" },
        { kind: "tempo", bpm: 72, words: "Adagio" },
      ]),
    );
    expect(buildTimeline(s).events.length).toBeGreaterThan(0);
    ed.text(at(0, 0), "expression", null);
    expect(ed.directions(at(0, 0)).filter((d) => d.kind === "text")).toHaveLength(2);
  });
});

describe("Transposing", () => {
  const keyOf = (s: ScoreDoc, m: number) => Array.from(s.measures[0][m].getElementsByTagName("fifths")).map((f) => Number(f.textContent));

  it("moves the notes by an interval, spelled by it, and the key with them", () => {
    const s = score(note("C", 1, "quarter") + note("E", 1, "quarter") + note("F", 1, "quarter", "<accidental>sharp</accidental>").replace("<step>F</step>", "<step>F</step><alter>1</alter>") + note("B", 1, "quarter"), note("G", 4, "whole"));
    const ed = new ScoreEditor(s);
    ed.transposeRange(null, 0, 2, 1, 2); // a major 2nd up
    expect(show(s, 0)).toBe("D4:1 F#4:1 G#4:1 C#5:1");
    expect(show(s, 1)).toBe("A4:4");
    expect(keyOf(s, 0)).toEqual([2]);
    ed.undo();
    expect(show(s, 0)).toBe("C4:1 E4:1 F#4:1 B4:1");
    expect(keyOf(s, 0)).toEqual([0]);
  });

  it("gives a range inside the score its own key, and the old one back after it", () => {
    const s = score(note("C", 4, "whole"), note("D", 4, "whole"), note("E", 4, "whole"));
    const ed = new ScoreEditor(s);
    ed.transposeRange(null, 1, 2, -2, -3); // a minor 3rd down
    expect(show(s, 1)).toBe("B3:4");
    expect(keyOf(s, 0)).toEqual([0]);
    expect(keyOf(s, 1)).toEqual([3]); // A major
    expect(keyOf(s, 2)).toEqual([0]);
    expect(show(s, 2)).toBe("E4:4");
  });

  it("finds the interval to a key, and moves chord symbols", async () => {
    const { intervalToKey, plainKey } = await import("./transpose");
    expect(intervalToKey(0, -3, "closest")).toEqual([2, 3]); // C to E flat: a minor 3rd up
    expect(intervalToKey(0, 3, "closest")).toEqual([-2, -3]); // C to A: a minor 3rd down
    expect(intervalToKey(0, 3, "up")).toEqual([5, 9]);
    expect(intervalToKey(7, -5, "closest")).toEqual([1, 0]); // C sharp to D flat: spelled anew
    expect(plainKey(9)).toBe(-3);
    const s = score(`<harmony><root><root-step>F</root-step></root><kind>major</kind><bass><bass-step>A</bass-step></bass></harmony>` + note("F", 4, "whole"));
    new ScoreEditor(s).transposeRange(null, 0, 1, 4, 7); // a fifth up
    const h = s.measures[0][0].getElementsByTagName("harmony")[0];
    expect([text(h, "root"), text(h, "bass")].map((x) => x.replace(/\s/g, ""))).toEqual(["C", "E"]);
  });
});

describe("Key and clef changes", () => {
  const three = () => score(note("F", 4, "whole"), note("F", 4, "whole"), note("F", 4, "whole"));
  const keys = (s: ScoreDoc) => s.measures[0].map((m) => Array.from(m.getElementsByTagName("fifths")).map((f) => Number(f.textContent)));

  it("sets a key from a bar on, keeping the pitches, and takes it off again", () => {
    const s = three();
    const ed = new ScoreEditor(s);
    ed.setKey(1, -1);
    expect(keys(s)).toEqual([[0], [-1], []]);
    expect(show(s, 1)).toBe("F4:4");
    ed.setKey(1, 0);
    expect(keys(s)).toEqual([[0], [], []]);
    ed.setKey(0, 3);
    expect(keys(s)).toEqual([[3], [], []]);
    ed.undo();
    expect(keys(s)).toEqual([[0], [], []]);
  });

  it("puts a clef change at the end of the bar before, as MuseScore keeps it", () => {
    const s = three();
    const ed = new ScoreEditor(s);
    ed.setClef(0, 1, 2, { sign: "F", line: 4 });
    const at = (m: number) => readMeasure(s.measures[0][m]).others.filter((o) => o.el.tagName === "attributes" && o.el.getElementsByTagName("clef").length).map((o) => [o.pos, text(o.el.getElementsByTagName("clef")[0], "sign")]);
    expect(at(1)).toEqual([[4, "F"]]);
    expect(s.attributesAt(0, 2).find((e) => e.tagName === "clef")?.textContent).toContain("F");
    // The clef already in force: nothing drawn; back to G: the change goes.
    ed.setClef(0, 1, 2, { sign: "G", line: 2 });
    expect(at(1)).toEqual([]);
    ed.setClef(0, 1, 0, { sign: "C", line: 3 });
    expect(text(s.measures[0][0].getElementsByTagName("clef")[0], "sign")).toBe("C");
  });
});

describe("Adding and taking out bars", () => {
  const four = () => score(note("C", 4, "whole", '<tie type="start"/><notations><tied type="start"/></notations>'.replace(/^/, "")), note("C", 4, "whole"), note("E", 4, "whole"), note("F", 4, "whole"));
  const all = (s: ScoreDoc) => s.measures[0].map((_, m) => show(s, m)).join(" | ");

  it("inserts empty bars in the middle, at the start and at the end", () => {
    const s = four();
    const ed = new ScoreEditor(s);
    ed.insertMeasures(2, 2);
    expect(all(s)).toBe("C4:4~ | C4:4 | r:4 | r:4 | E4:4 | F4:4");
    expect(s.measures[0].map((m) => m.getAttribute("number"))).toEqual(["1", "2", "3", "4", "5", "6"]);
    expect(s.origins).toEqual([0, 1, -1, -1, 2, 3]);
    ed.insertMeasures(0);
    // The opening clef, key and time moved to the new first bar.
    expect(kids(s.measures[0][0], "attributes")).toHaveLength(1);
    expect(kids(s.measures[0][1], "attributes")).toHaveLength(0);
    expect(all(s)).toBe("r:4 | C4:4~ | C4:4 | r:4 | r:4 | E4:4 | F4:4");
    ed.insertMeasures(s.measureCount);
    expect(s.measureCount).toBe(8);
    ed.undo();
    ed.undo();
    ed.undo();
    expect(all(s)).toBe("C4:4~ | C4:4 | E4:4 | F4:4");
    expect(s.origins).toBe(null);
  });

  it("cuts the tie across an inserted bar", () => {
    const s = four();
    new ScoreEditor(s).insertMeasures(1);
    expect(all(s)).toBe("C4:4 | r:4 | C4:4 | E4:4 | F4:4");
  });

  it("takes out bars, carrying a key change in them to the next bar", () => {
    const s = four();
    const ed = new ScoreEditor(s);
    ed.setKey(2, 2);
    ed.deleteMeasures(1, 3);
    expect(all(s)).toBe("C4:4 | F4:4");
    expect(text(s.measures[0][1], "attributes")).toContain("2");
    expect(s.origins).toEqual([0, 3]);
    // Not every bar.
    expect(ed.deleteMeasures(0, 2).to).toBe(0);
    ed.deleteMeasures(0, 1);
    expect(all(s)).toBe("F4:4");
    expect(kids(s.measures[0][0], "attributes").flatMap((a) => kids(a)).map((e) => e.tagName)).toEqual(expect.arrayContaining(["divisions", "key", "time", "clef"]));
  });
});

describe("Time signature changes", () => {
  const timeOf = (s: ScoreDoc, m: number) => Array.from(s.measures[0][m].getElementsByTagName("time")).map((t) => `${text(t, "beats")}/${text(t, "beat-type")}`);
  const all = (s: ScoreDoc) => s.measures[0].map((_, m) => show(s, m)).join(" | ");

  it("pours the music into bars of the new length, tying what a bar line cuts", () => {
    const s = score(note("C", 2, "half") + note("D", 2, "half"), note("E", 4, "whole"), note("F", 4, "whole"));
    const ed = new ScoreEditor(s);
    const r = ed.setTime(0, 3, 4);
    expect(r.refused).toBeUndefined();
    expect(all(s)).toBe("C4:2 D4:1~ | D4:1 E4:2~ | E4:2 F4:1~ | F4:3");
    expect(timeOf(s, 0)).toEqual(["3/4"]);
    expect(s.measures[0].map((m) => m.getAttribute("number"))).toEqual(["1", "2", "3", "4"]);
    ed.undo();
    expect(all(s)).toBe("C4:2 D4:2 | E4:4 | F4:4");
    expect(timeOf(s, 0)).toEqual(["4/4"]);
  });

  it("stops at the next time signature, and fills the last bar with rests", () => {
    const s = score(note("C", 4, "whole"), note("D", 4, "whole"), note("E", 4, "whole"));
    const ed = new ScoreEditor(s);
    ed.setTime(2, 3, 4);
    expect(all(s)).toBe("C4:4 | D4:4 | E4:3~ | E4:1 r:1 r:1");
    // 2/4 at bar 2 runs up to the 3/4 of bar 3 only.
    ed.setTime(1, 2, 4);
    expect(all(s)).toBe("C4:4 | D4:2~ | D4:2 | E4:3~ | E4:1 r:1 r:1");
    expect([1, 3].map((m) => timeOf(s, m))).toEqual([["2/4"], ["3/4"]]);
  });

  it("is refused when a repeat would fall inside a bar, or a triplet would be cut", () => {
    const s = score(note("C", 4, "whole"), note("D", 4, "whole") + `<barline location="right"><bar-style>light-heavy</bar-style><repeat direction="backward"/></barline>`, note("E", 4, "whole"));
    const ed = new ScoreEditor(s);
    expect(ed.setTime(0, 3, 4).refused).toEqual({ measure: 2, reason: "repeat" });
    expect(all(s)).toBe("C4:4 | D4:4 | E4:4");
    // 2/4 keeps it on a bar line.
    expect(ed.setTime(0, 2, 4).refused).toBeUndefined();
    const t = score(note("C", 1, "quarter") + ["D", "E", "F"].map((x) => note(x, 1, "quarter").replace("<duration>1</duration>", "<duration>1</duration>")).join("") );
    const e2 = new ScoreEditor(t);
    e2.tuplet({ part: 0, measure: 0, staff: 1, voice: "1", pos: 2 }, 2);
    expect(e2.setTime(0, 5, 8).refused?.reason).toBe("tuplet");
  });
});

describe("Instruments", () => {
  const flute = () => score(note("C", 1, "quarter") + note("D", 1, "quarter") + note("E", 1, "quarter") + note("F", 1, "quarter"), note("G", 4, "whole"));
  const part = (s: ScoreDoc, p: number, m: number) => {
    const per = Number(s.measures[p][0].getElementsByTagName("divisions")[0]?.textContent) || 1;
    return (readMeasure(s.measures[p][m]).voices.get(voiceKey(1, [...readMeasure(s.measures[p][m]).voices.keys()][0]?.split("|")[1] ?? "1")) ?? [])
      .map((e) => (e.rest ? "r" : e.notes.map((n) => `${text(n.getElementsByTagName("pitch")[0], "step")}${text(n.getElementsByTagName("pitch")[0], "alter") === "1" ? "#" : ""}${text(n.getElementsByTagName("pitch")[0], "octave")}`).join("+")) + ":" + e.dur / per)
      .join(" ");
  };

  it("adds a B flat clarinet with its written key and empty bars, and takes it out again", async () => {
    const { instrument } = await import("../model/instruments");
    const s = flute();
    const ed = new ScoreEditor(s);
    ed.addPart(instrument("clarinet")!, "Clarinet");
    expect(s.parts.map((p) => p.name)).toEqual(["Flute", "Clarinet"]);
    expect(s.measures[1]).toHaveLength(2);
    expect(ed.info(1, 0).fifths).toBe(2);
    expect(text(s.measures[1][0].getElementsByTagName("transpose")[0], "chromatic")).toBe("-2");
    expect(part(s, 1, 0)).toBe("r:4");
    expect(s.partOrigins).toEqual([0, -1]);
    ed.addPart(instrument("piano")!, "Piano");
    expect(Array.from(s.measures[2][0].getElementsByTagName("sign")).map((x) => x.textContent)).toEqual(["G", "F"]);
    ed.removePart(1);
    expect(s.parts.map((p) => p.name)).toEqual(["Flute", "Piano"]);
    expect(s.partOrigins).toEqual([0, -1]);
    ed.undo();
    ed.undo();
    ed.undo();
    expect(s.parts.map((p) => p.name)).toEqual(["Flute"]);
    expect(s.partOrigins).toBe(null);
  });

  it("changes a flute into a clarinet: the music sounds the same, written a tone higher", async () => {
    const { instrument } = await import("../model/instruments");
    const s = flute();
    const ed = new ScoreEditor(s);
    expect(ed.changePart(0, instrument("clarinet")!, "Clarinet")).not.toBe(null);
    expect(s.parts[0].name).toBe("Clarinet");
    expect(part(s, 0, 0)).toBe("D4:1 E4:1 F#4:1 G4:1");
    expect(ed.info(0, 0).fifths).toBe(2);
    // A piano has two staves: the second one comes with it.
    expect(ed.changePart(0, instrument("piano")!, "Piano")).not.toBe(null);
    // A drum kit is not a pitched instrument: refused.
    expect(ed.changePart(0, instrument("drumset")!, "Drums")).toBe(null);
  });

  it("enters drums on a new drum kit from the kit's places", async () => {
    const { instrument } = await import("../model/instruments");
    const s = flute();
    const ed = new ScoreEditor(s);
    ed.addPart(instrument("drumset")!, "Drums");
    expect(ed.isDrums(1)).toBe(true);
    const snare = ed.drumAt(1, "C", 5);
    expect(snare?.instrument).toBe(`${s.parts[1].id}-I39`);
    ed.enter({ part: 1, measure: 0, staff: 1, voice: ed.voiceId(1, 1, 1), pos: 0 }, { pitches: [snare!], quarters: 1 });
    expect(s.measures[1][0].getElementsByTagName("unpitched")).toHaveLength(1);
  });
});

describe("Chord symbols", () => {
  it("reads typed chords, and sets, replaces and takes them off", async () => {
    const { parseChord, chordText } = await import("./chords");
    expect(parseChord("Cm7")).toMatchObject({ root: { step: "C", alter: 0 }, kind: "minor-seventh", suffix: "m7" });
    expect(parseChord("Bb/D")).toMatchObject({ root: { step: "B", alter: -1 }, kind: "major", bass: { step: "D", alter: 0 } });
    expect(parseChord("F#m7b5")?.kind).toBe("half-diminished");
    expect(parseChord("hello")).toBe(null);
    expect(chordText(parseChord("bb7")!)).toBe("B♭7");
    const s = score(note("C", 2, "half") + note("D", 2, "half"));
    const ed = new ScoreEditor(s);
    expect(ed.chordSymbol(at(0, 0), "C").ok).toBe(true);
    expect(ed.chordSymbol(at(0, 2), "G7/B").ok).toBe(true);
    expect(ed.chordSymbolAt(at(0, 2))).toBe("G7/B");
    expect(ed.chordSymbol(at(0, 0), "nonsense").ok).toBe(false);
    ed.chordSymbol(at(0, 0), "Am");
    expect(ed.chordSymbolAt(at(0, 0))).toBe("Am");
    ed.chordSymbol(at(0, 0), null);
    expect(ed.chordSymbolAt(at(0, 0))).toBe("");
    expect(s.measures[0][0].getElementsByTagName("harmony")).toHaveLength(1);
  });
});

describe("Keys from a MIDI keyboard", () => {
  it("knows how far a transposing part sounds from its written notes", () => {
    const s = new ScoreDoc(`<score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Clarinet in Bb</part-name></score-part><score-part id="P2"><part-name>Flute</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions><key><fifths>2</fifths></key><transpose><diatonic>-1</diatonic><chromatic>-2</chromatic></transpose></attributes>${rest}</measure></part><part id="P2"><measure number="1"><attributes><divisions>1</divisions></attributes>${rest}</measure></part></score-partwise>`);
    const ed = new ScoreEditor(s);
    expect(ed.soundingShift(0)).toBe(-2);
    expect(ed.soundingShift(1)).toBe(0);
  });

  it("finds the drum a key plays, where the part writes it", () => {
    const s = new ScoreDoc(`<score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Drums</part-name><score-instrument id="P1-I36"><instrument-name>Bass Drum</instrument-name></score-instrument><score-instrument id="P1-I39"><instrument-name>Snare</instrument-name></score-instrument><midi-instrument id="P1-I36"><midi-channel>10</midi-channel><midi-unpitched>37</midi-unpitched></midi-instrument><midi-instrument id="P1-I39"><midi-channel>10</midi-channel><midi-unpitched>39</midi-unpitched></midi-instrument></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions><clef><sign>percussion</sign></clef></attributes><note><unpitched><display-step>F</display-step><display-octave>4</display-octave></unpitched><duration>4</duration><instrument id="P1-I36"/><voice>1</voice><type>whole</type></note></measure></part></score-partwise>`);
    const ed = new ScoreEditor(s);
    expect(ed.drumForKey(0, 36)).toMatchObject({ step: "F", octave: 4, unpitched: true, instrument: "P1-I36" });
    expect(ed.drumForKey(0, 38)).toMatchObject({ step: "C", octave: 5, unpitched: true, instrument: "P1-I39" });
    expect(ed.drumForKey(0, 60)).toBeNull();
  });
});
