// @vitest-environment happy-dom
// Reads every Guitar Pro file of the local corpus (npm run corpus, corpus/guitarpro/) and
// compares it with MuseScore 4's import of the same file, exported as MusicXML (notes) and
// .mscz (tab). Runs with SCOREDIT_CORPUS=1 when the corpus is there.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { kid, kids, parseXml, text } from "../model/xml";
import { readGuitarPro } from "./gp";
import { loadScore } from "./load";

// A summary of a MusicXML score for comparing two readings of the same Guitar Pro file: per
// measure, its signatures, barlines and tempo, and each sounding note's onset, pitch and length.
// Tab staves are left out (MuseScore's MusicXML export has none); their frets are read apart.

interface XmlNote {
  part: number;
  measure: number;
  /** Onset and length in 1/10080 quarter notes. */
  onset: number;
  dur: number;
  midi: number;
  tie: string;
  tuplet: string;
}
interface XmlMeasure {
  time: string;
  fifths: string;
  bars: string;
  tempo: string;
}
interface XmlSummary {
  parts: number;
  measures: XmlMeasure[][];
  notes: XmlNote[];
  frets: string[];
}

const STEPS: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const Q = 10080;

export function summarize(doc: Document): XmlSummary {
  const root = doc.documentElement;
  const unpitched = new Map<string, number>();
  for (const mi of Array.from(root.getElementsByTagName("midi-instrument"))) {
    const u = text(mi, "midi-unpitched");
    if (u) unpitched.set(mi.getAttribute("id") ?? "", Number(u) - 1);
  }
  const notes: XmlNote[] = [];
  const frets: string[] = [];
  const measures: XmlMeasure[][] = [];
  kids(root, "part").forEach((part, p) => {
    let divisions = 1;
    let time = "";
    let fifths = "0";
    // Sounding pitch: written plus <transpose>.
    let transpose = 0;
    const tabStaves = new Set<string>();
    const out: XmlMeasure[] = [];
    measures.push(out);
    kids(part, "measure").forEach((meas, m) => {
      let cursor = 0;
      let last = 0;
      const bars: string[] = [];
      let tempo = "";
      for (const c of kids(meas)) {
        const tag = c.tagName;
        if (tag === "attributes") {
          if (kid(c, "divisions")) divisions = Number(text(c, "divisions"));
          const t = kid(c, "time");
          if (t) time = `${text(t, "beats")}/${text(t, "beat-type")}`;
          const k = kid(c, "key");
          if (k) fifths = text(k, "fifths") || "0";
          const tr = kid(c, "transpose");
          if (tr) transpose = Number(text(tr, "chromatic") || 0) + 12 * Number(text(tr, "octave-change") || 0);
          for (const cl of kids(c, "clef")) if (text(cl, "sign") === "TAB") tabStaves.add(cl.getAttribute("number") ?? "1");
        } else if (tag === "backup") cursor -= Number(text(c, "duration"));
        else if (tag === "forward") cursor += Number(text(c, "duration"));
        else if (tag === "barline") {
          const rep = kid(c, "repeat");
          if (rep) bars.push(`${rep.getAttribute("direction")}${rep.getAttribute("times") ? "x" + rep.getAttribute("times") : ""}`);
          const end = kid(c, "ending");
          // Voltas on the first part only, as MuseScore writes them.
          if (end && p === 0 && end.getAttribute("type") === "start") bars.push(`ending ${end.getAttribute("number")?.replace(/\s+/g, "")}`);
        } else if (tag === "direction") {
          const s = kid(c, "sound");
          if (s?.getAttribute("tempo")) tempo = String(Math.round(Number(s.getAttribute("tempo"))));
        } else if (tag === "sound" && c.getAttribute("tempo")) tempo = String(Math.round(Number(c.getAttribute("tempo"))));
        else if (tag === "note") {
          const dur = Math.round((Number(text(c, "duration") || 0) * Q) / divisions);
          const chord = !!kid(c, "chord");
          const grace = !!kid(c, "grace");
          const onset = chord ? last : Math.round((cursor * Q) / divisions);
          if (!chord && !grace) {
            last = onset;
            cursor += Number(text(c, "duration") || 0);
          }
          const staff = text(c, "staff") || "1";
          const tech = c.getElementsByTagName("technical")[0];
          const str = tech ? text(tech, "string") : "";
          if (str && tabStaves.has(staff)) frets.push(`${p}|${m}|${str}|${text(tech, "fret")}`);
          if (grace || kid(c, "rest") || tabStaves.has(staff)) continue;
          const pitch = kid(c, "pitch");
          let midi = -1;
          if (pitch) midi = (Number(text(pitch, "octave")) + 1) * 12 + STEPS[text(pitch, "step")] + Number(text(pitch, "alter") || 0) + transpose;
          else midi = unpitched.get(kid(c, "instrument")?.getAttribute("id") ?? "") ?? -1;
          const tm = kid(c, "time-modification");
          notes.push({
            part: p,
            measure: m,
            onset,
            dur,
            midi: Math.round(midi),
            tie: kids(c, "tie").map((t) => t.getAttribute("type")).join(","),
            tuplet: tm ? `${text(tm, "actual-notes")}:${text(tm, "normal-notes")}` : "",
          });
        }
      }
      out.push({ time, fifths, bars: bars.join(" "), tempo });
    });
  });
  return { parts: measures.length, measures, notes, frets };
}

interface Comparison {
  /** Parts and measure counts, ours then theirs. */
  parts: [number, number];
  measures: [number, number];
  /** Measures whose time signature, key, barlines or tempo differ. */
  time: number;
  key: number;
  bars: number;
  tempo: number;
  /** Notes (onset and pitch) found on one side only, and matched notes of another length, tie or tuplet. */
  notes: number;
  missing: number;
  extra: number;
  dur: number;
  tie: number;
  tuplet: number;
  frets?: [number, number, number];
  sample: string[];
}

const key = (n: XmlNote) => `${n.part}|${n.measure}|${n.onset}|${n.midi}`;

/** Our onsets moved onto theirs when a few divisions apart: tuplets no division count holds round apart. */
function snap(ours: XmlNote[], theirs: XmlNote[]): XmlNote[] {
  const at = new Map<string, number[]>();
  for (const n of theirs) at.set(`${n.part}|${n.measure}|${n.midi}`, [...(at.get(`${n.part}|${n.measure}|${n.midi}`) ?? []), n.onset]);
  return ours.map((n) => {
    const near = at.get(`${n.part}|${n.measure}|${n.midi}`)?.find((o) => Math.abs(o - n.onset) <= 16);
    return near === undefined ? n : { ...n, onset: near };
  });
}

/** Compares two summaries; `frets` is the other side's tab, when read apart. */
function compareSummaries(ours: XmlSummary, theirs: XmlSummary, theirFrets?: string[]): Comparison {
  const sample: string[] = [];
  const note = (s: string) => sample.length < 8 && sample.push(s);
  const count = (f: (a: XmlMeasure, b: XmlMeasure) => boolean, what: string) => {
    let n = 0;
    ours.measures.forEach((ms, p) =>
      ms.forEach((a, m) => {
        const b = theirs.measures[p]?.[m];
        if (b && f(a, b)) {
          n++;
          note(`${what} p${p} m${m + 1}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
        }
      }),
    );
    return n;
  };
  const multi = (xs: XmlNote[]) => {
    const map = new Map<string, XmlNote[]>();
    for (const x of xs) map.set(key(x), [...(map.get(key(x)) ?? []), x]);
    return map;
  };
  const a = multi(snap(ours.notes, theirs.notes));
  const b = multi(theirs.notes);
  let missing = 0;
  let extra = 0;
  let dur = 0;
  let tie = 0;
  let tuplet = 0;
  for (const [k, xs] of b) {
    const ys = a.get(k) ?? [];
    if (ys.length < xs.length) {
      missing += xs.length - ys.length;
      note(`missing ${k} dur ${xs[0].dur}`);
    }
    const x = xs[0];
    const y = ys[0];
    if (!y) continue;
    // A few divisions of rounding apart, for tuplets no division count holds exactly.
    if (!ys.some((v) => Math.abs(v.dur - x.dur) <= 16)) {
      dur++;
      note(`dur ${k}: ${y.dur} vs ${x.dur}`);
    }
    if (!ys.some((v) => v.tie === x.tie)) {
      tie++;
      note(`tie ${k}: ${y.tie} vs ${x.tie}`);
    }
    if (!ys.some((v) => v.tuplet === x.tuplet)) {
      tuplet++;
      note(`tuplet ${k}: ${y.tuplet} vs ${x.tuplet}`);
    }
  }
  for (const [k, ys] of a) {
    const xs = b.get(k) ?? [];
    if (xs.length < ys.length) {
      extra += ys.length - xs.length;
      note(`extra ${k} dur ${ys[0].dur}`);
    }
  }
  let frets: [number, number, number] | undefined;
  if (theirFrets) {
    const left = [...ours.frets];
    let diff = 0;
    for (const f of theirFrets) {
      const i = left.indexOf(f);
      if (i >= 0) left.splice(i, 1);
      else {
        diff++;
        note(`fret missing ${f}`);
      }
    }
    for (const f of left.slice(0, 2)) note(`fret extra ${f}`);
    frets = [ours.frets.length, theirFrets.length, diff + left.length];
  }
  return {
    parts: [ours.parts, theirs.parts],
    measures: [ours.measures[0]?.length ?? 0, theirs.measures[0]?.length ?? 0],
    time: count((x, y) => x.time !== y.time, "time"),
    key: count((x, y) => x.fifths !== y.fifths, "key"),
    bars: count((x, y) => x.bars !== y.bars, "bars"),
    tempo: count((x, y) => !!y.tempo && x.tempo !== y.tempo, "tempo"),
    notes: theirs.notes.length,
    missing,
    extra,
    dur,
    tie,
    tuplet,
    frets,
    sample,
  };
}

const dir = join(__dirname, "../../corpus/guitarpro");
const on = process.env.SCOREDIT_CORPUS === "1" && existsSync(dir);

// Files MuseScore reads otherwise, checked by hand: why scoredit keeps its own reading.
const HARMONIC = "MuseScore writes a harmonic at its sounding pitch, or adds that pitch as a second note (and tab fret)";
const KNOWN: [RegExp, string][] = [
  [/^(Effects|Harmonics)\.gp[345]$|^artificial-harmonic|^gpp_tab\.gp5$|^gp8_syncpoint/, HARMONIC],
  [/^(basic-)?bend\.|^gpp_tab\.gp4$/,"MuseScore writes a bent or pre-bent note at its bent pitch, and its tab adds the bend's target"],
  [/^capo-fret\.gp[34]$|^fret-diagram\.gp4$/, "MuseScore leaves a GP3 or GP4 capo out of the pitch (not a GP5 one); Guitar Pro sounds it"],
  [/^all-percussion\./, "GP3 to GP5 drum keys are played on General MIDI sounds; GP6 kits other than drums, and notes naming no drum, differ"],
  [/^(chordnames_keyboard|clefs|dotted-tuplets|grace)\.gp/, "MuseScore gives a tab staff to a piano or xylophone track that has a tuning"],
  [/^high-pitch\.gp3$/, "a fret past MIDI 127: MuseScore writes fret 0, scoredit keeps the fret"],
  [/^Repeat\.gp5$/, "MuseScore counts a repeat's plays from its voltas"],
  [/^repeated-bars\./, "MuseScore repeats the tempo mark of the bar a simile bar repeats"],
];

describe.skipIf(!on)("Guitar Pro corpus", () => {
  const names = on ? readdirSync(dir).filter((f) => /\.gp[345x]?$/i.test(f)) : [];
  const report: Record<string, unknown> = {};
  // The comparison of each file, for a closer look: corpus/guitarpro/report.json.
  afterAll(() => void (names.length && writeFileSync(join(dir, "report.json"), JSON.stringify(report, null, 1))));
  for (const name of names) {
    it(`reads ${name} like MuseScore`, () => {
      const ours = summarize(readGuitarPro(new Uint8Array(readFileSync(join(dir, name)))).doc);
      expect(ours.measures[0]?.length).toBeGreaterThan(0);
      const xml = join(dir, "mscore", `${name}.musicxml`);
      if (!existsSync(xml)) return;
      const mscz = join(dir, "mscore", `${name}.mscz`);
      const tab = existsSync(mscz) ? summarize(loadScore(new Uint8Array(readFileSync(mscz)), { tab: "always" }).score.doc).frets : undefined;
      const r = compareSummaries(ours, summarize(parseXml(readFileSync(xml, "utf8"))), tab);
      const known = KNOWN.find(([re]) => re.test(name))?.[1];
      report[name] = { ...r, known };
      expect([r.parts[0], r.measures[0], r.time, r.key]).toEqual([r.parts[1], r.measures[1], 0, 0]);
      if (!known) expect([r.missing, r.extra, r.dur, r.tie, r.tuplet, r.bars, r.tempo, r.frets?.[2] ?? 0]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    }, 60_000);
  }
});
