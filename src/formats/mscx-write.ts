import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from "fflate";
import { pairEnds, type SlurItem } from "../edit/pairs";
import { isAfterGrace, readMeasure, voiceKey, type Event } from "../edit/measure";
import { bendsOf, fingeringOf, lyricsOf, marksOf, midiOf, readPitch, slursOf, spansOf, spellMidi, tremoloOf, type Pitch } from "../edit/notes";
import type { ScoreDoc } from "../model/score";
import { kid, kids, parseXml, text } from "../model/xml";
import { BREATH, SYM, marksOfSubtype, plain, type MscxLink } from "./mscx";
import { DYNAMICS, directionOf, type Direction } from "../edit/directions";
import { chordFromMuseScore, chordText, readHarmony, tpcOf } from "../edit/chords";
import { CLEFS, INSTRUMENTS, type InstrumentDef } from "../model/instruments";
import { partXml } from "./mscx-new";

// Writing an edited score back into its MuseScore file. Only the measures an edit touched are
// written again; everything else in the file stays byte for byte. In a rewritten measure, a
// chord whose notes did not change is copied from the file as it was (with what scoredit does
// not write itself), its ties, slurs and accidentals written again; a changed or new one is
// written from the score. Texts, dynamics, clefs and lines of the measure stay at their beat.
// Clean room: the format is learned from MuseScore files, never from MuseScore's source.

/** What a save could not carry over, by kind (marks scoredit does not write to MuseScore yet). */
export type Dropped = Record<string, number>;

const ARTIC: Record<string, string> = {
  staccato: "articStaccatoAbove",
  staccatissimo: "articStaccatissimoAbove",
  accent: "articAccentAbove",
  tenuto: "articTenutoAbove",
  "strong-accent": "articMarcatoAbove",
  "detached-legato": "articTenutoStaccatoAbove",
  spiccato: "articStaccatissimoStrokeAbove",
  stress: "articStressAbove",
  unstress: "articUnstressAbove",
  "soft-accent": "articSoftAccentAbove",
};
const ORNAMENT: Record<string, string> = {
  "trill-mark": "ornamentTrill",
  turn: "ornamentTurn",
  "delayed-turn": "ornamentTurn",
  "inverted-turn": "ornamentTurnInverted",
  "vertical-turn": "ornamentTurnUp",
  "inverted-vertical-turn": "ornamentTurnUpS",
  mordent: "ornamentMordent",
  "inverted-mordent": "ornamentShortTrill",
  shake: "ornamentTremblementCouperin",
  schleifer: "ornamentPrecompSlide",
  haydn: "ornamentHaydn",
};
// Technical marks MuseScore writes as articulations.
const BOWING: Record<string, string> = {
  "up-bow": "stringsUpBow",
  "down-bow": "stringsDownBow",
  harmonic: "stringsHarmonic",
  "open-string": "brassMuteOpen",
  open: "brassMuteOpen",
  stopped: "brassMuteClosed",
  "half-muted": "brassMuteHalfClosed",
  "snap-pizzicato": "pluckedSnapPizzicatoAbove",
  "thumb-position": "stringsThumbPosition",
  fingernails: "pluckedWithFingernails",
  "double-tongue": "doubleTongueAbove",
  "triple-tongue": "tripleTongueAbove",
  heel: "keyboardPedalHeel1",
  toe: "keyboardPedalToe2",
  "brass-bend": "brassBend",
  flip: "brassFlip",
  smear: "brassSmear",
  golpe: "guitarGolpe",
};
const CHORD_LINE: Record<string, number> = { falloff: 1, doit: 2, plop: 3, scoop: 4 };
// Written beside the chord or rest, not in it.
const BESIDE = new Set(["fermata", "arpeggiate", "breath-mark", "caesura", "tap", ...Object.keys(CHORD_LINE)]);
const ACCIDENTAL: Record<number, string> = { [-2]: "accidentalDoubleFlat", [-1]: "accidentalFlat", 0: "accidentalNatural", 1: "accidentalSharp", 2: "accidentalDoubleSharp" };
/** MusicXML's name of each accidental. */
const SHOWN: Record<number, string> = { [-2]: "flat-flat", [-1]: "flat", 0: "natural", 1: "sharp", 2: "double-sharp" };
const TPC_BASE: Record<string, number> = { F: 13, C: 14, G: 15, D: 16, A: 17, E: 18, B: 19 };
const TYPE_Q: Record<string, number> = { breve: 8, whole: 4, half: 2, quarter: 1, eighth: 0.5, "16th": 0.25, "32nd": 0.125, "64th": 0.0625, "128th": 0.03125 };
const DURATION_NAME: [string, number][] = Object.entries(TYPE_Q).sort((a, b) => b[1] - a[1]);

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : Math.abs(a));
/** A fraction of a whole note, from a count of divisions. */
function fraction(divs: number, perQuarter: number): string {
  const den = perQuarter * 4;
  const g = gcd(divs, den) || 1;
  return `${divs / g}/${den / g}`;
}

/** Where each measure of the score body is in the text: per staff, [start, end) of each <Measure>. */
interface Offsets {
  staves: [number, number][][];
  staffEnds: number[];
  mmrests: [number, number][];
  nested: [number, number][];
  /** <Part> definitions, and the body <Staff> elements, whole. */
  partDefs: [number, number][];
  bodies: [number, number][];
  /** Opening tags carrying ids: <Part>, its <Staff>s, the body <Staff>s. */
  partTags: [number, number][];
  defStaffTags: [number, number][];
  bodyTags: [number, number][];
}

function measureOffsets(source: string): Offsets {
  const tag = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<(\/?)([A-Za-z_][\w.-]*)[^>]*?(\/?)>/g;
  const stack: string[] = [];
  const staves: [number, number][][] = [];
  const staffEnds: number[] = [];
  // Multi-measure rests (a part's drawing of several empty bars as one): not bars of their own.
  const mmrests: [number, number][] = [];
  // MuseScore 3 keeps instrument parts as scores inside the score.
  const nested: [number, number][] = [];
  let nestedStart = -1;
  let scoreDepth = -1;
  let measureStart = -1;
  const partDefs: [number, number][] = [];
  const bodies: [number, number][] = [];
  const partTags: [number, number][] = [];
  const defStaffTags: [number, number][] = [];
  const bodyTags: [number, number][] = [];
  let partStart = -1;
  let bodyStart = -1;
  for (let m = tag.exec(source); m; m = tag.exec(source)) {
    if (!m[2]) continue;
    const [all, close, name, self] = m;
    if (close) {
      // Leaving an element: a measure of a body staff ends, a body staff ends.
      const depth = stack.length - 1;
      if (name === "Measure" && measureStart >= 0 && scoreDepth >= 0 && depth === scoreDepth + 2) {
        const range: [number, number] = [measureStart, m.index + all.length];
        if (/^<Measure[^>]*>\s*(?:<eid>[^<]*<\/eid>\s*)?<multiMeasureRest>/.test(source.slice(...range))) mmrests.push(range);
        else staves[staves.length - 1].push(range);
        measureStart = -1;
      }
      if (name === "Score" && scoreDepth >= 0 && depth === scoreDepth + 1 && nestedStart >= 0) {
        nested.push([nestedStart, m.index + all.length]);
        nestedStart = -1;
      }
      if (name === "Staff" && scoreDepth >= 0 && depth === scoreDepth + 1) {
        staffEnds.push(m.index);
        bodies.push([bodyStart, m.index + all.length]);
      }
      if (name === "Part" && scoreDepth >= 0 && depth === scoreDepth + 1) partDefs.push([partStart, m.index + all.length]);
      if (name === "Score" && depth === scoreDepth) scoreDepth = -2;
      stack.pop();
      continue;
    }
    const depth = stack.length;
    if (name === "Score" && scoreDepth === -1) scoreDepth = depth;
    else if (name === "Score" && scoreDepth >= 0 && depth === scoreDepth + 1 && !self) nestedStart = m.index;
    if (scoreDepth >= 0 && name === "Staff" && depth === scoreDepth + 1 && !self) {
      staves.push([]);
      bodyStart = m.index;
      bodyTags.push([m.index, m.index + all.length]);
    }
    if (scoreDepth >= 0 && name === "Part" && depth === scoreDepth + 1 && !self) {
      partStart = m.index;
      partTags.push([m.index, m.index + all.length]);
    }
    if (scoreDepth >= 0 && name === "Staff" && depth === scoreDepth + 2 && stack[stack.length - 1] === "Part") defStaffTags.push([m.index, m.index + all.length]);
    if (scoreDepth >= 0 && name === "Measure" && depth === scoreDepth + 2) {
      if (self) staves[staves.length - 1].push([m.index, m.index + all.length]);
      else measureStart = m.index;
    }
    if (!self) stack.push(name);
  }
  return { staves, staffEnds, mmrests, nested, partDefs, bodies, partTags, defStaffTags, bodyTags };
}

/** A note's content for telling whether an edit changed it (ties, slurs, beams, accidentals left out: written again anyway). */
function fingerprint(notes: Element[]): string {
  const ser = new XMLSerializer();
  return notes
    .map((n) => {
      const c = n.cloneNode(true) as Element;
      for (const tag of ["tie", "beam", "accidental", "voice", "staff"]) for (const e of kids(c, tag)) e.remove();
      for (const nots of kids(c, "notations")) {
        for (const tag of ["tied", "slur"]) for (const e of kids(nots, tag)) e.remove();
        if (!nots.firstElementChild) nots.remove();
      }
      return ser.serializeToString(c);
    })
    .join("");
}

/**
 * Keeps, before a measure first changes, the content of its notes that came from the file,
 * so a save can tell which chords an edit left alone. (ScoreDoc.beforeChange calls it.)
 */
export function rememberMeasure(score: ScoreDoc, link: MscxLink, part: number, measure: number, prints: WeakMap<Element, string>): void {
  const meas = score.measures[part]?.[measure];
  if (!meas) return;
  for (const evs of readMeasure(meas).voices.values())
    for (const ev of evs) {
      if (link.chords.has(ev.notes[0])) prints.set(ev.notes[0], fingerprint(ev.notes));
      for (const g of ev.graces) if (link.chords.has(g)) prints.set(g, fingerprint([g]));
    }
}

interface Ctx {
  score: ScoreDoc;
  link: MscxLink;
  doc: Document;
  prints: WeakMap<Element, string>;
  dropped: Dropped;
  v4: boolean;
  /** Write every chord from the score, reusing none (to test the writer). */
  fresh: boolean;
  /** A score measure's index in the file (-1: added), and back. */
  origin: (m: number) => number;
  place: (o: number) => number;
}

// Each measure read once per save (reads are the costly part of writing a big score).
let reads = new WeakMap<Element, ReturnType<typeof readMeasure>>();
function read(meas: Element): ReturnType<typeof readMeasure> {
  let r = reads.get(meas);
  if (!r) reads.set(meas, (r = readMeasure(meas)));
  return r;
}
let pers = new Map<string, number>();

/** An event with where it is, in a voice's run through the score. */
interface Placed {
  m: number;
  per: number;
  ev: Event;
}

/** The events of one MusicXML voice of a part, through all its measures (cached per save). */
const runs = new WeakMap<ScoreDoc, Map<string, Placed[] & { index?: Map<string, number> }>>();
function voiceRun(score: ScoreDoc, part: number, key: string): Placed[] & { index?: Map<string, number> } {
  const cache = runs.get(score) ?? new Map<string, Placed[] & { index?: Map<string, number> }>();
  runs.set(score, cache);
  const hit = cache.get(`${part}|${key}`);
  if (hit) return hit;
  const out: Placed[] & { index?: Map<string, number> } = [];
  cache.set(`${part}|${key}`, out);
  score.measures[part].forEach((meas, m) => {
    const per = perQuarter(score, part, m);
    for (const ev of read(meas).voices.get(key) ?? []) out.push({ m, per, ev });
  });
  out.index = new Map(out.map((r, i) => [`${r.m}|${r.ev.pos}`, i]));
  return out;
}

/** A place a slur can end: an event's main notes (grace -1) or one of its grace chords. */
interface Holder {
  key: string;
  m: number;
  per: number;
  /** Divisions from the measure start. */
  pos: number;
  grace: number;
  notes: Element[];
  /** Quarters from the score start, then order within (grace chords before the notes). */
  t: number;
  order: number;
  /** Its index in the part's list. */
  i: number;
}

/** An event's grace notes as grace chords (a grace with <chord/> sounds with the one before). */
function graceChords(graces: Element[]): Element[][] {
  const out: Element[][] = [];
  for (const g of graces) {
    if (kid(g, "chord") && out.length) out[out.length - 1].push(g);
    else out.push([g]);
  }
  return out;
}

/** Grace chords in file order with MuseScore's index: those before the notes, then those after, last first. */
function graceSlots(graces: Element[]): { notes: Element[]; index: number; after: boolean; order: number }[] {
  const before = graceChords(graces.filter((g) => !isAfterGrace(g)));
  const after = graceChords(graces.filter(isAfterGrace));
  const n = before.length + after.length;
  return [...before.map((notes, i) => ({ notes, index: i, after: false, order: i })), ...after.map((notes, j) => ({ notes, index: n - 1 - j, after: true, order: 200 + j })).reverse()];
}

const holderCache = new WeakMap<ScoreDoc, Map<number, Holder[]>>();
let byPlace = new Map<string, Holder>();
/** Every place a slur can end in a part, in time order (cached per save). */
function holders(score: ScoreDoc, part: number): Holder[] {
  const cache = holderCache.get(score) ?? new Map<number, Holder[]>();
  holderCache.set(score, cache);
  const hit = cache.get(part);
  if (hit) return hit;
  const out: Holder[] = [];
  let start = 0;
  score.measures[part].forEach((meas, m) => {
    const per = perQuarter(score, part, m);
    let len = 0;
    for (const [key, evs] of read(meas).voices)
      for (const ev of evs) {
        len = Math.max(len, (ev.pos + ev.dur) / per);
        const t = start + ev.pos / per;
        for (const g of graceSlots(ev.graces)) out.push({ key, m, per, pos: ev.pos, grace: g.index, notes: g.notes, t, order: g.order, i: 0 });
        if (!ev.rest || ev.notes.some((n) => slursOf(n).length)) out.push({ key, m, per, pos: ev.pos, grace: -1, notes: ev.notes, t, order: 100, i: 0 });
      }
    start += len;
  });
  out.sort((a, b) => a.t - b.t || a.order - b.order);
  out.forEach((h, i) => {
    h.i = i;
    byPlace.set(`${part}|${h.key}|${h.m}|${h.pos}|${h.grace}`, h);
  });
  cache.set(part, out);
  return out;
}

/** Each slur end of a part (holder, index among its slur ends) with the holder of its other end. */
const slurPairs = new WeakMap<Holder[], Map<Holder, Map<number, Holder>>>();
function slurPartners(score: ScoreDoc, part: number): Map<Holder, Map<number, Holder>> {
  const all = holders(score, part);
  const hit = slurPairs.get(all);
  if (hit) return hit;
  const items: SlurItem<{ h: Holder; j: number }>[] = [];
  for (const h of all) {
    const [staff, voice] = h.key.split("|");
    h.notes.flatMap(slursOf).forEach((end, j) => items.push({ t: h.t, order: h.order, staff, voice, end, ref: { h, j } }));
  }
  const out = new Map<Holder, Map<number, Holder>>();
  const set = (a: { h: Holder; j: number }, b: Holder) => out.set(a.h, (out.get(a.h) ?? new Map()).set(a.j, b));
  for (const [a, b] of pairEnds(items)) {
    set(a, b.h);
    set(b, a.h);
  }
  slurPairs.set(all, out);
  return out;
}

/** The holder for an event's notes or one of its grace chords. */
function holderOf(score: ScoreDoc, part: number, key: string, m: number, pos: number, grace: number): Holder | null {
  holders(score, part);
  return byPlace.get(`${part}|${key}|${m}|${pos}|${grace}`) ?? null;
}

/** MuseScore's track of a voice key within a part: staff * 4 + voice. */
const trackOf = (key: string) => (Number(key.split("|")[0]) - 1) * 4 + ((((Number(key.split("|")[1]) || 1) - 1) % 4) + 4) % 4;

function perQuarter(score: ScoreDoc, part: number, m: number): number {
  const k = `${part}|${m}`;
  const hit = pers.get(k);
  if (hit !== undefined) return hit;
  const meas = score.measures[part][m];
  let per = 1;
  for (const a of [...score.attributesAt(part, m), ...kids(meas, "attributes").flatMap((x) => kids(x))]) if (a.tagName === "divisions") per = Number(a.textContent) || per;
  pers.set(k, per);
  return per;
}

function keyAt(score: ScoreDoc, part: number, m: number): number {
  let fifths = 0;
  for (const a of [...score.attributesAt(part, m), ...kids(score.measures[part][m], "attributes").flatMap((x) => kids(x))]) if (a.tagName === "key" && kid(a, "fifths")) fifths = Number(text(a, "fifths")) || 0;
  return fifths;
}

/** A relative location from one place to another (voices, measures, then whole-note fractions within, then notes of the chord). */
function location(doc: Document, fromM: number, fromPos: number, toM: number, toPos: number, per: number, voices = 0, notes = 0, grace = -1, staves = 0): Element {
  const loc = doc.createElementNS(null, "location");
  if (staves) add(loc, "staves", staves);
  if (voices) add(loc, "voices", voices);
  if (toM !== fromM) add(loc, "measures", toM - fromM);
  const d = toPos - fromPos;
  if (d) add(loc, "fractions", fraction(d, per));
  if (grace >= 0) add(loc, "grace", grace);
  if (notes) add(loc, "notes", notes);
  return loc;
}

function add(parent: Element, tag: string, value?: string | number): Element {
  const e = parent.ownerDocument.createElementNS(null, tag);
  if (value !== undefined) e.textContent = String(value);
  parent.appendChild(e);
  return e;
}

/** MuseScore's pitch (concert, as drawn under octave lines) and spelling of a MusicXML note. */
function pitchOf(ctx: Ctx, part: number, staff: number, m: number, posWhole: number, p: Pitch): { pitch: number; tpc: number; tpc2?: number } {
  const { chromatic, diatonic } = ctx.link.transpose[part];
  const written = TPC_BASE[p.step] + 7 * p.alter;
  // Octave lines as the file has them: a new bar takes the end of the one before.
  let fm = m;
  let fpos = posWhole;
  if (ctx.origin(m) < 0) {
    fm = -1;
    for (let j = m - 1; j >= 0 && fm < 0; j--) if (ctx.origin(j) >= 0) fm = ctx.origin(j);
    fpos = Number.MAX_SAFE_INTEGER;
  } else fm = ctx.origin(m);
  const ott = staff >= 0 && fm >= 0 ? ctx.link.ottavaAt(staff, fm, fpos) : 0;
  const pitch = midiOf(p) + chromatic - ott;
  if (!chromatic) return { pitch, tpc: written };
  return { pitch, tpc: written + 7 * chromatic - 12 * diatonic, tpc2: written };
}

/** The written value of a length, for durationType and dots. */
function valueOf(note: Element): { type: string; dots: number } {
  return { type: text(note, "type") || "quarter", dots: kids(note, "dot").length };
}

/**
 * Writes the edited measures back into the MuseScore file. Takes the file's bytes (.mscz, or
 * the text of a .mscx) and returns the new ones, with what could not be carried over.
 */
export function writeMuseScore(original: Uint8Array, score: ScoreDoc, link: MscxLink, dirty: Set<string>, prints: WeakMap<Element, string>, opts: { fresh?: boolean } = {}): { bytes: Uint8Array; dropped: Dropped } {
  const zipped = original[0] === 0x50 && original[1] === 0x4b;
  const files = zipped ? unzipSync(original) : null;
  const name = files ? Object.keys(files).find((n) => !n.startsWith("Excerpts/") && n.endsWith(".mscx")) : null;
  const source = files && name ? strFromU8(files[name]) : new TextDecoder().decode(original);
  if (source !== link.source) throw new Error("The file changed since it was opened");
  const { text: out, dropped } = writeMscxText(score, link, dirty, prints, opts);
  if (!files || !name) return { bytes: strToU8(out), dropped };
  // MuseScore's instrument parts (Excerpts/...) are scores of their own: the same bars are
  // written into each, or MuseScore would show them as they were.
  const parts = new Map<string, string>();
  const gone = new Set<string>();
  const view = partsView(score, link);
  try {
    for (const n of Object.keys(files).filter((x) => x.startsWith("Excerpts/") && x.endsWith(".mscx"))) {
      const text = strFromU8(files[n]);
      // The part of an instrument taken out goes with it.
      if (excerptGone(link, view, text, restaffed(score, link))) gone.add(n.slice(0, n.lastIndexOf("/") + 1));
      else {
        const sub = excerptLink(view, text);
        if (sub) parts.set(n, writeText(score, sub, dirty, prints, { fresh: true }, true, true).text);
      }
    }
  } finally {
    clearCaches(score);
  }
  const next: Zippable = {};
  for (const [n, data] of Object.entries(files)) {
    if ([...gone].some((dir) => n.startsWith(dir))) continue;
    next[n] = n === name ? strToU8(out) : parts.has(n) ? strToU8(parts.get(n)!) : data;
  }
  return { bytes: zipSync(next), dropped };
}

/** The .mscx text with the edited measures written again. */
export function writeMscxText(score: ScoreDoc, link: MscxLink, dirty: Set<string>, prints: WeakMap<Element, string>, opts: { fresh?: boolean } = {}): { text: string; dropped: Dropped } {
  try {
    return writeText(score, link, dirty, prints, opts);
  } finally {
    clearCaches(score);
  }
}

/** The caches hold the whole score: let it go once written. */
function clearCaches(score: ScoreDoc): void {
  runs.delete(score);
  holderCache.delete(score);
  byPlace = new Map();
  reads = new WeakMap();
  pers = new Map();
  wedgeCache = new Map();
}

/**
 * A MuseScore part (an excerpt) seen as the score's file: its staves are those of the score
 * its own staves link to. Null when none of them links to one.
 */
function excerptLink(main: MscxLink, source: string): MscxLink | null {
  const src = parseXml(source);
  const ms = src.documentElement;
  const sc = ms.tagName === "Score" ? ms : kid(ms, "Score");
  if (!sc) return null;
  const defs = (doc: Element) => kids(doc, "Part").flatMap((p) => kids(p, "Staff"));
  const mainScore = kid(main.src.documentElement, "Score");
  const mainDefs = mainScore ? defs(mainScore) : [];
  // Each staff of the part: the score's staff it is linked to (MuseScore 4: by eid, 3: by id).
  const toMain = defs(sc).map((st) => {
    const to = text(st, "linkedTo");
    return to ? mainDefs.findIndex((d) => text(d, "eid") === to || d.getAttribute("id") === to) : -1;
  });
  if (!toMain.some((x) => x >= 0)) return null;
  const toPart = new Map(toMain.map((m, i) => [m, i]));
  return {
    ...main,
    source,
    src,
    version: Number(ms.getAttribute("version")) || main.version,
    measures: kids(sc, "Staff").map((st) => kids(st, "Measure").filter((x) => !kid(x, "multiMeasureRest"))),
    staves: main.staves.map((list) => list.map((st) => (st < 0 ? -1 : (toPart.get(st) ?? -1)))),
    ottavaAt: (st, m, pos) => main.ottavaAt(toMain[st] ?? st, m, pos),
    chords: new WeakMap(),
  };
}

/** Each score part's file part (-1: added since). */
const partOrigin = (score: ScoreDoc, p: number) => (score.partOrigins ? (score.partOrigins[p] ?? -1) : p);

/** A part's transposition in the score, written to sounding, as MuseScore keeps it. */
function scoreTranspose(score: ScoreDoc, p: number): { chromatic: number; diatonic: number } {
  const tr = [...score.attributesAt(p, 0), ...kids(score.measures[p][0], "attributes").flatMap((a) => kids(a))].filter((e) => e.tagName === "transpose").pop();
  if (!tr) return { chromatic: 0, diatonic: 0 };
  const oct = Number(text(tr, "octave-change")) || 0;
  return { chromatic: (Number(text(tr, "chromatic")) || 0) + 12 * oct, diatonic: (Number(text(tr, "diatonic")) || 0) + 7 * oct };
}

/** The MuseScore instrument id a score part names (MusicXML's instrument-sound), if any. */
function soundOf(score: ScoreDoc, p: number): string {
  return scorePartOf(score, p)?.getElementsByTagName("instrument-sound")[0]?.textContent?.trim() ?? "";
}

/** A score part's part-list entry. */
function scorePartOf(score: ScoreDoc, p: number): Element | undefined {
  const id = score.parts[p]?.id;
  return Array.from(score.root.getElementsByTagName("score-part")).find((x) => x.getAttribute("id") === id);
}

/**
 * The file seen through the score's parts: each part's file staves (none for one added
 * since), its transposition and drums as the score has them now.
 */
function partsView(score: ScoreDoc, link: MscxLink): MscxLink {
  if (!score.partOrigins) return link;
  return {
    ...link,
    // A part with fewer staves now keeps its first ones.
    staves: score.parts.map((_, p) => (partOrigin(score, p) >= 0 ? (link.staves[partOrigin(score, p)] ?? []).slice(0, scoreStaves(score, p)) : [])),
    transpose: score.parts.map((_, p) => scoreTranspose(score, p)),
    drums: score.parts.map((_, p) => {
      const sp = scorePartOf(score, p);
      const map = new Map<string, number>();
      for (const mi of sp ? kids(sp, "midi-instrument") : []) if (kid(mi, "midi-unpitched")) map.set(mi.getAttribute("id") ?? "", (Number(text(mi, "midi-unpitched")) || 1) - 1);
      return map.size ? map : partOrigin(score, p) >= 0 ? (link.drums[partOrigin(score, p)] ?? null) : null;
    }),
  };
}

/** How many staves a score part has. */
function scoreStaves(score: ScoreDoc, p: number): number {
  const st = [...score.attributesAt(p, 0), ...kids(score.measures[p][0], "attributes").flatMap((a) => kids(a))].filter((e) => e.tagName === "staves").pop();
  return Number(st?.textContent) || 1;
}

/** File staves of the instruments taken out, and of the staves a part no longer has. */
function removedStaves(score: ScoreDoc, link: MscxLink): Set<number> {
  const kept = new Map(score.parts.map((_, p) => [partOrigin(score, p), p]));
  const out = new Set<number>();
  link.staves.forEach((list, o) => {
    const p = kept.get(o);
    list.forEach((st, k) => {
      if (st >= 0 && (p === undefined || k >= scoreStaves(score, p))) out.add(st);
    });
  });
  return out;
}

/** File staves of the parts whose number of staves changed. */
function restaffed(score: ScoreDoc, link: MscxLink): Set<number> {
  const out = new Set<number>();
  score.parts.forEach((_, p) => {
    const o = partOrigin(score, p);
    const list = o >= 0 ? (link.staves[o] ?? []).filter((st) => st >= 0) : [];
    if (o >= 0 && list.length !== scoreStaves(score, p)) for (const st of list) out.add(st);
  });
  return out;
}

/**
 * A MuseScore part (excerpt) all of whose staves belong to instruments taken out, or showing
 * an instrument whose number of staves changed (MuseScore makes that part again).
 */
function excerptGone(main: MscxLink, view: MscxLink, source: string, changed: Set<number> = new Set()): boolean {
  if (view === main) return false;
  const sub = excerptLink(main, source);
  if (!sub) return false;
  // The score staves the part shows.
  const shown = main.staves.flatMap((list, o) => list.filter((st, k) => st >= 0 && (sub.staves[o]?.[k] ?? -1) >= 0));
  const kept = new Set(view.staves.flat());
  return shown.length > 0 && (shown.every((st) => !kept.has(st)) || shown.some((st) => changed.has(st)));
}

/** The instrument a score part is: its sound, else one like it from its clefs and staves. */
function instrumentOfPart(score: ScoreDoc, p: number): InstrumentDef {
  const sound = soundOf(score, p);
  const known = INSTRUMENTS.find((x) => x.musescore === sound);
  if (known) return known;
  const clefs = Array.from(score.measures[p][0].getElementsByTagName("clef")).map((c) => {
    const sig = `${text(c, "sign")}${text(c, "line")}/${Number(text(c, "clef-octave-change")) || 0}`;
    return Object.entries(CLEFS).find(([, v]) => `${v.sign}${v.line}/${v.octave ?? 0}` === sig)?.[0] ?? "G";
  });
  const sp = scorePartOf(score, p);
  const mi = sp ? kid(sp, "midi-instrument") : null;
  return { key: "custom", family: "other", musescore: sound || "keyboard.piano", program: Math.max(0, (Number(text(mi, "midi-program")) || 1) - 1), clefs: clefs.length ? clefs : ["G"], short: score.parts[p]?.abbreviation || "" };
}

function writeText(score: ScoreDoc, link: MscxLink, dirty: Set<string>, prints: WeakMap<Element, string>, opts: { fresh?: boolean }, warm = false, part = false): { text: string; dropped: Dropped } {
  const fileLink = link;
  // Instruments added, taken out or changed: the file seen through the score's parts.
  if (!part) link = partsView(score, link);
  const gone = part ? new Set<number>() : removedStaves(score, fileLink);
  if (link.version < 3) throw new Error("Saving MuseScore 2 files is not supported yet");
  // A part written after the score reuses what the score's writing read.
  if (!warm) clearCaches(score);
  if (/<Tuplet id=/.test(link.source)) throw new Error("This MuseScore file writes tuplets the MuseScore 2 way, which scoredit cannot save yet");
  const original = link.measures[0]?.length ?? 0;
  // Bars added or taken out: each score measure's file measure (-1: a new one), and back.
  const origin = (m: number) => (score.origins ? (score.origins[m] ?? -1) : m < original ? m : -1);
  const places = new Map<number, number>();
  for (let m = 0; m < score.measureCount; m++) if (origin(m) >= 0) places.set(origin(m), m);
  const place = (o: number) => places.get(o) ?? -1;
  const ctx: Ctx = { score, link, doc: link.src, prints, dropped: {}, v4: link.version >= 4, fresh: !!opts.fresh, origin, place };
  const { staves: offsets, staffEnds, mmrests, nested } = measureOffsets(link.source);
  // Measures to write: the edited ones, and those holding the other end of their ties and slurs.
  const todo = new Map<number, Set<number>>();
  for (const k of dirty) {
    const [p, m] = k.split(":").map(Number);
    if (!todo.has(p)) todo.set(p, new Set());
    todo.get(p)!.add(m);
  }
  for (const [p, ms] of todo) for (const m of [...ms]) for (const other of partnerMeasures(score, p, m)) ms.add(other);
  // Replacements in the text: [start, end, new text], applied from the end.
  const edits: [number, number, string][] = [];
  const ser = new XMLSerializer();
  // A new measure goes after the file's measure of the nearest one before it.
  const insertAt = (staff: number, m: number) => {
    for (let j = m - 1; j >= 0; j--) if (origin(j) >= 0 && offsets[staff]?.[origin(j)]) return offsets[staff][origin(j)][1];
    return offsets[staff]?.[0]?.[0] ?? staffEnds[staff];
  };
  const put = (staff: number, m: number, xml: string) => {
    const o = origin(m);
    if (o >= 0 && offsets[staff]?.[o]) edits.push([offsets[staff][o][0], offsets[staff][o][1], xml]);
    else if (o < 0) {
      const at = insertAt(staff, m);
      edits.push([at, at, at === staffEnds[staff] ? `${xml}\n` : `\n${xml}`]);
    }
  };
  const written = new Set<string>();
  for (const [p, ms] of todo) {
    link.staves[p]?.forEach((staff, k) => {
      if (staff < 0) return;
      for (const m of [...ms].sort((a, b) => a - b)) {
        put(staff, m, xmlOf(ser, writeMeasure(ctx, p, k, staff, m)));
        written.add(`${staff}:${m}`);
      }
    });
  }
  // Every staff gets the added measures, even staves of parts the edit did not touch.
  const lastLen = link.lengths[original - 1] ?? 1;
  link.measures.forEach((_, staff) => {
    if (gone.has(staff)) return;
    for (let m = 0; m < score.measureCount; m++) {
      if (origin(m) >= 0 || written.has(`${staff}:${m}`)) continue;
      const meas = ctx.doc.createElementNS(null, "Measure");
      const r = add(add(meas, "voice"), "Rest");
      add(r, "durationType", "measure");
      add(r, "duration", fraction(Math.round(lastLen * 4 * 480), 480));
      put(staff, m, xmlOf(ser, meas));
    }
  });
  if (score.origins) {
    // Measures taken out go; lines in the others that cross the change point to their bar again.
    link.measures.forEach((list, staff) => {
      if (gone.has(staff)) return;
      list.forEach((meas, o) => {
        const m = place(o);
        if (m < 0) {
          if (offsets[staff]?.[o]) edits.push([offsets[staff][o][0], offsets[staff][o][1], ""]);
          return;
        }
        if (written.has(`${staff}:${m}`)) return;
        const copy = meas.cloneNode(true) as Element;
        if (moveSpanners(copy, o, m, place) && offsets[staff]?.[o]) edits.push([offsets[staff][o][0], offsets[staff][o][1], xmlOf(ser, copy)]);
      });
    });
  }
  if (part && edits.length) {
    // A part's multi-measure rests may no longer be empty bars: MuseScore makes them again.
    for (const r of mmrests) edits.push([r[0], r[1], ""]);
  }
  if (part && score.partOrigins) excerptInstrumentEdits(ctx, edits);
  if (!part)
    for (const [s0, e0] of nested) {
      if (excerptGone(fileLink, link, link.source.slice(s0, e0), restaffed(score, fileLink))) {
        edits.push([s0, e0, ""]);
        continue;
      }
      const sub = excerptLink(link, link.source.slice(s0, e0));
      if (sub) edits.push([s0, e0, writeText(score, sub, dirty, prints, { fresh: true }, true, true).text]);
    }
  if (!part && score.partOrigins) instrumentEdits(ctx, fileLink, edits, gone);
  // Applied from the end, so earlier offsets stay right; measures added at one staff's end
  // keep the order they were made in.
  const order = edits.map((e, i) => [...e, i] as const).sort((a, b) => b[0] - a[0] || b[1] - a[1] || b[3] - a[3]);
  let out = link.source;
  for (const [s0, e0, t] of order) out = out.slice(0, s0) + t + out.slice(e0);
  if (!part && score.partOrigins) out = renumberStaves(reorderParts(out, score), staffNumbers(score, fileLink));
  return { text: out, dropped: ctx.dropped };
}

/**
 * Instruments taken out (their definition and staves go), added (a definition and every bar
 * written) or changed (names, sound, the definition anew for another instrument).
 */
function instrumentEdits(ctx: Ctx, fileLink: MscxLink, edits: [number, number, string][], gone: Set<number>): void {
  const { score } = ctx;
  const off = measureOffsets(fileLink.source);
  const kept = new Set(score.parts.map((_, p) => partOrigin(score, p)));
  fileLink.staves.forEach((_, o) => {
    if (!kept.has(o) && off.partDefs[o]) edits.push([off.partDefs[o][0], off.partDefs[o][1], ""]);
  });
  for (const st of gone) if (off.bodies[st]) edits.push([off.bodies[st][0], off.bodies[st][1], ""]);
  const ser = new XMLSerializer();
  const mainScore = kid(fileLink.src.documentElement, "Score");
  const defs = mainScore ? kids(mainScore, "Part") : [];
  const afterDefs = off.partDefs.length ? off.partDefs[off.partDefs.length - 1][1] : 0;
  const afterBodies = off.bodies.length ? off.bodies[off.bodies.length - 1][1] : 0;
  let staffCount = fileLink.measures.length;
  // A new part takes the next id after the file's own.
  let nextId = Math.max(0, ...defs.map((d) => Number(d.getAttribute("id")) || 0), defs.length) + 1;
  score.parts.forEach((info, p) => {
    const o = partOrigin(score, p);
    const def = instrumentOfPart(score, p);
    const sound = soundOf(score, p);
    const name = info.name;
    if (o < 0) {
      // A new instrument: its definition after the others, its staves after theirs.
      edits.push([afterDefs, afterDefs, partXml(def, name, nextId++, staffCount + 1)]);
      def.clefs.forEach((_, k) => {
        const bars = Array.from({ length: score.measureCount }, (_, m) => xmlOf(ser, writeMeasure(ctx, p, k, -1, m)));
        edits.push([afterBodies, afterBodies, `\n    <Staff id="${staffCount + 1}">\n      ${bars.join("\n      ")}\n      </Staff>`]);
        staffCount++;
      });
      return;
    }
    const old = defs[o];
    if (!old || !off.partDefs[o]) return;
    // More staves than the file has: the new ones after the part's last.
    const fileStaves = (fileLink.staves[o] ?? []).filter((st) => st >= 0);
    const count = scoreStaves(score, p);
    const lastBody = off.bodies[fileStaves[Math.min(fileStaves.length, count) - 1]];
    for (let k = fileStaves.length; k < count && lastBody; k++) {
      const bars = Array.from({ length: score.measureCount }, (_, m) => xmlOf(ser, writeMeasure(ctx, p, k, -1, m)));
      edits.push([lastBody[1], lastBody[1], `\n    <Staff id="${++staffCount}">\n      ${bars.join("\n      ")}\n      </Staff>`]);
    }
    const inst = kid(old, "Instrument");
    if ((sound && inst && text(inst, "instrumentId") !== sound) || kids(old, "Staff").length !== count) {
      // Another instrument: its definition anew; the staves (and what links to them) stay.
      edits.push([off.partDefs[o][0], off.partDefs[o][1], xmlOf(ser, swapInstrument(old, def, name, count))]);
      return;
    }
    // The same instrument: its names and sound as the score has them.
    const copy = old.cloneNode(true) as Element;
    const ci = kid(copy, "Instrument");
    let changed = false;
    const set = (parent: Element | null, tag: string, value: string) => {
      const e = parent ? kid(parent, tag) : null;
      if (e && e.textContent !== value) {
        e.textContent = value;
        changed = true;
      }
    };
    set(copy, "trackName", name);
    set(ci, "longName", name);
    set(ci, "trackName", name);
    if (info.abbreviation) set(ci, "shortName", info.abbreviation);
    const prog = info.program;
    const pe = ci ? kid(kid(ci, "Channel") ?? ci, "program") : null;
    if (pe && prog !== null && prog < 128 && pe.getAttribute("value") !== String(prog)) {
      pe.setAttribute("value", String(prog));
      changed = true;
    }
    if (changed) edits.push([off.partDefs[o][0], off.partDefs[o][1], xmlOf(ser, copy)]);
  });
}

/** A part definition with another instrument: its names, clefs and <Instrument> anew, its staves kept. */
function swapInstrument(old: Element, def: InstrumentDef, name: string, count = kids(old, "Staff").length): Element {
  const copy = old.cloneNode(true) as Element;
  const doc = copy.ownerDocument;
  // Another number of staves: the last ones go, or new ones follow; a brace over two or more.
  const staffDefs = kids(copy, "Staff");
  for (const st of staffDefs.slice(count)) st.remove();
  for (let k = staffDefs.length; k < count; k++) {
    const st = doc.createElementNS(null, "Staff");
    const prev = kids(copy, "Staff").pop()!;
    st.setAttribute("id", String((Number(prev.getAttribute("id")) || k) + 1));
    const type = doc.createElementNS(null, "StaffType");
    type.setAttribute("group", "pitched");
    st.appendChild(type);
    prev.after(st);
  }
  if (count !== staffDefs.length) {
    const first = kids(copy, "Staff")[0];
    for (const b of kids(first, "bracket")) if (b.getAttribute("type") === "1") b.remove();
    for (const b of kids(first, "barLineSpan")) b.remove();
    if (count > 1) {
      const br = doc.createElementNS(null, "bracket");
      for (const [a, v] of [["type", "1"], ["span", String(count)], ["col", "0"]]) br.setAttribute(a, v);
      const span = doc.createElementNS(null, "barLineSpan");
      span.textContent = "1";
      const after = kid(first, "StaffType");
      first.insertBefore(span, after ? after.nextSibling : first.firstChild);
      first.insertBefore(br, span);
    }
  }
  const fresh = parseXml(`<x>${partXml(def, name, 1, 1)}</x>`).documentElement;
  const freshPart = kid(fresh, "Part")!;
  const inst = doc.importNode(kid(freshPart, "Instrument")!, true) as Element;
  const oldInst = kid(copy, "Instrument");
  if (oldInst) oldInst.replaceWith(inst);
  else copy.appendChild(inst);
  const track = kid(copy, "trackName");
  if (track) track.textContent = name;
  kids(copy, "Staff").forEach((st, k) => {
    for (const d of kids(st, "defaultClef")) d.remove();
    const clef = def.clefs[k];
    if (clef && clef !== "G") {
      const d = doc.createElementNS(null, "defaultClef");
      d.textContent = clef;
      st.appendChild(d);
    }
  });
  return copy;
}

/** A MuseScore part file's own definitions of the instruments changed in the score, and its name. */
function excerptInstrumentEdits(ctx: Ctx, edits: [number, number, string][]): void {
  const { score, link } = ctx;
  const sc = link.src.documentElement.tagName === "Score" ? link.src.documentElement : kid(link.src.documentElement, "Score");
  if (!sc) return;
  const off = measureOffsets(link.source);
  const defs = kids(sc, "Part");
  // Which part definition holds each of the part file's staves.
  const holder: number[] = [];
  defs.forEach((d, i) => kids(d, "Staff").forEach(() => holder.push(i)));
  const ser = new XMLSerializer();
  score.parts.forEach((info, p) => {
    const st = link.staves[p]?.find((x) => x >= 0);
    if (st === undefined || holder[st] === undefined) return;
    const i = holder[st];
    const old = defs[i];
    const sound = soundOf(score, p);
    const inst = kid(old, "Instrument");
    if (!sound || !inst || text(inst, "instrumentId") === sound || !off.partDefs[i]) return;
    edits.push([off.partDefs[i][0], off.partDefs[i][1], xmlOf(ser, swapInstrument(old, instrumentOfPart(score, p), info.name))]);
    // The part named after its instrument is named after the new one.
    const oldName = text(old, "trackName");
    const re = /<metaTag name="partName">([^<]*)<\/metaTag>/;
    const m = re.exec(link.source);
    if (m && m[1] === oldName) edits.push([m.index, m.index + m[0].length, `<metaTag name="partName">${info.name.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</metaTag>`]);
  });
}

/** The parts as the written text has them: the file's in file order, then the added ones. */
function writtenOrder(score: ScoreDoc): number[] {
  const kept = score.parts.map((_, p) => p).filter((p) => partOrigin(score, p) >= 0);
  kept.sort((a, b) => partOrigin(score, a) - partOrigin(score, b));
  return [...kept, ...score.parts.map((_, p) => p).filter((p) => partOrigin(score, p) < 0)];
}

/** Each file staff's number once written (1 up, in the score's order), for MuseScore 3's parts. */
function staffNumbers(score: ScoreDoc, fileLink: MscxLink): Map<number, number> {
  const map = new Map<number, number>();
  let next = 1;
  score.parts.forEach((_, p) => {
    const o = partOrigin(score, p);
    const file = o >= 0 ? (fileLink.staves[o] ?? []).filter((st) => st >= 0) : [];
    for (let k = 0; k < scoreStaves(score, p); k++) {
      if (file[k] !== undefined) map.set(file[k] + 1, next);
      next++;
    }
  });
  return map;
}

const FRAME = /<(VBox|HBox|TBox|FBox)\b[^>]*>[\s\S]*?<\/\1>\s*/g;

/**
 * Part definitions and staves in the score's order. Frames (title, text) live on the first
 * staff: they move to the one that comes first now, between the same bars.
 */
function reorderParts(text0: string, score: ScoreDoc): string {
  const have = writtenOrder(score);
  if (have.every((p, i) => p === i)) return text0;
  const off = measureOffsets(text0);
  const defText = off.partDefs.map(([a, b]) => text0.slice(a, b));
  const bodyText = off.bodies.map(([a, b]) => text0.slice(a, b));
  // Staves of each part, in the written order.
  const groups: string[][] = [];
  let at = 0;
  for (const p of have) {
    const n = scoreStaves(score, p);
    groups.push(bodyText.slice(at, at + n));
    at += n;
  }
  if (have[0] !== 0 && groups[0]?.[0] && groups[have.indexOf(0)]?.[0]) {
    const from = groups[0][0];
    const frames: { before: number; text: string }[] = [];
    for (const m of from.matchAll(FRAME)) frames.push({ before: (from.slice(0, m.index).match(/<Measure[ >]/g) ?? []).length, text: m[0] });
    groups[0][0] = from.replace(FRAME, "");
    let to = groups[have.indexOf(0)][0];
    for (const f of [...frames].reverse()) {
      const starts = [...to.matchAll(/<Measure[ >]/g)].map((x) => x.index ?? 0);
      const pos = starts[f.before] ?? to.lastIndexOf("</Staff>");
      to = to.slice(0, pos) + f.text + to.slice(pos);
    }
    groups[have.indexOf(0)][0] = to;
  }
  const defs = score.parts.map((_, p) => defText[have.indexOf(p)]);
  const bodies = score.parts.flatMap((_, p) => groups[have.indexOf(p)]);
  const edits: [number, number, string][] = [...off.partDefs.map(([a, b], i) => [a, b, defs[i]] as [number, number, string]), ...off.bodies.map(([a, b], i) => [a, b, bodies[i]] as [number, number, string])];
  let out = text0;
  for (const [a, b, t] of edits.sort((x, y) => y[0] - x[0])) out = out.slice(0, a) + t + out.slice(b);
  return out;
}

/** Parts and staves numbered again in order (and MuseScore 3's parts pointing to them by number). */
function renumberStaves(text0: string, map: Map<number, number>): string {
  const off = measureOffsets(text0);
  const edits: [number, number, string][] = [];
  const retag = (ranges: [number, number][], from: number) =>
    ranges.forEach(([a, b], i) => {
      const tag = text0.slice(a, b);
      if (/\sid="\d+"/.test(tag)) edits.push([a, b, tag.replace(/\sid="\d+"/, ` id="${i + from}"`)]);
    });
  // Part ids stay: MuseScore's part files find their instrument by them.
  retag(off.defStaffTags, 1);
  retag(off.bodyTags, 1);
  // MuseScore 3 parts name the score's staves by their old numbers.
  for (const [a, b] of off.nested) {
    const inner = text0.slice(a, b).replace(/(<Part>[\s\S]*?<\/Part>)/g, (part) => part.replace(/<linkedTo>(\d+)<\/linkedTo>/g, (all, n) => (map.has(Number(n)) ? `<linkedTo>${map.get(Number(n))}</linkedTo>` : all)));
    if (inner !== text0.slice(a, b)) edits.push([a, b, inner]);
  }
  let out = text0;
  for (const [a, b, t] of edits.sort((x, y) => y[0] - x[0])) out = out.slice(0, a) + t + out.slice(b);
  return out;
}

/**
 * Lines (<Spanner> next/prev) in a file measure o, now measure m, counted again to their
 * other end's new measure; one whose other end was taken out goes. True if any changed.
 */
function moveSpanners(root: Element, o: number, m: number, place: (o: number) => number): boolean {
  let changed = false;
  for (const sp of Array.from(root.getElementsByTagName("Spanner"))) {
    for (const end of [kid(sp, "next"), kid(sp, "prev")]) {
      const loc = end ? kid(end, "location") : null;
      if (!loc) continue;
      const d = Number(text(loc, "measures")) || 0;
      const to = place(o + d);
      if (to < 0) {
        sp.remove();
        changed = true;
        break;
      }
      if (to - m === d) continue;
      changed = true;
      let el = kid(loc, "measures");
      if (to - m === 0) el?.remove();
      else {
        if (!el) {
          el = loc.ownerDocument.createElementNS(null, "measures");
          loc.insertBefore(el, loc.firstChild);
        }
        el.textContent = String(to - m);
      }
    }
  }
  return changed;
}

/** XML text of an element; named entities a DOM may write (&nbsp;) as character references. */
function xmlOf(ser: XMLSerializer, el: Element): string {
  const NAMED: Record<string, number> = { nbsp: 160, copy: 169, reg: 174, shy: 173, hellip: 8230, ndash: 8211, mdash: 8212 };
  return ser.serializeToString(el).replace(/&([a-zA-Z]+);/g, (all, n) => (["amp", "lt", "gt", "quot", "apos"].includes(n) ? all : NAMED[n] ? `&#${NAMED[n]};` : all));
}

/** Measures holding the other ends of ties and slurs that start or end in measure m of a part. */
function partnerMeasures(score: ScoreDoc, part: number, m: number): number[] {
  const out = new Set<number>();
  const meas = score.measures[part][m];
  if (!meas) return [];
  for (const [key, evs] of read(meas).voices) {
    const gliss = (n: Element) => spansOf(n).some((x) => x.kind === "glissando" || x.kind === "slide");
    if (!evs.some((e) => !e.rest && e.notes.some((n) => kids(n, "tie").length || gliss(n)))) continue;
    const run = voiceRun(score, part, key);
    for (const ev of evs) {
      const i = run.index?.get(`${m}|${ev.pos}`) ?? -1;
      if (ev.notes.some((n) => kids(n, "tie").some((t) => t.getAttribute("type") === "start")) && run[i + 1]) out.add(run[i + 1].m);
      if (ev.notes.some((n) => kids(n, "tie").some((t) => t.getAttribute("type") === "stop")) && run[i - 1]) out.add(run[i - 1].m);
      if (ev.notes.some(gliss)) for (const r of [run[i - 1], run[i + 1]]) if (r) out.add(r.m);
    }
  }
  const pairs = slurPartners(score, part);
  for (const h of holders(score, part)) if (h.m === m) for (const o of pairs.get(h)?.values() ?? []) out.add(o.m);
  out.delete(m);
  return [...out];
}

/** The new <Measure> for one staff: the original's own content, its voices written again. */
function writeMeasure(ctx: Ctx, part: number, k: number, staff: number, m: number): Element {
  const { score, link, doc } = ctx;
  const o = ctx.origin(m);
  const orig = o >= 0 ? (link.measures[staff]?.[o] ?? null) : null;
  const meas = orig ? (orig.cloneNode(false) as Element) : doc.createElementNS(null, "Measure");
  if (orig) for (const c of kids(orig)) if (c.tagName !== "voice") meas.appendChild(c.cloneNode(true));
  // A staff of an instrument added since: its bars as long as the first staff's, repeats and all.
  const like = !orig && staff < 0 && o >= 0 ? link.measures[0]?.[o] : null;
  if (like) {
    for (const a of Array.from(like.attributes)) meas.setAttribute(a.name, a.value);
    for (const c of kids(like)) if (["irregular", "startRepeat", "endRepeat", "breakMultiMeasureRest"].includes(c.tagName)) meas.appendChild(c.cloneNode(true));
  }
  // What the original voices hold besides notes, at its position (whole notes); lines in
  // them point to their other end's bar again when bars were added or taken out.
  const kept = new Map<number, Kept[]>();
  (orig ? kids(orig, "voice") : []).forEach((v, vi) =>
    kept.set(
      vi,
      keptItems(v, link.lengths[o] ?? 1).flatMap((it) => {
        const el = it.el.cloneNode(true) as Element;
        const holder = doc.createElementNS(null, "voice");
        holder.appendChild(el);
        moveSpanners(holder, o, m, ctx.place);
        return holder.firstElementChild ? [{ ...it, el: holder.firstElementChild }] : [];
      }),
    ),
  );
  if (orig) moveSpanners(meas, o, m, ctx.place);
  const xml = score.measures[part][m];
  const per = perQuarter(score, part, m);
  const voices = new Map<number, Event[]>();
  for (const [key, evs] of read(xml).voices) {
    const [st, voice] = key.split("|");
    if (Number(st) !== k + 1) continue;
    const vi = (((Number(voice) || 1) - 1) % 4 + 4) % 4;
    voices.set(vi, [...(voices.get(vi) ?? []), ...evs].sort((a, b) => a.pos - b.pos));
  }
  placeDirections(ctx, part, k, m, kept);
  placeHarmonies(ctx, part, k, m, kept);
  // Tab and drum staves keep their clefs as the file has them.
  if (staffGroup(ctx, staff) === "pitched") placeClefs(ctx, part, k, m, kept);
  placeKey(ctx, part, k, m, kept);
  placeTime(ctx, part, m, kept);
  const accidentals = accidentalsFor(score, part, m, k + 1);
  const top = Math.max(-1, ...kept.keys(), ...voices.keys());
  for (let vi = 0; vi <= top; vi++) {
    const v = add(meas, "voice");
    const key = [...read(xml).voices.keys()].find((x) => x.startsWith(`${k + 1}|`) && ((((Number(x.split("|")[1]) || 1) - 1) % 4) + 4) % 4 === vi) ?? voiceKey(k + 1, String(k * 4 + vi + 1));
    writeVoice(ctx, v, part, k, staff, m, per, key, voices.get(vi) ?? [], kept.get(vi) ?? [], accidentals);
  }
  return meas;
}

// ---- Dynamics, hairpins, text, tempo and rehearsal marks: written from the score's directions,
// reusing the file's own element where one at the same place says the same.

/** What an original voice element says, when it is one written from the score (else null: kept). */
function fileDirection(c: Element): Direction | null {
  const words = () => plain(kid(c, "text"));
  switch (c.tagName) {
    case "Dynamic": {
      if (text(c, "visible") === "0") return null;
      const sub = text(c, "subtype");
      // As the reader has it: a dynamic of its own words is expression text.
      return /^[pmfsrzn]+$/.test(sub) ? { kind: "dynamic", value: sub } : { kind: "text", text: "expression", words: words() || sub };
    }
    case "StaffText":
    case "SystemText":
      return words() ? { kind: "text", text: text(c, "placement") === "below" ? "expression" : "staff", words: words() } : null;
    case "Expression":
      return words() ? { kind: "text", text: "expression", words: words() } : null;
    case "RehearsalMark":
      return words() ? { kind: "text", text: "rehearsal", words: words() } : null;
    case "Tempo":
      return text(c, "visible") === "0" ? null : { kind: "tempo", bpm: Math.round(Number(text(c, "tempo")) * 60 * 100) / 100, words: words() };
    case "Spanner": {
      if (c.getAttribute("type") !== "HairPin") return null;
      if (!kid(c, "next")) return { kind: "wedge", type: "stop", number: 0 };
      const sub = Number(text(kid(c, "HairPin"), "subtype"));
      return { kind: "wedge", type: sub === 1 || sub === 3 ? "diminuendo" : "crescendo", number: 0 };
    }
  }
  return null;
}

function sameDirection(a: Direction, b: Direction): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "dynamic" && b.kind === "dynamic") return a.value === b.value;
  if (a.kind === "text" && b.kind === "text") return a.text === b.text && a.words.trim() === b.words.trim();
  if (a.kind === "tempo" && b.kind === "tempo") return Math.abs(a.bpm - b.bpm) < 0.01 && a.words.trim() === b.words.trim();
  if (a.kind === "wedge" && b.kind === "wedge") return a.type === b.type;
  return false;
}

interface Wedge {
  m: number;
  /** Whole notes from the measure start. */
  pos: number;
  el: Element;
  partner: Wedge | null;
}

let wedgeCache = new Map<number, Map<Element, Wedge>>();
/** A part's hairpin ends, each with the other end (a start, the next stop of its number on its staff). */
function wedgesOf(score: ScoreDoc, part: number): Map<Element, Wedge> {
  const hit = wedgeCache.get(part);
  if (hit) return hit;
  const out = new Map<Element, Wedge>();
  const open = new Map<string, Wedge>();
  score.measures[part].forEach((meas, m) => {
    const per = perQuarter(score, part, m);
    const list = read(meas)
      .others.filter((o) => o.el.tagName === "direction")
      .flatMap((o) => {
        const d = directionOf(o.el);
        return d?.kind === "wedge" ? [{ o, d }] : [];
      })
      .sort((a, b) => a.o.pos - b.o.pos || (a.d.type === "stop" ? -1 : 0) - (b.d.type === "stop" ? -1 : 0));
    for (const { o, d } of list) {
      if (d.kind !== "wedge") continue;
      const w: Wedge = { m, pos: Math.max(0, o.pos) / per / 4, el: o.el, partner: null };
      const key = `${Number(text(o.el, "staff")) || 1}|${d.number}`;
      out.set(o.el, w);
      if (d.type === "stop") {
        const start = open.get(key);
        if (start) {
          start.partner = w;
          w.partner = start;
          open.delete(key);
        }
      } else open.set(key, w);
    }
  });
  wedgeCache.set(part, out);
  return out;
}

/** Takes the kept voice items written from the score out, and puts the score's directions in their place. */
function placeDirections(ctx: Ctx, part: number, k: number, m: number, kept: Map<number, Kept[]>): void {
  const { score, doc } = ctx;
  const pool: { vi: number; pos: number; el: Element; d: Direction; timeTick?: boolean; used?: boolean }[] = [];
  for (const [vi, list] of kept)
    kept.set(
      vi,
      list.filter((it) => {
        const d = fileDirection(it.el);
        if (d) pool.push({ vi, pos: it.pos, el: it.el, d, timeTick: it.timeTick });
        return !d;
      }),
    );
  const per = perQuarter(score, part, m);
  const wedges = wedgesOf(score, part);
  const own = read(score.measures[part][m]).others.filter((o) => o.el.tagName === "direction" && (Number(text(o.el, "staff")) || 1) === k + 1);
  for (const o of own) {
    const d = directionOf(o.el);
    if (!d) continue;
    const pos = Math.max(0, o.pos) / per / 4;
    const hit = pool.find((x) => !x.used && Math.abs(x.pos - pos) < 1e-9 && sameDirection(x.d, d));
    if (hit) hit.used = true;
    let el: Element;
    const w = d.kind === "wedge" ? wedges.get(o.el) : undefined;
    if (d.kind === "wedge" && w?.partner) {
      el = doc.createElementNS(null, "Spanner");
      el.setAttribute("type", "HairPin");
      const start = d.type !== "stop";
      if (start) {
        const look = hit ? kid(hit.el, "HairPin") : null;
        if (look) el.appendChild(look.cloneNode(true));
        else add(add(el, "HairPin"), "subtype", d.type === "diminuendo" ? 1 : 0);
      }
      add(el, start ? "next" : "prev").appendChild(location(doc, m, Math.round(pos * 4 * per), w.partner.m, Math.round(w.partner.pos * 4 * per), per));
    } else if (hit) el = hit.el;
    // A hairpin end without its other end, and not in the file: left out.
    else if (d.kind === "wedge") continue;
    else el = newDirection(ctx, d);
    const vi = hit?.vi ?? 0;
    const list = kept.get(vi) ?? [];
    list.push({ pos, el, timeTick: hit?.timeTick });
    kept.set(vi, list);
  }
  for (const list of kept.values()) list.sort((a, b) => a.pos - b.pos);
}

/** Concert fifths of the key a part's measure starts with on staff k (own: in its attributes at the start, else null). */
function keyOf(ctx: Ctx, part: number, k: number, m: number, own: boolean): number | null {
  const els = own
    ? read(ctx.score.measures[part][m]).others.filter((o) => o.el.tagName === "attributes" && o.pos <= 0).flatMap((o) => kids(o.el, "key"))
    : ctx.score.attributesAt(part, m).filter((e) => e.tagName === "key");
  const key = els.find((e) => !e.getAttribute("number") || Number(e.getAttribute("number")) === k + 1);
  if (!key) return null;
  const { chromatic, diatonic } = ctx.link.transpose[part];
  return (Number(text(key, "fifths")) || 0) + (chromatic ? 7 * chromatic - 12 * diatonic : 0);
}

/** A file staff's kind: pitched, tablature or percussion (its StaffType group). */
function staffGroup(ctx: Ctx, staff: number): string {
  const sc = kid(ctx.link.src.documentElement, "Score");
  const def = sc ? kids(sc, "Part").flatMap((p) => kids(p, "Staff"))[staff] : undefined;
  return (def && kid(def, "StaffType")?.getAttribute("group")) || "pitched";
}

/** MuseScore's clef types, as MusicXML's sign, line and octave change. */
const CLEF_TYPES: [string, string, number, number][] = [
  ["G", "G", 2, 0], ["G8va", "G", 2, 1], ["G15ma", "G", 2, 2], ["G8vb", "G", 2, -1], ["F", "F", 4, 0], ["F8vb", "F", 4, -1], ["F15mb", "F", 4, -2],
  ["F3", "F", 3, 0], ["F5", "F", 5, 0], ["C1", "C", 1, 0], ["C2", "C", 2, 0], ["C3", "C", 3, 0], ["C4", "C", 4, 0], ["C5", "C", 5, 0],
  ["PERC", "percussion", 2, 0], ["PERC", "percussion", 3, 0],
];
const clefSig = (sign: string, line: number, octave: number) => `${sign}${line}/${octave}`;
/** A MuseScore clef's sign, or null for one written as the file has it (tab, percussion, unknown). */
function fileClef(c: Element): string | null {
  const type = text(c, "concertClefType") || text(c, "transposingClefType") || "G";
  const t = CLEF_TYPES.find(([n]) => n === type) ?? (type === "G8vbo" ? CLEF_TYPES[3] : null);
  return t ? clefSig(t[1], t[2], t[3]) : null;
}

/** The clefs of a staff in a measure, from the score; the file's own where they say the same. */
function placeClefs(ctx: Ctx, part: number, k: number, m: number, kept: Map<number, Kept[]>): void {
  const per = perQuarter(ctx.score, part, m);
  const want = read(ctx.score.measures[part][m])
    .others.filter((o) => o.el.tagName === "attributes")
    .flatMap((o) =>
      kids(o.el, "clef")
        .filter((c) => (Number(c.getAttribute("number")) || 1) === k + 1)
        .map((c) => ({ pos: Math.max(0, o.pos) / per / 4, sig: clefSig(text(c, "sign"), Number(text(c, "line")) || 0, Number(text(c, "clef-octave-change")) || 0) })),
    )
    .filter((c) => CLEF_TYPES.some(([, ...x]) => clefSig(...(x as [string, number, number])) === c.sig));
  const used = new Set<Kept>();
  const missing: { pos: number; sig: string }[] = [];
  for (const w of want) {
    const hit = [...kept.values()].flat().find((it) => !used.has(it) && it.el.tagName === "Clef" && Math.abs(it.pos - w.pos) < 1e-9 && fileClef(it.el) === w.sig);
    if (hit) used.add(hit);
    else missing.push(w);
  }
  // The file's clefs no longer in the score go (tab and percussion ones stay).
  for (const [vi, list] of kept) kept.set(vi, list.filter((it) => it.el.tagName !== "Clef" || used.has(it) || fileClef(it.el) === null));
  const list = kept.get(0) ?? [];
  for (const w of missing) {
    const type = CLEF_TYPES.find(([, ...x]) => clefSig(...(x as [string, number, number])) === w.sig)![0];
    const el = ctx.doc.createElementNS(null, "Clef");
    add(el, "concertClefType", type);
    add(el, "transposingClefType", type);
    if (m === 0 && w.pos <= 1e-9) add(el, "isHeader", 1);
    const at = w.pos <= 1e-9 ? 0 : list.findIndex((it) => it.pos > w.pos + 1e-9);
    list.splice(at < 0 ? list.length : at, 0, { pos: w.pos, el });
  }
  kept.set(0, list);
}

/** The key signature a measure starts with, from the score; the file's own when it says the same. */
function placeKey(ctx: Ctx, part: number, k: number, m: number, kept: Map<number, Kept[]>): void {
  let orig: { vi: number; at: number; item: Kept } | null = null;
  for (const [vi, list] of kept) {
    const at = list.findIndex((it) => it.el.tagName === "KeySig" && it.pos <= 1e-9);
    if (at >= 0 && !orig) orig = { vi, at, item: list[at] };
    if (at >= 0) list.splice(at, 1);
  }
  const want = keyOf(ctx, part, k, m, true);
  if (want === null) return;
  const before = m > 0 ? (keyOf(ctx, part, k, m, false) ?? 0) : 0;
  const was = orig ? Number(text(orig.item.el, "concertKey") || text(orig.item.el, "accidental") || text(orig.item.el, "key")) || 0 : null;
  // Only where the file had one, or the key changes there (a transposing staff starts with its written key).
  const { chromatic, diatonic } = ctx.link.transpose[part];
  const written = want - (chromatic ? 7 * chromatic - 12 * diatonic : 0);
  if (!orig && before === want && (m > 0 || written === 0)) return;
  let el: Element;
  if (orig && was === want) el = orig.item.el;
  else {
    el = ctx.doc.createElementNS(null, "KeySig");
    add(el, ctx.v4 ? "concertKey" : "accidental", want);
    // A transposing staff names its written key too.
    if (ctx.v4 && chromatic) add(el, "actualKey", written);
  }
  const vi = orig?.vi ?? 0;
  const list = kept.get(vi) ?? [];
  // Where the file had it, else after a clef at the start.
  let at = orig?.at ?? 0;
  if (!orig) while (at < list.length && list[at].pos <= 1e-9 && list[at].el.tagName === "Clef") at++;
  list.splice(at, 0, { pos: 0, el });
  kept.set(vi, list);
}

/** The time signature a measure starts with, from the score; the file's own when it says the same. */
function placeTime(ctx: Ctx, part: number, m: number, kept: Map<number, Kept[]>): void {
  let orig: { vi: number; at: number; item: Kept } | null = null;
  for (const [vi, list] of kept) {
    const at = list.findIndex((it) => it.el.tagName === "TimeSig" && it.pos <= 1e-9);
    if (at >= 0 && !orig) orig = { vi, at, item: list[at] };
    if (at >= 0) list.splice(at, 1);
  }
  const time = read(ctx.score.measures[part][m])
    .others.filter((o) => o.el.tagName === "attributes" && o.pos <= 0)
    .flatMap((o) => kids(o.el, "time"))[0];
  if (!time) return;
  const [n, d] = [text(time, "beats"), text(time, "beat-type")];
  let el: Element;
  if (orig && text(orig.item.el, "sigN") === n && text(orig.item.el, "sigD") === d) el = orig.item.el;
  else {
    el = ctx.doc.createElementNS(null, "TimeSig");
    add(el, "sigN", n);
    add(el, "sigD", d);
  }
  const vi = orig?.vi ?? 0;
  const list = kept.get(vi) ?? [];
  // Where the file had it, else after the clef and key at the start.
  let at = orig?.at ?? 0;
  if (!orig) while (at < list.length && list[at].pos <= 1e-9 && (list[at].el.tagName === "Clef" || list[at].el.tagName === "KeySig")) at++;
  list.splice(at, 0, { pos: 0, el });
  kept.set(vi, list);
}

/** The chord symbols of a staff in a measure, from the score; the file's own where they read the same. */
function placeHarmonies(ctx: Ctx, part: number, k: number, m: number, kept: Map<number, Kept[]>): void {
  const { score, doc } = ctx;
  const { chromatic, diatonic } = ctx.link.transpose[part];
  const move = chromatic ? 7 * chromatic - 12 * diatonic : 0;
  const fileText = (el: Element) => {
    const info = kid(el, "harmonyInfo") ?? el;
    if (text(info, "root") === "") return null;
    const bass = text(info, "bass") || text(info, "base");
    return chordText(chordFromMuseScore(text(info, "name"), Number(text(info, "root")) - move, bass !== "" ? Number(bass) - move : null));
  };
  const pool: { vi: number; pos: number; el: Element; text: string; used?: boolean }[] = [];
  for (const [vi, list] of kept)
    kept.set(
      vi,
      list.filter((it) => {
        if (it.el.tagName !== "Harmony") return true;
        const t = fileText(it.el);
        if (t === null) return true;
        pool.push({ vi, pos: it.pos, el: it.el, text: t });
        return false;
      }),
    );
  const per = perQuarter(score, part, m);
  for (const o of read(score.measures[part][m]).others) {
    if (o.el.tagName !== "harmony" || (Number(text(o.el, "staff")) || 1) !== k + 1) continue;
    const c = readHarmony(o.el);
    if (!c) continue;
    const pos = Math.max(0, o.pos) / per / 4;
    const hit = pool.find((x) => !x.used && Math.abs(x.pos - pos) < 1e-9 && x.text === chordText(c));
    let el: Element;
    if (hit) {
      hit.used = true;
      el = hit.el;
    } else {
      // MuseScore 4.6 and later wrap it in <harmonyInfo> and name the bass <bass>; earlier, <base>.
      el = doc.createElementNS(null, "Harmony");
      const wrap = ctx.link.version >= 4.6;
      const info = wrap ? add(el, "harmonyInfo") : el;
      if (c.suffix) add(info, "name", c.suffix);
      add(info, "root", tpcOf(c.root) + move);
      if (c.bass) add(info, wrap ? "bass" : "base", tpcOf(c.bass) + move);
    }
    const vi = hit?.vi ?? 0;
    const list = kept.get(vi) ?? [];
    list.push({ pos, el, timeTick: undefined });
    kept.set(vi, list);
  }
  for (const list of kept.values()) list.sort((a, b) => a.pos - b.pos);
}

/** A MuseScore element for a direction the file does not have. */
function newDirection(ctx: Ctx, d: Direction): Element {
  const { doc } = ctx;
  const words = (parent: Element, s: string) => {
    const t = add(parent, "text");
    // Note symbols as MuseScore's own (metNoteQuarterUp...).
    const names = Object.entries(SYM).filter(([n]) => n.startsWith("metNote"));
    let rest = s;
    while (rest) {
      const at = names.map(([n, ch]) => ({ n, ch, i: rest.indexOf(ch) })).filter((x) => x.i >= 0).sort((a, b) => a.i - b.i)[0];
      if (!at) {
        t.appendChild(doc.createTextNode(rest));
        break;
      }
      if (at.i) t.appendChild(doc.createTextNode(rest.slice(0, at.i)));
      add(t, "sym", at.n);
      rest = rest.slice(at.i + at.ch.length);
      // A dotted note value ("♩. = 60").
      if (rest.startsWith(".")) {
        add(t, "sym", "metAugmentationDot");
        rest = rest.slice(1);
      }
    }
  };
  switch (d.kind) {
    case "dynamic": {
      const e = doc.createElementNS(null, "Dynamic");
      add(e, "subtype", d.value);
      if (DYNAMICS[d.value]) add(e, "velocity", DYNAMICS[d.value]);
      return e;
    }
    case "text": {
      const tag = d.text === "rehearsal" ? "RehearsalMark" : d.text === "expression" && ctx.v4 ? "Expression" : "StaffText";
      const e = doc.createElementNS(null, tag);
      if (tag === "StaffText" && d.text === "expression") add(e, "placement", "below");
      words(e, d.words);
      return e;
    }
    case "tempo": {
      const e = doc.createElementNS(null, "Tempo");
      add(e, "tempo", Math.round((d.bpm / 60) * 1e6) / 1e6);
      if (/=/.test(d.words)) add(e, "followText", 1);
      words(e, d.words);
      return e;
    }
  }
  return doc.createElementNS(null, "StaffText");
}

const DROP = new Set(["Chord", "Rest", "Tuplet", "endTuplet", "location", "Beam", "Fermata", "Breath", "eid"]);

/** The non-note content of an original voice, at its positions (whole notes). */
/** An original voice item at its position; timeTick: placed inside a chord's length, as MuseScore marks it. */
interface Kept {
  pos: number;
  el: Element;
  timeTick?: boolean;
}

function keptItems(voice: Element, len: number): Kept[] {
  const out: Kept[] = [];
  let pos = 0;
  let tick = false;
  const ratios: number[] = [];
  const all = kids(voice);
  // A fermata after the voice's last chord or rest stands on the barline: kept as it is.
  let last = -1;
  all.forEach((c, i) => {
    if (c.tagName === "Chord" || c.tagName === "Rest") last = i;
  });
  for (const [i, c] of all.entries()) {
    if (c.tagName === "Fermata" && i > last) {
      out.push({ pos, el: c });
      continue;
    }
    switch (c.tagName) {
      case "location":
        pos += frac(text(c, "fractions"));
        tick = text(c, "timeTick") === "1";
        break;
      case "Tuplet":
        ratios.push((Number(text(c, "normalNotes")) || 2) / (Number(text(c, "actualNotes")) || 3));
        break;
      case "endTuplet":
        ratios.pop();
        break;
      case "Chord":
      case "Rest": {
        tick = false;
        if (GRACE_TAGS.some((g) => kid(c, g))) break;
        const dt = text(c, "durationType");
        if (dt === "measure") pos += text(c, "duration") ? frac(text(c, "duration")) : len;
        // A real length other than the drawn one (a two-chord tremolo's chords).
        else if (c.tagName === "Chord" && text(c, "duration")) pos += frac(text(c, "duration"));
        else pos += (TYPE_Q[dt] ?? 1) / 4 * (2 - 2 ** -(Number(text(c, "dots")) || 0)) * ratios.reduce((a, b) => a * b, 1);
        break;
      }
      default:
        // Slurs at voice level (older files) are written again from the score.
        if (c.tagName === "Spanner" && ["Slur", "Tie"].includes(c.getAttribute("type") ?? "")) break;
        if (!DROP.has(c.tagName)) out.push({ pos, el: c, ...(tick ? { timeTick: true } : {}) });
    }
  }
  return out;
}

const GRACE_TAGS = ["acciaccatura", "appoggiatura", "grace4", "grace8after", "grace16", "grace16after", "grace32", "grace32after"];

function frac(s: string): number {
  const [a, b] = s.split("/").map(Number);
  return b ? a / b : Number(a) || 0;
}

/** The accidental to draw on each note of a staff in a measure (key signature, then earlier notes). */
function accidentalsFor(score: ScoreDoc, part: number, m: number, staff: number): Map<Element, number | null> {
  const fifths = keyAt(score, part, m);
  const keyAlter = (step: string) => (fifths > 0 && "FCGDAEB".slice(0, fifths).includes(step) ? 1 : fifths < 0 && "BEADGCF".slice(0, -fifths).includes(step) ? -1 : 0);
  const notes: { pos: number; grace: number; note: Element; p: Pitch; tied: boolean }[] = [];
  for (const [key, evs] of read(score.measures[part][m]).voices) {
    if (Number(key.split("|")[0]) !== staff) continue;
    for (const ev of evs) {
      for (const slot of graceSlots(ev.graces))
        for (const g of slot.notes) {
          const p = readPitch(g);
          if (p && !p.unpitched) notes.push({ pos: ev.pos, grace: slot.order - (slot.after ? 199 : 100), note: g, p, tied: false });
        }
      for (const n of ev.notes) {
        const p = readPitch(n);
        if (p && !p.unpitched) notes.push({ pos: ev.pos, grace: 0, note: n, p, tied: kids(n, "tie").some((t) => t.getAttribute("type") === "stop") });
      }
    }
  }
  notes.sort((a, b) => a.pos - b.pos || a.grace - b.grace);
  const state = new Map<string, number>();
  const out = new Map<Element, number | null>();
  for (const x of notes) {
    const k = `${x.p.step}${x.p.octave}`;
    const now = state.has(k) ? state.get(k)! : keyAlter(x.p.step);
    out.set(x.note, x.tied || now === x.p.alter ? null : x.p.alter);
    state.set(k, x.p.alter);
  }
  return out;
}

/** Writes one voice: the original's non-note content and the score's events, by position. */
function writeVoice(ctx: Ctx, v: Element, part: number, k: number, staff: number, m: number, per: number, key: string, evs: Event[], kept: Kept[], accidentals: Map<Element, number | null>): void {
  const { doc } = ctx;
  let cur = 0; // whole notes
  const moveTo = (pos: number, timeTick = false) => {
    if (Math.abs(pos - cur) < 1e-9) return;
    const loc = add(v, "location");
    add(loc, "fractions", fraction(Math.round((pos - cur) * 4 * per), per));
    if (timeTick) add(loc, "timeTick", 1);
    cur = pos;
  };
  let ki = 0;
  const keepUpTo = (pos: number) => {
    while (ki < kept.length && kept[ki].pos <= pos + 1e-9) {
      moveTo(kept[ki].pos, kept[ki].timeTick);
      v.appendChild(kept[ki].el.cloneNode(true));
      ki++;
    }
  };
  const groups = tupletGroups(evs, per);
  const run = evs.length ? voiceRun(ctx.score, part, key) : [];
  evs.forEach((ev, i) => {
    const pos = ev.pos / per / 4;
    keepUpTo(pos);
    moveTo(pos);
    const g = groups.get(i);
    if (g?.start) {
      const t = add(v, "Tuplet");
      add(t, "normalNotes", g.normal);
      add(t, "actualNotes", g.actual);
      add(t, "baseNote", g.base);
      const num = add(t, "Number");
      add(num, "style", ctx.v4 ? "tuplet" : "Tuplet");
      add(num, "text", g.actual);
    }
    if (!ev.rest && ev.notes.some((n) => marksOf(n).includes("fermata"))) add(add(v, "Fermata"), "subtype", "fermataAbove");
    else if (ev.rest && ev.notes.some((n) => marksOf(n).includes("fermata"))) add(add(v, "Fermata"), "subtype", "fermataAbove");
    const at = run.index?.get(`${m}|${ev.pos}`) ?? -1;
    for (const g of graceSlots(ev.graces)) v.appendChild(chordFor(ctx, part, staff, m, pos, per, g.notes, g.index, run, at, accidentals, key, ev.pos));
    v.appendChild(ev.rest ? restFor(ctx, ev, per, part, key, m, pos) : chordFor(ctx, part, staff, m, pos, per, ev.notes, -1, run, at, accidentals, key, ev.pos));
    // A breath mark or caesura stands after its chord or rest.
    const breath = ev.notes.flatMap((n) => [...Array.from(n.getElementsByTagName("breath-mark")), ...Array.from(n.getElementsByTagName("caesura"))])[0];
    if (breath) {
      const value = breath.textContent?.trim() || (breath.tagName === "caesura" ? "normal" : "comma");
      const symbol = Object.keys(BREATH).find((k) => BREATH[k][0] === breath.tagName && BREATH[k][1] === value);
      add(add(v, "Breath"), "symbol", symbol ?? (breath.tagName === "caesura" ? "caesura" : "breathMarkComma"));
    }
    cur = pos + ev.dur / per / 4;
    if (g?.end) add(v, "endTuplet");
  });
  keepUpTo(Number.MAX_SAFE_INTEGER);
  void doc;
  void k;
}

interface Group {
  start: boolean;
  end: boolean;
  actual: number;
  normal: number;
  base: string;
}

/** Tuplets in a voice's events: from the first member to the last, with their ratio and base value. */
function tupletGroups(evs: Event[], per: number): Map<number, Group> {
  const out = new Map<number, Group>();
  for (let i = 0; i < evs.length; ) {
    const ratio = kid(evs[i].notes[0], "time-modification");
    if (!ratio) {
      i++;
      continue;
    }
    const actual = Number(text(ratio, "actual-notes")) || 3;
    const normal = Number(text(ratio, "normal-notes")) || 2;
    let j = i;
    let sum = 0;
    const marked = (e: Event, type: string) => Array.from(e.notes[0].getElementsByTagName("tuplet")).some((t) => t.getAttribute("type") === type);
    for (; j < evs.length && kid(evs[j].notes[0], "time-modification"); j++) {
      sum += evs[j].dur / per;
      if (marked(evs[j], "stop")) break;
      if (!marked(evs[i], "start") && DURATION_NAME.some(([, q]) => Math.abs(sum / normal - q) < 1e-6)) break;
    }
    j = Math.min(j, evs.length - 1);
    const baseQ = sum / normal;
    const base = DURATION_NAME.find(([, q]) => Math.abs(q - baseQ) < 1e-6)?.[0] ?? text(ratio, "normal-type") ?? text(evs[i].notes[0], "type");
    out.set(i, { ...(out.get(i) ?? { end: false }), start: true, actual, normal, base } as Group);
    out.set(j, { ...(out.get(j) ?? { start: false, actual, normal, base }), end: true } as Group);
    i = j + 1;
  }
  return out;
}

function restFor(ctx: Ctx, ev: Event, per: number, part: number, key: string, m: number, pos: number): Element {
  const r = ctx.doc.createElementNS(null, "Rest");
  const n = ev.notes[0];
  if (n.getAttribute("print-object") === "no") add(r, "visible", 0);
  if (kid(n, "rest")?.getAttribute("measure") === "yes") {
    add(r, "durationType", "measure");
    add(r, "duration", fraction(ev.dur, per));
  } else {
    const { type, dots } = valueOf(n);
    if (dots) add(r, "dots", dots);
    add(r, "durationType", type);
  }
  writeSlurs(ctx, part, key, m, pos, per, ev.pos, -1, r);
  return r;
}

/** A chord: the original one when unchanged (its ties, slurs and accidentals written again), else written from the notes. */
function chordFor(ctx: Ctx, part: number, staff: number, m: number, pos: number, per: number, given: Element[], graceIndex: number, run: Placed[], at: number, accidentals: Map<Element, number | null>, key: string, evPos: number): Element {
  const grace = graceIndex >= 0;
  const { doc, link, prints } = ctx;
  // MuseScore keeps a chord's notes from the lowest up.
  const notes = byPitch(given);
  const orig = link.chords.get(given[0]);
  const unchanged = !!orig && prints.has(given[0]) && prints.get(given[0]) === fingerprint(given);
  // Untouched in an edited measure (never remembered): unchanged as well.
  const untouched = !!orig && !prints.has(given[0]);
  let chord: Element;
  // A kept chord's accidentals, put back when still drawn (their look with them).
  const keptAcc = new Map<Element, Element>();
  if (orig && (unchanged || untouched) && orig.tagName === "Chord" && !ctx.fresh) {
    chord = orig.cloneNode(true) as Element;
    for (const s of kids(chord, "Spanner")) if (s.getAttribute("type") === "Slur") s.remove();
    for (const n of kids(chord, "Note")) {
      for (const s of kids(n, "Spanner")) if (s.getAttribute("type") === "Tie") s.remove();
      for (const s of kids(n, "Spanner")) {
        if (s.getAttribute("type") !== "Glissando") continue;
        const look = kid(s, "Glissando");
        if (look) glissLooks.set(n, look);
        s.remove();
      }
      for (const a of kids(n, "Accidental")) {
        keptAcc.set(n, a);
        a.remove();
      }
    }
  } else {
    chord = doc.createElementNS(null, "Chord");
    // Drawn on the staff above or below (cross-staff), as in the file.
    const move = orig ? text(orig, "staffMove") : "";
    if (move) add(chord, "staffMove", move);
    const { type, dots } = valueOf(notes[0]);
    if (dots) add(chord, "dots", dots);
    add(chord, "durationType", type);
    // A real length other than the drawn one (each chord of a two-chord tremolo).
    const d = Number(text(notes[0], "duration")) || 0;
    const tm = kid(notes[0], "time-modification");
    const ratio = tm ? (Number(text(tm, "normal-notes")) || 1) / (Number(text(tm, "actual-notes")) || 1) : 1;
    if (!grace && d && Math.abs(d / per - (TYPE_Q[type] ?? 1) * (2 - 2 ** -dots) * ratio) > 1e-9) add(chord, "duration", fraction(d, per));
    if (grace && isAfterGrace(notes[0])) add(chord, ({ "16th": "grace16after", "32nd": "grace32after" } as Record<string, string>)[type] ?? "grace8after");
    else if (grace) add(chord, kid(notes[0], "grace")?.getAttribute("slash") === "yes" ? "acciaccatura" : ({ quarter: "grace4", "16th": "grace16", "32nd": "grace32" } as Record<string, string>)[type] ?? "appoggiatura");
    for (const l of lyricsOf(notes[0])) {
      const ly = add(chord, "Lyrics");
      if (Number(l.number) > 1) add(ly, "no", Number(l.number) - 1);
      if (l.syllabic !== "single") add(ly, "syllabic", l.syllabic);
      add(ly, "text", l.text);
    }
    const marks = [...new Set(notes.flatMap(marksOf))];
    // The file's own marks that still apply are kept (their placement with them).
    const done = new Set<string>();
    for (const a of orig ? kids(orig).filter((x) => x.tagName === "Articulation" || x.tagName === "Ornament") : []) {
      const ms = marksOfSubtype(text(a, "subtype"));
      if (!ms.length || !ms.every((x) => marks.includes(x) && !done.has(x))) continue;
      chord.appendChild(withoutEid(a.cloneNode(true) as Element));
      for (const x of ms) done.add(x);
    }
    if (marks.includes("staccato") && marks.includes("tenuto") && !done.has("staccato") && !done.has("tenuto")) {
      add(add(chord, "Articulation"), "subtype", "articTenutoStaccatoAbove");
      done.add("staccato").add("tenuto");
    }
    for (const mk of marks.filter((x) => !done.has(x))) {
      if (ARTIC[mk] || BOWING[mk]) add(add(chord, "Articulation"), "subtype", ARTIC[mk] ?? BOWING[mk]);
      else if (ORNAMENT[mk]) add(add(chord, ctx.v4 ? "Ornament" : "Articulation"), "subtype", ORNAMENT[mk]);
      else if (!BESIDE.has(mk)) ctx.dropped[mk] = (ctx.dropped[mk] ?? 0) + 1;
    }
    if (marks.includes("tap")) add(add(chord, "Tapping"), "hand", "left");
    const origNotes = orig ? kids(orig, "Note") : [];
    notes.forEach((n, i) => chord.appendChild(noteFor(ctx, part, staff, m, pos, n, origNotes.length === notes.length ? origNotes[i] : null)));
    for (const mk of marks) if (CHORD_LINE[mk]) add(add(chord, "ChordLine"), "subtype", CHORD_LINE[mk]);
    const arp = orig ? kid(orig, "Arpeggio") : null;
    if (marks.includes("arpeggiate")) chord.appendChild(arp ? withoutEid(arp.cloneNode(true) as Element) : add(doc.createElementNS(null, "Arpeggio"), "subtype", 0).parentNode as Element);
    const tr = tremoloOf(notes[0]);
    if (tr) add(add(chord, ctx.v4 ? "TremoloSingleChord" : "Tremolo"), "subtype", `r${4 * 2 ** tr}`);
    const two = spansOf(notes[0]).find((x) => x.kind === "tremolo" && x.type === "start");
    if (two) add(add(chord, ctx.v4 ? "TremoloTwoChord" : "Tremolo"), "subtype", `c${4 * 2 ** (Number(two.value) || 3)}`);
  }
  // Ties, slurs and accidentals, from the score.
  const noteEls = kids(chord, "Note");
  notes.forEach((n, i) => {
    const el = noteEls[i];
    if (!el) return;
    // Drawn where needed, and where the score shows one anyway (a courtesy accidental).
    let acc = accidentals.get(n) ?? null;
    const p = readPitch(n);
    const courtesy = acc === null && !!p && text(n, "accidental") === SHOWN[p.alter];
    if (courtesy) acc = p!.alter;
    if (acc !== null) {
      const old = keptAcc.get(el);
      const a = old && text(old, "subtype") === ACCIDENTAL[acc] ? old : doc.createElementNS(null, "Accidental");
      if (a !== old) {
        if (courtesy) add(a, "role", 1);
        add(a, "subtype", ACCIDENTAL[acc] ?? "accidentalNatural");
      }
      el.insertBefore(a, el.firstChild?.nodeName === "eid" ? el.firstChild.nextSibling : el.firstChild);
    }
    if (grace) return;
    for (const t of kids(n, "tie")) {
      const start = t.getAttribute("type") === "start";
      const other = tiePartner(ctx, part, key, run, at, n, start);
      if (!other) continue;
      const sp = doc.createElementNS(null, "Spanner");
      sp.setAttribute("type", "Tie");
      if (start) add(sp, "Tie");
      const end = add(sp, start ? "next" : "prev");
      end.appendChild(location(doc, m, Math.round(pos * 4 * per), other.m, Math.round(other.pos * per), per, other.voice - voiceIndex(key), other.index - i));
      const before = kids(el).find((c) => c.tagName === "pitch") ?? null;
      el.insertBefore(sp, before);
    }
  });
  // Glissandos, at the end of the note, to the same voice's next (previous) chord.
  if (!grace)
    notes.forEach((n, i) => {
      const el = noteEls[i];
      if (!el) return;
      for (const g of spansOf(n)) {
        if (g.kind !== "glissando" && g.kind !== "slide") continue;
        const start = g.type === "start";
        const near = run[at + (start ? 1 : -1)];
        if (!near || near.ev.rest) continue;
        const sorted = byPitch(near.ev.notes);
        let j = sorted.findIndex((x) => spansOf(x).some((o) => (o.kind === "glissando" || o.kind === "slide") && o.number === g.number && o.type !== g.type));
        if (j < 0) j = Math.min(i, sorted.length - 1);
        const sp = doc.createElementNS(null, "Spanner");
        sp.setAttribute("type", "Glissando");
        if (start) {
          const look = glissLooks.get(el);
          if (look) sp.appendChild(look);
          else {
            const gl = add(sp, "Glissando");
            add(gl, "text", glissText(n));
            add(gl, "diagonal", 1);
          }
        }
        const end = add(sp, start ? "next" : "prev");
        end.appendChild(location(doc, m, Math.round(pos * 4 * per), near.m, Math.round(near.ev.pos / near.per * per), per, 0, j - i));
        el.appendChild(sp);
      }
    });
  // A slur keeps its look (direction, shape) from the file.
  const looks = orig ? kids(orig, "Spanner").filter((x) => x.getAttribute("type") === "Slur" && kid(x, "next") && kid(x, "Slur")).map((x) => withoutEid(kid(x, "Slur")!.cloneNode(true) as Element)) : [];
  writeSlurs(ctx, part, key, m, pos, per, evPos, graceIndex, chord, looks);
  return chord;
}

/** Slurs: on the chord (or rest), before its notes; the other end may be a grace chord, another voice or staff. */
function writeSlurs(ctx: Ctx, part: number, key: string, m: number, pos: number, per: number, evPos: number, graceIndex: number, into: Element, looks: Element[] = []): void {
  const { doc } = ctx;
  const self = holderOf(ctx.score, part, key, m, evPos, graceIndex);
  const partners = self ? slurPartners(ctx.score, part).get(self) : undefined;
  for (const [j, sl] of self ? self.notes.flatMap(slursOf).entries() : []) {
    const other = partners?.get(j);
    if (!other) continue;
    const sp = doc.createElementNS(null, "Spanner");
    sp.setAttribute("type", "Slur");
    if (sl.type === "start") {
      const look = looks.shift();
      if (look) sp.appendChild(look);
      else add(sp, "Slur");
    }
    const end = add(sp, sl.type === "start" ? "next" : "prev");
    const staves = Math.floor(trackOf(other.key) / 4) - Math.floor(trackOf(key) / 4);
    end.appendChild(location(doc, m, Math.round(pos * 4 * per), other.m, Math.round(other.pos * (per / other.per)), per, (trackOf(other.key) % 4) - (trackOf(key) % 4), 0, other.grace, staves));
    into.insertBefore(sp, kids(into).find((c) => ["Articulation", "Ornament", "Note"].includes(c.tagName)) ?? null);
  }
}

/** A copy of a file element without its MuseScore 4 ids (copies would share them). */
function withoutEid(e: Element): Element {
  for (const id of Array.from(e.getElementsByTagName("eid"))) id.remove();
  return e;
}

// A kept glissando's own look (line, text), carried to the note written again.
const glissLooks = new WeakMap<Element, Element>();

/** The text shown on a glissando (MuseScore writes it empty when there is none). */
function glissText(n: Element): string {
  for (const nots of kids(n, "notations")) for (const e of [...kids(nots, "slide"), ...kids(nots, "glissando")]) if (e.getAttribute("type") === "start") return e.textContent?.trim() ?? "";
  return "";
}

/** Notes from the lowest up (unpitched ones keep their order). */
function byPitch(notes: Element[]): Element[] {
  const midi = (n: Element) => {
    const p = readPitch(n);
    return p && !p.unpitched ? midiOf(p) : 0;
  };
  return [...notes].sort((a, b) => midi(a) - midi(b));
}

/** MuseScore's voice index (0-3) of a MusicXML voice key. */
const voiceIndex = (key: string) => ((((Number(key.split("|")[1]) || 1) - 1) % 4) + 4) % 4;

/**
 * The note a tie leads to (or comes from): the same pitch in the next (previous) event of the
 * voice, else in another voice of the staff where that note starts (ends).
 */
function tiePartner(ctx: Ctx, part: number, key: string, run: Placed[], at: number, note: Element, start: boolean): { m: number; pos: number; voice: number; index: number } | null {
  const p = readPitch(note);
  if (!p) return null;
  const midi = midiOf(p);
  const find = (ev: Event) => byPitch(ev.notes).findIndex((x) => { const q = readPitch(x); return !!q && midiOf(q) === midi; });
  const here = run[at];
  const near = run[at + (start ? 1 : -1)];
  if (near && !near.ev.rest && find(near.ev) >= 0) return { m: near.m, pos: near.ev.pos / near.per, voice: voiceIndex(key), index: find(near.ev) };
  if (!here) return null;
  // Where the tied note must start (or end), in quarters from the score start.
  const startOf = (m: number) => ctx.link.lengths.slice(0, m).reduce((a, b) => a + b, 0) * 4;
  const target = start ? startOf(here.m) + (here.ev.pos + here.ev.dur) / here.per : startOf(here.m) + here.ev.pos / here.per;
  const staff = key.split("|")[0];
  for (const other of [...readMeasureKeys(ctx.score, part)].filter((k) => k !== key && k.split("|")[0] === staff)) {
    for (const r of voiceRun(ctx.score, part, other)) {
      if (r.ev.rest) continue;
      const s0 = startOf(r.m) + r.ev.pos / r.per;
      const s1 = s0 + r.ev.dur / r.per;
      if (Math.abs((start ? s0 : s1) - target) > 1e-6) continue;
      const j = find(r.ev);
      if (j >= 0) return { m: r.m, pos: r.ev.pos / r.per, voice: voiceIndex(other), index: j };
    }
  }
  return null;
}

/** The voice keys used anywhere in a part. */
function readMeasureKeys(score: ScoreDoc, part: number): Set<string> {
  const keys = new Set<string>();
  for (const meas of score.measures[part]) for (const k of read(meas).voices.keys()) keys.add(k);
  return keys;
}

/** A <Note> from a MusicXML note. */
function noteFor(ctx: Ctx, part: number, staff: number, m: number, pos: number, n: Element, origNote: Element | null = null): Element {
  const { doc, link } = ctx;
  const note = doc.createElementNS(null, "Note");
  // The file's fingerings: string numbers as they were, the finger kept while unchanged.
  const f = fingeringOf(n);
  let placed = false;
  for (const old of origNote ? kids(origNote, "Fingering") : []) {
    const own = text(old, "style") === "string_number";
    if (!own && (placed || text(old, "text") !== f)) continue;
    note.appendChild(withoutEid(old.cloneNode(true) as Element));
    if (!own) placed = true;
  }
  if (f && !placed) add(add(note, "Fingering"), "text", f);
  const bends = bendsOf(n);
  // A bend as a curve (100 = a whole tone): MuseScore 4.2+ writes GuitarBend but still reads it.
  if (bends.length) {
    const top = Math.round(Math.max(...bends.map((b) => b.alter)) * 50);
    const pre = bends.some((b) => b.pre);
    const back = bends.some((b) => b.release);
    const curve = pre ? (back ? [[0, top], [15, top], [30, 0], [60, 0]] : [[0, top], [60, top]]) : back ? [[0, 0], [10, top], [20, top], [30, 0], [60, 0]] : [[0, 0], [15, top], [60, top]];
    const bend = add(note, "Bend");
    for (const [time, pitch] of curve) {
      const pt = add(bend, "point");
      pt.setAttribute("time", String(time));
      pt.setAttribute("pitch", String(pitch));
      pt.setAttribute("vibrato", "0");
    }
  }
  const p = readPitch(n);
  if (p?.unpitched) {
    const drum = link.drums[part]?.get(p.instrument ?? "") ?? midiOf(p);
    const sp = spellMidi(drum);
    add(note, "pitch", drum);
    add(note, "tpc", TPC_BASE[sp.step] + 7 * sp.alter);
  } else if (p) {
    const { pitch, tpc, tpc2 } = pitchOf(ctx, part, staff, m, pos, p);
    add(note, "pitch", pitch);
    add(note, "tpc", tpc);
    if (tpc2 !== undefined) add(note, "tpc2", tpc2);
    if (p.position) {
      add(note, "fret", p.position.fret);
      add(note, "string", p.position.string - 1);
    }
  }
  return note;
}

export { measureOffsets };
