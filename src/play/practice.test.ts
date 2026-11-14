// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { ScoreDoc } from "../model/score";
import { WaitMatcher, practiceGroups } from "./practice";
import { buildTimeline } from "./timeline";

const n = (step: string, dur: number, extra = "", octave = 4, staff = 0) =>
  `<note>${extra.includes("<grace") ? extra : ""}${extra.includes("<chord/>") ? "<chord/>" : ""}<pitch><step>${step}</step><octave>${octave}</octave></pitch><duration>${dur}</duration>${extra.replace("<chord/>", "").replace(/<grace[^>]*>/, "")}${staff ? `<staff>${staff}</staff>` : ""}</note>`;
const ATTR = `<attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>`;
const PIANO = `<attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time><staves>2</staves></attributes>`;
const part = (id: string, measures: string[]) => `<part id="${id}">${measures.map((m, i) => `<measure number="${i + 1}">${m}</measure>`).join("")}</part>`;
const doc = (...parts: string[][]) =>
  new ScoreDoc(
    `<score-partwise><part-list>${parts.map((_, i) => `<score-part id="P${i + 1}"><part-name>P${i + 1}</part-name></score-part>`).join("")}</part-list>${parts.map((m, i) => part(`P${i + 1}`, m)).join("")}</score-partwise>`,
  );
const groups = (s: ScoreDoc, target = {}) => practiceGroups(buildTimeline(s), target).map((g) => g.pitches);
const back = `<backup><duration>4</duration></backup>`;

describe("practice groups", () => {
  it("groups a chord and keeps melody notes apart", () => {
    const s = doc([ATTR + n("C", 2) + n("E", 2, "<chord/>") + n("G", 2, "<chord/>") + n("D", 1) + n("E", 1)]);
    expect(groups(s)).toEqual([[60, 64, 67], [62], [64]]);
  });

  it("keeps repeated notes as groups of their own", () => {
    const s = doc([ATTR + n("C", 1) + n("C", 1) + n("C", 2)]);
    expect(groups(s)).toEqual([[60], [60], [60]]);
  });

  it("does not expect a tied note again", () => {
    const s = doc([ATTR + n("C", 2) + n("D", 2, `<tie type="start"/>`), n("D", 2, `<tie type="stop"/>`) + n("E", 2)]);
    expect(groups(s)).toEqual([[60], [62], [64]]);
  });

  it("skips grace notes and expects an ornament's written note once", () => {
    const tr = `<notations><ornaments><trill-mark/></ornaments></notations>`;
    const mo = `<notations><ornaments><mordent/></ornaments></notations>`;
    const s = doc([ATTR + n("D", 0, `<grace slash="yes"/>`) + n("C", 2, tr) + n("E", 2, mo)]);
    expect(groups(s)).toEqual([[60], [64]]);
  });

  it("chooses parts, and a hand of a piano", () => {
    const s = doc([PIANO + n("E", 4, "", 5, 1) + back + n("C", 2, "", 3, 2) + n("G", 2, "", 2, 2)], [ATTR + n("A", 4)]);
    expect(groups(s)).toEqual([[48, 69, 76], [43]]);
    expect(groups(s, { parts: [0] })).toEqual([[48, 76], [43]]);
    expect(groups(s, { parts: [0], hand: "right" })).toEqual([[76]]);
    expect(groups(s, { parts: [0], hand: "left" })).toEqual([[48], [43]]);
    expect(groups(s, { parts: [1] })).toEqual([[69]]);
  });

  it("expects a repeated measure on each pass", () => {
    const s = doc([ATTR + `<barline location="left"><repeat direction="forward"/></barline>` + n("C", 4) + `<barline location="right"><repeat direction="backward"/></barline>`]);
    expect(groups(s)).toEqual([[60], [60]]);
  });
});

describe("wait matcher", () => {
  const s = doc([ATTR + n("C", 1) + n("E", 1, "<chord/>") + n("C", 1) + n("D", 2)]);
  const m = () => new WaitMatcher(practiceGroups(buildTimeline(s)));

  it("moves on once every pitch of a chord is struck, in any order", () => {
    const w = m();
    expect(w.noteOn(64)).toBe(false);
    expect(w.missing).toEqual([60]);
    expect(w.noteOn(60)).toBe(true);
    expect(w.index).toBe(1);
  });

  it("ignores extra wrong keys", () => {
    const w = m();
    expect(w.noteOn(61)).toBe(false);
    expect(w.noteOn(60)).toBe(false);
    expect(w.noteOn(65)).toBe(false);
    expect(w.noteOn(64)).toBe(true);
  });

  it("asks for a repeated note to be struck again", () => {
    const w = m();
    w.noteOn(60);
    w.noteOn(64);
    // C is still held from the chord: it does not count for the next C.
    expect(w.index).toBe(1);
    expect(w.missing).toEqual([60]);
    w.noteOff(64);
    expect(w.noteOn(64)).toBe(false);
    w.noteOff(60);
    expect(w.noteOn(60)).toBe(true);
    expect(w.noteOn(62)).toBe(true);
    expect(w.done).toBe(true);
    expect(w.current).toBeNull();
  });

  it("does not count a key struck while the group before was waited for", () => {
    const w = m();
    w.noteOn(62); // early, D is the third group
    w.noteOn(60);
    w.noteOn(64);
    w.noteOn(60);
    expect(w.missing).toEqual([62]);
    expect(w.noteOn(62)).toBe(true);
  });

  it("seeks to the first group from a time", () => {
    const w = m();
    w.noteOn(60);
    w.seek(0.3);
    expect(w.index).toBe(1);
    expect(w.noteOn(64)).toBe(false);
    w.seek(100);
    expect(w.done).toBe(true);
  });

  it("tracks the keys held", () => {
    const w = m();
    w.noteOn(70);
    w.noteOn(60);
    w.noteOff(70);
    expect([...w.held]).toEqual([60]);
  });
});
