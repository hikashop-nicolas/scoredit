// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { ScoreDoc } from "../model/score";
import { TimeMatcher, WaitMatcher, heardAt, heardWhen, practiceGroups, timeWindow, type PracticeGroup } from "./practice";
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

describe("time matcher", () => {
  // Groups at these times (piece seconds) with these pitches.
  const G = (...gs: [number, number[]][]): PracticeGroup[] => gs.map(([time, pitches]) => ({ time, pitches, events: [] }));
  const tm = (...gs: [number, number[]][]) => {
    const t = new TimeMatcher(G(...gs));
    t.seek(0);
    return t;
  };

  it("judges a key on time, early or late within the window", () => {
    const t = tm([1, [60]], [2, [62]], [3, [64]], [4, [65]]);
    expect(t.noteOn(60, 1.03).outcome).toBe("on");
    expect(t.noteOn(62, 1.9).outcome).toBe("early");
    expect(t.noteOn(64, 3.08).outcome).toBe("late");
    expect(t.noteOn(65, 4.2).outcome).toBe("wrong");
    const c = t.counts;
    expect([c.onTime, c.early, c.late, c.wrong, c.missed, c.total]).toEqual([1, 1, 1, 1, 0, 4]);
    expect(t.notes[1].offsetMs).toBeCloseTo(-100);
  });

  it("calls a note missed once its window has passed", () => {
    const t = tm([1, [60]], [2, [62]]);
    expect(t.advance(1.1)).toEqual([]);
    expect(t.advance(1.13).map((n) => n.pitch)).toEqual([60]);
    expect(t.advance(1.5)).toEqual([]);
    expect(t.noteOn(60, 1.2).outcome).toBe("wrong");
    expect(t.advance(5).map((n) => n.pitch)).toEqual([62]);
    expect(t.counts).toMatchObject({ missed: 2, wrong: 1, accuracy: 0 });
  });

  it("counts a key that came in time even when handled after the note was called missed", () => {
    const t = tm([1, [60]]);
    t.advance(1.2);
    expect(t.noteOn(60, 1.1).outcome).toBe("late");
    expect(t.counts.missed).toBe(0);
  });

  it("matches each pitch of a chord on its own and keeps wrong keys from consuming notes", () => {
    const t = tm([1, [60, 64, 67]]);
    expect(t.noteOn(61, 1).outcome).toBe("wrong");
    expect(t.noteOn(64, 1.01).outcome).toBe("on");
    expect(t.noteOn(64, 1.02).outcome).toBe("wrong");
    expect(t.noteOn(67, 0.94).outcome).toBe("early");
    expect(t.due(1.05).map((n) => n.pitch)).toEqual([60]);
    expect(t.advance(2).map((n) => n.pitch)).toEqual([60]);
    expect(t.counts).toMatchObject({ onTime: 1, early: 1, missed: 1, wrong: 2, total: 3 });
    // (1 + 0.5) / (3 + 2)
    expect(t.counts.accuracy).toBe(30);
  });

  it("gives repeated notes of one pitch their own halves of the gap", () => {
    // Two Cs 0.1 s apart: the windows meet halfway, at 1.05.
    const t = tm([1, [60]], [1.1, [60]]);
    expect(t.noteOn(60, 1.06).note).toBe(t.notes[1]);
    expect(t.notes[1].offsetMs).toBeCloseTo(-40, 5);
    expect(t.noteOn(60, 1.04).note).toBe(t.notes[0]);
    expect(t.notes[0].offsetMs).toBeCloseTo(40, 5);
    expect(t.noteOn(60, 1.07).outcome).toBe("wrong");
    const u = tm([1, [60]], [1.1, [60]]);
    // Skipping the first C and playing the second on time leaves the first missed, not late.
    expect(u.noteOn(60, 1.1).outcome).toBe("on");
    expect(u.advance(1.3).map((n) => n.time)).toEqual([1]);
  });

  it("scales the window with the speed, in real time", () => {
    expect(timeWindow(1)).toEqual({ windowMs: 120, onTimeMs: 50 });
    expect(timeWindow(0.5)).toEqual({ windowMs: 240, onTimeMs: 100 });
    expect(timeWindow(2)).toEqual({ windowMs: 80, onTimeMs: 35 });
    // At half speed 0.05 s of piece time is 100 ms of real time: on time; 0.1 s is 200 ms: late.
    const t = tm([1, [60]], [2, [62]], [3, [64]]);
    expect(t.noteOn(60, 1.05, 0.5).outcome).toBe("on");
    expect(t.noteOn(62, 2.1, 0.5).outcome).toBe("late");
    expect(t.notes[1].offsetMs).toBeCloseTo(200);
    expect(t.advance(3.11, 0.5)).toEqual([]);
    expect(t.advance(3.121, 0.5).length).toBe(1);
    // At double speed 0.1 s of piece time is only 50 ms: late, not on time.
    const f = tm([1, [60]]);
    expect(f.noteOn(60, 1.1, 2).outcome).toBe("late");
  });

  it("leaves notes before the start of a run out, and starts counting again on a seek", () => {
    const t = tm([1, [60]], [2, [62]], [3, [64]]);
    t.noteOn(60, 1);
    t.seek(1.5);
    expect(t.counts).toMatchObject({ onTime: 0, total: 2 });
    expect(t.noteOn(60, 1).outcome).toBe("wrong");
    expect(t.advance(10).length).toBe(2);
  });

  it("reports the mean offset of the notes played, for calibration", () => {
    const t = tm([1, [60]], [2, [62]], [3, [64]]);
    t.noteOn(60, 1.04);
    t.noteOn(62, 2.06);
    t.noteOn(64, 3.08);
    expect(t.counts.meanOffsetMs).toBe(60);
  });

  it("maps a key's MIDI time to the piece time heard, less the latencies", () => {
    // The audio clock read 10 s at performance time 5000 ms; piece time 0 played at audio 9 s.
    const clock = { audio: 10, perf: 5000 };
    expect(heardAt(5000, clock, 9, 1, 0)).toBeCloseTo(1);
    expect(heardAt(5500, clock, 9, 1, 0)).toBeCloseTo(1.5);
    // Sound reaches the ear 40 ms later, plus a 20 ms user offset: the key is 60 ms earlier.
    expect(heardAt(5500, clock, 9, 1, 0.06)).toBeCloseTo(1.44);
    expect(heardAt(5500, clock, 9, 0.5, 0)).toBeCloseTo(0.75);
    expect(heardWhen(heardAt(5321, clock, 9, 0.75, 0.03), clock, 9, 0.75, 0.03)).toBeCloseTo(5321);
    // A key 60 ms late on the wire, with the offset set to 60 ms, is on time.
    const t = tm([1.5, [60]]);
    expect(t.noteOn(60, heardAt(heardWhen(1.5, clock, 9, 1, 0) + 60, clock, 9, 1, 0.06)).outcome).toBe("on");
  });
});
