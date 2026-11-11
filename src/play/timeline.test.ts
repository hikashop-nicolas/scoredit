// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { ScoreDoc } from "../model/score";
import { positionAt } from "./player";
import { buildTimeline, playOrder, upperNeighbour } from "./timeline";

const n = (step: string, dur: number, extra = "", octave = 4) => `<note><pitch><step>${step}</step><octave>${octave}</octave></pitch><duration>${dur}</duration>${extra}</note>`;
const score = (measures: string[], partList = `<score-part id="P1"><part-name>P</part-name></score-part>`) =>
  `<score-partwise><part-list>${partList}</part-list><part id="P1">${measures.map((m, i) => `<measure number="${i + 1}">${m}</measure>`).join("")}</part></score-partwise>`;
const ATTR = `<attributes><divisions>1</divisions><time><beats>2</beats><beat-type>4</beat-type></time></attributes>`;
const fwd = `<barline location="left"><repeat direction="forward"/></barline>`;
const back = `<barline location="right"><repeat direction="backward"/></barline>`;

describe("playOrder", () => {
  it("plays a repeated section twice", () => {
    const s = new ScoreDoc(score([ATTR + n("C", 2), fwd + n("D", 2), n("E", 2) + back, n("F", 2)]));
    expect(playOrder(s)).toEqual([0, 1, 2, 1, 2, 3]);
  });

  it("repeats from the start without a forward sign, and honours times", () => {
    const s = new ScoreDoc(score([ATTR + n("C", 2), n("D", 2) + `<barline location="right"><repeat direction="backward" times="3"/></barline>`]));
    expect(playOrder(s)).toEqual([0, 1, 0, 1, 0, 1]);
  });

  it("takes the first ending, then the second", () => {
    const e1 = `<barline location="left"><ending number="1" type="start"/></barline>`;
    const e1end = `<barline location="right"><ending number="1" type="stop"/><repeat direction="backward"/></barline>`;
    const e2 = `<barline location="left"><ending number="2" type="start"/></barline>`;
    const e2end = `<barline location="right"><ending number="2" type="discontinue"/></barline>`;
    const s = new ScoreDoc(score([ATTR + n("C", 2), e1 + n("D", 2) + e1end, e2 + n("E", 2) + e2end, n("F", 2)]));
    expect(playOrder(s)).toEqual([0, 1, 0, 2, 3]);
  });
});

describe("jumps", () => {
  const dir = (snd: string) => `<direction><direction-type><words>x</words></direction-type><sound ${snd}/></direction>`;
  it("plays D.C. al Fine without the repeats", () => {
    const s = new ScoreDoc(score([ATTR + n("C", 2), n("D", 2) + dir('fine="yes"') + back, n("E", 2) + dir('dacapo="yes"')]));
    expect(playOrder(s)).toEqual([0, 1, 0, 1, 2, 0, 1]);
  });

  it("plays D.S. al Coda", () => {
    const s = new ScoreDoc(score([ATTR + n("C", 2), dir('segno="s"') + n("D", 2), n("E", 2) + dir('tocoda="c"'), n("F", 2) + dir('dalsegno="s"'), dir('coda="c"') + n("G", 2)]));
    expect(playOrder(s)).toEqual([0, 1, 2, 3, 1, 2, 4]);
  });
});

describe("buildTimeline", () => {
  it("times notes from tempo and divisions", () => {
    const tempo = `<direction><direction-type><words>Allegro</words></direction-type><sound tempo="120"/></direction>`;
    const tl = buildTimeline(new ScoreDoc(score([ATTR + tempo + n("C", 1) + n("D", 1), n("E", 2)])));
    expect(tl.events.map((e) => [e.midi, e.time, e.dur])).toEqual([
      [60, 0, 0.5],
      [62, 0.5, 0.5],
      [64, 1, 1],
    ]);
    expect(tl.duration).toBe(2);
    expect(tl.spans.map((s) => [s.measure, s.start, s.end])).toEqual([
      [0, 0, 1],
      [1, 1, 2],
    ]);
  });

  it("joins tied notes, also across a barline, and keeps chords together", () => {
    const tl = buildTimeline(new ScoreDoc(score([ATTR + n("C", 2, `<tie type="start"/>`) + n("E", 2, "<chord/>"), n("C", 2, `<tie type="stop"/>`)])));
    const c = tl.events.filter((e) => e.midi === 60);
    expect(c).toHaveLength(1);
    expect(c[0].dur).toBeCloseTo(2 * 2 * 0.6, 5); // two half bars at 100 bpm
    expect(tl.events.find((e) => e.midi === 64)!.time).toBe(0);
  });

  it("applies accidentals, transposition and the instrument's program", () => {
    const part = `<score-part id="P1"><part-name>Clarinet</part-name><midi-instrument id="I"><midi-channel>1</midi-channel><midi-program>72</midi-program></midi-instrument></score-part>`;
    const at = `<attributes><divisions>1</divisions><transpose><diatonic>-1</diatonic><chromatic>-2</chromatic></transpose></attributes>`;
    const tl = buildTimeline(new ScoreDoc(score([at + `<note><pitch><step>F</step><alter>1</alter><octave>4</octave></pitch><duration>1</duration></note>`], part)));
    expect(tl.events[0].midi).toBe(64); // written F#4 sounds E4
    expect([...tl.programs.values()]).toEqual([71]);
  });

  it("skips rests but lets them take time", () => {
    const tl = buildTimeline(new ScoreDoc(score([ATTR + `<note><rest/><duration>1</duration></note>` + n("G", 1)])));
    expect(tl.events.map((e) => e.onset)).toEqual([1]);
  });

  it("finds the measure and beat at a time", () => {
    const tl = buildTimeline(new ScoreDoc(score([ATTR + n("C", 2), n("D", 2)])));
    const p = positionAt(tl.spans, 1.5);
    expect(p.span).toBe(1);
    expect(p.quarter).toBeCloseTo(0.5, 5);
  });
});

describe("ornaments and pedal", () => {
  const Q = `<attributes><divisions>4</divisions><key><fifths>1</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time></attributes>`;
  const orn = (x: string) => `<notations><ornaments>${x}</ornaments></notations>`;

  it("finds the upper neighbour in the key", () => {
    expect(upperNeighbour("E", 4, 1)).toBe(66); // F# in G major
    expect(upperNeighbour("A", 4, -1)).toBe(70); // Bb in F major
    expect(upperNeighbour("B", 4, 0)).toBe(72); // C5
  });

  it("plays a trill as an alternation with the upper note", () => {
    const tl = buildTimeline(new ScoreDoc(score([Q + n("E", 16, orn("<trill-mark/>"))])));
    const pitches = tl.events.map((e) => e.midi);
    expect(pitches.length).toBeGreaterThan(8);
    expect(new Set(pitches)).toEqual(new Set([64, 66]));
    expect(pitches[0]).toBe(64);
    expect(tl.events.at(-1)!.time + tl.events.at(-1)!.dur).toBeCloseTo(4 * 0.6, 5);
  });

  it("repeats a single-note tremolo at its stroke value", () => {
    const tl = buildTimeline(new ScoreDoc(score([Q + n("C", 8, orn(`<tremolo type="single">2</tremolo>`))])));
    expect(tl.events).toHaveLength(8); // a half note in 16ths
    expect(new Set(tl.events.map((e) => e.midi))).toEqual(new Set([60]));
  });

  it("alternates the two chords of a two-chord tremolo over both lengths", () => {
    const tl = buildTimeline(new ScoreDoc(score([Q + n("C", 8, orn(`<tremolo type="start">2</tremolo>`)) + n("G", 8, orn(`<tremolo type="stop">2</tremolo>`))])));
    expect(tl.events.map((e) => e.midi)).toEqual([60, 67, 60, 67, 60, 67, 60, 67, 60, 67, 60, 67, 60, 67, 60, 67]);
  });

  it("turns pedal marks into sustain changes", () => {
    const ped = (t: string) => `<direction><direction-type><pedal type="${t}"/></direction-type></direction>`;
    const tl = buildTimeline(new ScoreDoc(score([Q + ped("start") + n("C", 8) + ped("stop") + n("D", 8)])));
    expect(tl.controls.map((c) => [c.cc, c.value, c.time])).toEqual([
      [64, 127, 0],
      [64, 0, 1.2],
    ]);
  });

  it("sounds once a note doubled on a linked staff", () => {
    const two = `<attributes><divisions>1</divisions><staves>2</staves></attributes>`;
    const tl = buildTimeline(new ScoreDoc(score([two + n("C", 4, "<staff>1</staff>") + `<backup><duration>4</duration></backup>` + n("C", 4, "<staff>2</staff>")])));
    expect(tl.events).toHaveLength(1);
  });
});
