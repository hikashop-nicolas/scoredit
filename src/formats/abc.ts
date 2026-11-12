import { makeHarmony, parseChord } from "../edit/chords";
import { parseXml } from "../model/xml";

// ABC notation (abcnotation.com, standard 2.1) read into MusicXML: the header (title,
// composer, meter, unit length, tempo, key and clef), notes, rests, chords, grace notes,
// ties, slurs, tuplets, broken rhythm, bar lines, repeats and endings, decorations,
// chord symbols, annotations, lyrics and voices (one part each).

export interface AbcOptions {
  /** The tune to open, by its X: number (the first one otherwise). */
  tune?: number;
}

/** The tunes of an ABC file: X: number and title. */
export function abcTunes(text: string): { x: number; title: string }[] {
  return splitTunes(text).map((t) => ({ x: t.x, title: /^T:\s*(.*)$/m.exec(t.text)?.[1]?.trim() ?? "" }));
}

/** Text that looks like ABC: an X: line followed later by a K: line. */
export function looksLikeAbc(head: string): boolean {
  return /^X:\s*\d*\s*$/m.test(head) && /^K:/m.test(head) && !/^\s*</.test(head);
}

function splitTunes(text: string): { x: number; text: string }[] {
  const out: { x: number; text: string }[] = [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let cur: { x: number; lines: string[] } | null = null;
  for (const line of lines) {
    const m = /^X:\s*(\d*)/.exec(line);
    if (m) {
      if (cur) out.push({ x: cur.x, text: cur.lines.join("\n") });
      cur = { x: Number(m[1]) || out.length + 1, lines: [line] };
    } else if (cur) cur.lines.push(line);
  }
  if (cur) out.push({ x: cur.x, text: cur.lines.join("\n") });
  return out;
}

// ---- Pitch and length

const DIV = 10080; // divisions per quarter: halves to 64ths, triplets, quintuplets, septuplets
const SHARPS = "FCGDAEB";
const TONIC: Record<string, number> = { C: 0, G: 1, D: 2, A: 3, E: 4, B: 5, "F#": 6, "C#": 7, F: -1, Bb: -2, Eb: -3, Ab: -4, Db: -5, Gb: -6, Cb: -7, "G#": 8, "D#": 9, "A#": 10, Fb: -8 };
const MODES: [RegExp, number][] = [
  [/^(maj|ion)/, 0],
  [/^mix/, -1],
  [/^(m|min|aeo)/, -3],
  [/^dor/, -2],
  [/^phr/, -4],
  [/^lyd/, 1],
  [/^loc/, -5],
];

interface Key {
  fifths: number;
  /** Alteration of each step in the key. */
  alters: Record<string, number>;
  clef?: Clef;
}

interface Tempo {
  /** Quarters per minute. */
  bpm: number;
  text: string;
  unit: string;
  dots: number;
  per: number;
}

interface Clef {
  sign: string;
  line: number;
  octave?: number;
}

const CLEFS: Record<string, Clef> = {
  treble: { sign: "G", line: 2 },
  bass: { sign: "F", line: 4 },
  bass3: { sign: "F", line: 3 },
  alto: { sign: "C", line: 3 },
  tenor: { sign: "C", line: 4 },
  alto1: { sign: "C", line: 1 },
  alto2: { sign: "C", line: 2 },
  perc: { sign: "percussion", line: 2 },
  none: { sign: "G", line: 2 },
};

function clefOf(spec: string): Clef | undefined {
  const m = /(?:clef=)?\b(treble|bass3|bass|alto[12]?|tenor|perc|none)([+-]8)?\b/.exec(spec);
  if (!m) return undefined;
  const c = { ...CLEFS[m[1]] };
  if (m[2]) c.octave = m[2] === "-8" ? -1 : 1;
  return c;
}

function parseKey(spec: string): Key {
  const s = spec.trim();
  const clef = clefOf(s);
  let fifths = 0;
  const m = /^([A-G])([#b]?)\s*([A-Za-z]*)/.exec(s);
  if (m && !/^none\b/i.test(s)) {
    const base = TONIC[m[1] + m[2]] ?? 0;
    const mode = m[3].toLowerCase();
    const shift = mode && !/^(clef|treble|bass|alto|tenor|perc)/.test(mode) ? (MODES.find(([re]) => re.test(mode))?.[1] ?? 0) : 0;
    fifths = base + shift;
  }
  // Explicit accidentals after the key (K:D =c ^g) change those steps.
  const alters: Record<string, number> = {};
  for (let i = 0; i < Math.abs(fifths) && i < 7; i++) alters[(fifths > 0 ? SHARPS : [...SHARPS].reverse().join(""))[i]] = fifths > 0 ? 1 : -1;
  for (const acc of s.matchAll(/(\^\^|\^|__|_|=)([A-Ga-g])/g)) alters[acc[2].toUpperCase()] = acc[1] === "^" ? 1 : acc[1] === "^^" ? 2 : acc[1] === "_" ? -1 : acc[1] === "__" ? -2 : 0;
  return { fifths: Math.max(-7, Math.min(7, fifths)), alters, clef };
}

function parseFraction(s: string): number | null {
  const m = /^\s*(\d+)\s*\/\s*(\d+)/.exec(s);
  if (m) return Number(m[1]) / Number(m[2]);
  const n = /^\s*(\d+)/.exec(s);
  return n ? Number(n[1]) : null;
}

/** Meter: beats, beat type and the bar length in quarters ("C" is 4/4, "C|" 2/2). */
function parseMeter(spec: string): { beats: string; type: string; quarters: number; symbol?: string } | null {
  const s = spec.trim();
  if (/^none/i.test(s) || !s) return null;
  if (s === "C") return { beats: "4", type: "4", quarters: 4, symbol: "common" };
  if (s === "C|") return { beats: "2", type: "2", quarters: 4, symbol: "cut" };
  const m = /^\(?([\d+]+)\)?\s*\/\s*(\d+)/.exec(s);
  if (!m) return null;
  const top = m[1].split("+").reduce((a, b) => a + Number(b), 0);
  return { beats: m[1], type: m[2], quarters: (top * 4) / Number(m[2]) };
}

/** Written note values (in quarters), with dots, for splitting a length into tied pieces. */
const VALUES: [number, string, number][] = [];
for (const [q, type] of [[4, "whole"], [2, "half"], [1, "quarter"], [0.5, "eighth"], [0.25, "16th"], [0.125, "32nd"], [0.0625, "64th"]] as [number, string][]) {
  VALUES.push([q * 1.75, type, 2], [q * 1.5, type, 1], [q, type, 0]);
}
VALUES.sort((a, b) => b[0] - a[0]);

/** A written length as note values tied together (largest first). */
function splitValue(quarters: number): [string, number, number][] {
  const out: [string, number, number][] = [];
  let left = quarters;
  for (let guard = 0; left > 1e-6 && guard < 12; guard++) {
    const exact = VALUES.find(([q]) => Math.abs(q - left) < 1e-6);
    const pick = exact ?? VALUES.find(([q]) => q <= left + 1e-6);
    if (!pick) break;
    out.push([pick[1], pick[2], pick[0]]);
    left -= pick[0];
  }
  return out.length ? out : [["quarter", 0, quarters]];
}

// ---- The music, as events per voice and measure

interface Pitch {
  step: string;
  octave: number;
  alter: number;
  /** An accidental written before it. */
  shown?: string;
}

interface NoteEvent {
  kind: "note";
  pitches: Pitch[] | null;
  invisible?: boolean;
  /** Length in quarters as played. */
  quarters: number;
  /** Tuplet: p notes in the time of q. */
  tuplet?: { p: number; q: number; start: boolean; stop: boolean };
  tie: boolean;
  slurStart: number;
  slurStop: number;
  decorations: string[];
  graces: { pitches: Pitch[]; quarters: number; slash: boolean }[];
  /** Directions written just before it. */
  before: Before[];
  /** No space before it: beamed with the note before when both can be. */
  joined: boolean;
  lyric?: { text: string; syllabic: string };
  measureRest?: boolean;
}

type Before = { kind: "chord"; text: string } | { kind: "words"; text: string; below: boolean } | { kind: "dynamic"; value: string } | { kind: "wedge"; type: "crescendo" | "diminuendo" | "stop" };

interface Measure {
  events: NoteEvent[];
  key?: Key;
  meter?: ReturnType<typeof parseMeter>;
  clef?: Clef;
  forward?: boolean;
  backward?: boolean;
  style?: string;
  ending?: { number: string; type: "start" | "stop" | "discontinue" }[];
  /** Directions after the last note (a hairpin's end at the bar line). */
  after: Before[];
}

interface Voice {
  id: string;
  name: string;
  clef?: Clef;
  measures: Measure[];
  cur: Measure;
  barAlters: Map<string, number>;
  key: Key;
  /** Notes of the music line just read, for its w: lyrics. */
  lineNotes: NoteEvent[];
  slurDepth: number;
  openEnding: string | null;
}

const newMeasure = (): Measure => ({ events: [], after: [] });

const DECORATION: Record<string, string> = {
  ".": "staccato",
  "~": "turn",
  H: "fermata",
  L: "accent",
  M: "mordent",
  P: "inverted-mordent",
  T: "trill-mark",
  u: "up-bow",
  v: "down-bow",
  O: "coda",
  S: "segno",
};
const NAMED: Record<string, string> = {
  staccato: "staccato",
  accent: "accent",
  ">": "accent",
  emphasis: "accent",
  tenuto: "tenuto",
  marcato: "strong-accent",
  "^": "strong-accent",
  fermata: "fermata",
  trill: "trill-mark",
  turn: "turn",
  roll: "turn",
  mordent: "mordent",
  lowermordent: "mordent",
  uppermordent: "inverted-mordent",
  pralltriller: "inverted-mordent",
  upbow: "up-bow",
  downbow: "down-bow",
  breath: "breath-mark",
  arpeggio: "arpeggiate",
  segno: "segno",
  coda: "coda",
  "D.C.": "D.C.",
  "D.S.": "D.S.",
  fine: "Fine",
  wedge: "staccatissimo",
  open: "open-string",
  thumb: "thumb-position",
  snap: "snap-pizzicato",
};
const DYNAMICS = new Set(["pppp", "ppp", "pp", "p", "mp", "mf", "f", "ff", "fff", "ffff", "sfz", "sf", "fp", "rfz"]);

// ---- Reading a tune

export function readAbc(text: string, opts: AbcOptions = {}): Document {
  const tunes = splitTunes(text);
  if (!tunes.length) throw new Error("No ABC tune (an X: line) in this file");
  const tune = tunes.find((t) => t.x === opts.tune) ?? tunes[0];
  const lines = tune.text
    .split("\n")
    .map((l) => l.replace(/(^|[^\\])%.*$/, "$1"))
    .filter((l) => !/^%%/.test(l));

  let title = "";
  let composer = "";
  let meter = parseMeter("4/4");
  let meterSeen = false;
  let unit = 0;
  let tempo: Tempo | null = null;
  let key = parseKey("C");
  const voices = new Map<string, Voice>();
  const voiceDefs = new Map<string, { name: string; clef?: Clef }>();
  let current: Voice | null = null;
  let inBody = false;

  const voiceOf = (id: string): Voice => {
    let v = voices.get(id);
    if (!v) {
      const def = voiceDefs.get(id);
      v = { id, name: def?.name ?? "", clef: def?.clef, measures: [], cur: newMeasure(), barAlters: new Map(), key, lineNotes: [], slurDepth: 0, openEnding: null };
      voices.set(id, v);
    }
    return v;
  };

  const unitLength = () => unit || (meter && meter.quarters < 3 ? 0.0625 : 0.125);

  const field = (name: string, value: string): void => {
    switch (name) {
      case "T":
        if (!title) title = value.trim();
        break;
      case "C":
        if (!composer) composer = value.trim();
        break;
      case "M": {
        meter = parseMeter(value);
        meterSeen = true;
        if (inBody && current) current.cur.meter = meter;
        break;
      }
      case "L": {
        const f = parseFraction(value);
        if (f) unit = f;
        break;
      }
      case "Q": {
        const words = /"([^"]*)"/.exec(value)?.[1] ?? "";
        const m = /(\d+)\s*\/\s*(\d+)\s*=\s*(\d+)/.exec(value);
        const plain = /^\s*(\d+)\s*$/.exec(value.replace(/"[^"]*"/, ""));
        const bpm = m ? (Number(m[3]) * Number(m[1]) * 4) / Number(m[2]) : plain ? Number(plain[1]) * unitLength() * 4 : 0;
        // The beat as written (1/2=100 shows a half note), a quarter when it is no single value.
        const beat = splitValue(m ? (Number(m[1]) * 4) / Number(m[2]) : unitLength() * 4);
        const one = beat.length === 1 ? beat[0] : null;
        if (bpm || words) tempo = { bpm, text: words, unit: one?.[0] ?? "quarter", dots: one?.[1] ?? 0, per: one ? bpm / one[2] : bpm };
        break;
      }
      case "K": {
        const k = parseKey(value);
        if (!inBody) {
          key = k;
          inBody = true;
          if (!meterSeen) meter = meter ?? parseMeter("4/4");
          return;
        }
        if (current) {
          current.key = k;
          current.cur.key = k;
          if (k.clef) current.cur.clef = k.clef;
        }
        break;
      }
      case "V": {
        const m = /^\s*(\S+)(.*)$/.exec(value);
        if (!m) break;
        const name = /(?:name|nm)\s*=\s*"([^"]*)"/.exec(m[2])?.[1] ?? /(?:name|nm)\s*=\s*(\S+)/.exec(m[2])?.[1] ?? "";
        const clef = clefOf(m[2]);
        const def = voiceDefs.get(m[1]);
        voiceDefs.set(m[1], { name: name || def?.name || "", clef: clef ?? def?.clef });
        if (inBody) current = voiceOf(m[1]);
        break;
      }
    }
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    const f = /^([A-Za-z]):(.*)$/.exec(line);
    if (f && !(inBody && /^[|:[\]]/.test(line))) {
      if (f[1] === "w" && inBody && current) lyrics(current, f[2]);
      else if (f[1] !== "W") field(f[1], f[2]);
      continue;
    }
    if (!inBody || !line.trim()) continue;
    current ??= voiceOf(voiceDefs.keys().next().value ?? "1");
    current.lineNotes = [];
    music(current, line, field);
  }
  if (!voices.size) voiceOf("1");
  for (const v of voices.values()) closeMeasure(v, true);
  return build({ title, composer, tempo, key, meter, voices: [...voices.values()] });

  /** One line of music for a voice. */
  function music(v: Voice, line: string, onField: (name: string, value: string) => void): void {
    let i = 0;
    let joined = false;
    let pendingDecos: string[] = [];
    let pendingBefore: Before[] = [];
    let pendingGraces: NoteEvent["graces"] = [];
    let slurOpen = 0;
    let broken = 0; // the factor for the next note from a > or <
    let tuplet: { p: number; q: number; left: number; total: number } | null = null;
    let lastEvent = null as NoteEvent | null;
    const text = line.replace(/\\$/, "");

    const readPitch = (): Pitch | null => {
      const m = /^(\^\^|\^|__|_|=)?([A-Ga-g])([',]*)/.exec(text.slice(i));
      if (!m) return null;
      i += m[0].length;
      const step = m[2].toUpperCase();
      let octave = m[2] === step ? 4 : 5;
      for (const c of m[3]) octave += c === "'" ? 1 : -1;
      const where = `${step}${octave}`;
      let alter: number;
      let shown: string | undefined;
      if (m[1]) {
        alter = m[1] === "^" ? 1 : m[1] === "^^" ? 2 : m[1] === "_" ? -1 : m[1] === "__" ? -2 : 0;
        shown = ({ 1: "sharp", 2: "double-sharp", [-1]: "flat", [-2]: "flat-flat", 0: "natural" } as Record<number, string>)[alter];
        v.barAlters.set(where, alter);
      } else alter = v.barAlters.get(where) ?? v.key.alters[step] ?? 0;
      return { step, octave, alter, shown };
    };
    const readLength = (): number => {
      const m = /^(\d*)(\/*)(\d*)/.exec(text.slice(i));
      if (!m || !m[0]) return 1;
      i += m[0].length;
      const num = m[1] ? Number(m[1]) : 1;
      if (!m[2]) return num;
      const den = m[3] ? Number(m[3]) : 2 ** m[2].length;
      return num / den;
    };
    const add = (ev: Omit<NoteEvent, "joined" | "before" | "decorations" | "graces" | "slurStart" | "tuplet">, factor: number): NoteEvent => {
      let quarters = ev.quarters * factor;
      if (broken) {
        quarters *= broken;
        broken = 0;
      }
      let t: NoteEvent["tuplet"];
      if (tuplet) {
        quarters *= tuplet.q / tuplet.p;
        t = { p: tuplet.p, q: tuplet.q, start: tuplet.left === tuplet.total, stop: tuplet.left === 1 };
        if (--tuplet.left <= 0) tuplet = null;
      }
      const full: NoteEvent = { ...ev, quarters, tuplet: t, joined, before: pendingBefore, decorations: pendingDecos, graces: pendingGraces, slurStart: slurOpen };
      pendingBefore = [];
      pendingDecos = [];
      pendingGraces = [];
      slurOpen = 0;
      joined = true;
      v.cur.events.push(full);
      if (full.pitches && !ev.measureRest) v.lineNotes.push(full);
      lastEvent = full;
      return full;
    };
    const unitQ = () => unitLength() * 4;

    while (i < text.length) {
      const c = text[i];
      const rest = text.slice(i);
      if (c === " " || c === "\t") {
        joined = false;
        i++;
        continue;
      }
      // Inline field [K:...], [M:...], [V:...]...
      const inline = /^\[([A-Za-z]):([^\]]*)\]/.exec(rest);
      if (inline) {
        i += inline[0].length;
        if (inline[1] === "V") {
          onField("V", inline[2]);
          return music(current!, text.slice(i), onField);
        }
        onField(inline[1], inline[2]);
        continue;
      }
      // Bar lines, repeats and endings.
      const bar = /^(:*)(\[\||\|\]|\|\||\|)(:*)\s*(\[?\d+(?:[-,]\d+)*)?/.exec(rest) ?? /^(::)()()/.exec(rest);
      if (bar && (bar[2] || bar[1] === "::")) {
        i += bar[0].length;
        const backward = bar[1].length > 0;
        const forward = bar[3].length > 0 || bar[1] === "::";
        const style = bar[2] === "|]" ? "light-heavy" : bar[2] === "||" ? "light-light" : bar[2] === "[|" ? "heavy-light" : "";
        endBar(v, { backward, forward, style });
        if (bar[4]) startEnding(v, bar[4].replace("[", ""));
        joined = false;
        continue;
      }
      const ending = /^\[(\d+(?:[-,]\d+)*)/.exec(rest);
      if (ending) {
        i += ending[0].length;
        startEnding(v, ending[1]);
        continue;
      }
      if (c === '"') {
        const end = text.indexOf('"', i + 1);
        const s = text.slice(i + 1, end < 0 ? undefined : end);
        i = end < 0 ? text.length : end + 1;
        const place = s[0];
        if ("^_<>@".includes(place)) pendingBefore.push({ kind: "words", text: s.slice(1), below: place === "_" });
        else if (parseChord(s)) pendingBefore.push({ kind: "chord", text: s });
        else if (s.trim()) pendingBefore.push({ kind: "words", text: s, below: false });
        continue;
      }
      const deco = /^[!+]([^!+\s]+)[!+]/.exec(rest);
      if (deco) {
        i += deco[0].length;
        const name = deco[1];
        if (DYNAMICS.has(name)) pendingBefore.push({ kind: "dynamic", value: name });
        else if (/^(crescendo|<)\($/.test(name)) pendingBefore.push({ kind: "wedge", type: "crescendo" });
        else if (/^(diminuendo|>)\($/.test(name)) pendingBefore.push({ kind: "wedge", type: "diminuendo" });
        else if (/^(crescendo|diminuendo|<|>)\)$/.test(name)) (lastEvent ? v.cur.after : pendingBefore).push({ kind: "wedge", type: "stop" });
        else if (NAMED[name]) pendingDecos.push(NAMED[name]);
        continue;
      }
      if (DECORATION[c]) {
        pendingDecos.push(DECORATION[c]);
        i++;
        continue;
      }
      if (c === "(") {
        const t = /^\((\d)(?::(\d*))?(?::(\d*))?/.exec(rest);
        if (t) {
          i += t[0].length;
          const p = Number(t[1]);
          const compound = !!meter && Number(meter.type) === 8 && Number(meter.beats) % 3 === 0;
          const q = t[2] ? Number(t[2]) : ({ 2: 3, 3: 2, 4: 3, 6: 2, 8: 3 } as Record<number, number>)[p] ?? (compound ? 3 : 2);
          const r = t[3] ? Number(t[3]) : p;
          tuplet = { p, q, left: r, total: r };
        } else {
          slurOpen++;
          i++;
        }
        continue;
      }
      if (c === ")") {
        if (lastEvent) lastEvent.slurStop++;
        i++;
        continue;
      }
      if (c === "-") {
        if (lastEvent) lastEvent.tie = true;
        i++;
        continue;
      }
      if (c === ">" || c === "<") {
        const m = /^(>+|<+)/.exec(rest)![0];
        const f = m.length === 1 ? 0.5 : m.length === 2 ? 0.25 : 0.125;
        if (lastEvent) {
          const last: NoteEvent = lastEvent;
          last.quarters *= c === ">" ? 2 - f : f;
          broken = c === ">" ? f : 2 - f;
        }
        i += m.length;
        continue;
      }
      if (c === "{") {
        const end = text.indexOf("}", i);
        const inner = text.slice(i + 1, end < 0 ? undefined : end);
        const slash = inner.startsWith("/");
        const saved = i;
        let j = slash ? 1 : 0;
        const graces: NoteEvent["graces"] = [];
        // Grace notes, read with the same pitch rules.
        const sub = inner;
        while (j < sub.length) {
          i = saved + 1 + j;
          const p = readPitch();
          if (!p) {
            j++;
            continue;
          }
          const len = readLength();
          j = i - saved - 1;
          graces.push({ pitches: [p], quarters: len * unitQ(), slash });
        }
        pendingGraces = graces;
        i = end < 0 ? text.length : end + 1;
        continue;
      }
      if (c === "[") {
        // A chord: [CEG]2
        const end = text.indexOf("]", i);
        if (end < 0) {
          i++;
          continue;
        }
        const saved = i;
        i++;
        const pitches: Pitch[] = [];
        let first = 0;
        while (i < end) {
          const p = readPitch();
          if (!p) {
            i++;
            continue;
          }
          const len = readLength();
          if (!pitches.length) first = len;
          pitches.push(p);
          while (text[i] === "-") i++;
        }
        i = end + 1;
        const outer = readLength();
        if (!pitches.length) {
          i = saved + 1;
          continue;
        }
        add({ kind: "note", pitches, quarters: (first || 1) * outer * unitQ(), tie: false, slurStop: 0 }, 1);
        continue;
      }
      if (c === "z" || c === "x") {
        i++;
        const len = readLength();
        add({ kind: "note", pitches: null, invisible: c === "x", quarters: len * unitQ(), tie: false, slurStop: 0 }, 1);
        continue;
      }
      if (c === "Z" || c === "X") {
        i++;
        const bars = Math.max(1, Math.round(readLength()));
        const len = meter ? meter.quarters : 4;
        for (let b = 0; b < bars; b++) {
          if (b > 0) endBar(v, { backward: false, forward: false, style: "" });
          add({ kind: "note", pitches: null, invisible: c === "X", quarters: len, tie: false, slurStop: 0, measureRest: true }, 1);
        }
        continue;
      }
      const p = readPitch();
      if (p) {
        const len = readLength();
        add({ kind: "note", pitches: [p], quarters: len * unitQ(), tie: false, slurStop: 0 }, 1);
        continue;
      }
      // y (spacing), & (overlay), stray characters: skipped.
      i++;
    }
  }

  function endBar(v: Voice, b: { backward: boolean; forward: boolean; style: string }): void {
    if (v.cur.events.length) {
      if (b.backward) v.cur.backward = true;
      if (b.style) v.cur.style = b.style;
      // An ending stops at a repeat or a double bar.
      if (v.openEnding && (b.backward || b.style)) {
        (v.cur.ending ??= []).push({ number: v.openEnding, type: b.backward ? "stop" : "discontinue" });
        v.openEnding = null;
      }
      closeMeasure(v, false);
    } else if (b.backward && v.measures.length) {
      // ":|" at the start of a line closes the bar before.
      const last = v.measures[v.measures.length - 1];
      last.backward = true;
      if (v.openEnding) {
        (last.ending ??= []).push({ number: v.openEnding, type: "stop" });
        v.openEnding = null;
      }
    }
    if (b.forward) v.cur.forward = true;
  }

  function startEnding(v: Voice, number: string): void {
    // A new ending closes one still open at the bar before.
    if (v.openEnding && v.measures.length) {
      const last = v.measures[v.measures.length - 1];
      if (!last.ending?.some((e) => e.type !== "start")) (last.ending ??= []).push({ number: v.openEnding, type: "discontinue" });
    }
    const n = number.replace(/-/g, ",").replace(/(\d+),(\d+)/, (all, a: string, b: string) => (number.includes("-") ? Array.from({ length: Number(b) - Number(a) + 1 }, (_, k) => Number(a) + k).join(",") : all));
    (v.cur.ending ??= []).push({ number: n, type: "start" });
    v.openEnding = n;
  }

  function closeMeasure(v: Voice, last: boolean): void {
    if (v.cur.events.length || (last && (v.cur.after.length || v.cur.ending?.length))) {
      if (last && v.openEnding) {
        (v.cur.ending ??= []).push({ number: v.openEnding, type: "discontinue" });
        v.openEnding = null;
      }
      v.measures.push(v.cur);
      v.cur = newMeasure();
    } else if (last && v.openEnding && v.measures.length) {
      (v.measures[v.measures.length - 1].ending ??= []).push({ number: v.openEnding, type: "discontinue" });
      v.openEnding = null;
    }
    v.barAlters.clear();
  }

  /** A w: line: syllables to the notes of the music line before it. */
  function lyrics(v: Voice, words: string): void {
    const notes = v.lineNotes.filter((_n, k, all) => !(k > 0 && all[k - 1].tie));
    let at = 0;
    for (const token of words.trim().split(/\s+/)) {
      if (!token || token === "|") continue;
      const parts = token.split(/(?<=-)/);
      parts.forEach((part, k) => {
        for (const ch of part) {
          if (ch === "*" || ch === "_") at++;
        }
        const syl = part.replace(/[-*_|]/g, "").replace(/~/g, " ").replace(/\\-/g, "-");
        if (!syl) return;
        const many = parts.length > 1;
        const syllabic = !many ? "single" : k === 0 ? "begin" : k === parts.length - 1 ? "end" : "middle";
        if (notes[at]) notes[at].lyric = { text: syl, syllabic };
        at++;
      });
    }
  }
}

// ---- MusicXML

function build(o: { title: string; composer: string; tempo: Tempo | null; key: Key; meter: ReturnType<typeof parseMeter>; voices: Voice[] }): Document {
  const doc = parseXml('<score-partwise version="4.0"/>');
  const root = doc.documentElement;
  const el = (parent: Element, tag: string, value?: string | number | null, attrs?: Record<string, string | number>) => {
    const e = doc.createElementNS(null, tag);
    if (value !== undefined && value !== null) e.textContent = String(value);
    for (const [k, v] of Object.entries(attrs ?? {})) e.setAttribute(k, String(v));
    parent.appendChild(e);
    return e;
  };
  if (o.title) el(el(root, "work"), "work-title", o.title);
  if (o.composer) el(el(root, "identification"), "creator", o.composer, { type: "composer" });
  const list = el(root, "part-list");
  const count = Math.max(1, ...o.voices.map((v) => v.measures.length));
  o.voices.forEach((v, n) => {
    const id = `P${n + 1}`;
    const sp = el(list, "score-part", null, { id });
    el(sp, "part-name", v.name || (o.voices.length > 1 ? `Voice ${v.id}` : ""));
    const part = el(root, "part", null, { id });
    let key = o.key;
    let meter = o.meter;
    let tieOpen: Pitch[] = [];
    for (let m = 0; m < count; m++) {
      const src = v.measures[m] ?? newMeasure();
      const pickup = m === 0 && meter && src.events.length > 0 && total(src) < meter.quarters - 1e-6;
      const meas = el(part, "measure", null, pickup ? { number: 0, implicit: "yes" } : { number: o.voices[0].measures[0] && total(o.voices[0].measures[0]) < (o.meter?.quarters ?? 4) - 1e-6 ? m : m + 1 });
      if (src.forward || src.ending?.some((e) => e.type === "start")) {
        const bl = el(meas, "barline", null, { location: "left" });
        for (const e of src.ending?.filter((x) => x.type === "start") ?? []) el(bl, "ending", null, { number: e.number, type: "start" });
        if (src.forward) el(bl, "repeat", null, { direction: "forward" });
      }
      if (m === 0 || src.key || src.meter || src.clef) {
        const at = el(meas, "attributes");
        if (m === 0) el(at, "divisions", DIV);
        if (src.key) key = src.key;
        if (m === 0 || src.key) el(el(at, "key"), "fifths", key.fifths);
        if (src.meter !== undefined) meter = src.meter;
        if ((m === 0 || src.meter !== undefined) && meter) {
          const t = el(at, "time", null, meter.symbol ? { symbol: meter.symbol } : undefined);
          el(t, "beats", meter.beats);
          el(t, "beat-type", meter.type);
        }
        const clef = src.clef ?? (m === 0 ? (v.clef ?? key.clef ?? CLEFS.treble) : undefined);
        if (clef) {
          const c = el(at, "clef");
          el(c, "sign", clef.sign);
          el(c, "line", clef.line);
          if (clef.octave) el(c, "clef-octave-change", clef.octave);
        }
        if (!at.firstChild) at.remove();
      }
      if (m === 0 && n === 0 && o.tempo) {
        const dir = el(meas, "direction", null, { placement: "above" });
        const dt = el(dir, "direction-type");
        if (o.tempo.text) el(dt, "words", o.tempo.text);
        if (o.tempo.bpm) {
          const mt = el(o.tempo.text ? el(dir, "direction-type") : dt, "metronome");
          el(mt, "beat-unit", o.tempo.unit);
          for (let d = 0; d < o.tempo.dots; d++) el(mt, "beat-unit-dot");
          el(mt, "per-minute", Math.round(o.tempo.per));
          el(dir, "sound", null, { tempo: Math.round(o.tempo.bpm * 100) / 100 });
        }
      }
      // An empty bar (a voice with nothing there): a whole-bar rest.
      const events = src.events.length ? src.events : [{ kind: "note", pitches: null, quarters: meter?.quarters ?? 4, tie: false, slurStart: 0, slurStop: 0, decorations: [], graces: [], before: [], joined: false, measureRest: true } as NoteEvent];
      const beams = beamsOf(events);
      events.forEach((ev, k) => {
        for (const b of ev.before) direction(meas, b);
        for (const g of ev.graces) note(meas, { ...ev, pitches: g.pitches, quarters: g.quarters, tie: false, slurStart: 0, slurStop: 0, decorations: [], tuplet: undefined, lyric: undefined }, true, g.slash, null, []);
        tieOpen = note(meas, ev, false, false, beams[k], tieOpen);
      });
      for (const b of src.after) direction(meas, b);
      if (src.backward || src.style || src.ending?.some((e) => e.type !== "start")) {
        const bl = el(meas, "barline", null, { location: "right" });
        el(bl, "bar-style", src.style || (src.backward ? "light-heavy" : "regular"));
        for (const e of src.ending?.filter((x) => x.type !== "start") ?? []) el(bl, "ending", null, { number: e.number, type: e.type });
        if (src.backward) el(bl, "repeat", null, { direction: "backward" });
      }
    }
    // The last bar ends the piece.
    const lastMeas = part.lastElementChild;
    if (lastMeas && ![...lastMeas.getElementsByTagName("barline")].some((b) => b.getAttribute("location") === "right")) el(el(lastMeas, "barline", null, { location: "right" }), "bar-style", "light-heavy");
  });
  return doc;

  function direction(meas: Element, b: Before): void {
    if (b.kind === "chord") {
      const c = parseChord(b.text);
      if (c) meas.appendChild(makeHarmony(doc, c));
      return;
    }
    const dir = el(meas, "direction", null, { placement: b.kind === "words" && !b.below ? "above" : "below" });
    const dt = el(dir, "direction-type");
    if (b.kind === "words") el(dt, "words", b.text);
    else if (b.kind === "dynamic") {
      el(el(dt, "dynamics"), b.value);
    } else el(dt, "wedge", null, { type: b.type });
  }

  /** One note (or chord, or rest); returns the pitches tied on to the next one. */
  function note(meas: Element, ev: NoteEvent, grace: boolean, slash: boolean, beam: string[] | null, tiedIn: Pitch[]): Pitch[] {
    const ratio = ev.tuplet ? ev.tuplet.p / ev.tuplet.q : 1;
    const written = ev.quarters * ratio;
    const pieces = grace ? [splitValue(written)[0]] : ev.measureRest ? [["whole", 0, written] as [string, number, number]] : splitValue(written);
    const out: Pitch[] = [];
    pieces.forEach(([type, dots, q], pi) => {
      const firstPiece = pi === 0;
      const lastPiece = pi === pieces.length - 1;
      (ev.pitches ?? [null]).forEach((p, ci) => {
        const n = el(meas, "note", null, ev.invisible ? { "print-object": "no" } : undefined);
        if (grace) el(n, "grace", null, slash ? { slash: "yes" } : undefined);
        if (ci > 0) el(n, "chord");
        if (!p) el(n, "rest", null, ev.measureRest ? { measure: "yes" } : undefined);
        else {
          const pitch = el(n, "pitch");
          el(pitch, "step", p.step);
          if (p.alter) el(pitch, "alter", p.alter);
          el(pitch, "octave", p.octave);
        }
        if (!grace) el(n, "duration", Math.round((q / ratio) * DIV));
        const tiedFrom = !!p && (firstPiece ? tiedIn.some((t) => t.step === p.step && t.octave === p.octave) : true);
        const tiedOn = !!p && (!lastPiece || ev.tie);
        if (tiedFrom) el(n, "tie", null, { type: "stop" });
        if (tiedOn) el(n, "tie", null, { type: "start" });
        el(n, "voice", 1);
        if (!ev.measureRest) el(n, "type", type);
        for (let d = 0; d < dots; d++) el(n, "dot");
        if (p?.shown && firstPiece) el(n, "accidental", p.shown);
        if (ev.tuplet && !grace) {
          const tm = el(n, "time-modification");
          el(tm, "actual-notes", ev.tuplet.p);
          el(tm, "normal-notes", ev.tuplet.q);
        }
        if (ci === 0 && beam && pieces.length === 1) beam.forEach((b, lvl) => b && el(n, "beam", b, { number: lvl + 1 }));
        // Notations: ties, slurs, tuplet bracket, marks.
        const nots: Element[] = [];
        const nt = () => (nots[0] ??= el(n, "notations"));
        if (tiedFrom) el(nt(), "tied", null, { type: "stop" });
        if (tiedOn) el(nt(), "tied", null, { type: "start" });
        if (ci === 0 && !grace) {
          if (firstPiece) for (let s = 0; s < ev.slurStart; s++) el(nt(), "slur", null, { type: "start", number: s + 1 });
          if (lastPiece) for (let s = 0; s < ev.slurStop; s++) el(nt(), "slur", null, { type: "stop", number: s + 1 });
          if (ev.tuplet?.start && firstPiece) el(nt(), "tuplet", null, { type: "start" });
          if (ev.tuplet?.stop && lastPiece) el(nt(), "tuplet", null, { type: "stop" });
          if (firstPiece) marks(nt, ev.decorations);
        }
        if (ci === 0 && firstPiece && ev.lyric && !grace) {
          const ly = el(n, "lyric", null, { number: 1 });
          el(ly, "syllabic", ev.lyric.syllabic);
          el(ly, "text", ev.lyric.text);
        }
        if (lastPiece && tiedOn && p) out.push(p);
      });
    });
    return out;
  }

  function marks(nt: () => Element, decos: string[]): void {
    const ART = ["staccato", "accent", "tenuto", "strong-accent", "staccatissimo", "breath-mark"];
    const ORN = ["trill-mark", "turn", "mordent", "inverted-mordent"];
    const TECH = ["up-bow", "down-bow", "open-string", "thumb-position", "snap-pizzicato"];
    const art = decos.filter((d) => ART.includes(d));
    if (art.length) {
      const a = el(nt(), "articulations");
      for (const d of art) el(a, d);
    }
    const orn = decos.filter((d) => ORN.includes(d));
    if (orn.length) {
      const a = el(nt(), "ornaments");
      for (const d of orn) el(a, d);
    }
    const tech = decos.filter((d) => TECH.includes(d));
    if (tech.length) {
      const a = el(nt(), "technical");
      for (const d of tech) el(a, d);
    }
    if (decos.includes("fermata")) el(nt(), "fermata", null, { type: "upright" });
    if (decos.includes("arpeggiate")) el(nt(), "arpeggiate");
  }
}

const total = (m: Measure) => m.events.reduce((s, e) => s + e.quarters, 0);

/** Beams for notes written next to each other (no space): eighths and shorter, levels 1 and 2. */
function beamsOf(events: NoteEvent[]): (string[] | null)[] {
  const out: (string[] | null)[] = events.map(() => null);
  const beamable = (e: NoteEvent) => !!e.pitches && !e.measureRest && writtenOf(e) < 1 - 1e-6 && splitValue(writtenOf(e)).length === 1;
  let k = 0;
  while (k < events.length) {
    if (!beamable(events[k])) {
      k++;
      continue;
    }
    let j = k + 1;
    while (j < events.length && events[j].joined && beamable(events[j])) j++;
    if (j - k >= 2) {
      for (let x = k; x < j; x++) {
        const lvl1 = x === k ? "begin" : x === j - 1 ? "end" : "continue";
        const short = (e: NoteEvent) => writtenOf(e) <= 0.375 + 1e-6;
        let lvl2 = "";
        if (short(events[x])) {
          const prev = x > k && short(events[x - 1]);
          const next = x < j - 1 && short(events[x + 1]);
          lvl2 = prev && next ? "continue" : prev ? "end" : next ? "begin" : x === k ? "forward hook" : "backward hook";
        }
        out[x] = lvl2 ? [lvl1, lvl2] : [lvl1];
      }
    }
    k = j;
  }
  return out;
}

const writtenOf = (e: NoteEvent) => e.quarters * (e.tuplet ? e.tuplet.p / e.tuplet.q : 1);

