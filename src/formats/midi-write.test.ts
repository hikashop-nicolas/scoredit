// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ScoreDoc } from "../model/score";
import { buildTimeline } from "../play/timeline";
import { loadScore } from "./load";
import { midiToMusicXml } from "./midi";
import { writeMidi } from "./midi-write";

// A small reader for what the writer wrote: every event of every track, with absolute ticks.
type Event = { tick: number; status: number; data: number[] };
function read(bytes: Uint8Array) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe("MThd");
  const head = { format: v.getUint16(8), tracks: v.getUint16(10), ppq: v.getUint16(12) };
  const tracks: Event[][] = [];
  let o = 14;
  for (let t = 0; t < head.tracks; t++) {
    expect(String.fromCharCode(...bytes.subarray(o, o + 4))).toBe("MTrk");
    const end = o + 8 + v.getUint32(o + 4);
    let p = o + 8;
    let tick = 0;
    const evs: Event[] = [];
    const vlq = () => {
      let x = 0;
      for (;;) {
        const b = bytes[p++];
        x = x * 128 + (b & 0x7f);
        if (!(b & 0x80)) return x;
      }
    };
    while (p < end) {
      tick += vlq();
      const status = bytes[p++];
      if (status === 0xff) {
        const type = bytes[p++];
        const n = vlq();
        evs.push({ tick, status, data: [type, ...bytes.subarray(p, p + n)] });
        p += n;
      } else {
        const n = (status & 0xf0) === 0xc0 || (status & 0xf0) === 0xd0 ? 1 : 2;
        evs.push({ tick, status, data: [...bytes.subarray(p, p + n)] });
        p += n;
      }
    }
    tracks.push(evs);
    o = end;
  }
  const metas = (t: number, type: number) => tracks[t].filter((e) => e.status === 0xff && e.data[0] === type);
  const text = (e: Event) => new TextDecoder().decode(new Uint8Array(e.data.slice(1)));
  // Notes of a track: [channel, pitch, on, off, velocity].
  const notes = (t: number) => {
    const open = new Map<number, Event>();
    const out: [number, number, number, number, number][] = [];
    for (const e of tracks[t]) {
      const kind = e.status & 0xf0;
      const key = ((e.status & 0x0f) << 8) | e.data[0];
      if (kind === 0x90 && e.data[1] > 0) open.set(key, e);
      else if (kind === 0x80 || kind === 0x90) {
        const on = open.get(key);
        if (on) out.push([e.status & 0x0f, e.data[0], on.tick, e.tick, on.data[1]]);
        open.delete(key);
      }
    }
    return out.sort((a, b) => a[2] - b[2] || a[1] - b[1]);
  };
  return { head, tracks, metas, text, notes };
}

const score = (parts: string, body: string) => new ScoreDoc(`<score-partwise version="4.0"><work><work-title>Study</work-title></work><part-list>${parts}</part-list>${body}</score-partwise>`);
const note = (step: string, octave: number, dur: number, extra = "", alter = 0) =>
  `<note><pitch><step>${step}</step>${alter ? `<alter>${alter}</alter>` : ""}<octave>${octave}</octave></pitch><duration>${dur}</duration>${extra}</note>`;

describe("MIDI writer", () => {
  it("writes a conductor track and a track a part, at concert pitch", () => {
    // A B flat clarinet written in D major, with a quarter pickup in 3/4 and a tempo of 90.
    const s = score(
      `<score-part id="P1"><part-name>Clarinet</part-name><score-instrument id="P1-I1"><instrument-name>Clarinet</instrument-name></score-instrument><midi-instrument id="P1-I1"><midi-channel>1</midi-channel><midi-program>72</midi-program><volume>80</volume><pan>-45</pan></midi-instrument></score-part>`,
      `<part id="P1"><measure number="0" implicit="yes"><attributes><divisions>2</divisions><key><fifths>2</fifths></key><time><beats>3</beats><beat-type>4</beat-type></time><transpose><diatonic>-1</diatonic><chromatic>-2</chromatic></transpose></attributes>` +
        `<direction><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>90</per-minute></metronome></direction-type><sound tempo="90"/></direction>${note("D", 5, 2)}</measure>` +
        `<measure number="1"><direction><direction-type><rehearsal>A</rehearsal></direction-type></direction>${note("E", 5, 2, "<notations><articulations><staccato/></articulations></notations>")}${note("F", 5, 2, '<tie type="start"/>', 1)}${note("F", 5, 2, '<tie type="stop"/>', 1)}</measure></part>`,
    );
    const m = read(writeMidi(s));
    expect(m.head).toEqual({ format: 1, tracks: 2, ppq: 480 });
    expect(m.text(m.metas(0, 0x03)[0])).toBe("Study");
    expect(m.metas(0, 0x51).map((e) => [e.tick, (e.data[1] << 16) | (e.data[2] << 8) | e.data[3]])).toEqual([[0, 666667]]);
    // The pickup has its own signature, as MuseScore writes it.
    expect(m.metas(0, 0x58).map((e) => [e.tick, e.data[1], 2 ** e.data[2]])).toEqual([[0, 1, 4], [480, 3, 4]]);
    // Concert key: D major for a B flat instrument sounds in C.
    expect(m.metas(0, 0x59).map((e) => [e.tick, (e.data[1] << 24) >> 24])).toEqual([[0, 0]]);
    expect(m.metas(0, 0x06).map((e) => [e.tick, m.text(e)])).toEqual([[480, "A"]]);
    expect(m.text(m.metas(1, 0x03)[0])).toBe("Clarinet");
    const setup = m.tracks[1].filter((e) => e.status !== 0xff && (e.status & 0xf0) !== 0x90 && (e.status & 0xf0) !== 0x80);
    expect(setup.map((e) => [e.status, ...e.data])).toEqual([[0xc0, 71], [0xb0, 7, 101], [0xb0, 10, 31]]);
    // Staccato at half length; the tied pair as one note.
    expect(m.notes(1).map(([ch, p, on, off]) => [ch, p, on, off])).toEqual([
      [0, 72, 0, 480],
      [0, 74, 480, 720],
      [0, 76, 960, 1920],
    ]);
  });

  it("unfolds repeats and endings in the order they play", () => {
    const P = `<score-part id="P1"><part-name>Flute</part-name><midi-instrument id="P1-I1"><midi-program>74</midi-program></midi-instrument></score-part>`;
    const s = score(
      P,
      `<part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>1</beats><beat-type>4</beat-type></time></attributes>${note("C", 5, 1)}</measure>` +
        `<measure number="2"><barline location="left"><ending number="1" type="start"/></barline>${note("D", 5, 1)}<barline location="right"><ending number="1" type="stop"/><repeat direction="backward"/></barline></measure>` +
        `<measure number="3"><barline location="left"><ending number="2" type="start"/></barline>${note("E", 5, 1)}<barline location="right"><ending number="2" type="discontinue"/></barline></measure></part>`,
    );
    expect(read(writeMidi(s)).notes(1).map(([, p, on]) => [p, on])).toEqual([[72, 0], [74, 480], [72, 960], [76, 1440]]);
    expect(read(writeMidi(s, { straight: true })).notes(1).map(([, p]) => p)).toEqual([72, 74, 76]);
  });

  it("plays drums on channel 10 with the notes the score gives them", () => {
    const s = loadScore(new Uint8Array(readFileSync(join(__dirname, "../../demo/fixtures/drums.musicxml")))).score;
    const m = read(writeMidi(s));
    const n = m.notes(1);
    expect(new Set(n.map(([ch]) => ch))).toEqual(new Set([9]));
    expect(new Set(n.map(([, p]) => p))).toEqual(new Set([36, 38, 42]));
    // No program change on the drum channel.
    expect(m.tracks[1].some((e) => (e.status & 0xf0) === 0xc0)).toBe(false);
  });

  it("follows dynamics and accents in velocities, and gives each part its own channel", () => {
    const parts = `<score-part id="P1"><part-name>Violin</part-name><midi-instrument id="P1-I1"><midi-program>41</midi-program></midi-instrument></score-part><score-part id="P2"><part-name>Violin 2</part-name><midi-instrument id="P2-I1"><midi-program>41</midi-program></midi-instrument></score-part>`;
    const dyn = (d: string) => `<direction><direction-type><dynamics><${d}/></dynamics></direction-type></direction>`;
    const s = score(
      parts,
      `<part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>3</beats><beat-type>4</beat-type></time></attributes>${dyn("p")}${note("A", 4, 1)}${note("A", 4, 1, "<notations><articulations><accent/></articulations></notations>")}${dyn("ff")}${note("A", 4, 1)}</measure></part>` +
        `<part id="P2"><measure number="1"><attributes><divisions>1</divisions><time><beats>3</beats><beat-type>4</beat-type></time></attributes>${note("E", 4, 3)}</measure></part>`,
    );
    const m = read(writeMidi(s));
    const v = m.notes(1).map((n) => n[4]);
    expect(v[1]).toBeGreaterThan(v[0]);
    expect(v[2]).toBeGreaterThan(v[1]);
    expect(m.notes(1)[0][0]).toBe(0);
    expect(m.notes(2)[0][0]).toBe(1);
  });

  it("plays a slashed grace note before the beat and an appoggiatura on it, at its written length", () => {
    const g = (slash: string, step: string) => `<note><grace${slash}/><pitch><step>${step}</step><octave>5</octave></pitch><type>eighth</type></note>`;
    const s = score(
      `<score-part id="P1"><part-name>Oboe</part-name></score-part>`,
      `<part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>${note("C", 5, 1)}${g(' slash="yes"', "E")}${note("D", 5, 1)}${g("", "F")}${note("E", 5, 2)}</measure></part>`,
    );
    expect(read(writeMidi(s)).notes(1).map(([, p, on, off]) => [p, on, off])).toEqual([
      [72, 0, 240],
      [76, 240, 480],
      [74, 480, 960],
      [77, 960, 1200],
      [76, 1200, 1920],
    ]);
  });

  it("slows the tempo under a fermata and gives a pause a bar of its own, as MuseScore does", () => {
    const ferm = `<notations><fermata type="upright"/></notations>`;
    const caes = `<notations><articulations><caesura/></articulations></notations>`;
    const tempo = `<direction><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>120</per-minute></metronome></direction-type><sound tempo="120"/></direction>`;
    const at = `<attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>`;
    const bars = [`${at}${tempo}${note("C", 5, 1)}${note("D", 5, 1, ferm)}${note("E", 5, 2, caes)}`, `${note("F", 5, 4)}`, `${note("G", 5, 4)}`];
    // Measure numbers starting again make a new section.
    const s = score(`<score-part id="P1"><part-name>Flute</part-name></score-part>`, `<part id="P1">${bars.map((b, i) => `<measure number="${[1, 2, 1][i]}">${b}</measure>`).join("")}</part>`);
    const m = read(writeMidi(s));
    const tempos = m.metas(0, 0x51).map((e) => [e.tick / 480, Math.round(60000000 / ((e.data[1] << 16) | (e.data[2] << 8) | e.data[3]))]);
    // 120, 60 under the fermata, the caesura's second over a bar (4 quarters at 240), the section's three seconds (at 80).
    expect(tempos).toEqual([[0, 120], [1, 60], [2, 120], [4, 240], [8, 120], [12, 80], [16, 120]]);
    expect(m.notes(1).map(([, p, on, off]) => [p, on / 480, off / 480])).toEqual([
      [72, 0, 1],
      [74, 1, 2],
      [76, 2, 4],
      [77, 8, 12],
      [79, 16, 20],
    ]);
  });

  // Notes as written: pitch, start and length in quarters over the whole score.
  const written = (s: ScoreDoc) => {
    const tl = buildTimeline(s, { straight: true });
    const at: number[] = [];
    let q = 0;
    for (const sp of tl.spans) {
      at[sp.measure] = q;
      q += sp.quarters;
    }
    return tl.events.map((e) => `${e.midi}@${at[e.measure] + e.onset}+${Math.round((e.dur / (tl.spans[0].tempo[0][1])) * 1000) / 1000}`).sort();
  };

  for (const name of ["melody.musicxml", "tunes.abc"]) {
    it(`reads back what it wrote: ${name}`, () => {
      const s = loadScore(new Uint8Array(readFileSync(join(__dirname, "../../demo/fixtures", name)))).score;
      // One tempo throughout, so lengths in seconds compare as quarters.
      for (const e of Array.from(s.root.getElementsByTagName("sound"))) e.removeAttribute("tempo");
      for (const e of Array.from(s.root.getElementsByTagName("metronome"))) e.remove();
      const back = new ScoreDoc(midiToMusicXml(writeMidi(s, { straight: true, articulations: false })));
      expect(written(back)).toEqual(written(s));
    });
  }

  it("reads back the drums it wrote", () => {
    const s = loadScore(new Uint8Array(readFileSync(join(__dirname, "../../demo/fixtures/drums.musicxml")))).score;
    const onsets = (x: ScoreDoc) => written(x).map((n) => n.split("+")[0]);
    expect(onsets(new ScoreDoc(midiToMusicXml(writeMidi(s))))).toEqual(onsets(s));
  });

  it("reads back quintuplets and triplets as tuplets", () => {
    const tuplet = (a: number, n: number, type: string) => `<time-modification><actual-notes>${a}</actual-notes><normal-notes>${n}</normal-notes></time-modification><type>${type}</type>`;
    const five = ["C", "D", "E", "F", "G"].map((st) => note(st, 5, 12, tuplet(5, 4, "16th"))).join("");
    const three = ["A", "G", "F"].map((st) => note(st, 5, 20, tuplet(3, 2, "eighth"))).join("");
    const s = score(`<score-part id="P1"><part-name>Flute</part-name></score-part>`, `<part id="P1"><measure number="1"><attributes><divisions>60</divisions><time><beats>2</beats><beat-type>4</beat-type></time></attributes>${five}${three}</measure></part>`);
    const back = new ScoreDoc(midiToMusicXml(writeMidi(s)));
    expect(written(back)).toEqual(written(s));
    const mods = Array.from(back.root.getElementsByTagName("actual-notes")).map((e) => e.textContent);
    expect(mods).toEqual(["5", "5", "5", "5", "5", "3", "3", "3"]);
  });
});
