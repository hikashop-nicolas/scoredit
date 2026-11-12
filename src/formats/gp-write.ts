import { strToU8, zipSync } from "fflate";
import { readHarmony } from "../edit/chords";
import { isAfterGrace, readMeasure, type Event, type ReadMeasure } from "../edit/measure";
import { midiOf } from "../edit/notes";
import { DRUM_KIT } from "../model/instruments";
import type { ScoreDoc } from "../model/score";
import { kid, kids, text } from "../model/xml";
import { harmonicFret } from "./gp";
import type { Dropped } from "./mscx-write";

// Guitar Pro 7 files (.gp) written from a score's MusicXML: a zip holding Content/score.gpif.
// The layout follows what guitarpro-parser reads; what GPIF cannot hold is counted in `dropped`.

export interface GuitarProWriteOptions {
  /** Fretted tracks show a tab staff in Guitar Pro: as the score does (default), always or never. */
  tab?: "auto" | "always" | "never";
}

const TPQ = 960;
const VALUES: [string, number][] = [["DoubleWhole", 7680], ["Whole", 3840], ["Half", 1920], ["Quarter", 960], ["Eighth", 480], ["16th", 240], ["32nd", 120], ["64th", 60], ["128th", 30], ["256th", 15]];
const VALUE_TICKS: Record<string, number> = Object.fromEntries(VALUES);
const TYPE_VALUE: Record<string, string> = { maxima: "DoubleWhole", long: "DoubleWhole", breve: "DoubleWhole", whole: "Whole", half: "Half", quarter: "Quarter", eighth: "Eighth", "16th": "16th", "32nd": "32nd", "64th": "64th", "128th": "128th", "256th": "256th" };
const DYNAMICS: Record<string, string> = { ppp: "PPP", pp: "PP", p: "P", mp: "MP", mf: "MF", f: "F", ff: "FF", fff: "FFF", pppp: "PPP", ffff: "FFF", sf: "FF", sfz: "FF", sffz: "FFF", rfz: "FF", rf: "FF", fz: "FF", fp: "F", sfp: "F", pf: "P" };
const EXACT_DYNAMICS = new Set(["ppp", "pp", "p", "mp", "mf", "f", "ff", "fff"]);
const ACCENTS: Record<string, number> = { staccato: 1, "strong-accent": 4, accent: 8, tenuto: 16 };
const SLIDES_OUT: Record<string, number> = { falloff: 4, doit: 8, scoop: 16, plop: 32 };
const ORNAMENTS: Record<string, string> = { turn: "Turn", "inverted-turn": "InvertedTurn", "inverted-mordent": "UpperMordent", mordent: "LowerMordent" };
// The tab labels of artificial harmonics, and Guitar Pro's harmonic types.
const HARMONIC_LABELS: Record<string, string> = { "A.H.": "Artificial", "P.H.": "Pinch", "T.H.": "Tap", "S.H.": "Semi", "Fdbk.": "Feedback" };
const OTTAVAS: Record<string, string> = { down8: "8va", up8: "8vb", down15: "15ma", up15: "15mb" };
const TREMOLO: Record<number, string> = { 1: "1/2", 2: "1/4", 3: "1/8" };
const CLEF: Record<string, string> = { G: "G2", F: "F4", C3: "C3", C4: "C4", percussion: "Neutral" };
const JUMP_WORDS: [RegExp, string][] = [
  [/^D\.?\s*S\.?\s*S\.?\s*al\s*Double\s*Coda/i, "DaSegnoSegnoAlDoubleCoda"],
  [/^D\.?\s*S\.?\s*S\.?\s*al\s*Coda/i, "DaSegnoSegnoAlCoda"],
  [/^D\.?\s*S\.?\s*S\.?\s*al\s*Fine/i, "DaSegnoSegnoAlFine"],
  [/^D\.?\s*S\.?\s*S\.?$/i, "DaSegnoSegno"],
  [/^D\.?\s*S\.?\s*al\s*Double\s*Coda/i, "DaSegnoAlDoubleCoda"],
  [/^D\.?\s*S\.?\s*al\s*Coda/i, "DaSegnoAlCoda"],
  [/^D\.?\s*S\.?\s*al\s*Fine/i, "DaSegnoAlFine"],
  [/^(D\.?\s*S\.?|Dal\s*Segno)$/i, "DaSegno"],
  [/^D\.?\s*C\.?\s*al\s*Double\s*Coda/i, "DaCapoAlDoubleCoda"],
  [/^D\.?\s*C\.?\s*al\s*Coda/i, "DaCapoAlCoda"],
  [/^D\.?\s*C\.?\s*al\s*Fine/i, "DaCapoAlFine"],
  [/^(D\.?\s*C\.?|Da\s*Capo)$/i, "DaCapo"],
  [/^To\s*Double\s*Coda/i, "DaDoubleCoda"],
  [/^To\s*Coda/i, "DaCoda"],
];

interface Rhythm {
  value: string;
  dots: number;
  tuplet: [number, number] | null;
}
interface Bend {
  origin: number;
  middle: number | null;
  dest: number;
}
interface GNote {
  midi: number;
  string: number;
  fret: number;
  /** Where the score placed it (string 0: lowest), when it did. */
  want: { string: number; fret: number } | null;
  tieFrom: boolean;
  tieTo: boolean;
  dead: boolean;
  ghost: boolean;
  accent: number;
  letRing: boolean;
  palmMute: boolean;
  vibrato: boolean;
  trill: boolean;
  ornament: string | null;
  hopoOrigin: boolean;
  hopoDest: boolean;
  slide: number;
  harmonic: string | null;
  bend: Bend | null;
  tapped: boolean;
  leftTapped: boolean;
}
interface GBeat {
  rhythm: Rhythm;
  tick: number;
  dur: number;
  grace: "BeforeBeat" | "OnBeat" | null;
  notes: GNote[];
  dynamic: string;
  chord: string | null;
  text: string[];
  brush: "Up" | "Down" | null;
  pick: "Up" | "Down" | null;
  tremolo: string | null;
  slurStart: number;
  slurStop: number;
  legato: [boolean, boolean] | null;
  hairpin: string | null;
  ottava: string | null;
  lyrics: Map<number, { text: string; syllabic: string }>;
}
type Voice = GBeat[] | null;
interface GStaff {
  part: PartIn;
  staff: number;
  /** bars[m][slot]: a voice's beats, null when empty. */
  bars: Voice[][];
  clefs: string[];
  voiceSlots: Map<string, number>;
  dynamics: { m: number; tick: number; value: string }[];
  wedges: { m: number; tick: number; type: string }[];
  runs: { m: number; tick: number; kind: "pm" | "ring"; end: { m: number; tick: number } | null }[];
  ottavas: { m: number; tick: number; kind: string }[];
  /** Bars marked to repeat the one or two before (Guitar Pro's simile marks). */
  similes: Map<number, string>;
}
interface MeasureState {
  div: number;
  beats: number;
  beatType: number;
  fifths: number;
  minor: boolean;
  clefs: Map<number, string>;
  octave: Map<number, number>;
  /** Measure repeats on each staff: this bar's place in the sign. */
  repeats: Map<number, string>;
}
interface PartIn {
  el: Element;
  index: number;
  name: string;
  short: string;
  program: number | null;
  measures: Element[];
  states: MeasureState[];
  reads: (ReadMeasure | null)[];
  staves: number;
  drums: boolean;
  /** Open strings, lowest first. */
  tuning: number[] | null;
  capo: number;
  tab: number | null;
  /** The staff written to Guitar Pro for a fretted part. */
  primary: number;
  transpose: number;
  drumOf: Map<string, number>;
  gp: GStaff[];
}

type Drop = (what: string, n?: number) => void;
const ordered = (a: { m: number; tick: number }, b: { m: number; tick: number }) => a.m - b.m || a.tick - b.tick;
const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : Math.abs(a));
const lengthOf = (r: Rhythm) => VALUE_TICKS[r.value] * (2 - 2 ** -r.dots) * (r.tuplet ? r.tuplet[1] / r.tuplet[0] : 1);
const cdata = (s: string) => `<![CDATA[${s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").replace(/]]>/g, "]]]]><![CDATA[>")}]]>`;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function single(t: number): Rhythm | null {
  for (const [value, n] of VALUES) for (let dots = 0; dots <= 2; dots++) if (Math.abs(n * (2 - 2 ** -dots) - t) < 1) return { value, dots, tuplet: null };
  return null;
}

/** Written values for a length in ticks, tied one to the next. */
function splitTicks(t: number): Rhythm[] {
  const s = single(t);
  if (s) return [s];
  for (const [num, den] of [[3, 2], [5, 4], [6, 4], [7, 4], [9, 8]] as [number, number][]) {
    const u = single((t * num) / den);
    if (u) return [{ ...u, tuplet: [num, den] }];
  }
  const out: Rhythm[] = [];
  let left = t;
  while (left >= 14.5) {
    let best: Rhythm | null = null;
    for (const [value, n] of VALUES)
      for (let dots = 0; dots <= 2; dots++) {
        const len = n * (2 - 2 ** -dots);
        if (len <= left + 0.5 && (!best || len > lengthOf(best))) best = { value, dots, tuplet: null };
      }
    if (!best) break;
    out.push(best);
    left -= lengthOf(best);
  }
  return out;
}

/** A score as a Guitar Pro 7 file, and what it could not hold. */
export function writeGuitarPro(score: ScoreDoc | Document, opts: GuitarProWriteOptions = {}): { bytes: Uint8Array; dropped: Dropped } {
  const doc = "doc" in score ? score.doc : score;
  const dropped: Dropped = {};
  const drop = (what: string, n = 1) => (dropped[what] = (dropped[what] ?? 0) + n);
  const root = doc.documentElement;

  const parts = kids(root, "part").map((el, index) => readPart(el, index, root, drop));
  const M = Math.max(0, ...parts.map((p) => p.measures.length));
  const lead = parts.find((p) => p.measures.length === M) ?? parts[0];
  // The key as it sounds: from a part that does not transpose, else moved to concert pitch.
  const keyPart = parts.find((p) => !p.drums && p.transpose % 12 === 0) ?? parts.find((p) => !p.drums) ?? lead;
  const concert = (f: number) => {
    let c = f + 7 * (keyPart?.transpose ?? 0);
    c = ((c % 12) + 12) % 12;
    return c > 6 ? c - 12 : c;
  };

  // Master bars: time and key from the first parts, length from the notes, then barlines.
  const master = Array.from({ length: M }, (_, m) => {
    const st = lead?.states[m] ?? { beats: 4, beatType: 4 };
    const ks = keyPart?.states[m] ?? { fifths: 0, minor: false };
    return {
      beats: st.beats,
      beatType: st.beatType,
      fifths: keyPart && keyPart.transpose % 12 ? concert(ks.fifths) : Math.max(-7, Math.min(7, ks.fifths)),
      minor: ks.minor,
      ticks: (st.beats * 4 * TPQ) / st.beatType,
      repeatStart: false,
      repeatEnd: 0,
      endings: null as number[] | null,
      doubleBar: false,
      section: null as { letter: string; text: string } | null,
      targets: new Set<string>(),
      jumps: new Set<string>(),
      fermatas: new Set<number>(),
      tempos: [] as { tick: number; bpm: number }[],
      shift: 0,
    };
  });
  const content = new Array<number>(M).fill(0);
  for (const p of parts)
    p.measures.forEach((_, m) => {
      const r = p.reads[m]!;
      const div = p.states[m].div;
      for (const evs of r.voices.values()) for (const ev of evs) content[m] = Math.max(content[m], Math.round(((ev.pos + ev.dur) * TPQ) / div));
    });
  let anacrusis = false;
  master.forEach((mb, m) => {
    const implicit = parts.some((p) => p.measures[m]?.getAttribute("implicit") === "yes");
    if (!implicit || content[m] <= 0 || content[m] >= mb.ticks - 1) return;
    if (m === 0) {
      anacrusis = true;
      mb.shift = mb.ticks - content[m];
      return;
    }
    // A short bar inside the score: written as a bar of its own time signature.
    for (const bt of [mb.beatType, 8, 16, 32, 64]) {
      const n = (content[m] * bt) / (4 * TPQ);
      if (Number.isInteger(n) && bt >= mb.beatType) {
        Object.assign(mb, { beats: n, beatType: bt, ticks: content[m] });
        drop("short measure as a time signature");
        break;
      }
    }
  });

  barlines(parts, master, drop);

  // Each part's staves become Guitar Pro staves (a track holds at most two).
  const staves: GStaff[] = [];
  for (const p of parts) {
    const list = p.drums ? [1] : p.tuning ? [p.primary] : Array.from({ length: Math.min(2, p.staves) }, (_, i) => i + 1);
    if (p.drums && p.staves > 1) drop("drum staff beyond the first", p.staves - 1);
    if (!p.drums && !p.tuning && p.staves > 2) drop("staff beyond the second", p.staves - 2);
    if (p.tuning) for (let s = 1; s <= p.staves; s++) if (s !== p.primary && s !== p.tab) drop("staff beside a fretted one");
    for (const s of list) {
      const g: GStaff = { part: p, staff: s, bars: [], clefs: [], voiceSlots: new Map(), dynamics: [], wedges: [], runs: [], ottavas: [], similes: new Map() };
      p.gp.push(g);
      staves.push(g);
    }
  }

  for (const g of staves) buildStaff(g, master, drop);

  // Directions, chord symbols and fermatas, now that the beats are known.
  for (const p of parts) placeMarks(p, master, drop);
  for (const g of staves) {
    applyDynamics(g);
    applyWedges(g);
    applyRuns(g);
    applyOttavas(g);
    applyLegato(g);
  }
  for (const p of parts) if (p.tuning) checkHopos(p);
  for (const p of parts) if (p.gp.length && p.tuning && p.transpose % 12) drop("transposition (written at concert pitch)");
  let tempos = master.flatMap((mb, m) => mb.tempos.map((t) => ({ m, ...t })));
  // Guitar Pro needs a tempo at the start: the one scoredit plays a score without one at.
  if (!tempos.some((t) => t.m === 0 && t.tick === 0)) tempos = [{ m: 0, tick: 0, bpm: 100 }, ...tempos];

  const xml = gpif(doc, parts, master, tempos, anacrusis, drop);
  const tracks = parts.flatMap((p) => (p.gp.length ? [p] : []));
  const files: Record<string, Uint8Array> = {
    VERSION: strToU8("7.0"),
    "Content/score.gpif": strToU8(xml),
    "Content/PartConfiguration": partConfiguration(tracks.map((p) => (p.drums || !p.tuning ? 1 : opts.tab === "always" ? 3 : opts.tab === "never" ? 1 : p.tab === null ? 1 : p.primary === p.tab ? 2 : 3))),
    "Content/LayoutConfiguration": layoutConfiguration(tracks.length),
    "Content/Preferences.json": strToU8(`{"tonality":{"isActive":false,"value":0},"tempo":{"isActive":false,"mode":"Constant","constantTempo":100,"fromTempo":70,"toTempo":100,"step":10,"repeatCount":1}}`),
  };
  return { bytes: zipSync(files), dropped };
}

function readPart(el: Element, index: number, root: Element, drop: Drop): PartIn {
  const id = el.getAttribute("id") ?? "";
  const list = kid(root, "part-list");
  const sp = list ? kids(list, "score-part").find((x) => x.getAttribute("id") === id) : undefined;
  const drumOf = new Map<string, number>();
  let program: number | null = null;
  let channel10 = false;
  for (const mi of sp ? kids(sp, "midi-instrument") : []) {
    const un = text(mi, "midi-unpitched");
    if (un) drumOf.set(mi.getAttribute("id") ?? "", Number(un) - 1);
    if (program === null && text(mi, "midi-program")) program = Number(text(mi, "midi-program")) - 1;
    if (text(mi, "midi-channel") === "10") channel10 = true;
  }
  const measures = kids(el, "measure");
  const p: PartIn = {
    el,
    index,
    name: text(sp, "part-name"),
    short: text(sp, "part-abbreviation"),
    program,
    measures,
    states: [],
    reads: measures.map((m) => readMeasure(m)),
    staves: 1,
    drums: false,
    tuning: null,
    capo: 0,
    tab: null,
    primary: 1,
    transpose: 0,
    drumOf,
    gp: [],
  };
  let div = 1;
  let beats = 4;
  let beatType = 4;
  let fifths = 0;
  let minor = false;
  let transposeSet = false;
  const clefs = new Map<number, string>();
  const octave = new Map<number, number>();
  let unpitched = false;
  const repeating = new Map<number, { bars: number; from: number }>();
  for (const [mi, meas] of measures.entries()) {
    let started = false;
    let start: { clefs: Map<number, string>; octave: Map<number, number> } | null = null;
    let measDiv: number | null = null;
    for (const c of kids(meas)) {
      if (c.tagName === "note" || c.tagName === "backup" || c.tagName === "forward") {
        if (!started) start = { clefs: new Map(clefs), octave: new Map(octave) };
        started = true;
        if (c.tagName === "note" && kid(c, "unpitched")) unpitched = true;
        continue;
      }
      if (c.tagName !== "attributes") continue;
      for (const a of kids(c)) {
        const n = Number(a.getAttribute("number")) || 1;
        switch (a.tagName) {
          case "divisions":
            div = Number(a.textContent) || 1;
            if (!started) measDiv = div;
            break;
          case "time":
            if (kid(a, "senza-misura")) drop("senza misura");
            else {
              beats = kids(a, "beats").reduce((s, b) => s + (b.textContent ?? "").split("+").reduce((x, y) => x + (Number(y) || 0), 0), 0) || 4;
              beatType = Number(text(a, "beat-type")) || 4;
            }
            break;
          case "key":
            if (kid(a, "fifths")) {
              fifths = Number(text(a, "fifths")) || 0;
              minor = text(a, "mode") === "minor";
            }
            break;
          case "clef": {
            const sign = text(a, "sign");
            const line = Number(text(a, "line"));
            clefs.set(n, sign === "C" ? (line === 4 ? "C4" : "C3") : sign === "TAB" ? "TAB" : (CLEF[sign] ?? "G2"));
            octave.set(n, Number(text(a, "clef-octave-change")) || 0);
            if (sign === "percussion") unpitched = true;
            break;
          }
          case "staves":
            p.staves = Math.max(p.staves, Number(a.textContent) || 1);
            break;
          case "measure-style":
            for (const mr of kids(a, "measure-repeat")) {
              const staves = a.hasAttribute("number") ? [n] : Array.from({ length: Math.max(p.staves, 2) }, (_, i) => i + 1);
              for (const sn of staves) {
                if (mr.getAttribute("type") === "start") repeating.set(sn, { bars: Number(mr.textContent) === 2 ? 2 : 1, from: mi });
                else repeating.delete(sn);
              }
            }
            break;
          case "staff-details": {
            const tunings = kids(a, "staff-tuning");
            if (tunings.length && !p.tuning) {
              p.tuning = tunings
                .sort((x, y) => Number(x.getAttribute("line")) - Number(y.getAttribute("line")))
                .map((t) => midiOf({ step: text(t, "tuning-step"), alter: Number(text(t, "tuning-alter")) || 0, octave: Number(text(t, "tuning-octave")) }));
            }
            if (text(a, "capo")) p.capo = Number(text(a, "capo")) || 0;
            break;
          }
          case "transpose":
            if (!transposeSet) p.transpose = (Number(text(a, "chromatic")) || 0) + 12 * (Number(text(a, "octave-change")) || 0);
            transposeSet = true;
            break;
        }
      }
    }
    const repeats = new Map([...repeating].map(([sn, r]) => [sn, r.bars === 1 ? "Simple" : (mi - r.from) % 2 ? "SecondOfDouble" : "FirstOfDouble"]));
    p.states.push({ div: measDiv ?? div, beats, beatType, fifths, minor, clefs: start?.clefs ?? new Map(clefs), octave: start?.octave ?? new Map(octave), repeats });
  }
  const first = p.states[0]?.clefs;
  const tabClef = first ? [...first].find(([, c]) => c === "TAB")?.[0] : undefined;
  if (tabClef !== undefined) p.tab = tabClef;
  p.drums = unpitched || (channel10 && !p.tuning) || (drumOf.size > 0 && program === null);
  if (p.drums) p.tuning = null;
  if (p.tuning) {
    const notation = Array.from({ length: p.staves }, (_, i) => i + 1).find((s) => s !== p.tab);
    p.primary = notation ?? p.tab ?? 1;
  }
  return p;
}

/** Repeats, voltas and double bars, from every part's barlines. */
function barlines(parts: PartIn[], master: MasterOut[], drop: Drop): void {
  parts.forEach((p, pi) => {
    let active: number[] | null = null;
    p.measures.forEach((meas, m) => {
      const mb = master[m];
      let stopAfter = false;
      for (const bl of kids(meas, "barline")) {
        const right = bl.getAttribute("location") !== "left";
        const rep = kid(bl, "repeat");
        if (rep) {
          const dir = rep.getAttribute("direction");
          if (dir === "forward") {
            const target = right ? master[m + 1] : mb;
            if (target) target.repeatStart = true;
          } else {
            const target = right ? mb : master[m - 1];
            if (target) target.repeatEnd = Math.max(target.repeatEnd, Number(rep.getAttribute("times")) || 2);
          }
        }
        const end = kid(bl, "ending");
        if (end) {
          const type = end.getAttribute("type");
          if (type === "start") {
            const nums = (end.getAttribute("number") ?? "").split(/[,\s]+/).map(Number).filter((n) => Number.isInteger(n) && n >= 1);
            active = nums.length ? nums : null;
          } else stopAfter = true;
        }
        const style = text(bl, "bar-style");
        if (right && !rep && pi === 0 && style && style !== "regular" && style !== "none" && style !== "dashed" && style !== "dotted") {
          if (style === "light-heavy" && m === p.measures.length - 1) continue;
          mb.doubleBar = true;
          if (style !== "light-light") drop(`barline ${style}`);
        }
      }
      if (active && !mb.endings) mb.endings = active;
      if (stopAfter) active = null;
    });
  });
}

type MasterOut = {
  beats: number;
  beatType: number;
  fifths: number;
  minor: boolean;
  ticks: number;
  repeatStart: boolean;
  repeatEnd: number;
  endings: number[] | null;
  doubleBar: boolean;
  section: { letter: string; text: string } | null;
  targets: Set<string>;
  jumps: Set<string>;
  fermatas: Set<number>;
  tempos: { tick: number; bpm: number }[];
  shift: number;
};

const midiOfNote = (el: Element, p: PartIn): number | null => {
  const pitch = kid(el, "pitch");
  if (pitch) return Math.round(midiOf({ step: text(pitch, "step"), alter: Number(text(pitch, "alter")) || 0, octave: Number(text(pitch, "octave")) })) + p.transpose;
  const un = kid(el, "unpitched");
  if (!un) return null;
  const inst = kid(el, "instrument")?.getAttribute("id");
  if (inst && p.drumOf.has(inst)) return p.drumOf.get(inst)!;
  // Else by where it sits on the staff (half spaces down from the top line, F5) and its head.
  const at = Number(text(un, "display-octave")) * 7 + "CDEFGAB".indexOf(text(un, "display-step") || "E");
  const line = 5 * 7 + 3 - at;
  const head = text(el, "notehead");
  const heads: Record<string, string> = { x: "cross", diamond: "diamond", "circle-x": "circle-x", triangle: "triangle" };
  const want = heads[head] ?? "normal";
  return (DRUM_KIT.find((d) => d.line === line && d.head === want) ?? DRUM_KIT.find((d) => d.line === line))?.pitch ?? 38;
};

function buildStaff(g: GStaff, master: MasterOut[], drop: Drop): void {
  const p = g.part;
  // Voices of the staff, in number order, take Guitar Pro's four voice slots.
  const ids = new Set<string>();
  for (const r of p.reads) for (const k of r?.voices.keys() ?? []) if (k.startsWith(`${g.staff}|`)) ids.add(k.split("|")[1]);
  [...ids].sort((a, b) => (Number(a) || 0) - (Number(b) || 0) || a.localeCompare(b)).forEach((v, i) => (i < 4 ? g.voiceSlots.set(v, i) : undefined));
  const lastString = [new Map<number, number>(), new Map<number, number>(), new Map<number, number>(), new Map<number, number>()];

  master.forEach((mb, m) => {
    const st = p.states[m] ?? p.states[p.states.length - 1];
    const clef = st?.clefs.get(g.staff) ?? (p.drums ? "Neutral" : "G2");
    g.clefs.push(clef === "TAB" ? (p.tuning && Math.min(...p.tuning) < 36 ? "F4" : "G2") : p.drums ? "Neutral" : clef);
    const slots: Voice[] = [null, null, null, null];
    g.bars.push(slots);
    const r = p.reads[m];
    if (!r || !st) return;
    // A bar repeat sign: Guitar Pro plays the bars before, so the notes filled in are not written.
    const simile = st.repeats.get(g.staff);
    if (simile && m >= (simile === "Simple" ? 1 : 2)) {
      g.similes.set(m, simile);
      return;
    }
    const div = st.div;
    const tk = (d: number) => Math.round((d * TPQ) / div);
    const barLen = m === 0 && mb.shift ? mb.ticks - mb.shift : mb.ticks;
    const tabIndex = p.tuning && p.tab !== null && p.tab !== g.staff ? tabNotes(r, p.tab, tk) : null;
    for (const [key, evs] of r.voices) {
      const [s, v] = key.split("|");
      if (Number(s) !== g.staff) continue;
      const slot = g.voiceSlots.get(v);
      if (slot === undefined) {
        drop("voice beyond the fourth");
        continue;
      }
      const sorted = [...evs].sort((a, b) => a.pos - b.pos);
      if (sorted.length === 1 && sorted[0].rest && !sorted[0].graces.length && (kid(sorted[0].notes[0], "rest")?.getAttribute("measure") === "yes" || tk(sorted[0].dur) >= barLen || !kid(sorted[0].notes[0], "type"))) {
        // A whole-bar rest with a fermata stays a beat, to hold it.
        if (!sorted[0].notes[0].getElementsByTagName("fermata").length) continue;
        sorted[0] = { ...sorted[0], dur: (barLen * div) / TPQ };
        if (!rhythmOf(sorted[0].notes[0], barLen)) {
          const b = beat(splitTicks(barLen)[0] ?? { value: "Whole", dots: 0, tuplet: null }, 0, barLen);
          restMarks(sorted[0].notes[0], b);
          slots[slot] = [b];
          continue;
        }
      }
      const beats: GBeat[] = [];
      let cursor = 0;
      for (const ev of sorted) {
        const t = tk(ev.pos);
        if (t > cursor + 1) beats.push(...rests(cursor, t - cursor));
        else if (t < cursor - 1) {
          drop("overlapping note");
          continue;
        }
        // Grace notes before the beat: one beat per grace chord.
        const graces: GBeat[] = [];
        for (const gn of ev.graces) {
          if (isAfterGrace(gn)) {
            drop("grace note after a note");
            continue;
          }
          if (!graces.length || !kid(gn, "chord")) {
            const gb = beat(rhythmOf(gn, 0) ?? { value: "Eighth", dots: 0, tuplet: null }, t, 0);
            gb.grace = kid(gn, "grace")!.getAttribute("slash") === "yes" ? "BeforeBeat" : "OnBeat";
            graces.push(gb);
          }
          const n = makeNote(gn, tabIndex?.grace(t, midiOfNote(gn, p)) ?? null, graces[graces.length - 1], true);
          if (n) graces[graces.length - 1].notes.push(n);
        }
        for (const gb of graces) {
          place(gb, slot);
          beats.push(gb);
        }
        const d = tk(ev.dur);
        const first = ev.notes[0];
        const written = rhythmOf(first, d);
        const pieces = written ? [written] : splitTicks(d);
        if (!pieces.length) {
          drop("note too short");
          continue;
        }
        let at = t;
        let head: GNote[] = [];
        pieces.forEach((rh, i) => {
          const b = beat(rh, at, Math.round(lengthOf(rh)));
          if (!ev.rest) {
            if (i === 0) {
              for (const el of ev.notes) {
                const n = makeNote(el, tabIndex?.main(t, midiOfNote(el, p)) ?? null, b, true);
                if (n) b.notes.push(n);
              }
              beatMarks(ev, b);
              place(b, slot);
              head = b.notes.map((n) => ({ ...plain(n), tieTo: n.tieTo }));
            } else b.notes = head.map((n) => ({ ...n, tieFrom: true }));
            // A note written in pieces is tied across them.
            if (i < pieces.length - 1) for (const n of b.notes) n.tieTo = true;
          } else if (i === 0) restMarks(first, b);
          beats.push(b);
          at += b.dur;
        });
        cursor = t + d;
      }
      slots[slot] = beats.length ? beats : null;
    }

    function rests(from: number, len: number): GBeat[] {
      let at = from;
      return splitTicks(len).map((rh) => {
        const b = beat(rh, at, Math.round(lengthOf(rh)));
        at += b.dur;
        return b;
      });
    }

    function beatMarks(ev: Event, b: GBeat): void {
      for (const el of ev.notes) {
        for (const nots of kids(el, "notations")) {
          for (const c of kids(nots)) {
            if (c.tagName === "arpeggiate") b.brush = c.getAttribute("direction") === "down" ? "Up" : "Down";
            else if (c.tagName === "slur") {
              if (c.getAttribute("type") === "start") b.slurStart++;
              else if (c.getAttribute("type") === "stop") b.slurStop++;
            } else if (c.tagName === "fermata") mb.fermatas.add(b.tick + (m === 0 ? mb.shift : 0));
            else if (c.tagName === "dynamics") {
              const v = c.firstElementChild?.tagName ?? "";
              if (DYNAMICS[v]) g.dynamics.push({ m, tick: b.tick, value: DYNAMICS[v] });
            }
          }
        }
        for (const ly of kids(el, "lyric")) {
          const num = Number(ly.getAttribute("number")) || 1;
          const t = kids(ly, "text").map((x) => x.textContent ?? "").join("");
          if (!t) continue;
          if (b.lyrics.has(num)) continue;
          b.lyrics.set(num, { text: t, syllabic: text(ly, "syllabic") || "single" });
        }
      }
    }

    function restMarks(el: Element, b: GBeat): void {
      for (const nots of kids(el, "notations")) {
        if (kid(nots, "fermata")) mb.fermatas.add(b.tick + (m === 0 ? mb.shift : 0));
        for (const c of kids(nots)) if (c.tagName === "slur") c.getAttribute("type") === "start" ? b.slurStart++ : b.slurStop++;
      }
    }

    function makeNote(el: Element, tabEl: Element | null, b: GBeat, count: boolean): GNote | null {
      const midi = midiOfNote(el, p);
      if (midi === null) return null;
      const alter = Number(text(kid(el, "pitch"), "alter")) || 0;
      if (count && alter !== Math.round(alter)) drop("microtone");
      const n: GNote = { midi, string: -1, fret: -1, want: null, tieFrom: false, tieTo: false, dead: false, ghost: false, accent: 0, letRing: false, palmMute: false, vibrato: false, trill: false, ornament: null, hopoOrigin: false, hopoDest: false, slide: 0, harmonic: null, bend: null, tapped: false, leftTapped: false };
      for (const tie of kids(el, "tie")) {
        if (tie.getAttribute("type") === "start") n.tieTo = true;
        if (tie.getAttribute("type") === "stop") n.tieFrom = true;
      }
      const head = kid(el, "notehead");
      if (!p.drums && head) {
        if (text(head) === "x" && p.tuning) n.dead = true;
        else if (text(head) === "diamond" && p.tuning) n.harmonic = "Natural";
        else if (text(head) !== "normal" && count) drop(`notehead ${text(head)}`);
        if (head.getAttribute("parentheses") === "yes") n.ghost = true;
      }
      const bends: { alter: number; pre: boolean; release: boolean }[] = [];
      const sources: [Element, boolean][] = [[el, count]];
      if (tabEl) sources.push([tabEl, false]);
      for (const [src, counting] of sources) {
        const lost = (w: string) => counting && drop(w);
        for (const nots of kids(src, "notations")) {
          for (const c of kids(nots)) {
            switch (c.tagName) {
              case "technical":
                for (const t of kids(c)) {
                  const type = t.getAttribute("type");
                  switch (t.tagName) {
                    case "string":
                    case "fret":
                      break;
                    case "hammer-on":
                    case "pull-off":
                      if (type === "start") n.hopoOrigin = true;
                      else if (type === "stop") n.hopoDest = true;
                      break;
                    case "bend":
                      bends.push({ alter: Number(text(t, "bend-alter")) || 0, pre: !!kid(t, "pre-bend"), release: !!kid(t, "release") });
                      break;
                    case "harmonic":
                      if (!n.harmonic || n.harmonic === "Natural") n.harmonic = kid(t, "artificial") ? "Artificial" : "Natural";
                      break;
                    case "other-technical":
                      if (HARMONIC_LABELS[text(t)]) n.harmonic = HARMONIC_LABELS[text(t)];
                      else lost(t.tagName);
                      break;
                    case "tap":
                      if (t.getAttribute("hand") === "left") n.leftTapped = true;
                      else n.tapped = true;
                      break;
                    case "up-bow":
                    case "down-bow":
                      if (counting) b.pick = t.tagName === "down-bow" ? "Down" : "Up";
                      break;
                    default:
                      lost(t.tagName);
                  }
                }
                break;
              case "ornaments":
                for (const o of kids(c)) {
                  if (o.tagName === "wavy-line") {
                    if (o.getAttribute("type") === "start") n.vibrato = true;
                  } else if (o.tagName === "trill-mark") n.trill = true;
                  else if (o.tagName === "tremolo") {
                    const strokes = Number(o.textContent) || 1;
                    if ((o.getAttribute("type") ?? "single") === "single" && TREMOLO[strokes]) b.tremolo = TREMOLO[strokes];
                    else lost("tremolo");
                  } else if (ORNAMENTS[o.tagName]) n.ornament = ORNAMENTS[o.tagName];
                  else if (o.tagName !== "accidental-mark") lost(o.tagName);
                }
                break;
              case "articulations":
                for (const a of kids(c)) {
                  if (ACCENTS[a.tagName]) n.accent |= ACCENTS[a.tagName];
                  else if (SLIDES_OUT[a.tagName] && p.tuning) n.slide |= SLIDES_OUT[a.tagName];
                  else lost(a.tagName);
                }
                break;
              case "slide":
              case "glissando":
                if (c.getAttribute("type") === "start") {
                  if (p.tuning) n.slide |= 1;
                  else lost(c.tagName);
                }
                break;
              case "tied":
              case "tuplet":
              case "slur":
              case "fermata":
              case "arpeggiate":
              case "dynamics":
                break;
              default:
                lost(c.tagName);
            }
          }
        }
      }
      if (n.accent & 4 && n.accent & 8) n.accent &= ~8;
      if (bends.length) {
        if (!p.tuning) count && drop("bend");
        else {
          const top = Math.max(...bends.map((x) => x.alter));
          const pre = bends.some((x) => x.pre);
          const release = bends.some((x) => x.release);
          const v = Math.round(top * 50);
          n.bend = pre ? { origin: v, middle: null, dest: release ? 0 : v } : release ? { origin: 0, middle: v, dest: 0 } : { origin: 0, middle: null, dest: v };
        }
      }
      // Where the score put it: the tab staff's note first, then the note's own.
      for (const src of tabEl ? [tabEl, el] : [el]) {
        const tech = kids(src, "notations").flatMap((x) => kids(x, "technical"));
        const s = tech.map((t) => text(t, "string")).find(Boolean);
        const f = tech.map((t) => text(t, "fret")).find(Boolean);
        if (s && f && p.tuning) {
          n.want = { string: p.tuning.length - Number(s), fret: Number(f) };
          break;
        }
      }
      return n;
    }

    /** Strings and frets for a fretted beat's notes; notes no string can play are dropped. */
    function place(b: GBeat, slot: number): void {
      const tuning = p.tuning;
      if (!tuning) return;
      const fits = (n: GNote, s: number, f: number) => s >= 0 && s < tuning.length && f >= 0 && f <= 36 && (n.harmonic !== null || tuning[s] + p.capo + f === n.midi || (n.midi === 127 && tuning[s] + p.capo + f > 127)); // the reader caps pitch at 127
      const taken = new Set<number>();
      const open: GNote[] = [];
      for (const n of b.notes) {
        const prev = n.tieFrom ? lastString[slot].get(n.midi) : undefined;
        const want = prev !== undefined ? { string: prev, fret: n.midi - tuning[prev] - p.capo } : n.want;
        if (want && fits(n, want.string, want.fret) && !taken.has(want.string)) {
          n.string = want.string;
          n.fret = want.fret;
          taken.add(n.string);
        } else if (n.want && fits(n, n.want.string, n.want.fret) && !taken.has(n.want.string)) {
          n.string = n.want.string;
          n.fret = n.want.fret;
          taken.add(n.string);
        } else open.push(n);
      }
      // The rest: the lowest frets on free strings, searched over every assignment.
      let best: number[] | null = null;
      let bestCost = Infinity;
      const choice: number[] = [];
      const search = (i: number, cost: number) => {
        if (cost >= bestCost) return;
        if (i === open.length) {
          best = [...choice];
          bestCost = cost;
          return;
        }
        const n = open[i];
        for (let s = tuning.length - 1; s >= 0; s--) {
          const f = played(n) - tuning[s] - p.capo;
          if (taken.has(s) || f < 0 || f > 24) continue;
          taken.add(s);
          choice.push(s);
          search(i + 1, cost + f);
          choice.pop();
          taken.delete(s);
        }
        // Left without a string.
        choice.push(-1);
        search(i + 1, cost + 1000);
        choice.pop();
      };
      if (open.length) search(0, 0);
      open.forEach((n, i) => {
        const s = (best as number[] | null)?.[i] ?? -1;
        if (s >= 0) {
          n.string = s;
          n.fret = played(n) - tuning[s] - p.capo;
        }
      });
      const kept = b.notes.filter((n) => n.string >= 0);
      if (kept.length < b.notes.length) drop("note no string can play", b.notes.length - kept.length);
      b.notes = kept;
      for (const n of kept) lastString[slot].set(n.midi, n.string);
    }
  });
}

/** Where a note is fretted, without a place in the score: an artificial harmonic an octave below its sound. */
const played = (n: GNote) => (n.harmonic && n.harmonic !== "Natural" ? n.midi - 12 : n.midi);

/** A note's pitch and place without its marks (the later pieces of a split note). */
function plain(n: GNote): GNote {
  return { ...n, dead: false, ghost: false, accent: 0, vibrato: false, trill: false, ornament: null, hopoOrigin: false, hopoDest: false, slide: 0, harmonic: null, bend: null, tapped: false, leftTapped: false, tieFrom: true };
}

function beat(rhythm: Rhythm, tick: number, dur: number): GBeat {
  return { rhythm, tick, dur, grace: null, notes: [], dynamic: "MF", chord: null, text: [], brush: null, pick: null, tremolo: null, slurStart: 0, slurStop: 0, legato: null, hairpin: null, ottava: null, lyrics: new Map() };
}

/** A note's written value, when it matches its length (any length for grace notes). */
function rhythmOf(el: Element, ticks: number): Rhythm | null {
  const value = TYPE_VALUE[text(el, "type")];
  if (!value) return null;
  const tm = kid(el, "time-modification");
  const actual = Number(text(tm, "actual-notes")) || 1;
  const normal = Number(text(tm, "normal-notes")) || 1;
  const r: Rhythm = { value, dots: Math.min(2, kids(el, "dot").length), tuplet: actual !== normal ? [actual, normal] : null };
  if (kid(el, "grace")) return r;
  return Math.abs(lengthOf(r) - ticks) <= 2 ? r : null;
}

/** The tab staff's notes of a measure, to take strings and frets from. */
function tabNotes(r: ReadMeasure, tab: number, tk: (d: number) => number) {
  const main = new Map<number, Element[]>();
  const graces = new Map<number, Element[]>();
  for (const [key, evs] of r.voices) {
    if (!key.startsWith(`${tab}|`)) continue;
    for (const ev of evs) {
      const t = tk(ev.pos);
      main.set(t, [...(main.get(t) ?? []), ...ev.notes.filter((n) => kid(n, "pitch"))]);
      graces.set(t, [...(graces.get(t) ?? []), ...ev.graces]);
    }
  }
  const pick = (list: Element[] | undefined, midi: number | null) => {
    if (!list || midi === null) return null;
    const i = list.findIndex((n) => {
      const pt = kid(n, "pitch")!;
      return midiOf({ step: text(pt, "step"), alter: Number(text(pt, "alter")) || 0, octave: Number(text(pt, "octave")) }) === midi;
    });
    return i < 0 ? null : list.splice(i, 1)[0];
  };
  return { main: (t: number, midi: number | null) => pick(main.get(t), midi), grace: (t: number, midi: number | null) => pick(graces.get(t), midi) };
}

/** Directions, chord symbols, tempo and navigation, from a part's measures onto its beats. */
function placeMarks(p: PartIn, master: MasterOut[], drop: Drop): void {
  p.measures.forEach((_, m) => {
    const mb = master[m];
    const div = p.states[m].div;
    const tk = (d: number) => Math.max(0, Math.round((d * TPQ) / div));
    for (const { pos, el } of p.reads[m]!.others) {
      if (el.tagName === "harmony") {
        const g = staffOf(p, Number(text(el, "staff")) || 1);
        const c = readHarmony(el);
        if (!g || !c) {
          drop("chord symbol");
          continue;
        }
        const name = `${c.root.step}${c.root.alter > 0 ? "#".repeat(c.root.alter) : "b".repeat(-c.root.alter)}${c.suffix}${c.bass ? `/${c.bass.step}${c.bass.alter > 0 ? "#".repeat(c.bass.alter) : "b".repeat(-c.bass.alter)}` : ""}`;
        const b = beatAt(g, m, tk(pos + (Number(text(el, "offset")) || 0)), master);
        if (b && !b.chord) b.chord = name;
        else if (!g.similes.has(m)) drop("chord symbol");
        continue;
      }
      if (el.tagName === "sound" && Number(el.getAttribute("tempo")) > 0) {
        const at = tk(pos);
        if (!mb.tempos.some((t) => t.tick === at)) mb.tempos.push({ tick: at, bpm: Number(el.getAttribute("tempo")) });
        continue;
      }
      if (el.tagName !== "direction") continue;
      const at = tk(pos + (Number(text(el, "offset")) || 0));
      const staffNo = Number(text(el, "staff")) || 1;
      const g = staffOf(p, staffNo);
      const sound = kid(el, "sound");
      const types = kids(el, "direction-type").flatMap((dt) => kids(dt));
      const words = types.filter((t) => t.tagName === "words").map((t) => t.textContent ?? "").join("").trim();
      let wordsUsed = false;
      const tempo = Number(sound?.getAttribute("tempo"));
      const metro = types.find((t) => t.tagName === "metronome");
      if (tempo > 0 || metro) {
        const unit: Record<string, number> = { whole: 4, half: 2, quarter: 1, eighth: 0.5, "16th": 0.25 };
        const q = metro ? (unit[text(metro, "beat-unit")] ?? 1) * (kid(metro, "beat-unit-dot") ? 1.5 : 1) : 1;
        const bpm = tempo > 0 ? tempo : (Number(text(metro, "per-minute")) || 0) * q;
        if (bpm > 0 && !mb.tempos.some((t) => t.tick === at)) mb.tempos.push({ tick: at, bpm });
      }
      if (sound?.getAttribute("fine") || /^fine$/i.test(words)) {
        mb.targets.add("Fine");
        wordsUsed = /^fine$/i.test(words) || wordsUsed;
      }
      for (const t of types) {
        if (t.tagName === "segno" || (sound?.getAttribute("segno") && t.tagName !== "coda")) mb.targets.add(sound?.getAttribute("segno") === "segno2" ? "SegnoSegno" : "Segno");
        if (t.tagName === "coda" || (sound?.getAttribute("coda") && t.tagName !== "segno")) mb.targets.add(sound?.getAttribute("coda") === "coda2" ? "DoubleCoda" : "Coda");
      }
      const jump = sound && (sound.getAttribute("dacapo") === "yes" || sound.getAttribute("dalsegno") || sound.getAttribute("tocoda"));
      const named = JUMP_WORDS.find(([re]) => re.test(words))?.[1];
      if (jump || named) {
        const j = named ?? (sound!.getAttribute("dacapo") === "yes" ? "DaCapo" : sound!.getAttribute("dalsegno") ? (sound!.getAttribute("dalsegno") === "segno2" ? "DaSegnoSegno" : "DaSegno") : sound!.getAttribute("tocoda") === "coda2" ? "DaDoubleCoda" : "DaCoda");
        mb.jumps.add(j);
        wordsUsed = true;
      }
      const reh = types.find((t) => t.tagName === "rehearsal");
      if (reh) {
        if (!mb.section) mb.section = { letter: reh.textContent?.trim() ?? "", text: words };
        wordsUsed = true;
      }
      for (const t of types) {
        switch (t.tagName) {
          case "dynamics": {
            const v = t.firstElementChild?.tagName ?? "";
            if (DYNAMICS[v] && g) {
              g.dynamics.push({ m, tick: at, value: DYNAMICS[v] });
              if (!EXACT_DYNAMICS.has(v)) drop(`dynamic ${v}`);
            } else drop("dynamic");
            break;
          }
          case "wedge":
            if (g) g.wedges.push({ m, tick: at, type: t.getAttribute("type") ?? "stop" });
            break;
          case "dashes":
          case "bracket":
            if (t.getAttribute("type") === "stop" && g) {
              const run = [...g.runs].reverse().find((r) => !r.end && ordered(r, { m, tick: at }) <= 0);
              if (run) run.end = { m, tick: at };
            }
            break;
          case "octave-shift":
            if (g) g.ottavas.push({ m, tick: at, kind: t.getAttribute("type") === "stop" ? "" : (OTTAVAS[`${t.getAttribute("type")}${t.getAttribute("size") ?? 8}`] ?? "") });
            break;
          case "words":
          case "rehearsal":
          case "segno":
          case "coda":
          case "metronome":
            break;
          default:
            drop(t.tagName);
        }
      }
      if (words && !wordsUsed) {
        if (/^(p\.?\s*m\.?|palm mute)$/i.test(words) || /^let\s*ring$/i.test(words)) {
          if (g) g.runs.push({ m, tick: at, kind: /ring/i.test(words) ? "ring" : "pm", end: null });
        } else if (/^capo\s*\d+$/i.test(words) && p.capo) {
          // The capo is the track's own.
        } else if (!(p.tuning && staffNo === p.tab && p.primary !== p.tab)) {
          // Text on a tab staff copies its notation staff's.
          const b = g ? beatAt(g, m, at, master) : null;
          if (b) b.text.push(words);
          else if (!g?.similes.has(m)) drop("text");
        }
      }
    }
  });
  for (const g of p.gp) {
    g.dynamics.sort(ordered);
    g.wedges.sort(ordered);
    g.runs.sort(ordered);
  }
}

function staffOf(p: PartIn, staff: number): GStaff | null {
  return p.gp.find((g) => g.staff === staff) ?? (p.tuning && staff === p.tab ? (p.gp[0] ?? null) : null);
}

/** The first voice's beat at a time in a bar; a rest is split so a beat starts there. */
function beatAt(g: GStaff, m: number, tick: number, master: MasterOut[]): GBeat | null {
  const slots = g.bars[m];
  if (!slots || g.similes.has(m)) return null;
  const mb = master[m];
  const barLen = m === 0 && mb.shift ? mb.ticks - mb.shift : mb.ticks;
  if (!slots[0]) {
    let at = 0;
    slots[0] = splitTicks(barLen).map((rh) => {
      const b = beat(rh, at, Math.round(lengthOf(rh)));
      at += b.dur;
      return b;
    });
    if (!slots[0].length) return null;
  }
  const beats = slots[0];
  let found: GBeat | null = null;
  for (const b of beats) if (!b.grace && b.tick <= tick) found = b;
  if (!found) return beats.find((b) => !b.grace) ?? null;
  if (found.tick === tick || found.notes.length || tick >= found.tick + found.dur) return found;
  // Split the rest in two at the tick.
  const i = beats.indexOf(found);
  const left = splitTicks(tick - found.tick);
  const right = splitTicks(found.tick + found.dur - tick);
  if (!left.length || !right.length) return found;
  const out: GBeat[] = [];
  let at = found.tick;
  for (const rh of [...left, ...right]) {
    const b = beat(rh, at, Math.round(lengthOf(rh)));
    at += b.dur;
    out.push(b);
  }
  out[0].text = found.text;
  out[0].chord = found.chord;
  beats.splice(i, 1, ...out);
  return out[left.length];
}

function eachBeat(g: GStaff, fn: (b: GBeat, m: number, slot: number) => void): void {
  g.bars.forEach((slots, m) => slots.forEach((beats, slot) => beats?.forEach((b) => fn(b, m, slot))));
}

function applyDynamics(g: GStaff): void {
  let i = 0;
  let current = "MF";
  // Beats in time order across the voices.
  const all: { b: GBeat; m: number }[] = [];
  eachBeat(g, (b, m) => all.push({ b, m }));
  all.sort((x, y) => x.m - y.m || x.b.tick - y.b.tick);
  // Notes before a first written mf were louder: Guitar Pro leaves its usual f unwritten.
  const first = g.dynamics[0];
  if (first?.value === "MF" && all.some(({ b, m }) => b.notes.length && ordered({ m, tick: b.tick }, first) < 0)) current = "F";
  for (const { b, m } of all) {
    while (i < g.dynamics.length && ordered(g.dynamics[i], { m, tick: b.tick }) <= 0) current = g.dynamics[i++].value;
    b.dynamic = current;
  }
}

function applyWedges(g: GStaff): void {
  let open: { m: number; tick: number; type: string } | null = null;
  const spans: { from: { m: number; tick: number }; to: { m: number; tick: number }; type: string }[] = [];
  for (const w of g.wedges) {
    if (w.type === "crescendo" || w.type === "diminuendo") open = w;
    else if (w.type === "stop" && open) {
      spans.push({ from: open, to: w, type: open.type === "crescendo" ? "Crescendo" : "Decrescendo" });
      open = null;
    }
  }
  if (!spans.length) return;
  eachBeat(g, (b, m, slot) => {
    if (slot !== 0) return;
    const at = { m, tick: b.tick };
    const s = spans.find((x) => ordered(x.from, at) <= 0 && ordered(at, x.to) < 0);
    if (s) b.hairpin = s.type;
  });
}

/** Palm mute and let ring: from the word on, until the line ends or the first rest. */
/** Ottava lines: every beat from a start to its stop. */
function applyOttavas(g: GStaff): void {
  if (!g.ottavas.length) return;
  g.ottavas.sort(ordered);
  eachBeat(g, (b, m) => {
    let kind = "";
    for (const o of g.ottavas) if (ordered(o, { m, tick: b.tick }) <= 0) kind = o.kind;
    if (kind) b.ottava = kind;
  });
}

function applyRuns(g: GStaff): void {
  if (!g.runs.length) return;
  const voice0: { b: GBeat; m: number }[] = [];
  eachBeat(g, (b, m, slot) => slot === 0 && !b.grace && voice0.push({ b, m }));
  for (const run of g.runs) {
    let end = run.end;
    if (!end) {
      const rest = voice0.find(({ b, m }) => ordered({ m, tick: b.tick }, run) > 0 && !b.notes.length);
      end = rest ? { m: rest.m, tick: rest.b.tick } : { m: Infinity, tick: 0 };
    }
    eachBeat(g, (b, m) => {
      const at = { m, tick: b.tick };
      if (ordered(at, run) < 0 || ordered(at, end!) >= 0) return;
      for (const n of b.notes) {
        if (run.kind === "pm") n.palmMute = true;
        else n.letRing = true;
      }
    });
  }
}

/** Slurs: a beat starts, continues or ends Guitar Pro's legato line. */
function applyLegato(g: GStaff): void {
  for (let slot = 0; slot < 4; slot++) {
    let open = 0;
    for (const slots of g.bars) {
      for (const b of slots[slot] ?? []) {
        const dest = open > 0;
        open = Math.max(0, open - b.slurStop) + b.slurStart;
        const origin = open > 0;
        if (dest || origin) b.legato = [origin, dest];
      }
    }
  }
}

/** A hammer-on or pull-off needs a later note on its string, at another fret. */
function checkHopos(p: PartIn): void {
  for (const g of p.gp)
    for (let slot = 0; slot < 4; slot++) {
      const notes = g.bars.flatMap((s) => s[slot] ?? []).flatMap((b) => b.notes);
      notes.forEach((n, i) => {
        if (!n.hopoOrigin) return;
        const next = notes.slice(i + 1).find((x) => x.string === n.string);
        if (!next) n.hopoOrigin = false;
        else if (next.fret !== n.fret) next.hopoDest = true;
      });
      notes.forEach((n, i) => {
        if (n.hopoDest && !notes.slice(0, i).some((x) => x.hopoOrigin && x.string === n.string)) n.hopoDest = false;
      });
    }
}

const GUITAR_TYPES: [number, number, string, string][] = [
  [24, 24, "nylonGuitar", "Nylon Guitar"],
  [25, 25, "steelGuitar", "Steel Guitar"],
  [26, 31, "electricGuitar", "Electric Guitar"],
  [32, 32, "acousticBass", "Acoustic Bass"],
  [33, 39, "electricBass", "Electric Bass"],
  [105, 105, "banjo", "Banjo"],
];

function instrumentSet(p: PartIn): { type: string; name: string; path: string; sound: string } {
  if (p.drums) return { type: "drumKit", name: "Drums", path: "Drums/Drums/Drumkit", sound: "Drumkit" };
  const prog = p.program ?? (p.tuning ? 25 : 0);
  if (p.tuning) {
    const known = GUITAR_TYPES.find(([a, b]) => prog >= a && prog <= b);
    const low = Math.min(...p.tuning);
    const [type, name] = known ? [known[2], known[3]] : low < 36 ? ["electricBass", "Electric Bass"] : p.tuning.length === 4 && low >= 55 ? ["ukulele", "Ukulele"] : ["steelGuitar", "Steel Guitar"];
    const bass = type.endsWith("Bass");
    return { type, name, path: bass ? `Stringed/Basses/${name}` : `Stringed/Acoustic Guitars/${name}`, sound: name };
  }
  if (prog <= 7) return { type: "acousticPiano", name: "Acoustic Piano", path: "Orchestra/Keyboard/Acoustic Piano", sound: "Acoustic Piano" };
  return { type: "acousticPiano", name: p.name || "Instrument", path: "Orchestra/Keyboard/Acoustic Piano", sound: p.name || "Instrument" };
}

const DRUM_TYPES: [RegExp, string][] = [
  [/bass drum|kick/i, "kickDrum"],
  [/snare|side stick/i, "snare"],
  [/hi-hat/i, "hiHat"],
  [/tom/i, "tom"],
  [/ride/i, "ride"],
  [/crash/i, "crash"],
  [/splash/i, "splash"],
  [/china/i, "china"],
  [/cowbell/i, "cowbell"],
  [/tambourine/i, "tambourine"],
];

function gpif(doc: Document, parts: PartIn[], master: MasterOut[], tempos: { m: number; tick: number; bpm: number }[], anacrusis: boolean, drop: Drop): string {
  const root = doc.documentElement;
  const work = kid(root, "work");
  const title = text(work, "work-title") || text(root, "movement-title");
  const subtitle = text(work, "work-title") ? text(root, "movement-title") : "";
  const ident = kid(root, "identification");
  const creator = (type: string) => (ident ? kids(ident, "creator").find((c) => c.getAttribute("type") === type)?.textContent?.trim() : "") ?? "";
  const rights = ident ? kids(ident, "rights").map((r) => r.textContent?.trim() ?? "").join(" ") : "";

  const out: string[] = [];
  const w = (s: string) => out.push(s);
  w(`<?xml version="1.0" encoding="utf-8"?>\n<GPIF>\n<GPVersion>7</GPVersion>\n<Encoding><EncodingDescription>GP7</EncodingDescription></Encoding>\n`);
  const field = (tag: string, v: string) => `<${tag}>${cdata(v)}</${tag}>`;
  w(`<Score>${field("Title", title)}${field("SubTitle", subtitle)}${field("Artist", "")}${field("Album", "")}${field("Words", creator("lyricist"))}${field("Music", creator("composer"))}${field("WordsAndMusic", "")}${field("Copyright", rights)}${field("Tabber", "")}${field("Instructions", "")}${field("Notices", "")}<ScoreSystemsDefaultLayout>4</ScoreSystemsDefaultLayout><ScoreSystemsLayout></ScoreSystemsLayout></Score>\n`);

  const tracks = parts.filter((p) => p.gp.length);
  // A pickup bar's flag comes first, where Guitar Pro 7 puts it.
  w(`<MasterTrack>${anacrusis ? "<Anacrusis />" : ""}<Tracks>${tracks.map((_, i) => i).join(" ")}</Tracks><Automations>`);
  for (const t of [...tempos].sort(ordered)) {
    const mb = master[t.m];
    const tick = t.m === 0 && t.tick === 0 ? 0 : t.tick + (t.m === 0 ? mb.shift : 0);
    const position = Math.min(1, tick / mb.ticks);
    w(`<Automation><Type>Tempo</Type><Linear>false</Linear><Bar>${t.m}</Bar><Position>${+position.toFixed(6)}</Position><Visible>true</Visible><Value>${+t.bpm.toFixed(3)} 2</Value></Automation>`);
  }
  w(`</Automations></MasterTrack>\n`);

  // Tracks.
  let channel = 0;
  w(`<Tracks>\n`);
  tracks.forEach((p, ti) => {
    const set = instrumentSet(p);
    let primary: number;
    let secondary: number;
    if (p.drums) primary = secondary = 9;
    else {
      if (channel === 9) channel++;
      primary = channel % 16;
      channel++;
      if (channel === 9) channel++;
      secondary = channel % 16;
      channel++;
    }
    const program = p.drums ? 0 : (p.program ?? (p.tuning ? 25 : 0));
    w(`<Track id="${ti}">${field("Name", p.name || `Track ${ti + 1}`)}${field("ShortName", p.short)}<Color>${["255 0 0", "0 128 0", "0 0 255", "200 120 0", "128 0 128", "0 128 128"][ti % 6]}</Color><SystemsDefautLayout>3</SystemsDefautLayout><SystemsLayout>1</SystemsLayout><PalmMute>0</PalmMute><PlayingStyle>Default</PlayingStyle>`);
    w(`<InstrumentSet><Name>${esc(set.name)}</Name><Type>${set.type}</Type><LineCount>5</LineCount><Elements>`);
    if (p.drums) {
      const kit = drumKit(p);
      for (const d of kit) {
        const known = DRUM_KIT.find((x) => x.pitch === d);
        const name = known?.name ?? `Drum ${d}`;
        const type = DRUM_TYPES.find(([re]) => re.test(name))?.[1] ?? "unpitched";
        const heads: Record<string, string> = { normal: "noteheadBlack noteheadHalf noteheadWhole", cross: "noteheadXBlack noteheadXBlack noteheadXBlack", diamond: "noteheadDiamondWhite noteheadDiamondWhite noteheadDiamondWhite", "circle-x": "noteheadCircleX noteheadCircleX noteheadCircleX", triangle: "noteheadTriangleUpBlack noteheadTriangleUpBlack noteheadTriangleUpBlack" };
        w(`<Element><Name>${esc(name)}</Name><Type>${type}</Type><SoundbankName></SoundbankName><Articulations><Articulation><Name>${esc(name)}</Name><StaffLine>${known?.line ?? 3}</StaffLine><Noteheads>${heads[known?.head ?? "normal"]}</Noteheads><TechniquePlacement>outside</TechniquePlacement><TechniqueSymbol></TechniqueSymbol><InputMidiNumbers>${d}</InputMidiNumbers><OutputRSESound></OutputRSESound><OutputMidiNumber>${d}</OutputMidiNumber></Articulation></Articulations></Element>`);
      }
    } else
      w(`<Element><Name>Pitched</Name><Type>pitched</Type><SoundbankName></SoundbankName><Articulations><Articulation><Name></Name><StaffLine>0</StaffLine><Noteheads>noteheadBlack noteheadHalf noteheadWhole</Noteheads><TechniquePlacement>outside</TechniquePlacement><TechniqueSymbol></TechniqueSymbol><InputMidiNumbers></InputMidiNumbers><OutputRSESound></OutputRSESound><OutputMidiNumber>0</OutputMidiNumber></Articulation></Articulations></Element>`);
    w(`</Elements></InstrumentSet>`);
    const total = transposeOf(p);
    const octaves = Math.trunc(total / 12);
    w(`<Transpose><Chromatic>${total - 12 * octaves}</Chromatic><Octave>${octaves}</Octave></Transpose>`);
    w(`<Sounds><Sound>${field("Name", set.sound)}${field("Label", set.sound)}<Path>${esc(set.path)}</Path><Role>User</Role><MIDI><LSB>0</LSB><MSB>0</MSB><Program>${program}</Program></MIDI></Sound></Sounds>`);
    w(`<MidiConnection><Port>0</Port><PrimaryChannel>${primary}</PrimaryChannel><SecondaryChannel>${secondary}</SecondaryChannel><ForeOneChannelPerString>false</ForeOneChannelPerString></MidiConnection><PlaybackState>Default</PlaybackState><AudioEngineState>MIDI</AudioEngineState>`);
    w(`<Lyrics dispatched="true">`);
    const lines = lyricLines(p.gp[0], drop);
    for (let i = 0; i < 5; i++) w(`<Line><Text>${cdata(lines[i]?.text ?? "")}</Text><Offset>${lines[i]?.bar ?? 0}</Offset></Line>`);
    w(`</Lyrics>`);
    // Chord names, by the id beats point to.
    const names = new Map<string, number>();
    for (const g of p.gp) eachBeat(g, (b) => b.chord !== null && !names.has(b.chord) && names.set(b.chord, names.size));
    (p as PartIn & { chordIds?: Map<string, number> }).chordIds = names;
    w(`<Staves>`);
    for (const _ of p.gp) {
      w(`<Staff><Properties>`);
      if (p.tuning) {
        w(`<Property name="CapoFret"><Fret>${p.capo}</Fret></Property><Property name="FretCount"><Number>24</Number></Property><Property name="PartialCapoFret"><Fret>0</Fret></Property>`);
        w(`<Property name="Tuning"><Pitches>${p.tuning.join(" ")}</Pitches></Property>`);
      }
      w(`<Property name="ChordCollection"><Items/></Property><Property name="DiagramCollection"><Items>${[...names].map(([n, id]) => `<Item id="${id}" name="${esc(n)}"/>`).join("")}</Items></Property>`);
      w(`<Name>${cdata("Standard")}</Name></Properties></Staff>`);
    }
    w(`</Staves>`);
    w(`<Automations><Automation><Type>Sound</Type><Linear>false</Linear><Bar>0</Bar><Position>0</Position><Visible>true</Visible><Value>${cdata(`${set.path};${set.sound};User`)}</Value></Automation></Automations>`);
    w(`</Track>\n`);
  });
  w(`</Tracks>\n`);

  // Bars, voices, beats, notes and rhythms, numbered as they are written.
  const bars: string[] = [];
  const voices: string[] = [];
  const beats: string[] = [];
  const notes: string[] = [];
  const rhythms = new Map<string, number>();
  const rhythmId = (r: Rhythm) => {
    const key = `${r.value}|${r.dots}|${r.tuplet?.join(":") ?? ""}`;
    if (!rhythms.has(key)) rhythms.set(key, rhythms.size);
    return rhythms.get(key)!;
  };
  const barIds: number[][] = master.map(() => []);
  for (const g of tracks.flatMap((p) => p.gp)) {
    const p = g.part;
    const kit = p.drums ? drumKit(p) : [];
    const chordIds = (p as PartIn & { chordIds?: Map<string, number> }).chordIds!;
    master.forEach((_, m) => {
      const slots = g.bars[m];
      const vids = slots.map((beatsOf) => {
        if (!beatsOf || !beatsOf.length) return -1;
        const ids = beatsOf.map((b) => {
          const nids = b.notes.map((n) => {
            const id = notes.length;
            notes.push(noteXml(id, n, p, kit));
            return id;
          });
          const id = beats.length;
          const props: string[] = [];
          if (b.brush) props.push(`<Property name="Brush"><Direction>${b.brush}</Direction></Property>`);
          if (b.pick) props.push(`<Property name="PickStroke"><Direction>${b.pick}</Direction></Property>`);
          const lyrics = [...b.lyrics].sort((x, y) => x[0] - y[0]);
          beats.push(
            `<Beat id="${id}">${b.grace ? `<GraceNotes>${b.grace}</GraceNotes>` : ""}<Dynamic>${b.dynamic}</Dynamic>${b.chord !== null ? `<Chord>${chordIds.get(b.chord)}</Chord>` : ""}<Rhythm ref="${rhythmId(b.rhythm)}" />${b.tremolo ? `<Tremolo>${b.tremolo}</Tremolo>` : ""}${b.hairpin ? `<Hairpin>${b.hairpin}</Hairpin>` : ""}${b.ottava ? `<Ottavia>${b.ottava}</Ottavia>` : ""}${b.legato ? `<Legato origin="${b.legato[0]}" destination="${b.legato[1]}" />` : ""}${b.text.length ? `<FreeText>${cdata(b.text.join(" "))}</FreeText>` : ""}${nids.length ? `<Notes>${nids.join(" ")}</Notes>` : ""}<Properties>${props.join("")}</Properties>${lyrics.length ? `<Lyrics>${[1, 2, 3, 4, 5].map((k) => `<Line>${cdata(b.lyrics.get(k) ? b.lyrics.get(k)!.text + (/^(begin|middle)$/.test(b.lyrics.get(k)!.syllabic) ? "-" : "") : "")}</Line>`).join("")}</Lyrics>` : ""}</Beat>`,
          );
          return id;
        });
        const id = voices.length;
        voices.push(`<Voice id="${id}"><Beats>${ids.join(" ")}</Beats></Voice>`);
        return id;
      });
      const id = bars.length;
      bars.push(`<Bar id="${id}"><Clef>${g.clefs[m] ?? "G2"}</Clef>${g.similes.has(m) ? `<SimileMark>${g.similes.get(m)}</SimileMark>` : ""}<Voices>${vids.join(" ")}</Voices></Bar>`);
      barIds[m].push(id);
    });
  }

  w(`<MasterBars>\n`);
  master.forEach((mb, m) => {
    let s = `<MasterBar><Key><AccidentalCount>${mb.fifths}</AccidentalCount><Mode>${mb.minor ? "Minor" : "Major"}</Mode></Key><Time>${mb.beats}/${mb.beatType}</Time>`;
    if (mb.doubleBar) s += `<DoubleBar />`;
    if (mb.repeatStart || mb.repeatEnd) s += `<Repeat start="${mb.repeatStart}" end="${mb.repeatEnd > 0}" count="${mb.repeatEnd}" />`;
    if (mb.endings) s += `<AlternateEndings>${mb.endings.join(" ")}</AlternateEndings>`;
    if (mb.section) s += `<Section><Letter>${cdata(mb.section.letter)}</Letter><Text>${cdata(mb.section.text)}</Text></Section>`;
    const fermatas = [...mb.fermatas].filter((t) => t >= 0 && t < mb.ticks).sort((a, b) => a - b);
    if (fermatas.length) {
      s += `<Fermatas>${fermatas
        .map((t) => {
          const d = gcd(t, TPQ) || 1;
          return `<Fermata><Type>Medium</Type><Offset>${t / d}/${TPQ / d}</Offset><Length>0.5</Length></Fermata>`;
        })
        .join("")}</Fermatas>`;
    }
    if (mb.targets.size || mb.jumps.size) s += `<Directions>${[...mb.targets].map((t) => `<Target>${t}</Target>`).join("")}${[...mb.jumps].map((j) => `<Jump>${j}</Jump>`).join("")}</Directions>`;
    s += `<Bars>${barIds[m].join(" ")}</Bars></MasterBar>\n`;
    w(s);
  });
  w(`</MasterBars>\n<Bars>\n${bars.join("\n")}\n</Bars>\n<Voices>\n${voices.join("\n")}\n</Voices>\n<Beats>\n${beats.join("\n")}\n</Beats>\n<Notes>\n${notes.join("\n")}\n</Notes>\n<Rhythms>\n`);
  for (const [key, id] of rhythms) {
    const [value, dots, tuplet] = key.split("|");
    const [num, den] = tuplet ? tuplet.split(":") : [];
    w(`<Rhythm id="${id}"><NoteValue>${value}</NoteValue>${Number(dots) ? `<AugmentationDot count="${dots}" />` : ""}${tuplet ? `<PrimaryTuplet num="${num}" den="${den}" />` : ""}</Rhythm>\n`);
  }
  w(`</Rhythms>\n</GPIF>\n`);
  return out.join("");
}

function drumKit(p: PartIn): number[] {
  const used = new Set<number>();
  for (const g of p.gp) eachBeat(g, (b) => b.notes.forEach((n) => used.add(n.midi)));
  return [...used].sort((a, b) => a - b);
}

const PITCH_NAMES: [string, string][] = [["C", ""], ["C", "#"], ["D", ""], ["D", "#"], ["E", ""], ["F", ""], ["F", "#"], ["G", ""], ["G", "#"], ["A", ""], ["A", "#"], ["B", ""]];
const pitchXml = (midi: number) => {
  const [step, acc] = PITCH_NAMES[((midi % 12) + 12) % 12];
  return `<Pitch><Step>${step}</Step><Accidental>${acc}</Accidental><Octave>${Math.floor(midi / 12)}</Octave></Pitch>`;
};

// Written to sounding: a transposition, or an 8vb clef. A fretted part keeps whole octaves only
// (its frets give the pitch), so another interval is written at concert pitch there.
const transposeOf = (p: PartIn) => (p.drums ? 0 : !p.tuning && p.transpose ? p.transpose : 12 * Math.trunc((p.transpose || 12 * (p.states[0]?.octave.get(p.gp[0]?.staff ?? 1) ?? 0)) / 12));
function noteXml(id: number, n: GNote, p: PartIn, kit: number[]): string {
  const on = (name: string) => `<Property name="${name}"><Enable /></Property>`;
  const float = (name: string, v: number) => `<Property name="${name}"><Float>${v.toFixed(6)}</Float></Property>`;
  let s = `<Note id="${id}">`;
  if (n.tieFrom || n.tieTo) s += `<Tie origin="${n.tieTo}" destination="${n.tieFrom}" />`;
  if (n.accent) s += `<Accent>${n.accent}</Accent>`;
  if (n.ghost) s += `<AntiAccent>Normal</AntiAccent>`;
  if (n.letRing) s += `<LetRing />`;
  if (n.vibrato) s += `<Vibrato>Slight</Vibrato>`;
  if (n.ornament) s += `<Ornament>${n.ornament}</Ornament>`;
  if (n.trill) s += `<Trill>${n.midi + 2}</Trill>`;
  // A harmonic sounds above the fret played, which Guitar Pro keeps as the note's pitch.
  const open = p.tuning && n.string >= 0 ? p.tuning[n.string] + p.capo : null;
  const midi = n.harmonic && open !== null ? open + n.fret : n.midi;
  s += `<InstrumentArticulation>${p.drums ? kit.indexOf(n.midi) : 0}</InstrumentArticulation><Properties>`;
  if (!p.drums) s += `<Property name="ConcertPitch">${pitchXml(midi)}</Property><Property name="TransposedPitch">${pitchXml(midi - transposeOf(p))}</Property>`;
  if (p.tuning) s += `<Property name="Fret"><Fret>${n.fret}</Fret></Property>`;
  s += `<Property name="Midi"><Number>${midi}</Number></Property>`;
  if (p.tuning) s += `<Property name="String"><String>${n.string}</String></Property>`;
  if (n.dead) s += on("Muted");
  if (n.palmMute) s += on("PalmMuted");
  if (n.tapped) s += on("Tapped");
  if (n.leftTapped) s += on("LeftHandTapped");
  if (n.hopoOrigin) s += on("HopoOrigin");
  if (n.hopoDest) s += on("HopoDestination");
  if (n.slide) s += `<Property name="Slide"><Flags>${n.slide}</Flags></Property>`;
  if (n.harmonic) {
    // The touch fret, from how far above the open string (natural) or the fretted note it sounds.
    const natural = n.harmonic === "Natural";
    const fret = harmonicFret(natural, n.midi - (natural ? (open ?? n.midi) : midi), n.fret) ?? (natural ? n.fret : 12);
    s += `<Property name="HarmonicType"><HType>${n.harmonic}</HType></Property><Property name="HarmonicFret"><HFret>${fret}</HFret></Property>`;
  }
  if (n.bend) {
    s += on("Bended") + float("BendOriginOffset", 0) + float("BendOriginValue", n.bend.origin);
    if (n.bend.middle !== null) s += float("BendMiddleOffset1", 50) + float("BendMiddleOffset2", 50) + float("BendMiddleValue", n.bend.middle);
    s += float("BendDestinationOffset", 100) + float("BendDestinationValue", n.bend.dest);
  }
  return `${s}</Properties></Note>`;
}

/** A track's lyrics lines: each number's syllables in turn on the struck beats of its first voice. */
function lyricLines(g: GStaff | undefined, drop: Drop): { text: string; bar: number }[] {
  if (!g) return [];
  const struck: { b: GBeat; m: number }[] = [];
  g.bars.forEach((slots, m) => slots[0]?.forEach((b) => !b.grace && b.notes.length && !b.notes.every((n) => n.tieFrom) && struck.push({ b, m })));
  let lost = 0;
  g.bars.forEach((slots) => slots.slice(1).forEach((beats) => beats?.forEach((b) => (lost += b.lyrics.size))));
  const numbers = [...new Set(g.bars.flatMap((s) => s[0] ?? []).flatMap((b) => [...b.lyrics.keys()]))].sort((a, b) => a - b);
  if (numbers.length > 5) lost += numbers.length - 5;
  const lines = numbers.slice(0, 5).map((num) => {
    const firstAt = struck.findIndex(({ b }) => b.lyrics.has(num));
    if (firstAt < 0) return { text: "", bar: 0 };
    const bar = struck[firstAt].m;
    let lastAt = struck.length - 1;
    while (lastAt > firstAt && !struck[lastAt].b.lyrics.has(num)) lastAt--;
    let line = "";
    let gaps = 0;
    for (let i = struck.findIndex(({ m }) => m === bar); i <= lastAt; i++) {
      const ly = struck[i].b.lyrics.get(num);
      if (!ly) {
        gaps++;
        continue;
      }
      const syl = ly.text.replace(/\s+/g, "\u203f").replace(/-/g, "\u2010");
      line += syl + (ly.syllabic === "begin" || ly.syllabic === "middle" ? "-" : " ");
    }
    if (gaps) drop("lyric syllable moved", gaps);
    return { text: line.trim().replace(/-$/, ""), bar };
  });
  if (lost) drop("lyric", lost);
  return lines;
}

/** Guitar Pro's score and part views: notation (1), tab (2) or both, per track. */
function partConfiguration(flags: number[]): Uint8Array {
  const bytes: number[] = [];
  const int = (v: number) => bytes.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
  int(flags.length + 1);
  bytes.push(0);
  int(flags.length);
  bytes.push(...flags);
  for (const f of flags) {
    bytes.push(0);
    int(1);
    bytes.push(f);
  }
  int(flags.length === 1 ? 1 : 0);
  return new Uint8Array(bytes);
}

function layoutConfiguration(tracks: number): Uint8Array {
  return new Uint8Array([0, 0, 0, 4, 1, 0, ...new Array(tracks * 2).fill(255), 0, 0, 0, 0]);
}
