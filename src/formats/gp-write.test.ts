// @vitest-environment happy-dom
import { unzipSync } from "fflate";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseGuitarPro } from "guitarpro-parser";
import { describe, expect, it } from "vitest";
import { gpFile } from "../../scripts/gp-fixture.mjs";
import { readMeasure } from "../edit/measure";
import { ScoreDoc } from "../model/score";
import { kid, kids, text } from "../model/xml";
import { buildTimeline } from "../play/timeline";
import { readGuitarPro } from "./gp";
import { writeGuitarPro } from "./gp-write";
import { loadScore } from "./load";

const fixtures = join(__dirname, "../../demo/fixtures");
const corpus = join(__dirname, "../../corpus");

/** What a score plays: each note once (part, measure, beat, pitch, length, string, fret), and the measures in played order. */
export function content(score: ScoreDoc) {
  const straight = buildTimeline(score, { straight: true });
  const notes = straight.events.filter((e) => !e.grace).map((e) => `${e.part}|${e.measure}|${Math.round(e.onset * 48)}|${e.midi}|${Math.round(e.dur * 1000)}|${e.string ?? ""}|${e.fret ?? ""}`);
  const played = buildTimeline(score);
  return { notes: notes.sort(), order: played.spans.map((s) => s.measure), seconds: Math.round((played.events.at(-1)?.time ?? 0) * 100), marks: marks(score) };
}

/** Ottavas, bar repeats, harmonic kinds and tempo marks, each with its part, measure and beat. */
function marks(score: ScoreDoc): string[] {
  const out: string[] = [];
  score.measures.forEach((ms, p) => {
    let div = 1;
    ms.forEach((meas, m) => {
      for (const d of meas.getElementsByTagName("divisions")) div = Number(d.textContent) || div;
      const at = (pos: number) => `${p}|${m}|${Math.round((pos * 48) / div)}`;
      const r = readMeasure(meas);
      for (const { pos, el } of r.others) {
        for (const o of el.getElementsByTagName("octave-shift")) out.push(`${at(pos)}|ottava ${o.getAttribute("type")} ${o.getAttribute("size") ?? 8}`);
        for (const mr of el.getElementsByTagName("measure-repeat")) out.push(`${p}|${m}|repeat ${mr.getAttribute("type")} ${mr.textContent}`);
        const tempo = el.tagName === "direction" ? kid(el, "sound")?.getAttribute("tempo") : null;
        if (tempo) out.push(`${at(pos)}|tempo ${tempo}`);
      }
      for (const evs of r.voices.values())
        for (const ev of evs)
          for (const n of [...ev.notes, ...ev.graces]) {
            const tech = kids(n, "notations").flatMap((x) => kids(x, "technical"));
            const h = tech.flatMap((t) => kids(t, "harmonic"))[0];
            if (h) out.push(`${at(ev.pos)}|harmonic ${h.firstElementChild?.tagName ?? ""} ${tech.map((t) => text(t, "other-technical")).join("")}`);
          }
    });
  });
  // Once each (a tab staff repeats its notation staff); a harmonic's kind as its tab labels it.
  const all = new Set(out);
  return [...all].filter((x) => !(x.endsWith(" ") && [...all].some((y) => y !== x && y.startsWith(x)))).sort();
}

const roundTrip = (score: ScoreDoc) => {
  const { bytes, dropped } = writeGuitarPro(score);
  const back = new ScoreDoc(readGuitarPro(bytes).doc);
  return { bytes, dropped, back };
};

// A MusicXML score using what Guitar Pro holds: a fretted guitar with capo, a transposing
// clarinet with lyrics, a piano on two staves and drums; pickup, repeats, voltas, D.S. al Coda.
const DIV = 60;
type N = { p?: string; d: number; t?: string; dots?: number; v?: number; staff?: number; chord?: boolean; tm?: string; tech?: string; nots?: string; extra?: string; head?: string; tie?: "start" | "stop"; lyric?: string; drum?: string };
const pitch = (p: string) => {
  const m = /^([A-G])(#|b)?(\d)$/.exec(p)!;
  return `<pitch><step>${m[1]}</step>${m[2] ? `<alter>${m[2] === "#" ? 1 : -1}</alter>` : ""}<octave>${m[3]}</octave></pitch>`;
};
const note = (o: N) => {
  const body = o.drum ? `<unpitched><display-step>${o.p![0]}</display-step><display-octave>${o.p![1]}</display-octave></unpitched>` : o.p ? pitch(o.p) : `<rest${o.t ? "" : ` measure="yes"`}/>`;
  const tie = o.tie ? `<tie type="${o.tie}"/>` : "";
  const tied = o.tie ? `<tied type="${o.tie}"/>` : "";
  const nots = o.tech || o.nots || tied ? `<notations>${tied}${o.nots ?? ""}${o.tech ? `<technical>${o.tech}</technical>` : ""}</notations>` : "";
  return `<note>${o.chord ? "<chord/>" : ""}${body}<duration>${o.d}</duration>${tie}${o.drum ? `<instrument id="${o.drum}"/>` : ""}<voice>${o.v ?? 1}</voice>${o.t ? `<type>${o.t}</type>` : ""}${"<dot/>".repeat(o.dots ?? 0)}${o.tm ? `<time-modification><actual-notes>${o.tm.split(":")[0]}</actual-notes><normal-notes>${o.tm.split(":")[1]}</normal-notes></time-modification>` : ""}${o.head ? `<notehead>${o.head}</notehead>` : ""}${o.staff ? `<staff>${o.staff}</staff>` : ""}${nots}${o.lyric ?? ""}</note>`;
};
const sf = (s: number, f: number) => `<string>${s}</string><fret>${f}</fret>`;
const words = (w: string, sound = "", placement = "above") => `<direction placement="${placement}"><direction-type><words>${w}</words></direction-type>${sound ? `<sound ${sound}/>` : ""}</direction>`;
const lyric = (t: string, s: string) => `<lyric number="1"><syllabic>${s}</syllabic><text>${t}</text></lyric>`;
const bars = (n: number, d: number[], staves = 1) => d.slice(0, n).map((len) => Array.from({ length: staves }, (_, s) => (s ? `<backup><duration>${len}</duration></backup>` : "") + note({ d: len, staff: staves > 1 ? s + 1 : undefined, v: s * 4 + 1 })).join(""));
const LENS = [60, 240, 240, 240, 180, 180, 180];

export function featureScore(): string {
  const g: string[] = [
    `<attributes><divisions>${DIV}</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line><clef-octave-change>-1</clef-octave-change></clef><staff-details><staff-lines>6</staff-lines>${[["E", 2], ["A", 2], ["D", 3], ["G", 3], ["B", 3], ["E", 4]].map(([s, o], i) => `<staff-tuning line="${i + 1}"><tuning-step>${s}</tuning-step><tuning-octave>${o}</tuning-octave></staff-tuning>`).join("")}<capo>2</capo></staff-details></attributes>` +
      `<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>90</per-minute></metronome></direction-type><sound tempo="90"/></direction>` +
      note({ p: "B2", d: 60, t: "quarter", tech: sf(5, 0) }),
    `<barline location="left"><repeat direction="forward"/></barline>` +
      `<direction placement="above"><direction-type><rehearsal>A</rehearsal></direction-type><direction-type><words>Verse</words></direction-type></direction>` +
      `<direction placement="below"><direction-type><dynamics><p/></dynamics></direction-type></direction>` +
      note({ p: "E3", d: 20, t: "eighth", tm: "3:2", nots: `<tuplet type="start"/>`, tech: sf(4, 0) + `<hammer-on type="start">H</hammer-on>` }) +
      note({ p: "F#3", d: 20, t: "eighth", tm: "3:2", tech: sf(4, 2) + `<hammer-on type="stop"/>` }) +
      note({ p: "B3", d: 20, t: "eighth", tm: "3:2", nots: `<tuplet type="stop"/>`, tech: sf(3, 2) }) +
      note({ p: "F#4", d: 60, t: "quarter", tech: sf(2, 5) + `<bend><bend-alter>2</bend-alter></bend>` }) +
      note({ p: "F#5", d: 60, t: "quarter", tech: sf(1, 12) + `<harmonic><natural/></harmonic>` }) +
      note({ p: "F#2", d: 60, t: "quarter", head: "x", nots: `<articulations><staccato/></articulations>`, tech: sf(6, 0) }),
    `<barline location="left"><ending number="1" type="start">1.</ending></barline>` +
      `<harmony><root><root-step>E</root-step></root><kind text="m">minor</kind></harmony>` +
      note({ p: "F#2", d: 120, t: "half", tech: sf(6, 0) }) +
      note({ p: "C#3", d: 120, t: "half", chord: true, tech: sf(5, 2) }) +
      note({ p: "F#3", d: 120, t: "half", chord: true, tech: sf(4, 2) }) +
      note({ p: "B3", d: 60, t: "quarter", nots: `<ornaments><wavy-line type="start"/><wavy-line type="stop"/></ornaments>`, tech: sf(3, 2) }) +
      note({ d: 60, t: "quarter" }) +
      `<barline location="right"><bar-style>light-heavy</bar-style><ending number="1" type="stop"/><repeat direction="backward"/></barline>`,
    `<barline location="left"><ending number="2" type="start">2.</ending></barline>` +
      // The pinch harmonic sounds an octave above its fret.
      [0, 2, 3, 5, 7].map((f, i) => note({ p: ["F#5", "G#4", "A4", "B4", "C#5"][i], d: 12, t: "16th", tm: "5:4", nots: i === 0 ? `<tuplet type="start"/>` : i === 4 ? `<tuplet type="stop"/>` : "", tech: sf(1, f) + (i === 0 ? `<harmonic><artificial/></harmonic><other-technical>P.H.</other-technical>` : "") })).join("") +
      words("let ring", "", "below") +
      note({ p: "E4", d: 180, t: "half", dots: 1, nots: `<slide type="start" number="1"/>`, tech: sf(2, 3) }) +
      `<barline location="right"><ending number="2" type="discontinue"/></barline>`,
    `<attributes><key><fifths>1</fifths></key><time><beats>3</beats><beat-type>4</beat-type></time></attributes>` +
      `<direction placement="above"><direction-type><segno/></direction-type><sound segno="segno"/></direction>` +
      `<direction placement="above"><direction-type><octave-shift type="down" size="8"/></direction-type></direction>` +
      note({ p: "F#4", d: 105, t: "quarter", dots: 2, nots: `<slide type="stop" number="1"/>`, tech: sf(2, 5) }) +
      note({ p: "G#4", d: 15, t: "16th", tech: sf(2, 7) + "<tap/>" }) +
      `<direction placement="above"><direction-type><octave-shift type="stop" size="8"/></direction-type></direction>` +
      note({ p: "C#4", d: 60, t: "quarter", tech: sf(3, 4) }) +
      words("To Coda", `tocoda="coda"`),
    words("P.M.", "", "below") +
      note({ p: "A2", d: 60, t: "quarter", tech: sf(6, 3) }) +
      note({ p: "A2", d: 60, t: "quarter", tech: sf(6, 3) }) +
      note({ p: "C#4", d: 60, t: "quarter", nots: `<articulations><accent/></articulations>`, tech: sf(3, 4) + `<bend><bend-alter>1</bend-alter><pre-bend/></bend><bend><bend-alter>1</bend-alter><release/></bend>` }) +
      words("D.S. al Coda", `dalsegno="segno"`),
    `<direction placement="above"><direction-type><coda/></direction-type><sound coda="coda"/></direction>` +
      note({ p: "F#2", d: 60, t: "quarter", head: "normal", tech: sf(6, 0) }) +
      `<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>120</per-minute></metronome></direction-type><sound tempo="120"/></direction>` +
      note({ p: "B2", d: 60, t: "quarter", tie: "start", tech: sf(5, 0) }) +
      note({ p: "B2", d: 60, t: "quarter", tie: "stop", nots: `<fermata type="upright"/>`, tech: sf(5, 0) }) +
      `<barline location="right"><bar-style>light-heavy</bar-style></barline>`,
  ];
  const cl = bars(7, LENS);
  cl[0] = `<attributes><divisions>${DIV}</divisions><key><fifths>2</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef><transpose><diatonic>-1</diatonic><chromatic>-2</chromatic></transpose></attributes>` + cl[0];
  cl[1] = note({ p: "D5", d: 60, t: "quarter", nots: `<slur type="start"/>`, lyric: lyric("Hel", "begin") }) + note({ p: "E5", d: 60, t: "quarter", lyric: lyric("lo", "end") }) + note({ p: "F#5", d: 120, t: "half", nots: `<slur type="stop"/>`, lyric: lyric("world", "single") });
  const pn = bars(7, LENS, 2);
  pn[0] = `<attributes><divisions>${DIV}</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes>` + pn[0];
  pn[1] = note({ p: "C5", d: 240, t: "whole", staff: 1 }) + `<backup><duration>240</duration></backup>` + note({ p: "C3", d: 120, t: "half", staff: 2, v: 5 }) + note({ p: "E3", d: 120, t: "half", staff: 2, v: 5 });
  // Bar 2 repeats bar 1 on both staves, with its notes filled in for playback as the reader does.
  pn[2] = `<attributes><measure-style><measure-repeat type="start">1</measure-repeat></measure-style></attributes>` + pn[1];
  pn[3] = `<attributes><measure-style><measure-repeat type="stop"/></measure-style></attributes>` + pn[3];
  const dr = bars(7, LENS);
  dr[0] = `<attributes><divisions>${DIV}</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>percussion</sign><line>2</line></clef></attributes>` + dr[0];
  dr[1] = [0, 1, 2, 3].map((i) => note({ p: i % 2 ? "C5" : "F4", d: 60, t: "quarter", drum: i % 2 ? "P4-I39" : "P4-I37" }) + note({ p: "G5", d: 60, t: "quarter", chord: true, head: "x", drum: "P4-I43" })).join("");
  const part = (id: string, ms: string[]) => `<part id="${id}">${ms.map((m, i) => `<measure number="${i}"${i === 0 ? ` implicit="yes"` : ""}>${m}</measure>`).join("")}</part>`;
  const sp = (id: string, name: string, inner: string) => `<score-part id="${id}"><part-name>${name}</part-name>${inner}</score-part>`;
  const drum = (n: number, name: string) => `<score-instrument id="P4-I${n}"><instrument-name>${name}</instrument-name></score-instrument>`;
  const drumMidi = (n: number) => `<midi-instrument id="P4-I${n}"><midi-channel>10</midi-channel><midi-unpitched>${n}</midi-unpitched></midi-instrument>`;
  return `<?xml version="1.0" encoding="UTF-8"?><score-partwise version="4.0"><work><work-title>Feature study</work-title></work><identification><creator type="composer">scoredit</creator></identification><part-list>${sp("P1", "Guitar", `<midi-instrument id="P1-I1"><midi-program>26</midi-program></midi-instrument>`)}${sp("P2", "Clarinet", `<midi-instrument id="P2-I1"><midi-program>72</midi-program></midi-instrument>`)}${sp("P3", "Piano", `<midi-instrument id="P3-I1"><midi-program>1</midi-program></midi-instrument>`)}${sp("P4", "Drums", drum(37, "Bass Drum") + drum(39, "Snare") + drum(43, "Closed Hi-Hat") + drumMidi(37) + drumMidi(39) + drumMidi(43))}</part-list>${part("P1", g)}${part("P2", cl)}${part("P3", pn)}${part("P4", dr)}</score-partwise>`;
}

describe("Guitar Pro writer", () => {
  it("writes a GP7 zip that guitarpro-parser reads", () => {
    const { bytes } = writeGuitarPro(loadScore(gpFile()).score);
    const files = unzipSync(bytes);
    expect(Object.keys(files)).toEqual(expect.arrayContaining(["VERSION", "Content/score.gpif"]));
    expect(parseGuitarPro(bytes).tracks.map((t) => t.kind)).toEqual(["stringed", "percussion"]);
  });

  it("round trips the riff fixture", () => {
    const score = loadScore(gpFile()).score;
    const { back, dropped } = roundTrip(score);
    console.log(dropped);
    expect(content(back)).toEqual(content(score));
    expect(back.serialize()).toBe(score.serialize());
  });

  it("round trips a score of guitar effects, transposition, staves and navigation", () => {
    const score = new ScoreDoc(featureScore());
    const { back, bytes, dropped } = roundTrip(score);
    expect(dropped).toEqual({});
    const a = content(score);
    const b = content(back);
    expect(b.notes).toEqual(a.notes);
    expect(b.order).toEqual(a.order);
    expect(b.seconds).toEqual(a.seconds);
    expect(b.marks).toEqual(a.marks);
    expect(a.marks.filter((x) => !x.includes("harmonic"))).toEqual(["0|0|0|tempo 90", "0|4|0|ottava down 8", "0|4|96|ottava stop 8", "0|6|48|tempo 120", "2|2|repeat start 1", "2|3|repeat stop "]);
    expect(a.marks.filter((x) => x.includes("harmonic"))).toEqual(["0|1|96|harmonic natural ", "0|3|0|harmonic artificial P.H."]);
    const song = parseGuitarPro(bytes);
    expect(song.tracks.map((t) => [t.kind, t.name])).toEqual([["stringed", "Guitar"], ["pitched", "Clarinet"], ["pitched", "Piano"], ["pitched", "Piano"], ["percussion", "Drums"]]);
    const gtr = song.tracks[0];
    if (gtr.kind !== "stringed") throw new Error("not fretted");
    expect([gtr.capo, [...gtr.tuning].reverse()]).toEqual([2, [40, 45, 50, 55, 59, 64]]);
    const notes = gtr.bars.flatMap((b) => b.voices[0]?.beats ?? []).flatMap((b) => b.notes);
    const find = (string: number, fret: number) => notes.filter((n) => n.string + 1 === string && n.fret === fret);
    expect(find(4, 0)[0].hopoToNext).toBe("hammerOn");
    expect(find(2, 5)[0].bend?.map((p) => p.semitones)).toEqual([0, 2]);
    expect(find(3, 4)[1].bend?.map((p) => p.semitones)).toEqual([1, 0]);
    expect(find(1, 12)[0].harmonic?.type).toBe("natural");
    expect(find(6, 0)[0].dead).toBe(true);
    expect(find(2, 3)[0]).toMatchObject({ letRing: true, slides: ["shift"] });
    expect(find(2, 7)[0].tapped).toBe(true);
    expect(find(6, 3).map((n) => n.palmMute)).toEqual([true, true]);
    expect(find(3, 2).map((n) => n.vibrato)).toEqual([null, "slight"]);
    expect(song.masterBars.map((m) => [m.repeatStart, m.repeatEnd?.playCount ?? 0, m.alternateEndings.join(), m.targets.join(), m.jumps.join()])).toEqual([
      [false, 0, "", "", ""],
      [true, 0, "", "", ""],
      [false, 2, "1", "", ""],
      [false, 0, "2", "", ""],
      [false, 0, "", "segno", "daCoda"],
      [false, 0, "", "", "daSegnoAlCoda"],
      [false, 0, "", "coda", ""],
    ]);
    expect(song.masterBars[0].anacrusis).toBe(true);
    expect(song.masterBars[1].section).toEqual({ letter: "A", text: "Verse" });
    expect(song.tempoChanges.map((t) => [t.masterBar, t.bpm])).toEqual([[0, 90], [6, 120]]);
    expect(song.tracks[1].lyrics).toEqual([{ masterBar: 1, text: "Hel-lo world" }]);
    expect(gtr.bars[2].voices[0].beats[0].chord).toBe("Em");
    const gpif = new TextDecoder().decode(unzipSync(bytes)["Content/score.gpif"]);
    expect(gpif.match(/<SimileMark>\w+<\/SimileMark>/g)).toEqual(["<SimileMark>Simple</SimileMark>", "<SimileMark>Simple</SimileMark>"]);
    expect(gpif.match(/<Ottavia>8va<\/Ottavia>/g)).toHaveLength(2);
    expect(find(1, 0)[0].harmonic).toEqual({ type: "pinch", fret: 12 });
    expect(gpif).toContain("<MasterTrack><Anacrusis /><Tracks>");
    // The clarinet stays a B-flat instrument: GP7's track transposition, notes at written pitch.
    expect(gpif.match(/<Transpose><Chromatic>-?\d+<\/Chromatic><Octave>-?\d+<\/Octave><\/Transpose>/g)?.[1]).toBe("<Transpose><Chromatic>-2</Chromatic><Octave>0</Octave></Transpose>");
    const cl = back.measures[1];
    expect(text(cl[0].getElementsByTagName("transpose")[0], "chromatic")).toBe("-2");
    expect(text(cl[0].getElementsByTagName("key")[0], "fifths")).toBe("2");
    expect(kids(cl[1], "note").map((n) => text(kid(n, "pitch"), "step"))).toEqual(["D", "E", "F"]);
    expect(song.tempoChanges[1].offsetTick).toBe(960);
  });

  for (const name of ["guitar", "drums", "melody", "piano"]) {
    it(`saves ${name}.musicxml as a Guitar Pro file`, () => {
      const score = new ScoreDoc(readFileSync(join(fixtures, `${name}.musicxml`), "utf8"));
      const { back, bytes, dropped } = roundTrip(score);
      expect(dropped).toEqual({});
      expect(parseGuitarPro(bytes).tracks.length).toBeGreaterThan(0);
      const a = content(score);
      const b = content(back);
      expect(b.notes.map((n) => n.split("|").slice(0, 5).join("|"))).toEqual(a.notes.map((n) => n.split("|").slice(0, 5).join("|")));
      expect(b.order).toEqual(a.order);
    });
  }
});

const gpDirs = ["guitarpro-write", "guitarpro"].map((d) => join(corpus, d)).filter((d) => existsSync(d));
describe.skipIf(process.env.SCOREDIT_CORPUS !== "1" || !gpDirs.length)("Guitar Pro corpus round trip", () => {
  for (const dir of gpDirs)
    for (const f of readdirSync(dir).filter((x) => /\.(gp|gpx|gp[345])$/i.test(x)))
      it(`round trips ${f}`, () => {
        let score: ScoreDoc;
        try {
          score = loadScore(new Uint8Array(readFileSync(join(dir, f)))).score;
        } catch {
          return; // a file the reader cannot open
        }
        const { back, dropped } = roundTrip(score);
        const a = content(score);
        const b = content(back);
        const missing = a.notes.filter((x) => !b.notes.includes(x));
        const extra = b.notes.filter((x) => !a.notes.includes(x));
        console.log(f, JSON.stringify({ notes: a.notes.length, missing: missing.length, extra: extra.length, sample: [...missing.slice(0, 2), "/", ...extra.slice(0, 2)], dropped }));
        expect(missing).toEqual([]);
        expect(extra).toEqual([]);
        expect(b.order).toEqual(a.order);
        expect(b.seconds).toEqual(a.seconds);
        expect(b.marks).toEqual(a.marks);
      }, 60_000);
});
