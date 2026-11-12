import { makeHarmony, parseChord } from "../edit/chords";
import { parseXml } from "../model/xml";

// ABC notation (abcnotation.com, standard 2.1) read into MusicXML: the header (title,
// composer, meter, unit length, tempo, key and clef), notes, rests, chords, grace notes,
// ties, slurs, tuplets, broken rhythm, bar lines, repeats and endings, decorations,
// chord symbols, annotations, lyrics (verses, bar skips), s: symbol lines, voices with their V:
// properties (middle=, stafflines=...), & voice overlays, the %%score / %%staves layout (shared
// staves, braces, brackets; later ones merged in) and P: parts with their play order.

export interface AbcOptions {
  /** The tune to open, by its X: number (the first one otherwise). */
  tune?: number;
}

/** The tunes of an ABC file: X: number and title. */
export function abcTunes(text: string): { x: number; title: string }[] {
  return splitTunes(text).map((t) => ({ x: t.x, title: decodeText(/^T:\s*(.*)$/m.exec(t.text)?.[1]?.trim() ?? "") }));
}

/** Text that looks like ABC: an X: line followed later by a K: line. */
export function looksLikeAbc(head: string): boolean {
  return /^X:\s*\d*\s*$/m.test(head) && /^K:/m.test(head) && !/^\s*</.test(head);
}

function splitTunes(text: string): { x: number; text: string }[] {
  const out: { x: number; text: string }[] = [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  // The file header (before the first X:) sets defaults for every tune.
  const first = lines.findIndex((l) => /^X:/.test(l));
  const fileHeader = lines.slice(0, Math.max(0, first)).filter((l) => /^([MLIU]:|%%)/.test(l));
  let cur: { x: number; lines: string[] } | null = null;
  const done = () => {
    if (cur) out.push({ x: cur.x, text: cur.lines.join("\n") });
    cur = null;
  };
  for (const line of lines) {
    const m = /^X:\s*(\d*)/.exec(line);
    if (m) {
      done();
      cur = { x: Number(m[1]) || out.length + 1, lines: [line, ...fileHeader] };
    } else if (cur && !line.trim() && cur.lines.some((l) => /^K:/.test(l))) done();
    // An empty line ends the tune (text between tunes is not music).
    else if (cur) cur.lines.push(line);
  }
  done();
  return out;
}

// ---- Text: ABC mnemonics (\\'e), HTML entities (&eacute;) and \\u00e9

const ACCENT: Record<string, string> = { "`": "\u0300", "'": "\u0301", "^": "\u0302", "~": "\u0303", '"': "\u0308", c: "\u0327", a: "\u030a", o: "\u0338", v: "\u030c", u: "\u0306", "=": "\u0304" };
const ENTITY_ACCENT: Record<string, string> = { grave: "`", acute: "'", circ: "^", tilde: "~", uml: '"', cedil: "c", ring: "a", caron: "v" };
const LIGATURE: Record<string, string> = { ss: "\u00df", AE: "\u00c6", ae: "\u00e6", OE: "\u0152", oe: "\u0153", szlig: "\u00df", aelig: "\u00e6", AElig: "\u00c6", oelig: "\u0153", OElig: "\u0152", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0", oslash: "\u00f8", Oslash: "\u00d8" };

function decodeText<T extends string | undefined>(s: T): T {
  if (!s || !/[\\&]/.test(s)) return s;
  return s
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\(ss|AE|ae|OE|oe)/g, (_, l: string) => LIGATURE[l])
    .replace(/\\([`'^~"cauov=])([A-Za-z])/g, (_, a: string, l: string) => (a === "o" && /o/i.test(l) ? (l === "O" ? "\u00d8" : "\u00f8") : (l + ACCENT[a]).normalize("NFC")))
    .replace(/&#(x[0-9a-fA-F]+|\d+);/g, (_, n: string) => String.fromCodePoint(n[0] === "x" ? parseInt(n.slice(1), 16) : Number(n)))
    .replace(/&([A-Za-z])(grave|acute|circ|tilde|uml|cedil|ring|caron);/g, (_, l: string, a: string) => (l + ACCENT[ENTITY_ACCENT[a]]).normalize("NFC"))
    .replace(/&([A-Za-z]+);/g, (all, n: string) => LIGATURE[n] ?? all) as T;
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
  /** No key given (K:clef=bass): only the other properties change. */
  none?: boolean;
  props: Props;
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
  /** Octaves middle= moves the notes by (not shown). */
  shift?: number;
}

const CLEFS: Record<string, Clef> = {
  treble: { sign: "G", line: 2 },
  bass: { sign: "F", line: 4 },
  baritone: { sign: "F", line: 3 },
  alto: { sign: "C", line: 3 },
  tenor: { sign: "C", line: 4 },
  perc: { sign: "percussion", line: 2 },
  percussion: { sign: "percussion", line: 2 },
  none: { sign: "G", line: 2 },
  g: { sign: "G", line: 2 },
  f: { sign: "F", line: 4 },
  c: { sign: "C", line: 3 },
};

function clefOf(spec: string): Clef | undefined {
  const s = spec.replace(/"[^"]*"/g, "");
  // clef=bass, clef=F3, bass3, alto1, treble-8; bare none only after a space (K:none is a key).
  const m = /(?:^|\s)clef\s*=\s*(treble|bass|baritone|alto|tenor|perc|percussion|none|[GFC])([1-5])?([+-]8)?[,']*(?=\s|$)/i.exec(s) ?? /(?:^|(?<=\s))(treble|bass|baritone|alto|tenor|perc)([1-5])?([+-]8)?[,']*(?=\s|$)/.exec(s) ?? /(?<=\s)(none)([1-5])?([+-]8)?[,']*(?=\s|$)/.exec(s);
  if (!m) return undefined;
  const c: Clef = { ...CLEFS[m[1].toLowerCase()] };
  if (m[2]) c.line = Number(m[2]);
  if (m[3]) c.octave = m[3] === "-8" ? -1 : 1;
  return c;
}

// The pitch each clef sign stands for, as a diatonic index (octave * 7 + step).
const CLEF_REF: Record<string, number> = { G: 4 * 7 + 4, F: 3 * 7 + 3, C: 4 * 7 };

/** middle=: the clef line that puts that pitch on the middle line, the notes moved by whole octaves. */
function withMiddle(clef: Clef, middle: number): Clef {
  const ref = CLEF_REF[clef.sign];
  if (ref === undefined) return clef;
  let line = clef.line;
  for (let l = 1; l <= 5; l++) if ((((middle - ref - 2 * (3 - l)) % 7) + 7) % 7 === 0) line = l;
  const shift = Math.round((ref + 2 * (3 - line) - middle) / 7);
  const out: Clef = { ...clef, line };
  if (shift) out.shift = shift;
  else delete out.shift;
  return out;
}

/** The clef props ask for: clef= and middle= together. */
function clefFrom(p: Props, now?: Clef): Clef | undefined {
  if (p.middle === undefined) return p.clef;
  return withMiddle(p.clef ?? now ?? CLEFS.treble, p.middle);
}

/** Voice and key properties (ABC 2.1 sections 4.6 and 7.1). */
interface Props {
  name?: string;
  subname?: string;
  clef?: Clef;
  /** Octaves the music is moved by (octave=). */
  octave?: number;
  /** Semitones it sounds away from the written notes (transpose=). */
  transpose?: number;
  stem?: "up" | "down";
  /** The pitch on the middle line (middle=), as a diatonic index. */
  middle?: number;
  /** Lines of the staff (stafflines=). */
  stafflines?: number;
}

function propsOf(spec: string): Props {
  const get = (keys: string) => {
    const m = new RegExp(`(?:^|[\\s"])(?:${keys})\\s*=\\s*(?:"([^"]*)"|(\\S+))`, "i").exec(spec);
    return m ? (m[1] ?? m[2]) : undefined;
  };
  const num = (keys: string) => {
    const v = get(keys);
    return v !== undefined && /^[+-]?\d+$/.test(v) ? Number(v) : undefined;
  };
  const stem = get("stem")?.toLowerCase();
  const mid = /^[_^=]*([A-Ga-g])([,']*)$/.exec(get("middle") ?? "");
  const lines = num("stafflines");
  const out: Props = {
    name: decodeText(get("name|nm")?.replace(/\\n/g, " ")),
    subname: decodeText(get("subname|sname|snm")?.replace(/\\n/g, " ")),
    clef: clefOf(spec),
    octave: num("octave"),
    transpose: num("transpose"),
    stem: stem === "up" || stem === "down" ? stem : undefined,
    middle: mid ? (mid[1] === mid[1].toUpperCase() ? 4 : 5) * 7 + "CDEFGAB".indexOf(mid[1].toUpperCase()) + [...mid[2]].reduce((a, c) => a + (c === "'" ? 7 : -7), 0) : undefined,
    stafflines: lines !== undefined && lines >= 0 && lines <= 9 ? lines : undefined,
  };
  for (const k of Object.keys(out) as (keyof Props)[]) if (out[k] === undefined) delete out[k];
  return out;
}

function parseKey(spec: string): Key {
  const s = spec.trim();
  const props = propsOf(s);
  let fifths = 0;
  const m = /^([A-G])([#b]?)\s*([A-Za-z]*)/.exec(s);
  if (m) {
    const base = TONIC[m[1] + m[2]] ?? 0;
    const mode = m[3].toLowerCase();
    // A word followed by = is a property (K:D middle=d), not a mode.
    const word = /^\s*([A-Za-z]*)\s*=/.test(s.slice(m[1].length + m[2].length));
    const shift = mode && !word ? (MODES.find(([re]) => re.test(mode))?.[1] ?? 0) : 0;
    fifths = base + shift;
  }
  const none = !m && !/^(none|HP|Hp)\b/.test(s) && !/^(\^\^|\^|__|_|=)[A-Ga-g]/.test(s);
  // Explicit accidentals after the key (K:D =c ^g) change those steps.
  const alters: Record<string, number> = {};
  for (let i = 0; i < Math.abs(fifths) && i < 7; i++) alters[(fifths > 0 ? SHARPS : [...SHARPS].reverse().join(""))[i]] = fifths > 0 ? 1 : -1;
  for (const acc of s.matchAll(/(?:^|\s)(\^\^|\^|__|_|=)([A-Ga-g])/g)) alters[acc[2].toUpperCase()] = acc[1] === "^" ? 1 : acc[1] === "^^" ? 2 : acc[1] === "_" ? -1 : acc[1] === "__" ? -2 : 0;
  return { fifths: Math.max(-7, Math.min(7, fifths)), alters, none, props };
}

function parseFraction(s: string): number | null {
  const m = /^\s*(\d+)\s*\/\s*(\d+)/.exec(s);
  if (m) return Number(m[1]) / Number(m[2]);
  const n = /^\s*(\d+)/.exec(s);
  return n ? Number(n[1]) : null;
}

type Meter = { beats: string; type: string; quarters: number; symbol?: string } | null;

/** Meter: beats, beat type and the bar length in quarters ("C" is 4/4, "C|" 2/2). */
function parseMeter(spec: string): Meter {
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

// ---- Voice grouping: %%score and %%staves

interface Layout {
  /** The staves, top to bottom, with the voice ids on each. */
  staves: string[][];
  /** Braces and brackets, as staff ranges. */
  groups: { kind: "brace" | "bracket"; first: number; last: number; barline: boolean }[];
}

/** A %%score (or %%staves, where | means the reverse) voice grouping. */
function parseScore(spec: string, staves: boolean): Layout {
  const out: Layout = { staves: [], groups: [] };
  const open: { kind: "brace" | "bracket"; first: number; bars: boolean }[] = [];
  let paren: string[] | null = null;
  let floating = false;
  for (const t of spec.match(/[()[\]{}|*]|[^\s()[\]{}|*]+/g) ?? []) {
    if (t === "(") paren = [];
    else if (t === ")") {
      if (paren?.length) out.staves.push(paren);
      paren = null;
    } else if (t === "[" || t === "{") open.push({ kind: t === "{" ? "brace" : "bracket", first: out.staves.length, bars: false });
    else if (t === "]" || t === "}") {
      const g = open.pop();
      if (g && out.staves.length > g.first) out.groups.push({ kind: g.kind, first: g.first, last: out.staves.length - 1, barline: staves ? !g.bars : g.bars });
    } else if (t === "|") {
      if (open.length) open[open.length - 1].bars = true;
    } else if (t === "*") floating = true;
    else if (paren) paren.push(t);
    // A floating voice goes on the staff before it.
    else if (floating && out.staves.length) out.staves[out.staves.length - 1].push(t);
    else out.staves.push([t]);
    if (t !== "*") floating = false;
  }
  if (paren?.length) out.staves.push(paren);
  return out;
}

/**
 * A later %%score merged into the layout (MusicXML parts cannot regroup mid-score): its new voices
 * join the staff of a voice they share one with, or get a staff of their own; its groups are kept when they fit.
 */
function mergeLayout(base: Layout, next: Layout): Layout {
  const staves = base.staves.map((s) => [...s]);
  const groups = base.groups.map((g) => ({ ...g, firstStaff: staves[g.first], lastStaff: staves[g.last] }));
  const staffOf = (id: string) => staves.find((s) => s.includes(id));
  const mapped: string[][] = [];
  next.staves.forEach((ids, k) => {
    const home = ids.map(staffOf).find((s) => s);
    const fresh = [...new Set(ids.filter((id) => !staffOf(id)))];
    if (home) home.push(...fresh);
    else {
      // After the staff of the voice before it in the new directive.
      const prev = next.staves.slice(0, k).flat().reverse().map(staffOf).find((s) => s);
      const after = next.staves.slice(k + 1).flat().map(staffOf).find((s) => s);
      const at = prev ? staves.indexOf(prev) + 1 : after ? staves.indexOf(after) : staves.length;
      staves.splice(at, 0, fresh);
    }
    mapped.push(home ?? staffOf(ids[0])!);
  });
  for (const g of next.groups) {
    const idx = [...new Set(mapped.slice(g.first, g.last + 1))].map((s) => staves.indexOf(s)).sort((a, b) => a - b);
    const first = idx[0];
    const last = idx[idx.length - 1];
    const contiguous = last - first + 1 === idx.length;
    const crosses = groups.some((o) => {
      const a = staves.indexOf(o.firstStaff);
      const b = staves.indexOf(o.lastStaff);
      return (a === first && b === last) || (a < first && b >= first && b < last) || (a > first && a <= last && b > last);
    });
    if (contiguous && !crosses) groups.push({ ...g, firstStaff: staves[first], lastStaff: staves[last] });
  }
  return { staves, groups: groups.map(({ firstStaff, lastStaff, ...g }) => ({ ...g, first: staves.indexOf(firstStaff), last: staves.indexOf(lastStaff) })) };
}

/** A P: play order (ABC 2.1 section 4.8): P:AABA, P:A2B, P:((AB)2C)2, dots ignored; the part letters in order. */
function playOrderOf(spec: string): string[] {
  let i = 0;
  const s = spec.replace(/[\s.]/g, "");
  const seq = (): string[] => {
    const out: string[] = [];
    while (i < s.length && s[i] !== ")") {
      let item: string[];
      if (s[i] === "(") {
        i++;
        item = seq();
        i++;
      } else if (/[A-Za-z]/.test(s[i])) item = [s[i++]];
      else {
        i++;
        continue;
      }
      const n = /^\d+/.exec(s.slice(i));
      if (n) i += n[0].length;
      for (let k = 0; k < Math.min(n ? Number(n[0]) : 1, 99); k++) out.push(...item);
    }
    return out;
  };
  const out: string[] = [];
  while (i < s.length) {
    out.push(...seq());
    i++;
  }
  return out;
}

// ---- The music, as events per voice and measure

interface Pitch {
  step: string;
  octave: number;
  alter: number;
  /** An accidental written before it. */
  shown?: string;
  /** The note as written (accidental, letter, octave marks), for a drum map. */
  abc?: string;
}

/** %%MIDI and %%percmap settings, for the whole tune or one voice. */
interface MidiSettings {
  channel?: number;
  program?: number;
  /** Written note (see Pitch.abc) to General MIDI drum key, and its notehead. */
  drums: Map<string, number>;
  heads: Map<string, string>;
}

const newMidi = (): MidiSettings => ({ drums: new Map(), heads: new Map() });

/** A written ABC note as a drum-map key: accidental, letter and octave, whatever the bar says. */
function abcNoteKey(note: string): string | null {
  const m = /^(\^\^|\^|__|_|=)?([A-Ga-g])([',]*)$/.exec(note.trim());
  if (!m) return null;
  let octave = m[2] === m[2].toUpperCase() ? 4 : 5;
  for (const c of m[3]) octave += c === "'" ? 1 : -1;
  const alter = m[1] === "^" ? 1 : m[1] === "^^" ? 2 : m[1] === "_" ? -1 : m[1] === "__" ? -2 : 0;
  return `${alter}${m[2].toUpperCase()}${octave}`;
}

// General MIDI percussion keys 35-81, by the names %%percmap uses.
const GM_DRUMS = "acoustic-bass-drum bass-drum-1 side-stick acoustic-snare hand-clap electric-snare low-floor-tom closed-hi-hat high-floor-tom pedal-hi-hat low-tom open-hi-hat low-mid-tom hi-mid-tom crash-cymbal-1 high-tom ride-cymbal-1 chinese-cymbal ride-bell tambourine splash-cymbal cowbell crash-cymbal-2 vibraslap ride-cymbal-2 hi-bongo low-bongo mute-hi-conga open-hi-conga low-conga high-timbale low-timbale high-agogo low-agogo cabasa maracas short-whistle long-whistle short-guiro long-guiro claves hi-wood-block low-wood-block mute-cuica open-cuica mute-triangle open-triangle".split(" ");
const drumKey = (s: string): number | undefined => {
  if (/^\d+$/.test(s)) return Number(s);
  const k = GM_DRUMS.indexOf(s.toLowerCase());
  return k < 0 ? undefined : k + 35;
};
const drumName = (key: number) => (GM_DRUMS[key - 35] ?? `drum ${key}`).replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());
// Noteheads MusicXML knows, as %%percmap may name them.
const HEADS = new Set(["x", "circle-x", "triangle", "diamond", "slash", "square", "cross", "normal", "circle-dot", "left-triangle", "inverted triangle", "do", "re", "mi"]);

interface NoteEvent {
  kind: "note";
  pitches: Pitch[] | null;
  invisible?: boolean;
  /** A gap with nothing written (the start of an overlay begun mid-bar). */
  spacer?: boolean;
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
  lyrics?: { verse: number; text: string; syllabic: string }[];
  measureRest?: boolean;
}

type Before = { kind: "chord"; text: string } | { kind: "words"; text: string; below: boolean } | { kind: "dynamic"; value: string } | { kind: "wedge"; type: "crescendo" | "diminuendo" | "stop" };

interface Measure {
  events: NoteEvent[];
  /** Overlay voices (&) on the same staff, each from the start of the bar. */
  layers: NoteEvent[][];
  key?: Key;
  meter?: Meter;
  clef?: Clef;
  stafflines?: number;
  forward?: boolean;
  backward?: boolean;
  style?: string;
  ending?: { number: string; type: "start" | "stop" | "discontinue" }[];
  /** Directions after the last note (a hairpin's end at the bar line). */
  after: Before[];
}

/** An overlay being written: its layer, from which measure, and where it writes now. */
interface Overlay {
  layer: number;
  anchor: number;
  /** Quarters into the anchor measure where it starts. */
  offset: number;
  at: number;
  /** The (& ... &) form, ended by &) rather than by catching up with the voice. */
  multi: boolean;
  alters: Map<string, number>;
}

interface Voice {
  id: string;
  props: Props;
  /** The clef in force, for the octave a +8/-8 clef moves the notes by. */
  clefNow?: Clef;
  /** The staff lines in force (stafflines=). */
  linesNow: number;
  measures: Measure[];
  cur: Measure;
  barAlters: Map<string, number>;
  key: Key;
  /** Notes of the music line just read, with their bar, for its w: lyrics. */
  lineNotes: { ev: NoteEvent; bar: number }[];
  /** A new music line began: its first note of the voice's own starts new lineNotes. */
  freshLine: boolean;
  /** Lyric verse and position for +: continuation lines. */
  verse: number;
  lyricAt: number;
  /** Position of the s: symbol line being read, for its +: continuation. */
  symbolAt: number;
  openEnding: string | null;
  overlay: Overlay | null;
  /** Where a (& overlay starts. */
  overlayStart: { at: number; offset: number } | null;
}

/** A voice played on drums: the percussion clef, or MIDI channel 10. */
const isDrums = (v: Voice, midi: MidiSettings) => midi.channel === 10 || v.props.clef?.sign === "percussion" || v.clefNow?.sign === "percussion";

const newMeasure = (): Measure => ({ events: [], layers: [], after: [] });

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

/** A !decoration!: a mark on the note, a direction before it, or the end of a hairpin. */
function decoration(name: string): { mark?: string; dir?: Before; stop?: boolean } {
  if (DYNAMICS.has(name)) return { dir: { kind: "dynamic", value: name } };
  if (/^(crescendo|<)\($/.test(name)) return { dir: { kind: "wedge", type: "crescendo" } };
  if (/^(diminuendo|>)\($/.test(name)) return { dir: { kind: "wedge", type: "diminuendo" } };
  if (/^(crescendo|diminuendo|<|>)\)$/.test(name)) return { dir: { kind: "wedge", type: "stop" }, stop: true };
  return NAMED[name] ? { mark: NAMED[name] } : {};
}

/** A quoted string: a chord symbol, or an annotation (^_<>@ place it). */
function quoted(s: string): Before | null {
  const place = s[0];
  if (place && "^_<>@".includes(place)) return { kind: "words", text: decodeText(s.slice(1)), below: place === "_" };
  if (parseChord(s)) return { kind: "chord", text: s };
  return s.trim() ? { kind: "words", text: decodeText(s), below: false } : null;
}

// ---- Reading a tune

export function readAbc(text: string, opts: AbcOptions = {}): Document {
  const tunes = splitTunes(text);
  if (!tunes.length) throw new Error("No ABC tune (an X: line) in this file");
  const tune = tunes.find((t) => t.x === opts.tune) ?? tunes[0];
  // Directives (%%score) are kept; other comments are dropped.
  const lines = tune.text.split("\n").map((l) => (/^%%/.test(l) ? l : l.replace(/(^|[^\\])%.*$/, "$1")));

  let title = "";
  let composer = "";
  let meter = parseMeter("4/4");
  let headerMeter: Meter = meter;
  let meterSeen = false;
  let unit = 0;
  let tempo: Tempo | null = null;
  let key = parseKey("C");
  const voices = new Map<string, Voice>();
  const voiceDefs = new Map<string, Props>();
  let allVoices: Props = {};
  let layout: Layout | null = null;
  const userSymbols = new Map<string, string>();
  let partOrder: string[] = [];
  /** P: part letters in the body, by the measure they start. */
  const partAt = new Map<number, string>();
  let synced = 0;
  let current: Voice | null = null;
  let inBody = false;
  let lastField = "";
  let continued = false;
  const midiAll = newMidi();
  const midiVoice = new Map<string, MidiSettings>();
  let headerVoice: string | null = null;
  /** The settings in force for a voice: its own over the tune's. */
  const midiOf = (v: Voice): MidiSettings => {
    const own = midiVoice.get(v.id);
    return { channel: own?.channel ?? midiAll.channel, program: own?.program ?? midiAll.program, drums: new Map([...midiAll.drums, ...(own?.drums ?? [])]), heads: new Map([...midiAll.heads, ...(own?.heads ?? [])]) };
  };
  /** %%MIDI channel/program/drummap and %%percmap: for the voice being read, or the whole tune. */
  const midiDirective = (name: string, value: string) => {
    const target = inBody ? current?.id : headerVoice;
    const m = target ? (midiVoice.get(target) ?? midiVoice.set(target, newMidi()).get(target)!) : midiAll;
    const w = value.trim().split(/\s+/);
    if (name === "percmap") {
      const note = abcNoteKey(w[0] ?? "");
      const k = drumKey(w[1] ?? "");
      if (note && k !== undefined) m.drums.set(note, k);
      if (note && w[2] && HEADS.has(w[2])) m.heads.set(note, w[2]);
      return;
    }
    const nums = w.slice(1).map(Number);
    if (w[0] === "channel" && nums[0] >= 1 && nums[0] <= 16) m.channel = nums[0];
    else if (w[0] === "program" && w.length > 1) {
      // program [channel] number
      const prog = nums.length > 1 ? nums[1] : nums[0];
      if (prog >= 0 && prog <= 127) m.program = prog;
    } else if (w[0] === "drummap") {
      const note = abcNoteKey(w[1] ?? "");
      if (note && nums[1] >= 0 && nums[1] <= 127) m.drums.set(note, nums[1]);
    }
  };

  const voiceOf = (id: string): Voice => {
    let v = voices.get(id);
    if (!v) {
      const props = { ...key.props, ...allVoices, ...voiceDefs.get(id) };
      const clef = clefFrom(props);
      if (clef) props.clef = clef;
      v = { id, props, clefNow: clef, linesNow: props.stafflines ?? 5, measures: [], cur: newMeasure(), barAlters: new Map(), key, lineNotes: [], freshLine: true, verse: 0, lyricAt: 0, symbolAt: 0, openEnding: null, overlay: null, overlayStart: null };
      // A voice that starts after a %%score in the body starts there.
      while (v.measures.length < synced) v.measures.push(newMeasure());
      voices.set(id, v);
    }
    return v;
  };

  /** A clef, middle=, stafflines= or octave= change in the body, for the voice's current bar. */
  const change = (v: Voice, p: Props) => {
    const same = (a?: Clef, b?: Clef) => !!a && !!b && a.sign === b.sign && a.line === b.line && (a.octave ?? 0) === (b.octave ?? 0);
    const clef = clefFrom(p, v.clefNow);
    if (clef) {
      if (!same(clef, v.clefNow ?? CLEFS.treble)) v.cur.clef = clef;
      v.clefNow = clef;
    }
    if (p.stafflines !== undefined && p.stafflines !== v.linesNow) {
      v.linesNow = p.stafflines;
      v.cur.stafflines = p.stafflines;
    }
    if (p.octave !== undefined) v.props.octave = p.octave;
    if (p.stem) v.props.stem = p.stem;
  };

  const unitLength = () => unit || (meter && meter.quarters < 3 ? 0.0625 : 0.125);

  /** %%score or %%staves: the first sets the layout; later ones add their voices and bring all back in step. */
  const directive = (name: string, value: string) => {
    const next = parseScore(value, name === "staves");
    layout = layout ? mergeLayout(layout, next) : next;
    if (inBody) {
      synced = Math.max(0, ...[...voices.values()].map((v) => v.measures.length + (v.cur.events.length ? 1 : 0)));
      for (const v of voices.values()) {
        if (v.cur.events.length) closeMeasure(v, false);
        while (v.measures.length < synced) v.measures.push(newMeasure());
      }
    }
  };

  const field = (name: string, value: string): void => {
    switch (name) {
      case "T":
        if (!title) title = decodeText(value.trim());
        break;
      case "C":
        if (!composer) composer = decodeText(value.trim());
        break;
      case "M": {
        meter = parseMeter(value);
        meterSeen = true;
        if (inBody && current) current.cur.meter = meter;
        else if (!inBody) headerMeter = meter;
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
        if (!tempo && (bpm || words)) tempo = { bpm, text: words, unit: one?.[0] ?? "quarter", dots: one?.[1] ?? 0, per: one ? bpm / one[2] : bpm };
        break;
      }
      case "K": {
        const k = parseKey(value);
        if (!inBody) {
          if (!k.none) key = k;
          else key = { ...key, props: { ...key.props, ...k.props } };
          inBody = true;
          if (!meterSeen) meter = meter ?? parseMeter("4/4");
          headerMeter = meter;
          return;
        }
        if (!current && !voices.size) {
          // A K: before any music: still the tune's key.
          key = k.none ? { ...key, props: { ...key.props, ...k.props } } : k;
          return;
        }
        current ??= voiceOf(voiceDefs.keys().next().value ?? "1");
        if (!k.none) {
          current.key = k;
          current.cur.key = k;
        }
        change(current, k.props);
        break;
      }
      case "V": {
        const m = /^\s*(\S+)(.*)$/.exec(value);
        if (!m) break;
        const props = propsOf(m[2]);
        if (m[1] === "*") {
          allVoices = { ...allVoices, ...props };
          break;
        }
        voiceDefs.set(m[1], { ...voiceDefs.get(m[1]), ...props });
        if (!inBody) headerVoice = m[1];
        if (inBody) {
          const known = voices.has(m[1]);
          current = voiceOf(m[1]);
          if (known) change(current, props);
        }
        break;
      }
      case "P": {
        const label = value.trim();
        if (!inBody) partOrder = playOrderOf(label);
        else {
          const letter = /^([A-Za-z])\b/.exec(label)?.[1];
          const v = current;
          if (letter) partAt.set(v ? v.measures.length + (v.cur.events.length ? 1 : 0) : 0, letter);
        }
        break;
      }
      case "U": {
        const u = /^\s*(\S)\s*=\s*[!+]?([^!+\s]+)[!+]?/.exec(value);
        if (u) userSymbols.set(u[1], u[2]);
        break;
      }
      case "I": {
        const d = /^\s*(score|staves)\s+(.*)$/.exec(value);
        if (d) directive(d[1], d[2]);
        const md = /^\s*(MIDI|percmap)\s+(.*)$/.exec(value);
        if (md) midiDirective(md[1], md[2]);
        break;
      }
    }
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    const dir = /^%%\s*(score|staves)\b(.*)$/.exec(line);
    if (dir) {
      directive(dir[1], dir[2]);
      continue;
    }
    const md = /^%%\s*(MIDI|percmap)\s+(.*)$/.exec(line);
    if (md) {
      midiDirective(md[1], md[2]);
      continue;
    }
    if (/^%%/.test(line)) continue;
    const f = /^([A-Za-z+]):(.*)$/.exec(line);
    if (f && !(inBody && /^[|:[\]]/.test(line))) {
      if (f[1] === "+") {
        if (lastField === "w" && inBody && current) lyrics(current, f[2].replace(/\\$/, ""), true);
        else if (lastField === "s" && inBody && current) symbols(current, f[2].replace(/\\$/, ""), true);
        continue;
      }
      if (f[1] === "w" && inBody && current) lyrics(current, f[2].replace(/\\$/, ""), false);
      else if (f[1] === "s" && inBody && current) symbols(current, f[2].replace(/\\$/, ""), false);
      else if (f[1] !== "W") field(f[1], f[2]);
      lastField = f[1];
      continue;
    }
    if (!inBody || !line.trim()) continue;
    lastField = "";
    current ??= voiceOf(voiceDefs.keys().next().value ?? "1");
    // A line ending in \ goes on with the next: one music line for its w: lyrics.
    if (!continued) current.freshLine = true;
    continued = /\\$/.test(line);
    music(current, line, field);
  }
  for (const v of voices.values()) closeMeasure(v, true);
  const order = [...new Set([...voiceDefs.keys(), ...voices.keys()])].map((id) => voices.get(id)).filter((v): v is Voice => !!v && v.measures.length > 0);
  if (!order.length) order.push(voiceOf("1"));
  // A one-letter header P: is a label, not an order; the order needs parts marked in the body.
  const play = partOrder.length > 1 && partAt.size ? partOrder : [];
  return build({ title, composer, tempo, key, meter: headerMeter, plan: planParts(order, layout), parts: partAt, play, midiOf });

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
      const abc = `${m[1] === "^" ? 1 : m[1] === "^^" ? 2 : m[1] === "_" ? -1 : m[1] === "__" ? -2 : 0}${step}${octave}`;
      const where = `${step}${octave}`;
      const alters = v.overlay ? v.overlay.alters : v.barAlters;
      let alter: number;
      let shown: string | undefined;
      if (m[1]) {
        alter = m[1] === "^" ? 1 : m[1] === "^^" ? 2 : m[1] === "_" ? -1 : m[1] === "__" ? -2 : 0;
        shown = ({ 1: "sharp", 2: "double-sharp", [-1]: "flat", [-2]: "flat-flat", 0: "natural" } as Record<number, string>)[alter];
        alters.set(where, alter);
      } else alter = alters.get(where) ?? v.key.alters[step] ?? 0;
      // octave= and a +8/-8 clef move the notes (MusicXML pitches are as heard).
      octave += (v.props.octave ?? 0) + (v.clefNow?.octave ?? 0) + (v.clefNow?.shift ?? 0);
      return { step, octave, alter, shown, abc };
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
      if (v.overlay) overlayEvents(v).push(full);
      else {
        v.cur.events.push(full);
        // Lyrics go to the voice's own notes, not to an overlay.
        if (v.freshLine) {
          v.lineNotes = [];
          v.verse = 0;
          v.freshLine = false;
        }
        if (full.pitches && !ev.measureRest) v.lineNotes.push({ ev: full, bar: v.measures.length });
      }
      lastEvent = full;
      return full;
    };
    const unitQ = () => unitLength() * 4;
    const bar = (b: { backward: boolean; forward: boolean; style: string }) => {
      joined = false;
      if (barInOverlay(v)) return;
      endBar(v, b);
    };

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
          current!.freshLine = true;
          return music(current!, text.slice(i), onField);
        }
        onField(inline[1], inline[2]);
        continue;
      }
      // Voice overlay: & within a bar, (& ... & ... &) over several.
      if (rest.startsWith("(&")) {
        i += 2;
        v.overlayStart = { at: v.measures.length, offset: total(v.cur.events) };
        continue;
      }
      if (rest.startsWith("&)")) {
        i += 2;
        v.overlay = null;
        v.overlayStart = null;
        lastEvent = null;
        joined = false;
        continue;
      }
      if (c === "&") {
        let n = 0;
        while (text[i] === "&") {
          n++;
          i++;
        }
        startOverlay(v, n);
        lastEvent = null;
        joined = false;
        broken = 0;
        tuplet = null;
        continue;
      }
      // Bar lines, repeats and endings.
      const barM = /^(:*)(\[\||\|\]|\|\||\|)(:*)\s*(\[?\d+(?:[-,]\d+)*)?/.exec(rest) ?? /^(::)()()/.exec(rest);
      if (barM && (barM[2] || barM[1] === "::")) {
        i += barM[0].length;
        const backward = barM[1].length > 0;
        const forward = barM[3].length > 0 || barM[1] === "::";
        const style = barM[2] === "|]" ? "light-heavy" : barM[2] === "||" ? "light-light" : barM[2] === "[|" ? "heavy-light" : "";
        const inOverlay = !!v.overlay;
        bar({ backward, forward, style });
        if (barM[4] && !inOverlay) startEnding(v, barM[4].replace("[", ""));
        continue;
      }
      const ending = /^\[(\d+(?:[-,]\d+)*)/.exec(rest);
      if (ending) {
        i += ending[0].length;
        if (!v.overlay) startEnding(v, ending[1]);
        continue;
      }
      if (c === '"') {
        const end = text.indexOf('"', i + 1);
        const s = text.slice(i + 1, end < 0 ? undefined : end);
        i = end < 0 ? text.length : end + 1;
        const q = quoted(s);
        if (q) pendingBefore.push(q);
        continue;
      }
      const deco = /^[!+]([^!+\s]+)[!+]/.exec(rest);
      // U: user symbols (U:T=!trill!) stand for a decoration.
      const user = !deco && /[H-Wh-w~]/.test(c) ? userSymbols.get(c) : undefined;
      if (deco || user) {
        i += deco ? deco[0].length : 1;
        const d = decoration(deco ? deco[1] : user!);
        if (d.stop) (lastEvent && !v.overlay ? v.cur.after : pendingBefore).push(d.dir!);
        else if (d.dir) pendingBefore.push(d.dir);
        else if (d.mark) pendingDecos.push(d.mark);
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
        let tied = false;
        while (i < end) {
          const p = readPitch();
          if (!p) {
            i++;
            continue;
          }
          const len = readLength();
          if (!pitches.length) first = len;
          pitches.push(p);
          while (text[i] === "-") {
            tied = true;
            i++;
          }
        }
        i = end + 1;
        const outer = readLength();
        if (!pitches.length) {
          i = saved + 1;
          continue;
        }
        add({ kind: "note", pitches, quarters: (first || 1) * outer * unitQ(), tie: tied, slurStop: 0 }, 1);
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
          if (b > 0) bar({ backward: false, forward: false, style: "" });
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
      // y (spacing), stray characters: skipped.
      i++;
    }
  }

  function measureAt(v: Voice, at: number): Measure {
    return at < v.measures.length ? v.measures[at] : v.cur;
  }

  /** & (n of them in a row): the notes after it overlay the bar(s) just written. */
  function startOverlay(v: Voice, n: number): void {
    const o = v.overlay;
    if (v.overlayStart) {
      const s = v.overlayStart;
      v.overlay = { layer: (o?.layer ?? 0) + 1, anchor: s.at, offset: s.offset, at: s.at, multi: true, alters: new Map() };
    } else if (o) v.overlay = { ...o, layer: o.layer + 1, at: o.anchor, alters: new Map() };
    else {
      // Each & sets the time back one bar line; right after a bar line that is the bar before.
      const back = v.cur.events.length ? n - 1 : n;
      const at = Math.max(0, v.measures.length - back);
      v.overlay = { layer: measureAt(v, at).layers.length + 1, anchor: at, offset: 0, at, multi: false, alters: new Map() };
    }
  }

  function overlayEvents(v: Voice): NoteEvent[] {
    const o = v.overlay!;
    const m = measureAt(v, o.at);
    while (m.layers.length < o.layer) m.layers.push([]);
    const layer = m.layers[o.layer - 1];
    if (!layer.length && o.at === o.anchor && o.offset > 1e-9) layer.push({ kind: "note", pitches: null, spacer: true, quarters: o.offset, tie: false, slurStart: 0, slurStop: 0, decorations: [], graces: [], before: [], joined: false });
    return layer;
  }

  /** A bar line met while writing an overlay: true when the overlay goes on past it. */
  function barInOverlay(v: Voice): boolean {
    const o = v.overlay;
    if (!o) return false;
    if (o.multi) {
      o.at++;
      o.alters.clear();
      return true;
    }
    // The overlay of the bar being written ends with it.
    if (o.at >= v.measures.length) {
      v.overlay = null;
      return false;
    }
    o.at++;
    o.alters.clear();
    if (o.at >= v.measures.length && !v.cur.events.length) v.overlay = null;
    return true;
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
    if (v.cur.events.length || v.cur.layers.length || (last && (v.cur.after.length || v.cur.ending?.length))) {
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
    if (last) v.overlay = null;
    v.barAlters.clear();
  }

  /** The notes of the music line before a w: or s: line: those tied from the one before take none. */
  function alignable(v: Voice): Voice["lineNotes"] {
    return v.lineNotes.filter((_n, k, all) => !(k > 0 && all[k - 1].ev.tie));
  }

  /** The note after a | in a w: or s: line: the first of the next bar. */
  function nextBar(notes: Voice["lineNotes"], at: number): number {
    const bar = notes[at - 1]?.bar;
    if (bar !== undefined) while (at < notes.length && notes[at].bar === bar) at++;
    return at;
  }

  /** An s: symbol line (or its +: continuation): decorations and texts to notes, as w: aligns syllables. */
  function symbols(v: Voice, line: string, more: boolean): void {
    const notes = alignable(v);
    let at = more ? v.symbolAt : 0;
    let open = false; // the note at "at" has a symbol
    const done = () => {
      if (open) at++;
      open = false;
    };
    for (let k = 0; k < line.length; ) {
      const ch = line[k];
      const rest = line.slice(k);
      const deco = /^[!+]([^!+]*)[!+]/.exec(rest);
      const text = /^"([^"]*)"?/.exec(rest);
      if (deco || text) {
        k += (deco ?? text)![0].length;
        const n = notes[at]?.ev;
        open = true;
        if (!n) continue;
        if (deco) {
          const d = decoration(deco[1]);
          if (d.dir) n.before.push(d.dir);
          else if (d.mark) n.decorations.push(d.mark);
        } else {
          const q = quoted(text![1]);
          if (q) n.before.push(q);
        }
        continue;
      }
      k++;
      if (ch === "*") {
        done();
        at++;
      } else if (ch === "|") {
        done();
        at = nextBar(notes, at);
      } else if (ch === " " || ch === "\t") done();
    }
    done();
    v.symbolAt = at;
  }

  /** A w: line (or its +: continuation): syllables to the notes of the music line before it. */
  function lyrics(v: Voice, words: string, more: boolean): void {
    const notes = alignable(v);
    if (!more) {
      v.verse++;
      v.lyricAt = 0;
    }
    let at = v.lyricAt;
    const syllables: { text: string; at: number; hyphen: boolean }[] = [];
    let cur = "";
    const flush = (hyphen: boolean) => {
      if (cur) {
        syllables.push({ text: cur, at: at++, hyphen });
        cur = "";
        return true;
      }
      return false;
    };
    for (let k = 0; k < words.length; k++) {
      const ch = words[k];
      if (ch === "\\" && words[k + 1] === "-") {
        cur += "-";
        k++;
      } else if (ch === "-") {
        // A hyphen after a space or a hyphen is a syllable of its own: the word goes on over a note.
        if (!flush(true)) {
          if (syllables.length) syllables[syllables.length - 1].hyphen = true;
          at++;
        }
      } else if (ch === " " || ch === "\t") flush(false);
      else if (ch === "_" || ch === "*") {
        if (cur) flush(false);
        at++;
      } else if (ch === "|") {
        flush(false);
        at = nextBar(notes, at);
      } else if (ch === "~") cur += " ";
      else cur += ch;
    }
    flush(false);
    v.lyricAt = at;
    syllables.forEach((s, k) => {
      const before = k > 0 && syllables[k - 1].hyphen;
      const syllabic = before ? (s.hyphen ? "middle" : "end") : s.hyphen ? "begin" : "single";
      const n = notes[s.at];
      if (n) (n.ev.lyrics ??= []).push({ verse: v.verse, text: decodeText(s.text), syllabic });
    });
  }
}

// ---- Staves and parts

interface Plan {
  /** Each part: its staves, each with its voices (two on a staff are MusicXML voices 1 and 2). */
  parts: Voice[][][];
  /** Brackets and braces over parts. */
  groups: { kind: "brace" | "bracket"; first: number; last: number; barline: boolean }[];
}

/** The parts for the voices: one each, or as %%score groups them (a brace is one part with its staves). */
function planParts(order: Voice[], layout: Layout | null): Plan {
  const byId = new Map(order.map((v) => [v.id, v]));
  if (layout) {
    const used = new Set<string>();
    const staves: Voice[][] = [];
    const kept: number[] = [];
    for (const s of layout.staves) {
      const vs = s.filter((id) => byId.has(id) && !used.has(id)).map((id) => (used.add(id), byId.get(id)!));
      kept.push(vs.length ? staves.length : -1);
      if (vs.length) staves.push(vs);
    }
    if (staves.length) {
      const groups = layout.groups
        .map((g) => {
          const ks = kept.slice(g.first, g.last + 1).filter((k) => k >= 0);
          return ks.length ? { ...g, first: ks[0], last: ks[ks.length - 1] } : null;
        })
        .filter((g): g is NonNullable<typeof g> => !!g);
      // A brace over two or more staves, with no group inside and one name at most, is one part (a piano).
      const names = (g: { first: number; last: number }) => new Set(staves.slice(g.first, g.last + 1).flatMap((vs) => vs.map((v) => v.props.name).filter((x) => x)));
      const merged = groups.filter((g) => g.kind === "brace" && g.last > g.first && names(g).size <= 1 && !groups.some((o) => o !== g && o.first >= g.first && o.last <= g.last));
      const parts: Voice[][][] = [];
      const partOf: number[] = [];
      for (let s = 0; s < staves.length; s++) {
        const brace = merged.find((g) => g.first === s);
        if (brace) {
          for (let k = brace.first; k <= brace.last; k++) partOf.push(parts.length);
          parts.push(staves.slice(brace.first, brace.last + 1));
          s = brace.last;
        } else {
          partOf.push(parts.length);
          parts.push([staves[s]]);
        }
      }
      const outer = groups.filter((g) => !merged.includes(g)).map((g) => ({ ...g, first: partOf[g.first], last: partOf[g.last] }));
      return { parts, groups: outer };
    }
  }
  return { parts: order.map((v) => [[v]]), groups: [] };
}

// ---- MusicXML

function build(o: { title: string; composer: string; tempo: Tempo | null; key: Key; meter: Meter; plan: Plan; parts: Map<number, string>; play: string[]; midiOf: (v: Voice) => MidiSettings }): Document {
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
  if (o.composer || o.play.length) {
    const id = el(root, "identification");
    if (o.composer) el(id, "creator", o.composer, { type: "composer" });
    // The P: play order, read by the player with the rehearsal marks of the parts.
    if (o.play.length) el(el(id, "miscellaneous"), "miscellaneous-field", o.play.join(" "), { name: "play-order" });
  }
  const list = el(root, "part-list");
  /** Per part, how a voice's notes name their drum (null: pitched). */
  const instruments = new Map<number, (v: Voice) => ((p: Pitch) => { id: string; head?: string }) | null>();
  const all = o.plan.parts.flat(2);
  const count = Math.max(1, ...all.map((v) => v.measures.length));
  const lead = all[0];
  const pickup = !!o.meter && !!lead.measures[0]?.events.length && total(lead.measures[0].events) < o.meter.quarters - 1e-6;
  let groupNo = 0;
  const groupOpen = new Map<number, number>();
  // Outer groups open first and close last.
  const groups = [...o.plan.groups].sort((a, b) => a.first - b.first || b.last - a.last);
  o.plan.parts.forEach((staves, n) => {
    const id = `P${n + 1}`;
    groups.forEach((g, k) => {
      if (g.first !== n) return;
      groupOpen.set(k, ++groupNo);
      const pg = el(list, "part-group", null, { type: "start", number: groupNo });
      el(pg, "group-symbol", g.kind);
      el(pg, "group-barline", g.barline ? "yes" : "no");
    });
    const voices = staves.flat();
    const sp = el(list, "score-part", null, { id });
    const named = voices.find((v) => v.props.name);
    el(sp, "part-name", named?.props.name ?? (o.plan.parts.length > 1 ? `Voice ${voices[0].id}` : ""));
    const sub = voices.find((v) => v.props.subname)?.props.subname;
    if (sub) el(sp, "part-abbreviation", sub);
    instruments.set(n, writeInstruments(sp, id, voices));
    for (let k = groups.length - 1; k >= 0; k--) if (groups[k].last === n) el(list, "part-group", null, { type: "stop", number: groupOpen.get(k) ?? 1 });
    writePart(el(root, "part", null, { id }), staves, n);
  });
  return doc;

  /** The part's instruments: one per drum its percussion voices play, or its MIDI program. */
  function writeInstruments(sp: Element, id: string, voices: Voice[]) {
    const drumsOf = new Map<Voice, MidiSettings>();
    for (const v of voices) {
      const m = o.midiOf(v);
      if (isDrums(v, m)) drumsOf.set(v, m);
    }
    const keyOf = (m: MidiSettings, p: Pitch) => m.drums.get(p.abc ?? "") ?? Math.max(0, Math.min(127, 12 * (p.octave + 1) + "C D EF G A B".indexOf(p.step) + p.alter));
    const used = new Set<number>();
    for (const [v, m] of drumsOf) for (const ms of v.measures) for (const ev of [...ms.events, ...ms.layers.flat()]) for (const p of [...(ev.pitches ?? []), ...ev.graces.flatMap((g) => g.pitches ?? [])]) used.add(keyOf(m, p));
    const keys = [...used].sort((a, b) => a - b);
    const iid = (k: number) => `${id}-I${k + 1}`;
    for (const k of keys) el(el(sp, "score-instrument", null, { id: iid(k) }), "instrument-name", drumName(k));
    for (const k of keys) {
      const mi = el(sp, "midi-instrument", null, { id: iid(k) });
      el(mi, "midi-channel", 10);
      el(mi, "midi-unpitched", k + 1);
    }
    const pitched = voices.find((v) => !drumsOf.has(v));
    const program = pitched ? o.midiOf(pitched).program : undefined;
    if (!keys.length && program !== undefined) {
      el(el(sp, "score-instrument", null, { id: `${id}-I1` }), "instrument-name", sp.querySelector("part-name")?.textContent || "Instrument");
      const mi = el(sp, "midi-instrument", null, { id: `${id}-I1` });
      el(mi, "midi-program", program + 1);
    }
    return (v: Voice) => {
      const m = drumsOf.get(v);
      if (!m) return null;
      return (p: Pitch) => ({ id: iid(keyOf(m, p)), head: m.heads.get(p.abc ?? "") });
    };
  }

  function writePart(part: Element, staves: Voice[][], n: number): void {
    const head = staves[0][0];
    const many = staves.length > 1;
    // MusicXML voice numbers: 1-4 on the first staff, 5-8 on the second..., overlays after their voice.
    const numbers = new Map<Voice, number[]>();
    staves.forEach((vs, s) => {
      let next = s * 4 + 1;
      for (const v of vs) {
        const layers = 1 + Math.max(0, ...v.measures.map((m) => m.layers.length));
        numbers.set(v, Array.from({ length: layers }, (_, k) => next + k));
        next += layers;
      }
    });
    let key = o.key;
    let meter = o.meter;
    const tieOpen = new Map<number, Pitch[]>();
    // Staff lines in force per voice, for where drum notes are drawn.
    const linesNow = new Map(staves.flat().map((v) => [v, v.props.stafflines ?? 5] as const));
    for (let m = 0; m < count; m++) {
      const at = (v: Voice) => v.measures[m] ?? newMeasure();
      for (const v of linesNow.keys()) if (at(v).stafflines !== undefined) linesNow.set(v, at(v).stafflines!);
      const src = at(head);
      const meas = el(part, "measure", null, pickup && m === 0 ? { number: 0, implicit: "yes" } : { number: pickup ? m : m + 1 });
      if (src.forward || src.ending?.some((e) => e.type === "start")) {
        const bl = el(meas, "barline", null, { location: "left" });
        for (const e of src.ending?.filter((x) => x.type === "start") ?? []) el(bl, "ending", null, { number: e.number, type: "start" });
        if (src.forward) el(bl, "repeat", null, { direction: "forward" });
      }
      const partVoices = staves.flat();
      const newKey = partVoices.map((v) => at(v).key).find((k) => k);
      const newMeter = partVoices.map((v) => at(v).meter).find((x) => x !== undefined);
      const clefs = staves.map((vs) => {
        const c = vs.map((v) => at(v).clef).find((x) => x);
        return c ?? (m === 0 ? (vs[0].props.clef ?? CLEFS.treble) : undefined);
      });
      const lines = staves.map((vs) => {
        const n = vs.map((v) => at(v).stafflines).find((x) => x !== undefined);
        return n ?? (m === 0 && (vs[0].props.stafflines ?? 5) !== 5 ? vs[0].props.stafflines : undefined);
      });
      if (m === 0 || newKey || newMeter !== undefined || clefs.some((c) => c) || lines.some((x) => x !== undefined)) {
        const attrs = el(meas, "attributes");
        if (m === 0) el(attrs, "divisions", DIV);
        if (newKey) key = newKey;
        if (m === 0 || newKey) el(el(attrs, "key"), "fifths", key.fifths);
        if (newMeter !== undefined) meter = newMeter;
        if ((m === 0 || newMeter !== undefined) && meter) {
          const t = el(attrs, "time", null, meter.symbol ? { symbol: meter.symbol } : undefined);
          el(t, "beats", meter.beats);
          el(t, "beat-type", meter.type);
        }
        if (m === 0 && many) el(attrs, "staves", staves.length);
        clefs.forEach((clef, s) => {
          if (!clef) return;
          const c = el(attrs, "clef", null, many ? { number: s + 1 } : undefined);
          el(c, "sign", clef.sign);
          el(c, "line", clef.line);
          if (clef.octave) el(c, "clef-octave-change", clef.octave);
        });
        lines.forEach((n, s) => {
          if (n !== undefined) el(el(attrs, "staff-details", null, many ? { number: s + 1 } : undefined), "staff-lines", n);
        });
        const tr = head.props.transpose;
        if (m === 0 && tr) {
          const t = el(attrs, "transpose");
          const oct = Math.trunc(tr / 12);
          el(t, "diatonic", Math.round(((tr - oct * 12) * 7) / 12));
          el(t, "chromatic", tr - oct * 12);
          if (oct) el(t, "octave-change", oct);
        }
        if (!attrs.firstChild) attrs.remove();
      }
      const partLabel = o.parts.get(m);
      if (n === 0 && partLabel) el(el(el(meas, "direction", null, { placement: "above" }), "direction-type"), "rehearsal", partLabel);
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
      // Every voice and overlay of the bar, staff by staff, with a backup between them.
      let pos = 0;
      staves.forEach((vs, s) => {
        const layers: { v: Voice; voice: number; events: NoteEvent[] }[] = [];
        vs.forEach((v, j) => {
          const bar = at(v);
          numbers.get(v)!.forEach((voice, k) => {
            let events = k === 0 ? bar.events : (bar.layers[k - 1] ?? []);
            // An empty bar: a whole-bar rest for the staff's first voice, nothing for the others.
            if (!events.length && k === 0 && j === 0) events = [{ kind: "note", pitches: null, quarters: meter?.quarters ?? 4, tie: false, slurStart: 0, slurStop: 0, decorations: [], graces: [], before: [], joined: false, measureRest: true }];
            if (events.length) layers.push({ v, voice, events });
          });
        });
        // Two voices or more on the staff: stems up for the first, down for the others.
        const sounding = layers.filter((l) => l.events.some((e) => e.pitches));
        layers.forEach((l) => {
          const stem = l.v.props.stem ?? (sounding.length > 1 ? (l === sounding[0] ? "up" : "down") : undefined);
          if (pos > 0) el(el(meas, "backup"), "duration", pos);
          pos = 0;
          const beams = beamsOf(l.events);
          const where = { voice: l.voice, staff: many ? s + 1 : 0, stem, drum: instruments.get(n)?.(l.v) ?? undefined, lines: linesNow.get(l.v) ?? 5 };
          l.events.forEach((ev, k) => {
            if (ev.spacer) {
              const fw = el(meas, "forward");
              const d = Math.round(ev.quarters * DIV);
              el(fw, "duration", d);
              el(fw, "voice", l.voice);
              if (where.staff) el(fw, "staff", where.staff);
              pos += d;
              return;
            }
            for (const b of ev.before) direction(meas, b, where.staff);
            for (const g of ev.graces) note(meas, { ...ev, pitches: g.pitches, quarters: g.quarters, tie: false, slurStart: 0, slurStop: 0, decorations: [], tuplet: undefined, lyrics: undefined }, true, g.slash, null, [], where);
            const r = note(meas, ev, false, false, beams[k], tieOpen.get(l.voice) ?? [], where);
            tieOpen.set(l.voice, r.tied);
            pos += r.duration;
          });
          if (l.v === head && l.voice === numbers.get(head)![0]) for (const b of at(head).after) direction(meas, b, where.staff);
        });
      });
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
  }

  function direction(meas: Element, b: Before, staff: number): void {
    if (b.kind === "chord") {
      const c = parseChord(b.text);
      if (c) meas.appendChild(makeHarmony(doc, c, staff || undefined));
      return;
    }
    const dir = el(meas, "direction", null, { placement: b.kind === "words" && !b.below ? "above" : "below" });
    const dt = el(dir, "direction-type");
    if (b.kind === "words") el(dt, "words", b.text);
    else if (b.kind === "dynamic") {
      el(el(dt, "dynamics"), b.value);
    } else el(dt, "wedge", null, { type: b.type });
    if (staff) el(dir, "staff", staff);
  }

  /** One note (or chord, or rest); returns the pitches tied on to the next one and its duration. */
  function note(meas: Element, ev: NoteEvent, grace: boolean, slash: boolean, beam: string[] | null, tiedIn: Pitch[], where: { voice: number; staff: number; stem?: string; drum?: (p: Pitch) => { id: string; head?: string }; lines?: number }): { tied: Pitch[]; duration: number } {
    const ratio = ev.tuplet ? ev.tuplet.p / ev.tuplet.q : 1;
    const written = ev.quarters * ratio;
    const pieces = grace ? [splitValue(written)[0]] : ev.measureRest ? [["whole", 0, written] as [string, number, number]] : splitValue(written);
    const out: Pitch[] = [];
    let duration = 0;
    pieces.forEach(([type, dots, q], pi) => {
      const firstPiece = pi === 0;
      const lastPiece = pi === pieces.length - 1;
      const d = Math.round((q / ratio) * DIV);
      if (!grace) duration += d;
      (ev.pitches ?? [null]).forEach((p, ci) => {
        const n = el(meas, "note", null, ev.invisible ? { "print-object": "no" } : undefined);
        if (grace) el(n, "grace", null, slash ? { slash: "yes" } : undefined);
        if (ci > 0) el(n, "chord");
        if (!p) el(n, "rest", null, ev.measureRest ? { measure: "yes" } : undefined);
        else if (where.drum) {
          // A drum: drawn where it is written, played by its instrument. ABC centres a staff of
          // fewer lines on the middle line; MusicXML builds it up from the bottom line (E4).
          const at = p.octave * 7 + "CDEFGAB".indexOf(p.step) + (where.lines ?? 5) - 5;
          const u = el(n, "unpitched");
          el(u, "display-step", "CDEFGAB"[((at % 7) + 7) % 7]);
          el(u, "display-octave", Math.floor(at / 7));
        } else {
          const pitch = el(n, "pitch");
          el(pitch, "step", p.step);
          if (p.alter) el(pitch, "alter", p.alter);
          el(pitch, "octave", p.octave);
        }
        if (!grace) el(n, "duration", d);
        const tiedFrom = !!p && (firstPiece ? tiedIn.some((t) => t.step === p.step && t.octave === p.octave) : true);
        const tiedOn = !!p && (!lastPiece || ev.tie);
        if (tiedFrom) el(n, "tie", null, { type: "stop" });
        if (tiedOn) el(n, "tie", null, { type: "start" });
        const drum = p && where.drum ? where.drum(p) : null;
        if (drum) el(n, "instrument", null, { id: drum.id });
        el(n, "voice", where.voice);
        if (!ev.measureRest) el(n, "type", type);
        for (let dd = 0; dd < dots; dd++) el(n, "dot");
        if (p?.shown && firstPiece && !drum) el(n, "accidental", p.shown);
        if (ev.tuplet && !grace) {
          const tm = el(n, "time-modification");
          el(tm, "actual-notes", ev.tuplet.p);
          el(tm, "normal-notes", ev.tuplet.q);
        }
        if (p && where.stem) el(n, "stem", where.stem);
        if (drum?.head) el(n, "notehead", drum.head);
        if (where.staff) el(n, "staff", where.staff);
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
          if (firstPiece) marks(nt, ev.decorations, where.stem === "down");
        }
        if (ci === 0 && firstPiece && ev.lyrics && !grace) {
          for (const l of ev.lyrics) {
            const ly = el(n, "lyric", null, { number: l.verse });
            el(ly, "syllabic", l.syllabic);
            el(ly, "text", l.text);
          }
        }
        if (lastPiece && tiedOn && p) out.push(p);
      });
    });
    return { tied: out, duration };
  }

  function marks(nt: () => Element, decos: string[], below: boolean): void {
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
    // A lower voice (stems down) has its fermata below.
    if (decos.includes("fermata")) el(nt(), "fermata", null, { type: below ? "inverted" : "upright" });
    if (decos.includes("arpeggiate")) el(nt(), "arpeggiate");
  }
}

const total = (events: NoteEvent[]) => events.reduce((s, e) => s + e.quarters, 0);

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
