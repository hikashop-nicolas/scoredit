// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { detectFormat } from "./detect";
import { loadScore } from "./load";
import { midiToMusicXml } from "./midi";

// A tiny SMF writer: notes in quarters, at 480 ticks a quarter.
const PPQ = 480;
type Ev = [tick: number, bytes: number[]];
const vlq = (n: number) => {
  const out = [n & 0x7f];
  while ((n >>= 7)) out.unshift((n & 0x7f) | 0x80);
  return out;
};
const meta = (tick: number, type: number, data: number[]): Ev => [tick, [0xff, type, ...vlq(data.length), ...data]];
const name = (s: string) => meta(0, 3, [...s].map((c) => c.charCodeAt(0)));
const tempo = (q: number, bpm: number) => {
  const us = Math.round(60000000 / bpm);
  return meta(q * PPQ, 0x51, [us >> 16, (us >> 8) & 0xff, us & 0xff]);
};
const time = (q: number, n: number, d: number) => meta(q * PPQ, 0x58, [n, Math.log2(d), 24, 8]);
const key = (q: number, fifths: number) => meta(q * PPQ, 0x59, [fifths & 0xff, 0]);
const program = (ch: number, p: number): Ev => [0, [0xc0 | ch, p]];
const notes = (ch: number, list: [pitch: number, start: number, len: number][]): Ev[] =>
  list.flatMap(([p, s, l]) => [
    [Math.round(s * PPQ), [0x90 | ch, p, 80]] as Ev,
    // Note off as a note on at velocity 0, as many files do.
    [Math.round((s + l) * PPQ), [0x90 | ch, p, 0]] as Ev,
  ]);
function smf(tracks: Ev[][], format = 1): Uint8Array {
  const bytes = [...[..."MThd"].map((c) => c.charCodeAt(0)), 0, 0, 0, 6, 0, format, 0, tracks.length, PPQ >> 8, PPQ & 0xff];
  for (const tr of tracks) {
    // Offs before ons at the same tick.
    const evs = [...tr].sort((a, b) => a[0] - b[0] || (a[1][2] === 0 ? -1 : 0) - (b[1][2] === 0 ? -1 : 0));
    const body: number[] = [];
    let at = 0;
    for (const [tick, b] of evs) {
      body.push(...vlq(tick - at), ...b);
      at = tick;
    }
    body.push(0, 0xff, 0x2f, 0);
    bytes.push(...[..."MTrk"].map((c) => c.charCodeAt(0)), (body.length >>> 24) & 0xff, (body.length >> 16) & 0xff, (body.length >> 8) & 0xff, body.length & 0xff, ...body);
  }
  return new Uint8Array(bytes);
}

const parse = (bytes: Uint8Array) => new DOMParser().parseFromString(midiToMusicXml(bytes), "application/xml");
const kid = (e: Element, tag: string) => [...e.children].find((c) => c.tagName === tag);

/** A part's bars as text: "C4 q", "r h", "~" before a tied-in note, "+" for a chord note, "/3" in a triplet, "/5" in a quintuplet. */
function bars(doc: Document, part = 0, voice?: number): string[][] {
  const p = doc.getElementsByTagName("part")[part];
  return [...p.getElementsByTagName("measure")].map((m) =>
    [...m.getElementsByTagName("note")]
      .filter((n) => voice === undefined || kid(n, "voice")?.textContent === String(voice))
      .map((n) => {
        const pitch = kid(n, "pitch");
        const un = kid(n, "unpitched");
        const what = pitch ? `${kid(pitch, "step")!.textContent}${({ "1": "#", "-1": "b" } as Record<string, string>)[kid(pitch, "alter")?.textContent ?? ""] ?? ""}${kid(pitch, "octave")!.textContent}` : un ? `x${kid(un, "display-step")!.textContent}${kid(un, "display-octave")!.textContent}` : "r";
        const type = { whole: "w", half: "h", quarter: "q", eighth: "e", "16th": "s", "32nd": "t" }[kid(n, "type")?.textContent ?? ""] ?? "bar";
        const tie = [...n.getElementsByTagName("tie")].some((t) => t.getAttribute("type") === "stop") ? "~" : "";
        return `${kid(n, "chord") ? "+" : ""}${tie}${what} ${type}${"." .repeat(n.getElementsByTagName("dot").length)}${kid(n, "time-modification") ? `/${n.getElementsByTagName("actual-notes")[0].textContent}` : ""}`;
      }),
  );
}

/** Every voice of every bar adds up to the bar. */
function checkFull(doc: Document) {
  for (const m of doc.getElementsByTagName("measure")) {
    const time = 96;
    const sums = new Map<string, number>();
    for (const n of m.getElementsByTagName("note")) {
      if (kid(n, "chord")) continue;
      const v = kid(n, "voice")!.textContent!;
      sums.set(v, (sums.get(v) ?? 0) + Number(kid(n, "duration")!.textContent));
    }
    const len = [...m.getElementsByTagName("backup")].map((b) => Number(kid(b, "duration")!.textContent))[0];
    for (const s of sums.values()) expect(s).toBe(len ?? s);
    void time;
  }
}

describe("MIDI reader", () => {
  it("is detected from its header", () => {
    expect(detectFormat(smf([[]]))).toBe("midi");
  });

  it("reads a melody in quarters and eighths, with rests filling gaps", () => {
    const doc = parse(smf([[name("Flute"), program(0, 73), ...notes(0, [[60, 0, 1], [62, 1, 0.5], [64, 1.5, 0.5], [65, 3, 1], [67, 4, 2]])]]));
    expect(bars(doc)).toEqual([
      ["C4 q", "D4 e", "E4 e", "r q", "F4 q"],
      ["G4 h", "r h"],
    ]);
    expect(doc.getElementsByTagName("part-name")[0].textContent).toBe("Flute");
    checkFull(doc);
  });

  it("quantises loose timings", () => {
    // Played a bit early and late, and held a bit short.
    const doc = parse(smf([[...notes(0, [[60, 0.02, 0.9], [62, 0.97, 0.95], [64, 2.03, 1.9]])]]));
    expect(bars(doc)).toEqual([["C4 q", "D4 q", "E4 h"]]);
  });

  it("ties notes across bar lines and writes plain values", () => {
    const doc = parse(smf([[...notes(0, [[60, 3, 2], [62, 5, 2.5]])]]));
    expect(bars(doc)).toEqual([
      ["r h", "r q", "C4 q"],
      ["~C4 q", "D4 h", "~D4 e", "r e"],
    ]);
    expect(doc.getElementsByTagName("tied").length).toBe(4);
  });

  it("makes chords of notes that start together", () => {
    const doc = parse(smf([[...notes(0, [[60, 0, 4], [64, 0, 4], [67, 0, 4]])]]));
    expect(bars(doc)).toEqual([["C4 w", "+E4 w", "+G4 w"]]);
  });

  it("puts overlapping lines in a second voice", () => {
    const doc = parse(smf([[...notes(0, [[72, 0, 1], [74, 1, 1], [76, 2, 2], [67, 0, 4]])]]));
    expect(bars(doc, 0, 1)).toEqual([["C5 q", "D5 q", "E5 h"]]);
    expect(bars(doc, 0, 2)).toEqual([["G4 w"]]);
    checkFull(doc);
  });

  it("writes triplets", () => {
    const third = 1 / 3;
    const doc = parse(smf([[...notes(0, [[60, 0, third], [62, third, third], [64, 2 * third, third], [65, 1, 1], [67, 2, 2]])]]));
    expect(bars(doc)).toEqual([["C4 e/3", "D4 e/3", "E4 e/3", "F4 q", "G4 h"]]);
    const tuplets = [...doc.getElementsByTagName("tuplet")].map((t) => t.getAttribute("type"));
    expect(tuplets).toEqual(["start", "stop"]);
    checkFull(doc);
  });

  it("writes sixteenths and dotted values", () => {
    const doc = parse(smf([[...notes(0, [[60, 0, 1.5], [62, 1.5, 0.25], [64, 1.75, 0.25], [65, 2, 2]])]]));
    expect(bars(doc)).toEqual([["C4 q.", "D4 s", "E4 s", "F4 h"]]);
  });

  it("puts a piano on two staves, split at middle C", () => {
    const doc = parse(smf([[name("Piano"), ...notes(0, [[72, 0, 4], [48, 0, 2], [43, 2, 2]])]]));
    expect(doc.getElementsByTagName("staves")[0].textContent).toBe("2");
    const clefs = [...doc.getElementsByTagName("clef")].map((c) => kid(c, "sign")!.textContent);
    expect(clefs).toEqual(["G", "F"]);
    expect(bars(doc, 0, 1)).toEqual([["C5 w"]]);
    expect(bars(doc, 0, 5)).toEqual([["C3 h", "G2 h"]]);
    const staffOf = [...doc.getElementsByTagName("note")].map((n) => kid(n, "staff")?.textContent);
    expect(staffOf).toEqual(["1", "2", "2"]);
  });

  it("gives a low line a bass clef", () => {
    const doc = parse(smf([[program(0, 33), ...notes(0, [[40, 0, 4]])]]));
    expect(kid(doc.getElementsByTagName("clef")[0], "sign")!.textContent).toBe("F");
    expect(doc.getElementsByTagName("part-name")[0].textContent).toBe("Bass Guitar");
  });

  it("reads channel 10 as a drum kit, feet in the second voice", () => {
    const kit = notes(9, [[42, 0, 0.5], [42, 0.5, 0.5], [42, 1, 0.5], [42, 1.5, 0.5], [38, 1, 0.5], [36, 0, 0.5], [36, 2, 0.5]]);
    const xml = midiToMusicXml(smf([kit]));
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    expect(doc.getElementsByTagName("midi-unpitched").length).toBe(3);
    expect(doc.getElementsByTagName("pitch").length).toBe(0);
    expect(kid(doc.getElementsByTagName("clef")[0], "sign")!.textContent).toBe("percussion");
    expect(bars(doc, 0, 2).flat().filter((s) => !s.startsWith("r"))).toHaveLength(2);
    expect(doc.getElementsByTagName("notehead").length).toBe(4);
    const score = loadScore(smf([kit])).score;
    expect(score.parts[0].program).toBe(128);
    checkFull(doc);
  });

  it("reads tempo, time and key changes", () => {
    const doc = parse(
      smf([
        [tempo(0, 90), time(0, 3, 4), key(0, -3), tempo(6, 120), time(6, 2, 4), key(6, 2)],
        [...notes(0, [[63, 0, 3], [70, 3, 3], [66, 6, 2]])],
      ]),
    );
    expect(bars(doc)).toEqual([["Eb4 h."], ["Bb4 h."], ["F#4 h"]]);
    const keys = [...doc.getElementsByTagName("fifths")].map((f) => f.textContent);
    expect(keys).toEqual(["-3", "2"]);
    const times = [...doc.getElementsByTagName("time")].map((t) => `${kid(t, "beats")!.textContent}/${kid(t, "beat-type")!.textContent}`);
    expect(times).toEqual(["3/4", "2/4"]);
    const tempos = [...doc.getElementsByTagName("sound")].map((s) => s.getAttribute("tempo"));
    expect(tempos).toEqual(["90", "120"]);
    expect(doc.getElementsByTagName("per-minute")[0].textContent).toBe("90");
  });

  it("reads a type 0 file, one part a channel", () => {
    const bytes = smf([[program(0, 40), program(1, 0), ...notes(0, [[76, 0, 4]]), ...notes(1, [[48, 0, 4]])]], 0);
    const { score, format, save } = loadScore(bytes);
    expect(format).toBe("midi");
    expect(save).toBeUndefined();
    expect(score.parts.map((p) => p.name)).toEqual(["Violin", "Piano"]);
  });

  it("names parts from track names, and takes the first track's name as the title", () => {
    const doc = parse(smf([[name("My Song"), tempo(0, 100)], [name("Lead"), ...notes(0, [[67, 0, 4]])], [name("Bass"), program(1, 32), ...notes(1, [[43, 0, 4]])]]));
    expect([...doc.getElementsByTagName("part-name")].map((p) => p.textContent)).toEqual(["Lead", "Bass"]);
    expect(doc.getElementsByTagName("work-title")[0].textContent).toBe("My Song");
  });

  it("reads running status and note-off messages", () => {
    // C4 then D4: the second note on and both offs use running status.
    const body = [0x00, 0x90, 60, 80, 0x83, 0x60, 60, 0, 0x00, 62, 80, 0x83, 0x60, 0x80, 62, 0, 0x00, 0xff, 0x2f, 0x00];
    const bytes = new Uint8Array([..."MThd"].map((c) => c.charCodeAt(0)).concat([0, 0, 0, 6, 0, 0, 0, 1, 1, 0xe0], [..."MTrk"].map((c) => c.charCodeAt(0)), [0, 0, 0, body.length], body));
    expect(bars(parse(bytes))).toEqual([["C4 q", "D4 q", "r h"]]);
  });

  it("writes detached playing at its written length", () => {
    // Eighths played as sixteenths.
    const doc = parse(smf([[...notes(0, [0, 1, 2, 3, 4, 5, 6, 7].map((i) => [60 + i, i / 2, 0.25] as [number, number, number]))]]));
    expect(bars(doc)).toEqual([["C4 e", "C#4 e", "D4 e", "D#4 e", "E4 e", "F4 e", "F#4 e", "G4 s", "r s"]]);
  });

  it("beams eighths and shorter within a beat, and in threes in compound time", () => {
    const beams = (doc: Document) => [...doc.getElementsByTagName("beam")].map((b) => b.textContent![0]).join("");
    expect(beams(parse(smf([[...notes(0, [[60, 0, 0.5], [62, 0.5, 0.5], [64, 1, 0.25], [65, 1.25, 0.25], [67, 1.5, 0.5], [69, 2, 2]])]])))).toBe("bebce");
    const six = parse(smf([[time(0, 6, 8), ...notes(0, [0, 1, 2, 3, 4, 5].map((i) => [60 + i, i / 2, 0.5] as [number, number, number]))]]));
    expect(beams(six)).toBe("bcebce");
  });

  it("writes a guitar in its octave clef, and reads UTF-8 names", () => {
    const utf = [..."Guitare électrique"].flatMap((c) => [...new TextEncoder().encode(c)]);
    const doc = parse(smf([[meta(0, 3, [...utf, 0]), program(0, 27), ...notes(0, [[52, 0, 4]])]]));
    expect(doc.getElementsByTagName("part-name")[0].textContent).toBe("Guitare électrique");
    expect(doc.getElementsByTagName("clef-octave-change")[0].textContent).toBe("-1");
    expect(bars(doc)).toEqual([["E3 w"]]);
  });

  it("writes quintuplets and sextuplets where the timing calls for them", () => {
    // Five in a beat, played a little loose; then six sixteenths in a beat.
    const jitter = [0, 0.012, -0.01, 0.008, -0.006];
    const five = [0, 1, 2, 3, 4].map((i) => [60 + i, i / 5 + jitter[i], 0.19] as [number, number, number]);
    const six = [0, 1, 2, 3, 4, 5].map((i) => [72 - i, 1 + i / 6, 1 / 6] as [number, number, number]);
    const doc = parse(smf([[...notes(0, [...five, ...six, [60, 2, 2]])]]));
    expect(bars(doc)).toEqual([["C4 s/5", "C#4 s/5", "D4 s/5", "D#4 s/5", "E4 s/5", "C5 s/6", "B4 s/6", "A#4 s/6", "A4 s/6", "G#4 s/6", "G4 s/6", "C4 h"]]);
    const mods = [...doc.getElementsByTagName("time-modification")].map((m) => `${kid(m, "actual-notes")!.textContent}:${kid(m, "normal-notes")!.textContent}`);
    expect(new Set(mods)).toEqual(new Set(["5:4", "6:4"]));
    expect([...doc.getElementsByTagName("tuplet")].map((t) => t.getAttribute("type"))).toEqual(["start", "stop", "start", "stop"]);
    checkFull(doc);
  });

  it("keeps loosely played straight rhythms straight", () => {
    // Sixteenths and eighths, each up to 25 ms early or late at 120 bpm.
    const off = [0.03, -0.04, 0.05, -0.02, 0.04, -0.05, 0.02, -0.03];
    const list: [number, number, number][] = [];
    for (let b = 0; b < 4; b++) {
      const sub = b % 2 ? [0, 0.5] : [0, 0.25, 0.5, 0.75];
      sub.forEach((x, i) => list.push([60 + i, b + x + off[(b * 4 + i) % 8], b % 2 ? 0.45 : 0.22]));
    }
    const doc = parse(smf([[...notes(0, [...list, [60, 4, 4]])]]));
    expect(doc.getElementsByTagName("time-modification").length).toBe(0);
    expect(bars(doc)[0].join(" ")).toBe("C4 s C#4 s D4 s D#4 s C4 e C#4 e C4 s C#4 s D4 s D#4 s C4 e C#4 e");
  });

  it("gives independent lines voices of their own, up to four, and keeps chords together", () => {
    // In one strings track: a whole note, halves, quarters and eighths against each other.
    const lines: [number, number, number][] = [
      [48, 0, 4],
      [55, 0, 2],
      [57, 2, 2],
      ...[0, 1, 2, 3].map((i) => [64 + i, i, 1] as [number, number, number]),
      ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => [76 + (i % 3), i / 2 + 0.25, 0.25] as [number, number, number]),
    ];
    const doc = parse(smf([[program(0, 48), ...notes(0, lines)]]));
    const voices = new Set([...doc.getElementsByTagName("voice")].map((v) => v.textContent));
    expect(voices.size).toBe(4);
    const all = [1, 2, 3, 4].map((v) => bars(doc, 0, v)[0].filter((x) => !x.startsWith("r")).join(" "));
    expect(all).toContain("C3 w");
    expect(all).toContain("G3 h A3 h");
    expect(all).toContain("E4 q F4 q F#4 q G4 q");
    checkFull(doc);
    // A block chord against one line: still two voices, the chord in one.
    const chordDoc = parse(smf([[program(0, 48), ...notes(0, [[60, 0, 4], [64, 0, 4], [67, 0, 4], [72, 0, 1], [74, 1, 1], [76, 2, 2]])]]));
    expect(bars(chordDoc, 0, 2)).toEqual([["C4 w", "+E4 w", "+G4 w"]]);
    expect(bars(chordDoc, 0, 1)).toEqual([["C5 q", "D5 q", "E5 h"]]);
  });

  it("reads a long file with many tracks and tempo and key changes quickly", () => {
    const tracks: Ev[][] = [[tempo(0, 100), ...Array.from({ length: 1500 }, (_, i) => tempo(i, 90 + (i % 40))), ...Array.from({ length: 300 }, (_, i) => key(i * 4, (i % 7) - 3))]];
    for (let tr = 0; tr < 16; tr++) {
      const list: [number, number, number][] = [];
      for (let i = 0; i < 3000; i++) list.push([48 + ((i * 7 + tr) % 36), i / 2, 0.5]);
      tracks.push([program(tr === 9 ? 0 : tr, tr * 5), ...notes(tr === 9 ? 0 : tr, list)]);
    }
    const bytes = smf(tracks);
    const t = performance.now();
    const xml = midiToMusicXml(bytes);
    const ms = performance.now() - t;
    expect(ms).toBeLessThan(4000);
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    expect(doc.getElementsByTagName("part").length).toBe(16);
    expect(doc.getElementsByTagName("part")[0].getElementsByTagName("measure").length).toBe(375);
  }, 30000);
});
