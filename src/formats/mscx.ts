import { strFromU8, unzipSync } from "fflate";
import { kidIndexed as kid, kids, parseXml } from "../model/xml";

// A chord or note's children by tag, read in one pass.
const NO_GROUPS = new Map<string, Element[]>();
const groups = (e: Element): Map<string, Element[]> => {
  const g = new Map<string, Element[]>();
  for (let c = e.firstElementChild; c; c = c.nextElementSibling) {
    const l = g.get(c.tagName);
    if (l) l.push(c);
    else g.set(c.tagName, [c]);
  }
  return g;
};
const gone = (g: Map<string, Element[]>, tag: string): Element | null => g.get(tag)?.[0] ?? null;
const gall = (g: Map<string, Element[]>, tag: string): Element[] => g.get(tag) ?? [];
const gtext = (g: Map<string, Element[]>, tag: string): string => g.get(tag)?.[0].textContent?.trim() ?? "";
const GRACES = ["acciaccatura", "appoggiatura", "grace4", "grace8after", "grace16", "grace16after", "grace32", "grace32after"];

// The reader asks the same elements for many children: indexed lookups.
const text = (el: Element | null | undefined, tag?: string): string => {
  const e = el && tag ? kid(el, tag) : el;
  return e?.textContent?.trim() ?? "";
};

// MuseScore's .mscx (and the .mscz zip around it) read into MusicXML, versions 3 and 4.
// Learned from MuseScore files and MuseScore's own MusicXML export of the same scores; the
// format has no published spec.

/** Divisions per quarter note: exact for tuplets of 3, 5, 7 and 9 down to 128ths. */
const DIV = 10080;

const DURATION: Record<string, number> = { long: 16, breve: 8, whole: 4, half: 2, quarter: 1, eighth: 0.5, "16th": 0.25, "32nd": 0.125, "64th": 1 / 16, "128th": 1 / 32, "256th": 1 / 64 };
const TYPE_NAME: Record<string, string> = { long: "long", breve: "breve", whole: "whole", half: "half", quarter: "quarter", eighth: "eighth", "16th": "16th", "32nd": "32nd", "64th": "64th", "128th": "128th", "256th": "256th" };
const ATTR_ORDER = ["divisions", "key", "time", "staves", "part-symbol", "instruments", "clef", "staff-details", "transpose"];
/** MuseScore 2 lines written as their own element with an id. */
const MS2_LINES = new Set(["HairPin", "Ottava", "Pedal", "Trill", "Volta"]);
const SEMIS: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const ACCIDENTAL: Record<string, string> = {
  accidentalSharp: "sharp",
  accidentalFlat: "flat",
  accidentalNatural: "natural",
  accidentalDoubleSharp: "double-sharp",
  accidentalDoubleFlat: "flat-flat",
};
const ARTIC: Record<string, string> = {
  articStaccatoAbove: "staccato",
  articStaccatoBelow: "staccato",
  articStaccatissimoAbove: "staccatissimo",
  articStaccatissimoBelow: "staccatissimo",
  articAccentAbove: "accent",
  articAccentBelow: "accent",
  articTenutoAbove: "tenuto",
  articTenutoBelow: "tenuto",
  articMarcatoAbove: "strong-accent",
  articMarcatoBelow: "strong-accent",
  articStaccatissimoStrokeAbove: "spiccato",
  articStaccatissimoStrokeBelow: "spiccato",
  articStressAbove: "stress",
  articStressBelow: "stress",
  articUnstressAbove: "unstress",
  articUnstressBelow: "unstress",
  articSoftAccentAbove: "soft-accent",
  articSoftAccentBelow: "soft-accent",
};
const ORNAMENT: Record<string, string> = {
  ornamentTrill: "trill-mark",
  ornamentTurn: "turn",
  ornamentTurnInverted: "inverted-turn",
  ornamentMordent: "mordent",
  ornamentShortTrill: "inverted-mordent",
  ornamentTremblement: "inverted-mordent",
  ornamentTurnUp: "vertical-turn",
  ornamentTurnUpS: "inverted-vertical-turn",
  ornamentTremblementCouperin: "shake",
  ornamentPrecompSlide: "schleifer",
  ornamentHaydn: "haydn",
};
// Two marks drawn as one.
const ARTIC_PAIRS: Record<string, string[]> = { articTenutoStaccatoAbove: ["tenuto", "staccato"], articTenutoStaccatoBelow: ["tenuto", "staccato"] };
/** The MusicXML marks a MuseScore articulation or ornament stands for. */
export function marksOfSubtype(subtype: string): string[] {
  return ARTIC_PAIRS[subtype] ?? [ARTIC[subtype] ?? ORNAMENT[subtype] ?? TECHNICAL[subtype]].filter(Boolean);
}
// Bowing marks go under <technical>.
const TECHNICAL: Record<string, string> = {
  stringsUpBow: "up-bow",
  stringsDownBow: "down-bow",
  stringsHarmonic: "harmonic",
  brassMuteOpen: "open",
  brassMuteClosed: "stopped",
  brassMuteHalfClosed: "half-muted",
  pluckedSnapPizzicatoAbove: "snap-pizzicato",
  pluckedSnapPizzicatoBelow: "snap-pizzicato",
  stringsThumbPosition: "thumb-position",
  pluckedWithFingernails: "fingernails",
  doubleTongueAbove: "double-tongue",
  doubleTongueBelow: "double-tongue",
  tripleTongueAbove: "triple-tongue",
  tripleTongueBelow: "triple-tongue",
  keyboardPedalHeel1: "heel",
  keyboardPedalToe2: "toe",
  brassBend: "brass-bend",
  brassFlip: "flip",
  brassSmear: "smear",
  guitarGolpe: "golpe",
};
// Jazz falls and scoops: a <ChordLine> by number.
const CHORD_LINE: Record<string, string> = { 1: "falloff", 2: "doit", 3: "plop", 4: "scoop" };
// MuseScore clef names: [sign, line, octave change].
const CLEF: Record<string, [string, number, number]> = {
  G: ["G", 2, 0],
  G8va: ["G", 2, 1],
  G15ma: ["G", 2, 2],
  G8vb: ["G", 2, -1],
  G8vbo: ["G", 2, -1],
  F: ["F", 4, 0],
  F8vb: ["F", 4, -1],
  F15mb: ["F", 4, -2],
  F3: ["F", 3, 0],
  F5: ["F", 5, 0],
  C1: ["C", 1, 0],
  C2: ["C", 2, 0],
  C3: ["C", 3, 0],
  C4: ["C", 4, 0],
  C5: ["C", 5, 0],
  PERC: ["percussion", 3, 0],
  PERC2: ["percussion", 3, 0],
  TAB: ["TAB", 5, 0],
  TAB4: ["TAB", 5, 0],
};

/** The .mscx inside an .mscz (META-INF/container.xml names it; else the first .mscx). */
export function readMscz(bytes: Uint8Array): string {
  const files = unzipSync(bytes, { filter: (f) => f.name.endsWith(".mscx") || f.name === "META-INF/container.xml" });
  const container = files["META-INF/container.xml"];
  if (container) {
    const m = /<rootfile[^>]*full-path="([^"]+\.mscx)"/.exec(strFromU8(container));
    if (m && files[m[1]]) return strFromU8(files[m[1]]);
  }
  const names = Object.keys(files).filter((n) => n.endsWith(".mscx"));
  const name = names.find((n) => !n.startsWith("Excerpts/")) ?? names[0];
  if (!name) throw new Error("No MuseScore score inside the file");
  return strFromU8(files[name]);
}

/** The other scores in an .mscz: MuseScore's instrument parts (Excerpts/...). */
export function readMsczExcerpts(bytes: Uint8Array): string[] {
  const files = unzipSync(bytes, { filter: (f) => f.name.startsWith("Excerpts/") && f.name.endsWith(".mscx") });
  return Object.values(files).map((f) => strFromU8(f));
}

export interface MscxOptions {
  /** MuseScore's instrument parts, where a tab staff may live that the score does not show. */
  excerpts?: string[];
  /** Tab staff for fretted parts: "auto" where MuseScore had one, "always", or "never". */
  tab?: "auto" | "always" | "never";
}

const SHARP_NAMES: [string, number][] = [["C", 0], ["C", 1], ["D", 0], ["D", 1], ["E", 0], ["F", 0], ["F", 1], ["G", 0], ["G", 1], ["A", 0], ["A", 1], ["B", 0]];

/** Instruments (id or name) that have a tab staff in one of MuseScore's instrument parts. */
function tabInstruments(excerpts: string[]): Set<string> {
  const out = new Set<string>();
  for (const x of excerpts) {
    for (const block of x.match(/<Part[\s>][\s\S]*?<\/Part>/g) ?? []) {
      if (!/group="tablature"/.test(block)) continue;
      const id = /<instrumentId>([^<]*)<\/instrumentId>/.exec(block)?.[1];
      const name = /<trackName>([^<]*)<\/trackName>/.exec(block)?.[1];
      if (id) out.add(id);
      if (name) out.add(name);
    }
  }
  return out;
}

const frac = (s: string | null | undefined): number => {
  if (!s) return 0;
  const [n, d] = s.split("/").map(Number);
  return d ? n / d : Number(n) || 0;
};

/** Spelling from MuseScore's tonal pitch class (line of fifths, C = 14). */
function spell(tpc: number, midi: number): { step: string; alter: number; octave: number } {
  const step = "FCGDAEB"[(((tpc - 13) % 7) + 7) % 7];
  const alter = Math.floor((tpc + 1) / 7) - 2;
  const octave = Math.round((midi - alter - SEMIS[step]) / 12) - 1;
  return { step, alter, octave };
}

/** A clef at the very start of a staff's first measure (before any note), if there is one. */
function firstClef(measure: Element | undefined): boolean {
  const voice = measure ? (kid(measure, "voice") ?? measure) : null;
  for (const c of voice ? kids(voice) : []) {
    if (c.tagName === "Clef") return true;
    if (c.tagName === "Chord" || c.tagName === "Rest") return false;
  }
  return false;
}

// MuseScore's music symbols in text (tempo marks), as characters.
const SYM: Record<string, string> = {
  metNoteWhole: "𝅝",
  metNoteHalfUp: "𝅗𝅥",
  metNoteQuarterUp: "♩",
  metNote8thUp: "♪",
  metNote16thUp: "𝅘𝅥𝅯",
  metAugmentationDot: ".",
  noteQuarterUp: "♩",
  // MuseScore 2 names
  unicodeNoteWhole: "𝅝",
  unicodeNoteHalfUp: "𝅗𝅥",
  unicodeNoteQuarterUp: "♩",
  unicodeNote8thUp: "♪",
  unicodeNote16thUp: "𝅘𝅥𝅯",
  unicodeAugmentationDot: ".",
  noteHalfUp: "𝅗𝅥",
  note8thUp: "♪",
  accidentalSharp: "♯",
  accidentalFlat: "♭",
  accidentalNatural: "♮",
  segno: "𝄋",
  coda: "𝄌",
};

// Text content with MuseScore's line breaks (<br/>) as spaces and its symbols as characters.
const plain = (el: Element | null): string => {
  if (!el) return "";
  const copy = el.cloneNode(true) as Element;
  for (const br of Array.from(copy.getElementsByTagName("br"))) br.replaceWith(" ");
  for (const sym of Array.from(copy.getElementsByTagName("sym"))) sym.replaceWith(SYM[sym.textContent?.trim() ?? ""] ?? "");
  // Non-breaking spaces stay (MuseScore joins elided syllables with them).
  return (copy.textContent ?? "").replace(/[ \t\r\n]+/g, " ").replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
};

interface PartDef {
  id: string;
  staves: Element[]; // the <Staff> definitions inside <Part>
  name: string;
  abbreviation: string;
  program: number;
  drums: boolean;
  /** Written = sounding - chromatic (semitones); spelled diatonic steps away. */
  chromatic: number;
  diatonic: number;
  tab: boolean[];
  strings: number[];
  /** Index of a staff scoredit adds (tab drawn from the notes' frets, or notation above a tab-only part), or -1. */
  virtual: number;
  /** Staves read from tab but drawn as notation, with the instrument's own clef. */
  notation: Set<number>;
  /** The drum map of a percussion part: each sound's staff line and notehead. */
  drumset: Map<number, { line: number; head: string; name: string }>;
  /** Lines of each staff (5 unless a percussion or special staff says otherwise). */
  lines: number[];
  clef: string;
  instrumentId: string;
}

/** MuseScore .mscx text to a MusicXML partwise document, plus where its sections start. */
export function mscxToMusicXml(source: string): Document {
  return readMscx(source).doc;
}

/**
 * What writing an edited score back into its MuseScore file needs: the file as read, which
 * MuseScore staff each MusicXML staff came from, and which chord each note came from.
 */
export interface MscxLink {
  /** The .mscx text as read. */
  source: string;
  /** The parsed file (the measures, by staff, are measures[staff][m]). */
  src: Document;
  version: number;
  measures: Element[][];
  /** Per part: the MuseScore staff of each MusicXML staff (staves added by scoredit: -1). */
  staves: number[][];
  /** Per part: semitones from written to concert, and the diatonic steps of that move. */
  transpose: { chromatic: number; diatonic: number }[];
  /** Per part: its drum kit (MusicXML instrument id to MuseScore pitch), if a drum part. */
  drums: (Map<string, number> | null)[];
  /** Semitones an octave line moves the notes of a staff at a measure and position (whole notes). */
  ottavaAt(staff: number, m: number, pos: number): number;
  /** Measure lengths in whole notes. */
  lengths: number[];
  /** MusicXML note (first of its chord, or a rest) to the MuseScore chord or rest it came from. */
  chords: WeakMap<Element, Element>;
}

export function readMscx(source: string, opts: MscxOptions = {}): { doc: Document; sections: number[]; fretted: boolean; tab: boolean; link: MscxLink } {
  const src = parseXml(source);
  const ms = src.documentElement;
  if (ms.tagName !== "museScore") throw new Error("Not a MuseScore file");
  const score = kid(ms, "Score");
  if (!score) throw new Error("The MuseScore file holds no score");

  let pendingFermata = false;
  // Slurs paired by where each end says the other is: open ones by the place they end at,
  // and ends met before their start (an earlier staff or voice) by their own place.
  const slurOpen = new Map<string, number[]>();
  const slurEarly = new Map<string, Element[]>();
  const placeKey = (track: number, m: number, pos: number, grace: number) => `${track}|${m}|${Math.round(pos * 161280)}|${grace}`;
  const chordOf = new WeakMap<Element, Element>();
  const out = parseXml(`<score-partwise version="4.0"/>`);
  const root = out.documentElement;
  const el = (parent: Element, tag: string, txt?: string | number | null, attrs?: Record<string, string | number>): Element => {
    const e = out.createElementNS(null, tag);
    if (attrs) for (const k in attrs) e.setAttribute(k, String(attrs[k]));
    if (txt !== undefined && txt !== null) e.appendChild(out.createTextNode(String(txt)));
    parent.appendChild(e);
    return e;
  };

  // ---- Header: title, composer, lyricist from the title frame or the meta tags.
  const staffEls = kids(score, "Staff");
  const meta = (name: string) => plain(kids(score, "metaTag").find((m) => m.getAttribute("name") === name) ?? null);
  const frameText = (style: string) => {
    const first = staffEls[0];
    if (!first) return "";
    for (const box of kids(first).filter((c) => /Box$/.test(c.tagName))) {
      for (const t of kids(box, "Text")) if (text(t, "style") === style) return plain(kid(t, "text"));
    }
    return "";
  };
  const title = frameText("title") || meta("workTitle");
  const subtitle = frameText("subtitle") || meta("subtitle");
  const composer = frameText("composer") || meta("composer");
  const lyricist = frameText("lyricist") || frameText("poet") || meta("lyricist");
  if (title) el(el(root, "work"), "work-title", title);
  if (subtitle) el(root, "movement-title", subtitle);
  const ident = el(root, "identification");
  if (composer) el(ident, "creator", composer, { type: "composer" });
  if (lyricist) el(ident, "creator", lyricist, { type: "lyricist" });
  const rights = meta("copyright");
  if (rights) el(ident, "rights", rights);
  el(el(ident, "encoding"), "software", "scoredit (from MuseScore)");

  // ---- Parts and their staves.
  const parts: PartDef[] = kids(score, "Part").map((p, i) => {
    const inst = kid(p, "Instrument");
    const staves = kids(p, "Staff");
    const program = Number(kid(kid(inst ?? p, "Channel") ?? p, "program")?.getAttribute("value") ?? 0) || 0;
    const types = staves.map((s) => kid(s, "StaffType")?.getAttribute("group") ?? "pitched");
    const stringData = inst ? kid(inst, "StringData") : null;
    const strings = stringData ? kids(stringData, "string").map((s) => Number(s.textContent)) : [];
    return {
      id: `P${i + 1}`,
      staves,
      name: text(p, "trackName") || text(inst, "longName"),
      abbreviation: text(inst, "shortName"),
      program,
      // A drum kit only when it maps its sounds; a percussion staff without a map (a bass drum
      // on a tuned program, a cannon effect) plays its program like any instrument.
      drums: types.includes("percussion") && !!inst && kids(inst, "Drum").length > 0,
      drumset: new Map(
        (inst ? kids(inst, "Drum") : []).map((d) => [Number(d.getAttribute("pitch")), { line: Number(text(d, "line")) || 0, head: text(d, "head"), name: text(d, "name") }] as const),
      ),
      lines: staves.map((st) => Number(text(kid(st, "StaffType"), "lines")) || 5),
      chromatic: Number(text(inst, "transposeChromatic")) || 0,
      diatonic: Number(text(inst, "transposeDiatonic")) || 0,
      tab: types.map((t) => t === "tablature"),
      strings,
      virtual: -1,
      notation: new Set<number>(),
      clef: text(inst, "clef") || (/bass/i.test(text(inst, "instrumentId")) ? "F8vb" : "G8vb"),
      instrumentId: text(inst, "instrumentId"),
    };
  });
  const list = el(root, "part-list");
  for (const p of parts) {
    const sp = el(list, "score-part", null, { id: p.id });
    el(sp, "part-name", p.name);
    if (p.abbreviation) el(sp, "part-abbreviation", p.abbreviation);
    if (p.drums) {
      // One instrument per drum sound, each naming the General MIDI drum it plays.
      for (const [pitch, d] of p.drumset) el(el(sp, "score-instrument", null, { id: `${p.id}-I${pitch + 1}` }), "instrument-name", d.name || p.name || "Drum");
      for (const pitch of p.drumset.keys()) {
        const mi = el(sp, "midi-instrument", null, { id: `${p.id}-I${pitch + 1}` });
        el(mi, "midi-channel", 10);
        el(mi, "midi-unpitched", pitch + 1);
      }
      continue;
    }
    el(el(sp, "score-instrument", null, { id: `${p.id}-I1` }), "instrument-name", p.name || "Instrument");
    const mi = el(sp, "midi-instrument", null, { id: `${p.id}-I1` });
    el(mi, "midi-program", p.program + 1);
  }

  // Staff contents in order: <Staff id> elements after the parts, matched to parts in order.
  const measuresOf = staffEls.map((s) => kids(s, "Measure"));
  let staffCursor = 0;
  const partStaves = parts.map((p) => {
    const ids = p.staves.map((_, k) => staffCursor + k);
    staffCursor += p.staves.length;
    return ids;
  });
  // Tab for fretted parts. "auto": tab where the file has it, and where MuseScore had it in an
  // instrument part. "always": notation and tab (a tab-only part gets a notation staff above).
  // "never": notation only (tab staves read as notation, or dropped next to a notation staff).
  const tabbed = tabInstruments(opts.excerpts ?? []);
  parts.forEach((p, pi) => {
    if (!p.strings.length || p.drums) return;
    const hasTab = p.tab.includes(true);
    const tabOnly = hasTab && p.tab.every(Boolean);
    if (opts.tab === "never" && hasTab) {
      if (tabOnly) {
        p.notation = new Set(p.tab.map((_, k) => k));
        p.tab = p.tab.map(() => false);
      } else {
        const keep = p.tab.map((t) => !t);
        p.staves = p.staves.filter((_, k) => keep[k]);
        partStaves[pi] = partStaves[pi].filter((_, k) => keep[k]);
        p.tab = p.tab.filter((_, k) => keep[k]);
      }
      return;
    }
    if (opts.tab === "always" && tabOnly) {
      p.staves = [p.staves[0], ...p.staves];
      p.tab = [false, ...p.tab];
      partStaves[pi] = [partStaves[pi][0], ...partStaves[pi]];
      p.virtual = 0;
      p.notation = new Set([0]);
      return;
    }
    if (hasTab) return;
    const want = opts.tab === "always" || (opts.tab !== "never" && (tabbed.has(p.instrumentId) || tabbed.has(p.name)));
    if (!want) return;
    p.staves = [...p.staves, p.staves[0]];
    p.tab = [...p.tab, true];
    p.virtual = p.staves.length - 1;
    partStaves[pi].push(partStaves[pi][0]);
  });
  const nMeasures = Math.max(0, ...measuresOf.map((m) => m.length));

  // Time signature in force per measure (from the first staff), for measure lengths.
  const lengths: number[] = [];
  {
    let sig = 1; // whole notes
    for (let m = 0; m < nMeasures; m++) {
      const meas = measuresOf[0]?.[m];
      const ts = meas ? Array.from(meas.getElementsByTagName("TimeSig"))[0] : undefined;
      if (ts) sig = Number(text(ts, "sigN")) / (Number(text(ts, "sigD")) || 4);
      lengths.push(meas?.getAttribute("len") ? frac(meas.getAttribute("len")) : sig);
    }
  }

  // Where each measure starts, in whole notes (MuseScore 2 positions are absolute ticks).
  const division = Number(text(score, "Division")) || 480;
  const measureStart: number[] = [];
  lengths.reduce((at, l, i) => ((measureStart[i] = at), at + l), 0);

  // Octave lines: MuseScore keeps the pitch as drawn and shifts it when playing; MusicXML
  // (as MuseScore exports it) holds the sounding pitch under an <octave-shift>. Ranges per
  // staff: [start measure, pos, end measure, pos, semitones].
  const OTTAVA: Record<string, [number, string, number]> = { "8va": [12, "down", 8], "8vb": [-12, "up", 8], "15ma": [24, "down", 15], "15mb": [-24, "up", 15], "22ma": [36, "down", 22], "22mb": [-36, "up", 22] };
  const ottavas = new Map<number, [number, number, number, number, number][]>();
  const ottavaAt = (staff: number, m: number, pos: number) => {
    for (const [m0, p0, m1, p1, semis] of ottavas.get(staff) ?? []) {
      const after = m > m0 || (m === m0 && pos >= p0 - 1e-9);
      const before = m < m1 || (m === m1 && pos < p1 - 1e-9);
      if (after && before) return semis;
    }
    return 0;
  };

  // MuseScore 2 lines by id, open until their <endSpanner>.
  const ms2Lines = new Map<string, string>();

  // MuseScore 2 tie ids, to tell a tie's end from another spanner's.
  // MuseScore 2 slurs: only those that end somewhere are drawn; overlapping ones get their own number.
  const slurStops = new Set(Array.from(score.getElementsByTagName("Slur")).flatMap((e) => (e.getAttribute("type") === "stop" ? [e.getAttribute("id") ?? ""] : [])));
  const slurNumbers = new Map<string, number>();
  const tieIds = new Set(Array.from(score.getElementsByTagName("Tie")).map((t) => t.getAttribute("id") ?? "").filter(Boolean));

  // Jumps name their markers: play until one, then continue at another.
  const jumpUntil = new Map<string, string>();
  const jumpContinue = new Set<string>();
  for (const st of staffEls) {
    for (const j of Array.from(st.getElementsByTagName("Jump"))) {
      const until = text(j, "playUntil");
      const cont = text(j, "continueAt");
      if (until && until !== "end") jumpUntil.set(until, cont);
      if (cont) jumpContinue.add(cont);
    }
  }

  // Volta ends found while reading, keyed by measure index: ending numbers and whether it closes.
  const voltaStart = new Map<number, string>();
  const voltaStop = new Map<number, string>();

  parts.forEach((p, pi) => {
    const part = el(root, "part", null, { id: p.id });
    const shift = p.chromatic;
    const oct = Math.trunc(shift / 12);
    let number = 0;
    for (let m = 0; m < nMeasures; m++) {
      const first = measuresOf[partStaves[pi][0]]?.[m];
      const irregular = !!first && !!kid(first, "irregular");
      if (!irregular) number++;
      const meas = el(part, "measure", null, irregular && m === 0 ? { number: 0, implicit: "yes" } : irregular ? { number: `${number}X`, implicit: "yes" } : { number });
      // Left barline: forward repeat, volta start (filled in after the staves are read).
      if (first && kid(first, "startRepeat")) el(el(meas, "barline", null, { location: "left" }), "repeat", null, { direction: "forward" });
      // Only the first measure starts with attributes of its own; later changes come inline.
      const attrs = m === 0 ? el(meas, "attributes") : (null as unknown as Element);
      if (m === 0) {
        el(attrs, "divisions", DIV);
        if (p.staves.length > 1) el(attrs, "staves", p.staves.length);
        if (shift) {
          const tr = el(attrs, "transpose");
          el(tr, "diatonic", p.diatonic - 7 * oct);
          el(tr, "chromatic", shift - 12 * oct);
          if (oct) el(tr, "octave-change", oct);
        }
        p.staves.forEach((s, k) => {
          const def = text(s, "defaultClef");
          if (!p.tab[k] && (p.lines[k] ?? 5) !== 5) el(el(attrs, "staff-details", null, p.staves.length > 1 ? { number: k + 1 } : undefined), "staff-lines", p.lines[k]);
          if (p.notation.has(k)) {
            addClef(attrs, p.clef, k + 1, p.staves.length > 1);
          } else if (p.tab[k]) {
            if (k === p.virtual || !firstClef(measuresOf[partStaves[pi][k]]?.[0])) addClef(attrs, "TAB", k + 1, p.staves.length > 1);
            const sd = el(attrs, "staff-details", null, p.staves.length > 1 ? { number: k + 1 } : undefined);
            el(sd, "staff-lines", p.strings.length || 6);
            p.strings.forEach((midi, line) => {
              const [step, alter] = SHARP_NAMES[midi % 12];
              const tu = el(sd, "staff-tuning", null, { line: line + 1 });
              el(tu, "tuning-step", step);
              if (alter) el(tu, "tuning-alter", alter);
              el(tu, "tuning-octave", Math.floor(midi / 12) - 1);
            });
          } else if (!firstClef(measuresOf[partStaves[pi][k]]?.[0])) {
            // Every staff gets its clef: a lone numbered clef is taken for the first staff otherwise.
            addClef(attrs, def || (kid(s, "StaffType")?.getAttribute("group") === "percussion" ? "PERC" : "G"), k + 1, p.staves.length > 1);
          }
        });
      }
      const len = lengths[m];
      // Each staff, each voice, in turn; <backup> between them.
      let emitted = 0; // whole notes from the measure start, where the output stream is
      const goTo = (pos: number) => {
        const d = Math.round((pos - emitted) * 4 * DIV);
        if (d > 0) el(el(meas, "forward"), "duration", d);
        else if (d < 0) el(el(meas, "backup"), "duration", -d);
        emitted = pos;
      };
      partStaves[pi].forEach((staffIdx, k) => {
        const smeas = measuresOf[staffIdx]?.[m];
        if (!smeas) return;
        const virtual = k === p.virtual;
        // The added tab staff repeats the notes only: no texts, marks or clefs of its own.
        const SKIP = new Set(["Clef", "Dynamic", "Tempo", "StaffText", "SystemText", "Expression", "RehearsalMark", "Spanner", "Fermata", ...MS2_LINES, "endSpanner"]);
        // MuseScore 3 and 4 group a measure's content in <voice>s; MuseScore 2 lists it flat,
        // each chord naming its track (staff * 4 + voice).
        const voiceEls = kids(smeas, "voice");
        const voiceLists: Element[][] = voiceEls.length
          ? voiceEls.map((x) => kids(x))
          : [0, 1, 2, 3].map((vi) => kids(smeas).filter((c) => (Number(text(c, "track")) || 0) % 4 === vi || (vi === 0 && !kid(c, "track") && c.tagName !== "Chord" && c.tagName !== "Rest"))).filter((l, vi) => vi === 0 || l.length);
        // MuseScore 2 tuplets are declared with an id that the chords in them name.
        const tupletDefs = new Map<string, { actual: number; normal: number }>();
        for (const t of kids(smeas, "Tuplet")) {
          const id = t.getAttribute("id");
          if (id) tupletDefs.set(id, { actual: Number(text(t, "actualNotes")) || 3, normal: Number(text(t, "normalNotes")) || 2 });
        }
        voiceLists.forEach((voiceKids, v) => {
          let pos = 0;
          // A fermata left over at the end of a voice stood on the barline.
          pendingFermata = false;
          // A trill line or two-chord tremolo starts on the next chord; a trill line ends on the last one.
          let trillNext = false;
          let tremoloStop = 0;
          let lastFirst: Element | null = null;
          let graceCount = 0;
          let lastEvent: Element | null = null;
          const tuplets: number[] = [];
          const tupletInfo: { actual: number; normal: number; base: string }[] = [];
          for (const c of voiceKids) {
            if (virtual && SKIP.has(c.tagName)) continue;
            // Lines (hairpins, octave lines, pedals, trills, voltas): MuseScore 3 and 4 write a
            // <Spanner type> at each end; MuseScore 2 the line's own element with an id, then
            // an <endSpanner id> where it stops.
            let spanType: string | null = null;
            let spanStarts = false;
            let spanInner: Element | null = null;
            if (c.tagName === "Spanner") {
              spanType = c.getAttribute("type");
              spanStarts = !!kid(c, "next");
              spanInner = spanType ? kid(c, spanType) : null;
            } else if (MS2_LINES.has(c.tagName) && c.getAttribute("id")) {
              spanType = c.tagName;
              spanStarts = true;
              spanInner = c;
              ms2Lines.set(c.getAttribute("id")!, c.tagName);
            } else if (c.tagName === "endSpanner") {
              spanType = ms2Lines.get(c.getAttribute("id") ?? "") ?? null;
            }
            switch (spanType ? "__span" : c.tagName) {
              case "location": {
                pos += frac(text(c, "fractions"));
                break;
              }
              case "TimeSig": {
                if (k === 0) {
                  goTo(pos);
                  const at = pos === 0 && m === 0 ? attrs : el(meas, "attributes");
                  const t = el(at, "time");
                  el(t, "beats", text(c, "sigN"));
                  el(t, "beat-type", text(c, "sigD"));
                }
                break;
              }
              case "KeySig": {
                if (k === 0) {
                  goTo(pos);
                  const at = pos === 0 && m === 0 ? attrs : el(meas, "attributes");
                  const fifths = Number(text(c, "concertKey") || text(c, "accidental") || text(c, "key")) || 0;
                  // The written key of a transposing part moves with it.
                  const written = shift ? fifths - (7 * shift - 12 * p.diatonic) : fifths;
                  const key = el(at, "key");
                  el(key, "fifths", written);
                }
                break;
              }
              case "Clef": {
                const type = text(c, "concertClefType") || text(c, "transposingClefType") || "G";
                // A tab clef on a staff now drawn as notation: its notation clef is already set.
                if (p.notation.has(k) && type.startsWith("TAB")) break;
                goTo(pos);
                const at = pos === 0 && m === 0 ? attrs : el(meas, "attributes");
                addClef(at, type, k + 1, p.staves.length > 1);
                break;
              }
              case "tick": {
                // MuseScore 2: an absolute position, in ticks from the start of the score.
                pos = Number(c.textContent) / (division * 4) - measureStart[m];
                break;
              }
              case "Tuplet": {
                if (c.getAttribute("id")) break; // a MuseScore 2 declaration, applied by reference
                const actual = Number(text(c, "actualNotes")) || 3;
                const normal = Number(text(c, "normalNotes")) || 2;
                tuplets.push(normal / actual);
                tupletInfo.push({ actual, normal, base: text(c, "baseNote") });
                break;
              }
              case "endTuplet": {
                tuplets.pop();
                tupletInfo.pop();
                break;
              }
              case "Dynamic": {
                goTo(pos);
                const sub = text(c, "subtype");
                if (text(c, "visible") === "0") {
                  const vel = Number(text(c, "velocity"));
                  if (vel > 0) el(meas, "sound", null, { dynamics: Math.round((vel / 90) * 100) });
                  break;
                }
                const dir = el(meas, "direction", null, { placement: "below" });
                const dt = el(dir, "direction-type");
                if (/^[pmfsrzn]+$/.test(sub)) el(el(dt, "dynamics"), sub);
                else el(dt, "words", plain(kid(c, "text")) || sub);
                const vel = Number(text(c, "velocity"));
                if (vel > 0) el(dir, "sound", null, { dynamics: Math.round((vel / 90) * 100) });
                if (p.staves.length > 1) el(dir, "staff", k + 1);
                break;
              }
              case "Tempo": {
                goTo(pos);
                const qps = Number(text(c, "tempo"));
                const bpm = Math.round(qps * 60 * 100) / 100;
                // An invisible tempo mark (a written-out ritardando) sounds but is not printed.
                if (text(c, "visible") === "0") {
                  if (qps > 0) el(meas, "sound", null, { tempo: bpm });
                  break;
                }
                const dir = el(meas, "direction", null, { placement: "above" });
                el(el(dir, "direction-type"), "words", plain(kid(c, "text")) || " ");
                if (qps > 0) el(dir, "sound", null, { tempo: bpm });
                break;
              }
              case "StaffText":
              case "SystemText":
              case "Expression":
              case "RehearsalMark": {
                const words = plain(kid(c, "text"));
                if (!words) break;
                goTo(pos);
                const dir = el(meas, "direction", null, { placement: c.tagName === "Expression" ? "below" : "above" });
                el(el(dir, "direction-type"), c.tagName === "RehearsalMark" ? "rehearsal" : "words", words);
                if (p.staves.length > 1) el(dir, "staff", k + 1);
                break;
              }
              case "__span": {
                const type = spanType;
                const starts = spanStarts;
                if (type === "HairPin") {
                  goTo(pos);
                  const dir = el(meas, "direction", null, { placement: "below" });
                  const hp = spanInner;
                  const sub = Number(text(hp, "subtype"));
                  el(el(dir, "direction-type"), "wedge", null, { type: starts ? (sub === 1 || sub === 3 ? "diminuendo" : "crescendo") : "stop" });
                  if (p.staves.length > 1) el(dir, "staff", k + 1);
                } else if (type === "Ottava") {
                  const list = ottavas.get(staffIdx) ?? [];
                  ottavas.set(staffIdx, list);
                  goTo(pos);
                  const dir = el(meas, "direction", null, { placement: "above" });
                  const dt = el(dir, "direction-type");
                  if (starts) {
                    const [semis, shiftType, size] = OTTAVA[text(spanInner, "subtype")] ?? OTTAVA["8va"];
                    list.push([m, pos, Infinity, 0, semis]);
                    el(dt, "octave-shift", null, { type: shiftType, size });
                  } else {
                    const open = [...list].reverse().find((r) => r[2] === Infinity);
                    if (open) {
                      open[2] = m;
                      open[3] = pos;
                    }
                    el(dt, "octave-shift", null, { type: "stop", size: open ? (Math.abs(open[4]) / 12) * 7 + 1 : 8 });
                  }
                  if (p.staves.length > 1) el(dir, "staff", k + 1);
                } else if (type === "Pedal") {
                  goTo(pos);
                  const pd = spanInner;
                  const hidden = text(pd, "visible") === "0";
                  const line = text(pd, "lineVisible") !== "0";
                  const dir = el(meas, "direction", null, { placement: "below" });
                  el(el(dir, "direction-type"), "pedal", null, { type: starts ? "start" : "stop", line: line ? "yes" : "no", ...(hidden ? { "print-object": "no" } : {}) });
                  if (p.staves.length > 1) el(dir, "staff", k + 1);
                } else if (type === "Trill") {
                  if (starts) trillNext = true;
                  else if (lastFirst) {
                    const nt = kid(lastFirst, "notations") ?? el(lastFirst, "notations");
                    const orn = kid(nt, "ornaments") ?? el(nt, "ornaments");
                    el(orn, "wavy-line", null, { type: "stop" });
                  }
                } else if (type === "Volta" && pi === 0 && k === 0) {
                  const vt = spanInner;
                  if (starts) voltaStart.set(m, text(vt, "endings") || "1");
                  else {
                    const at = pos <= 0 && m > 0 ? m - 1 : m;
                    const startM = [...voltaStart.keys()].filter((x) => x <= at).pop();
                    voltaStop.set(at, startM !== undefined ? voltaStart.get(startM)! : "1");
                  }
                }
                break;
              }
              case "Rest":
              case "Chord": {
                const cg = groups(c);
                const dt = gtext(cg, "durationType");
                const graceTag = GRACES.find((g) => cg.has(g));
                const ref = tupletDefs.get(gtext(cg, "Tuplet"));
                const ratio = tuplets.reduce((a, b) => a * b, 1) * (ref ? ref.normal / ref.actual : 1);
                const dots = Number(gtext(cg, "dots")) || 0;
                let whole: number;
                const override = gtext(cg, "duration");
                if (dt === "measure") whole = override ? frac(override) : len;
                else if (override && c.tagName === "Chord") whole = frac(override);
                else whole = ((DURATION[dt] ?? 1) / 4) * (2 - 2 ** -dots) * ratio;
                if (graceTag) whole = 0;
                goTo(pos);
                const notes = c.tagName === "Chord" ? gall(cg, "Note") : [null];
                const tremEl = gone(cg, "TremoloSingleChord") ?? gone(cg, "TremoloTwoChord") ?? gone(cg, "Tremolo");
                const tremSub = text(tremEl, "subtype");
                const tremolo = tremEl ? { strokes: ({ 8: 1, 16: 2, 32: 3, 64: 4 } as Record<number, number>)[Number(tremSub.replace(/\D/g, ""))] ?? 2, two: tremSub.startsWith("c") } : null;
                let firstNote: Element | null = null;
                notes.forEach((n, ni) => {
                  const ng = n ? groups(n) : NO_GROUPS;
                  const note = el(meas, "note");
                  firstNote ??= note;
                  if (ni === 0 && !virtual) chordOf.set(note, c);
                  if (graceTag) el(note, "grace", null, graceTag === "acciaccatura" ? { slash: "yes" } : undefined);
                  if (ni > 0) el(note, "chord");
                  if (!n) {
                    el(note, "rest", null, dt === "measure" ? { measure: "yes" } : undefined);
                  } else if (p.drums) {
                    // A drum: shown on its line of the drum staff (counting half spaces down from
                    // the top line), played as its General MIDI drum.
                    const d = p.drumset.get(Number(gtext(ng, "pitch")));
                    const lines = p.lines[k] ?? 5;
                    const top = lines === 1 ? 4 * 7 + 2 : 5 * 7 + 3; // E4 for a one-line staff, F5 for five lines
                    const at = top - (d?.line ?? 0);
                    const un = el(note, "unpitched");
                    el(un, "display-step", "CDEFGAB"[((at % 7) + 7) % 7]);
                    el(un, "display-octave", Math.floor(at / 7));
                  } else {
                    const sounding = Number(gtext(ng, "pitch"));
                    const tpc = Number(gtext(ng, "tpc"));
                    const tpc2 = gtext(ng, "tpc2");
                    const writtenTpc = shift ? (tpc2 ? Number(tpc2) : tpc - (7 * shift - 12 * p.diatonic)) : tpc;
                    const sp = spell(writtenTpc, sounding - shift + ottavaAt(staffIdx, m, pos));
                    const pitch = el(note, "pitch");
                    el(pitch, "step", sp.step);
                    if (sp.alter) el(pitch, "alter", sp.alter);
                    el(pitch, "octave", sp.octave);
                  }
                  if (!graceTag) el(note, "duration", Math.max(1, Math.round(whole * 4 * DIV)));
                  const ties = n ? gall(ng, "Spanner").filter((s) => s.getAttribute("type") === "Tie") : [];
                  // MuseScore 2: <Tie id> on the first note, <endSpanner id> on the second.
                  const tieStart = ties.some((s) => kid(s, "next")) || (!!n && !!gone(ng, "Tie"));
                  const tieStop = ties.some((s) => kid(s, "prev")) || (!!n && gall(ng, "endSpanner").some((e) => tieIds.has(e.getAttribute("id") ?? "")));
                  if (tieStop) el(note, "tie", null, { type: "stop" });
                  if (tieStart) el(note, "tie", null, { type: "start" });
                  if (n && p.drums) el(note, "instrument", null, { id: `${p.id}-I${Number(gtext(ng, "pitch")) + 1}` });
                  el(note, "voice", k * 4 + v + 1);
                  if (dt !== "measure" && TYPE_NAME[dt]) el(note, "type", TYPE_NAME[dt]);
                  for (let d = 0; d < dots; d++) el(note, "dot");
                  const acc = n ? gone(ng, "Accidental") : null;
                  if (acc && ACCIDENTAL[text(acc, "subtype")]) el(note, "accidental", ACCIDENTAL[text(acc, "subtype")]);
                  if ((tupletInfo.length || ref) && !graceTag) {
                    const ti = ref ?? tupletInfo[tupletInfo.length - 1];
                    const tm = el(note, "time-modification");
                    el(tm, "actual-notes", ti.actual);
                    el(tm, "normal-notes", ti.normal);
                  }
                  const stem = gtext(cg, "StemDirection");
                  if (stem === "up" || stem === "down") el(note, "stem", stem);
                  // Ghost notes in brackets, dead notes as a cross.
                  const drumHead = n && p.drums ? p.drumset.get(Number(gtext(ng, "pitch")))?.head : undefined;
                  const HEADS: Record<string, string> = { "1": "x", cross: "x", "2": "diamond", diamond: "diamond", "3": "triangle", "triangle-up": "triangle", slash: "slash", xcircle: "circle-x" };
                  if (drumHead && HEADS[drumHead]) el(note, "notehead", HEADS[drumHead]);
                  else if (n && gtext(ng, "dead") === "1") el(note, "notehead", "x");
                  else if (n && gtext(ng, "ghost") === "1") el(note, "notehead", "normal", { parentheses: "yes" });
                  if (p.staves.length > 1) el(note, "staff", k + 1);
                  // Notations: ties, slurs, articulations, ornaments, fermata, tab string/fret.
                  const nots: Element[] = [];
                  const notations = () => (nots[0] ??= el(note, "notations"));
                  const ornEls: Element[] = [];
                  const ornaments = () => (ornEls[0] ??= el(notations(), "ornaments"));
                  // Tremolos: repeated notes (r8, r16...) or two chords in alternation (c16, c32...).
                  if (tremolo) el(ornaments(), "tremolo", tremolo.strokes, { type: tremolo.two ? "start" : "single" });
                  else if (tremoloStop) el(ornaments(), "tremolo", tremoloStop, { type: "stop" });
                  if (tieStop) el(notations(), "tied", null, { type: "stop" });
                  if (tieStart) el(notations(), "tied", null, { type: "start" });
                  // Glissandos, drawn straight (MuseScore exports them as slides).
                  for (const g of n ? gall(ng, "Spanner").filter((x) => x.getAttribute("type") === "Glissando") : []) {
                    const start = !!kid(g, "next");
                    el(notations(), "slide", start ? text(kid(g, "Glissando") ?? g, "text") || null : null, { type: start ? "start" : "stop", number: ni + 1, "line-type": "solid" });
                  }
                  if (ni === 0 && !virtual) {
                    const track = staffIdx * 4 + v;
                    const here = placeKey(track, m, pos, graceTag ? graceCount : -1);
                    for (const s of gall(cg, "Spanner").filter((x) => x.getAttribute("type") === "Slur")) {
                      const end = kid(s, "next") ?? kid(s, "prev");
                      const loc = end ? kid(end, "location") : null;
                      if (kid(s, "next")) {
                        const there = placeKey(track + 4 * (Number(text(loc, "staves")) || 0) + (Number(text(loc, "voices")) || 0), m + (Number(text(loc, "measures")) || 0), pos + (loc && text(loc, "fractions") ? frac(text(loc, "fractions")) : 0), loc && text(loc, "grace") ? Number(text(loc, "grace")) : -1);
                        const used = new Set([...slurOpen.values()].flat());
                        let number = 1;
                        while (used.has(number) && number < 16) number++;
                        const early = slurEarly.get(there)?.shift();
                        if (early) early.setAttribute("number", String(number));
                        else slurOpen.set(there, [...(slurOpen.get(there) ?? []), number]);
                        el(notations(), "slur", null, { type: "start", number });
                      } else {
                        const number = slurOpen.get(here)?.shift();
                        const e = el(notations(), "slur", null, { type: "stop", number: number ?? 1 });
                        if (number === undefined) slurEarly.set(here, [...(slurEarly.get(here) ?? []), e]);
                        else if (!slurOpen.get(here)!.length) slurOpen.delete(here);
                      }
                    }
                    // MuseScore 2 marks a slur's ends on the chords themselves.
                    for (const s of gall(cg, "Slur")) {
                      const type = s.getAttribute("type");
                      const id = s.getAttribute("id") ?? "";
                      if (type === "start" && slurStops.has(id)) {
                        const used = new Set(slurNumbers.values());
                        let number = 1;
                        while (used.has(number) && number < 16) number++;
                        slurNumbers.set(id, number);
                        el(notations(), "slur", null, { type, number });
                      } else if (type === "stop" && slurNumbers.has(id)) {
                        el(notations(), "slur", null, { type, number: slurNumbers.get(id)! });
                        slurNumbers.delete(id);
                      }
                    }
                    const bows = gall(cg, "Articulation").map((a) => TECHNICAL[text(a, "subtype")]).filter(Boolean);
                    if (gone(cg, "Tapping")) bows.push("tap");
                    if (bows.length) {
                      const tech = kid(notations(), "technical") ?? el(notations(), "technical");
                      for (const b of bows) el(tech, b);
                    }
                    const arts = [...gall(cg, "Articulation").flatMap((a) => ARTIC_PAIRS[text(a, "subtype")] ?? [ARTIC[text(a, "subtype")]]), ...gall(cg, "ChordLine").map((x) => CHORD_LINE[text(x, "subtype")])].filter(Boolean);
                    if (arts.length) {
                      const a = el(notations(), "articulations");
                      for (const x of arts) el(a, x);
                    }
                    const ornEls = [...gall(cg, "Ornament"), ...gall(cg, "Articulation")].filter((a) => ORNAMENT[text(a, "subtype")]);
                    const orns = ornEls.map((a) => ORNAMENT[text(a, "subtype")]);
                    ornEls.forEach((a, i) => {
                      // A MuseScore 4 ornament may name its upper or lower note (with its accidental),
                      // and start on the upper note.
                      const upperStart = kids(a).some((x) => /upper/i.test(x.tagName) && /^(1|true)$/.test(x.textContent?.trim() ?? ""));
                      el(ornaments(), orns[i], null, orns[i] === "trill-mark" && upperStart ? { "start-note": "upper" } : undefined);
                      const cue = kid(a, "Note");
                      if (cue) {
                        const alter = Math.floor((Number(text(cue, "tpc")) + 1) / 7) - 2;
                        const mark = ({ 2: "double-sharp", 1: "sharp", 0: "natural", [-1]: "flat", [-2]: "flat-flat" } as Record<number, string>)[alter];
                        if (mark) el(ornaments(), "accidental-mark", mark);
                      }
                    });
                    if (trillNext) {
                      if (!orns.includes("trill-mark")) el(ornaments(), "trill-mark");
                      el(ornaments(), "wavy-line", null, { type: "start" });
                    }
                    if (pendingFermata && !graceTag) {
                      el(notations(), "fermata", null, { type: "upright" });
                      pendingFermata = false;
                    }
                    if (gone(cg, "Arpeggio")) el(notations(), "arpeggiate");
                  }
                  // A fingering written on the note.
                  const fing = n ? gall(ng, "Fingering").find((x) => text(x, "style") !== "string_number") ?? null : null;
                  if (fing && plain(kid(fing, "text"))) el(kid(notations(), "technical") ?? el(notations(), "technical"), "fingering", plain(kid(fing, "text")));
                  if (n && p.tab[k]) {
                    let fret = gtext(ng, "fret");
                    let str = gtext(ng, "string");
                    if ((fret === "" || str === "") && p.strings.length) {
                      // No position stored: the lowest fret that reaches the note.
                      const sounding = Number(gtext(ng, "pitch"));
                      let best = -1;
                      p.strings.forEach((open, i) => {
                        const f = sounding - open;
                        if (f >= 0 && f <= 24 && (best < 0 || f < sounding - p.strings[best])) best = i;
                      });
                      if (best >= 0) {
                        fret = String(sounding - p.strings[best]);
                        str = String(p.strings.length - 1 - best);
                      }
                    }
                    if (fret !== "" && str !== "") {
                      const tech = kid(notations(), "technical") ?? el(notations(), "technical");
                      el(tech, "string", Number(str) + 1);
                      el(tech, "fret", fret);
                      // A bend: its curve's highest point (MuseScore: 100 = a whole tone), and a
                      // release when it comes back down.
                      const pts = n ? Array.from(n.getElementsByTagName("Bend")[0]?.getElementsByTagName("point") ?? []).map((x) => Number(x.getAttribute("pitch")) || 0) : [];
                      const top = pts.length ? Math.max(...pts) : 0;
                      if (top > 0) {
                        // OSMD draws each <bend> as one stroke: up (or already up), then the release.
                        const bend = el(tech, "bend");
                        el(bend, "bend-alter", top / 50);
                        if (pts[0] >= top) el(bend, "pre-bend");
                        if (pts[pts.length - 1] < top) {
                          const back = el(tech, "bend");
                          el(back, "bend-alter", top / 50);
                          el(back, "release");
                        }
                      }
                    }
                  }
                  if (ni === 0 && !virtual) {
                    for (const ly of gall(cg, "Lyrics")) {
                      const lyric = el(note, "lyric", null, { number: (Number(text(ly, "no")) || 0) + 1 });
                      el(lyric, "syllabic", text(ly, "syllabic") || "single");
                      el(lyric, "text", plain(kid(ly, "text")));
                    }
                  }
                });
                if (c.tagName === "Chord") {
                  if (trillNext) trillNext = false;
                  tremoloStop = tremolo?.two ? tremolo.strokes : 0;
                  if (!graceTag) lastFirst = firstNote;
                  graceCount = graceTag ? graceCount + 1 : 0;
                }
                if (!graceTag && !virtual) lastEvent = firstNote;
                emitted = pos + whole;
                pos += whole;
                break;
              }
              case "Fermata": {
                pendingFermata = true;
                break;
              }
              case "Breath": {
                // A breath mark or caesura after a chord or rest: a mark of that event.
                if (lastEvent) {
                  const nt = kid(lastEvent, "notations") ?? el(lastEvent, "notations");
                  const arts = kid(nt, "articulations") ?? el(nt, "articulations");
                  el(arts, /caesura/i.test(text(c, "symbol")) ? "caesura" : "breath-mark");
                }
                break;
              }
            }
          }
          goTo(0);
        });
      });
      // Right barline: end repeat, final or double bar from the first staff.
      const endRep = first ? kid(first, "endRepeat") : null;
      const bl = first ? Array.from(first.getElementsByTagName("BarLine")).pop() : undefined;
      const style = text(bl, "subtype");
      const rightBar = style === "double" || style === "end" || endRep ? el(meas, "barline", null, { location: "right" }) : null;
      if (style === "double") el(rightBar!, "bar-style", "light-light");
      else if (style === "end" || endRep) el(rightBar!, "bar-style", "light-heavy");
      if (endRep) el(rightBar!, "repeat", null, { direction: "backward", ...(Number(endRep.textContent) > 2 ? { times: Number(endRep.textContent) } : {}) });
      // Jumps and markers, as playback sounds.
      if (first) {
        for (const mk of kids(first, "Marker")) {
          const label = text(mk, "label") || text(mk, "subtype");
          const sub = (text(mk, "subtype") || label).toLowerCase();
          const dir = el(meas, "direction", null, { placement: "above" });
          el(el(dir, "direction-type"), "words", plain(kid(mk, "text")) || label);
          // A marker's role comes first from the jump that names it: where to leave for the
          // coda ("play until"), where the coda is ("continue at"), or where to stop.
          const leaveFor = jumpUntil.get(label);
          if (leaveFor) el(dir, "sound", null, { tocoda: leaveFor });
          else if (jumpContinue.has(label)) el(dir, "sound", null, { coda: label });
          else if (jumpUntil.has(label) && sub !== "fine") el(dir, "sound", null, { fine: "yes" });
          else if (sub === "fine") el(dir, "sound", null, { fine: "yes" });
          else if (sub.startsWith("segno")) el(dir, "sound", null, { segno: label });
          else if (sub === "tocoda" || sub === "tocodasym") el(dir, "sound", null, { tocoda: label });
          else if (sub.startsWith("coda") || sub === "varcoda") el(dir, "sound", null, { coda: label });
        }
        for (const j of kids(first, "Jump")) {
          const to = text(j, "jumpTo");
          const dir = el(meas, "direction", null, { placement: "above" });
          el(el(dir, "direction-type"), "words", plain(kid(j, "text")) || (to === "start" ? "D.C." : "D.S."));
          if (to === "start") el(dir, "sound", null, { dacapo: "yes" });
          else el(dir, "sound", null, { dalsegno: to });
        }
      }
      // Drop empty helpers so OSMD and the timeline see only what is there.
      if (attrs && !attrs.firstChild) attrs.remove();
    }
  });

  // MusicXML wants the children of <attributes> in schema order.
  for (const at of Array.from(root.getElementsByTagName("attributes"))) {
    // Also by staff number: OSMD takes clefs in order, whatever their number says.
    const sorted = kids(at).sort((a, b) => ATTR_ORDER.indexOf(a.tagName) - ATTR_ORDER.indexOf(b.tagName) || Number(a.getAttribute("number") ?? 0) - Number(b.getAttribute("number") ?? 0));
    for (const c of sorted) at.appendChild(c);
  }

  // Volta brackets on the barlines, in every part.
  for (const part of kids(root, "part")) {
    const meas = kids(part, "measure");
    for (const [m, nums] of voltaStart) addEnding(meas[m], "left", "start", nums);
    for (const [m, nums] of voltaStop) addEnding(meas[m], "right", meas[m] && hasBackward(meas[m]) ? "stop" : "discontinue", nums);
  }
  // Section breaks (between movements) end a section; the next measure starts one.
  const sections = [0];
  (measuresOf[0] ?? []).forEach((m, i) => {
    if (kids(m, "LayoutBreak").some((b) => text(b, "subtype") === "section") && i + 1 < nMeasures) sections.push(i + 1);
  });
  const fretted = parts.some((p) => p.strings.length > 0 && !p.drums);
  const link: MscxLink = {
    source,
    src,
    version: Number(ms.getAttribute("version")) || 0,
    measures: measuresOf,
    staves: parts.map((p, pi) => partStaves[pi].map((s, k) => (k === p.virtual ? -1 : s))),
    transpose: parts.map((p) => ({ chromatic: p.chromatic, diatonic: p.diatonic })),
    drums: parts.map((p) => (p.drums ? new Map([...p.drumset.keys()].map((pitch) => [`${p.id}-I${pitch + 1}`, pitch])) : null)),
    ottavaAt,
    lengths,
    chords: chordOf,
  };
  return { doc: out, sections, fretted, tab: parts.some((p) => p.tab.includes(true)), link };

  function addClef(at: Element, name: string, number: number, numbered: boolean): void {
    const [sign, line, octave] = CLEF[name] ?? CLEF.G;
    const clef = el(at, "clef", null, numbered ? { number } : undefined);
    el(clef, "sign", sign);
    el(clef, "line", line);
    if (octave) el(clef, "clef-octave-change", octave);
  }
  function addEnding(measure: Element | undefined, location: string, type: string, nums: string): void {
    if (!measure) return;
    let bar = kids(measure, "barline").find((b) => b.getAttribute("location") === location);
    if (!bar) {
      bar = out.createElementNS(null, "barline");
      bar.setAttribute("location", location);
      if (location === "left") measure.insertBefore(bar, measure.firstChild);
      else measure.appendChild(bar);
    }
    const e = out.createElementNS(null, "ending");
    e.setAttribute("number", nums.replace(/\s+/g, ""));
    e.setAttribute("type", type);
    // <ending> goes after bar-style and before repeat.
    bar.insertBefore(e, kid(bar, "repeat"));
  }
  function hasBackward(measure: Element): boolean {
    return kids(measure, "barline").some((b) => kid(b, "repeat")?.getAttribute("direction") === "backward");
  }
}

