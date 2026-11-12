// @vitest-environment happy-dom
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { ScoreEditor } from "../edit/editor";
import { noteList } from "../edit/rebuild";
import { INSTRUMENTS, instrument } from "../model/instruments";
import { loadScore } from "./load";
import { newMuseScore } from "./mscx-new";

const make = (keys: string[], o: Partial<Parameters<typeof newMuseScore>[0]> = {}) =>
  newMuseScore({ title: "Sketch", composer: "Someone", parts: keys.map((k) => ({ def: instrument(k)!, name: k })), fifths: -2, time: [3, 4], tempo: 96, pickup: 1, measures: 8, ...o });

describe("A new MuseScore score", () => {
  it("opens with its instruments, key, time, tempo and pickup", () => {
    const { score, save } = loadScore(make(["flute", "clarinet", "piano", "guitar", "drumset"]));
    expect(score.parts.map((p) => p.name)).toEqual(["flute", "clarinet", "piano", "guitar", "drumset"]);
    expect(score.measureCount).toBe(8);
    expect(save).toBeTruthy();
    const ed = new ScoreEditor(score);
    // The clarinet in B flat reads two sharps more than the score's B flat major.
    expect(ed.info(0, 1).fifths).toBe(-2);
    expect(ed.info(1, 1).fifths).toBe(0);
    expect(ed.isDrums(4)).toBe(true);
    // A pickup bar of one beat, left out of the bar numbers.
    expect(score.measures[0][0].getAttribute("implicit")).toBe("yes");
    expect(ed.info(0, 0).length).toBe(ed.info(0, 1).perQuarter);
  });

  it("writes every instrument of the list", () => {
    const text = strFromU8(unzipSync(make(INSTRUMENTS.map((i) => i.key)))["score.mscx"]);
    expect(text.match(/<Part id=/g)).toHaveLength(INSTRUMENTS.length);
    expect(text).toContain("<KeySig><concertKey>-2</concertKey><actualKey>0</actualKey></KeySig>");
    expect(text).toContain('<bracket type="1" span="2" col="0"/>');
    const { score } = loadScore(make(INSTRUMENTS.map((i) => i.key)));
    expect(score.parts).toHaveLength(INSTRUMENTS.length);
  });

  it("takes edits and saves them like any MuseScore file", () => {
    const loaded = loadScore(make(["violin", "cello"], { pickup: 0, fifths: 0, tempo: null }));
    const ed = new ScoreEditor(loaded.score);
    ed.enter({ part: 0, measure: 1, staff: 1, voice: "1", pos: 0 }, { pitches: [{ step: "A", alter: 0, octave: 4 }], quarters: 2 });
    ed.dynamic({ part: 0, measure: 1, staff: 1, voice: "1", pos: 0 }, "mf");
    const back = loadScore(loaded.save!().bytes).score;
    expect(noteList(back)).toEqual(noteList(loaded.score));
  });
});
