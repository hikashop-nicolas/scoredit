// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { ScoreEditor, type Caret } from "../edit/editor";
import { readPitch, type Pitch } from "../edit/notes";
import { loadScore } from "./load";
import { readMidiEvents } from "./midi";
import { soundingNotes } from "./midi-save";

// A small SMF writer that plays like a person: off-grid ticks, velocities, controllers,
// pitch bends, a sysex, running status wherever the status repeats.
const PPQ = 480;
type Ev = [tick: number, bytes: number[]];
const vlq = (n: number) => {
  const out = [n & 0x7f];
  while ((n >>= 7)) out.unshift((n & 0x7f) | 0x80);
  return out;
};
const meta = (tick: number, type: number, data: number[]): Ev => [tick, [0xff, type, ...vlq(data.length), ...data]];
const tempo = (tick: number, us: number) => meta(tick, 0x51, [us >> 16, (us >> 8) & 0xff, us & 0xff]);
const time = (tick: number, n: number, d: number) => meta(tick, 0x58, [n, Math.log2(d), 24, 8]);
const key = (tick: number, fifths: number) => meta(tick, 0x59, [fifths & 0xff, 0]);
const name = (s: string) => meta(0, 3, [...s].map((c) => c.charCodeAt(0)));
/** Notes as [pitch, on tick, off tick, velocity], their offs as note on at velocity 0. */
const notes = (ch: number, list: [number, number, number, number][]): Ev[] => list.flatMap(([p, on, off, v]) => [[on, [0x90 | ch, p, v]] as Ev, [off, [0x90 | ch, p, 0]] as Ev]);
function smf(tracks: Ev[][], format = 1): Uint8Array {
  const bytes = [...[..."MThd"].map((c) => c.charCodeAt(0)), 0, 0, 0, 6, 0, format, 0, tracks.length, PPQ >> 8, PPQ & 0xff];
  for (const tr of tracks) {
    // Stable: at one tick, offs first, then the rest as given.
    const evs = tr.map((e, i) => ({ e, i })).sort((a, b) => a.e[0] - b.e[0] || Number(a.e[1][2] !== 0) - Number(b.e[1][2] !== 0) || a.i - b.i);
    const body: number[] = [];
    let at = 0;
    let status = 0;
    for (const { e: [tick, b] } of evs) {
      body.push(...vlq(tick - at));
      if (b[0] < 0xf0 && b[0] === status) body.push(...b.slice(1));
      else body.push(...b);
      status = b[0] < 0xf0 ? b[0] : 0;
      at = tick;
    }
    body.push(0, 0xff, 0x2f, 0);
    bytes.push(...[..."MTrk"].map((c) => c.charCodeAt(0)), (body.length >>> 24) & 0xff, (body.length >> 16) & 0xff, (body.length >> 8) & 0xff, body.length & 0xff, ...body);
  }
  return new Uint8Array(bytes);
}

const conductor = (): Ev[] => [name("Song"), tempo(0, 500000), time(0, 4, 4), key(0, 0), tempo(1930, 480000)];
// Bar 1: C4 E4 G4 C5 quarters, played a little loose; bar 2: a held chord.
const melody: [number, number, number, number][] = [
  [60, 3, 470, 81],
  [64, 478, 930, 77],
  [67, 962, 1418, 90],
  [72, 1436, 1900, 70],
  [60, 1921, 3800, 60],
  [67, 1925, 3810, 64],
];
const piano = (): Ev[] => [
  name("Piano"),
  [0, [0xc0, 0]],
  [0, [0xb0, 7, 100]],
  [0, [0xf0, 3, 0x7e, 0x7f, 0xf7]],
  [5, [0xb0, 64, 127]],
  [700, [0xe0, 0, 0x50]],
  [800, [0xe0, 0, 0x40]],
  [1910, [0xb0, 64, 0]],
  [1930, [0xb0, 64, 127]],
  ...notes(0, melody),
];

/** Track by track: the events that are not note on/off, as text. */
function others(bytes: Uint8Array): string[][] {
  return readMidiEvents(bytes).chunks.map((c) => (c.events ?? []).filter((e) => (e.status & 0xe0) !== 0x80).map((e) => `${e.tick}:${[...e.bytes].join(",")}`));
}
/** Notes as "pitch@on-off v velocity", track by track. */
function played(bytes: Uint8Array): string[][] {
  return readMidiEvents(bytes).chunks.map((c) => {
    const open = new Map<number, [number, number][]>();
    const out: string[] = [];
    for (const e of c.events ?? []) {
      const k = e.status & 0xf0;
      if (k === 0x90 && e.bytes[2] > 0) open.set(e.bytes[1], [...(open.get(e.bytes[1]) ?? []), [e.tick, e.bytes[2]]]);
      else if (k === 0x80 || k === 0x90) {
        const on = open.get(e.bytes[1])?.shift();
        if (on) out.push(`${e.bytes[1]}@${on[0]}-${e.tick} v${on[1]}`);
      }
    }
    return out.sort();
  });
}
const heard = (s: Parameters<typeof soundingNotes>[0]) => soundingNotes(s).map((n) => `${n.part}:${n.pitch}@${n.start}/${n.dur}`).sort();
const at = (measure: number, pos: number, part = 0, staff = 1): Caret => ({ part, measure, staff, voice: "1", pos });
const P = (step: string, octave = 4, alter = 0): Pitch => ({ step, alter, octave });

function open(bytes: Uint8Array) {
  const loaded = loadScore(bytes);
  return { ...loaded, ed: new ScoreEditor(loaded.score) };
}

describe("Saving a MIDI file in place", () => {
  const file = smf([conductor(), piano()]);

  it("saves an unedited file to the same bytes, type 1 and type 0", () => {
    expect(open(file).save!().bytes).toEqual(file);
    const zero = smf([[...conductor(), ...piano()]], 0);
    expect(open(zero).save!().bytes).toEqual(zero);
  });

  it("saves the same bytes after an edit is undone", () => {
    const { ed, save } = open(file);
    ed.remove(at(0, 1));
    ed.undo();
    expect(save!().bytes).toEqual(file);
  });

  it("refuses type 2 files", () => {
    expect(loadScore(smf([conductor(), piano()], 2)).save).toBeUndefined();
  });

  it("changes a pitch, keeping the note's ticks and velocity and every other event", () => {
    const { ed, score, save } = open(file);
    const e4 = [...score.measures[0][0].getElementsByTagName("note")].find((n) => readPitch(n)?.step === "E")!;
    ed.setNotePitch(e4, P("F"));
    const { bytes, dropped } = save!();
    expect(dropped).toEqual({});
    expect(others(bytes)).toEqual(others(file));
    expect(played(bytes)[1]).toEqual(played(file)[1].map((n) => (n.startsWith("64@") ? n.replace("64@", "65@") : n)).sort());
    expect(heard(loadScore(bytes).score)).toEqual(heard(score));
  });

  it("deletes a note's on and off only", () => {
    const { ed, score, save } = open(file);
    ed.remove(at(0, 2));
    const { bytes } = save!();
    expect(others(bytes)).toEqual(others(file));
    expect(played(bytes)[1]).toEqual(played(file)[1].filter((n) => !n.startsWith("67@962")));
    expect(heard(loadScore(bytes).score)).toEqual(heard(score));
  });

  it("adds a note on the grid, as loud as the nearest played one", () => {
    const gap = smf([conductor(), piano().filter((e) => !(e[1][1] === 67 && (e[0] === 962 || e[0] === 1418)))]);
    const { ed, score, save } = open(gap);
    ed.enter(at(0, 2), { pitches: [P("A")], quarters: 0.5 });
    const { bytes } = save!();
    expect(others(bytes)).toEqual(others(gap));
    expect(played(bytes)[1]).toEqual([...played(gap)[1], "69@960-1200 v70"].sort());
    expect(heard(loadScore(bytes).score)).toEqual(heard(score));
  });

  it("takes a note written over another as that note changed, keeping its onset and velocity", () => {
    const { ed, score, save } = open(file);
    ed.remove(at(0, 2));
    ed.enter(at(0, 2), { pitches: [P("A")], quarters: 0.5 });
    const { bytes } = save!();
    expect(others(bytes)).toEqual(others(file));
    expect(played(bytes)[1]).toEqual(played(file)[1].map((n) => (n === "67@962-1418 v90" ? "69@962-1200 v90" : n)).sort());
    expect(heard(loadScore(bytes).score)).toEqual(heard(score));
  });

  it("changes a length, moving only the note off", () => {
    const { ed, score, save } = open(file);
    ed.setLength(at(0, 0), 0.5);
    const { bytes } = save!();
    expect(others(bytes)).toEqual(others(file));
    expect(played(bytes)[1]).toEqual(played(file)[1].map((n) => (n === "60@3-470 v81" ? "60@3-240 v81" : n)).sort());
    expect(heard(loadScore(bytes).score)).toEqual(heard(score));
  });

  it("writes a tempo change into the tempo event and keeps the others", () => {
    const { ed, save } = open(file);
    ed.tempo(at(0, 0), 100);
    const { bytes } = save!();
    const before = others(file)[0];
    const after = others(bytes)[0];
    // 600000 µs a quarter, at the tick of the first tempo event.
    expect(after).toEqual(before.map((e) => (e === "0:255,81,3,7,161,32" ? "0:255,81,3,9,39,192" : e)));
    expect(played(bytes)).toEqual(played(file));
  });

  it("moves everything after a measure inserted before it", () => {
    const { ed, save, score } = open(file);
    ed.insertMeasures(1);
    const { bytes } = save!();
    const shift = (t: number) => (t >= 1910 ? t + 1920 : t);
    expect(played(bytes)[1]).toEqual(
      played(file)[1]
        .map((n) => n.replace(/@(\d+)-(\d+)/, (_, a, b) => (Number(a) >= 1915 ? `@${shift(+a)}-${shift(+b)}` : `@${a}-${b}`)))
        .sort(),
    );
    expect(heard(loadScore(bytes).score)).toEqual(heard(score));
    // The tempo change and the pedal in bar 2 moved with it.
    expect(others(bytes)[0]).toContain("3850:255,81,3,7,83,0");
    expect(others(bytes)[1]).toContain("3850:176,64,127");
  });

  it("writes a key change into the key event", () => {
    const { ed, save } = open(file);
    ed.setKey(0, 2);
    const { bytes } = save!();
    expect(others(bytes)[0]).toEqual(others(file)[0].map((e) => (e === "0:255,89,2,0,0" ? "0:255,89,2,2,0" : e)));
    expect(played(bytes)).toEqual(played(file));
  });

  it("deletes a drum hit on channel 10", () => {
    const drums = smf([conductor(), [name("Drums"), ...notes(9, [[36, 0, 60, 100], [38, 480, 540, 90], [36, 960, 1020, 110], [42, 0, 30, 70]])]]);
    const { ed, score, save } = open(drums);
    const snare = [...score.measures[0][0].getElementsByTagName("note")].find((n) => n.getElementsByTagName("instrument")[0]?.getAttribute("id")?.endsWith("-I39"))!;
    ed.remove(at(0, 1), snare);
    const { bytes } = save!();
    expect(played(bytes)[1]).toEqual(played(drums)[1].filter((n) => !n.startsWith("38@")));
    expect(heard(loadScore(bytes).score)).toEqual(heard(score));
  });

  it("reports the marks a MIDI file cannot take", () => {
    const { ed, save } = open(file);
    ed.mark(at(0, 0), "staccato");
    expect(save!().dropped).toEqual({ staccato: 1 });
  });

  it("edits a type 0 file in its one track", () => {
    const zero = smf([[...conductor(), ...piano()]], 0);
    const { ed, score, save } = open(zero);
    ed.remove(at(0, 3));
    const { bytes } = save!();
    expect(others(bytes)).toEqual(others(zero));
    expect(played(bytes)[0]).toEqual(played(zero)[0].filter((n) => !n.startsWith("72@")));
    expect(heard(loadScore(bytes).score)).toEqual(heard(score));
  });
});
