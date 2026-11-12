import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from "fflate";
import { pairEnds, type SlurItem } from "../edit/pairs";
import { isAfterGrace, readMeasure, voiceKey, type Event } from "../edit/measure";
import { bendsOf, fingeringOf, lyricsOf, marksOf, midiOf, readPitch, slursOf, spansOf, spellMidi, tremoloOf, type Pitch } from "../edit/notes";
import type { ScoreDoc } from "../model/score";
import { kid, kids, text } from "../model/xml";
import { BREATH, SYM, marksOfSubtype, plain, type MscxLink } from "./mscx";
import { DYNAMICS, directionOf, type Direction } from "../edit/directions";

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
function measureOffsets(source: string): { staves: [number, number][][]; staffEnds: number[] } {
  const tag = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<(\/?)([A-Za-z_][\w.-]*)[^>]*?(\/?)>/g;
  const stack: string[] = [];
  const staves: [number, number][][] = [];
  const staffEnds: number[] = [];
  let scoreDepth = -1;
  let measureStart = -1;
  for (let m = tag.exec(source); m; m = tag.exec(source)) {
    if (!m[2]) continue;
    const [all, close, name, self] = m;
    if (close) {
      // Leaving an element: a measure of a body staff ends, a body staff ends.
      const depth = stack.length - 1;
      if (name === "Measure" && measureStart >= 0 && scoreDepth >= 0 && depth === scoreDepth + 2) {
        staves[staves.length - 1].push([measureStart, m.index + all.length]);
        measureStart = -1;
      }
      if (name === "Staff" && scoreDepth >= 0 && depth === scoreDepth + 1) staffEnds.push(m.index);
      if (name === "Score" && depth === scoreDepth) scoreDepth = -2;
      stack.pop();
      continue;
    }
    const depth = stack.length;
    if (name === "Score" && scoreDepth === -1) scoreDepth = depth;
    if (scoreDepth >= 0 && name === "Staff" && depth === scoreDepth + 1 && !self) staves.push([]);
    if (scoreDepth >= 0 && name === "Measure" && depth === scoreDepth + 2) {
      if (self) staves[staves.length - 1].push([m.index, m.index + all.length]);
      else measureStart = m.index;
    }
    if (!self) stack.push(name);
  }
  return { staves, staffEnds };
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
  const ott = staff >= 0 ? ctx.link.ottavaAt(staff, m, posWhole) : 0;
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
  const next: Zippable = {};
  for (const [n, data] of Object.entries(files)) next[n] = n === name ? strToU8(out) : data;
  return { bytes: zipSync(next), dropped };
}

/** The .mscx text with the edited measures written again. */
export function writeMscxText(score: ScoreDoc, link: MscxLink, dirty: Set<string>, prints: WeakMap<Element, string>, opts: { fresh?: boolean } = {}): { text: string; dropped: Dropped } {
  try {
    return writeText(score, link, dirty, prints, opts);
  } finally {
    // The caches hold the whole score: let it go once written.
    runs.delete(score);
    holderCache.delete(score);
    byPlace = new Map();
    reads = new WeakMap();
    pers = new Map();
    wedgeCache = new Map();
  }
}

function writeText(score: ScoreDoc, link: MscxLink, dirty: Set<string>, prints: WeakMap<Element, string>, opts: { fresh?: boolean }): { text: string; dropped: Dropped } {
  if (link.version < 3) throw new Error("Saving MuseScore 2 files is not supported yet");
  runs.delete(score);
  holderCache.delete(score);
  byPlace = new Map();
  reads = new WeakMap();
  pers = new Map();
  wedgeCache = new Map();
  if (/<Tuplet id=/.test(link.source)) throw new Error("This MuseScore file writes tuplets the MuseScore 2 way, which scoredit cannot save yet");
  const ctx: Ctx = { score, link, doc: link.src, prints, dropped: {}, v4: link.version >= 4, fresh: !!opts.fresh };
  const { staves: offsets, staffEnds } = measureOffsets(link.source);
  const original = link.measures[0]?.length ?? 0;
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
  for (const [p, ms] of todo) {
    link.staves[p]?.forEach((staff, k) => {
      if (staff < 0) return;
      for (const m of [...ms].sort((a, b) => a - b)) {
        const meas = writeMeasure(ctx, p, k, staff, m);
        const xml = xmlOf(ser, meas);
        if (m < original && offsets[staff]?.[m]) edits.push([offsets[staff][m][0], offsets[staff][m][1], xml]);
        else if (m >= original) edits.push([staffEnds[staff], staffEnds[staff], `${xml}\n`]);
      }
    });
  }
  // Every staff gets the added measures, even staves of parts the edit did not touch.
  const added = score.measureCount - original;
  if (added > 0)
    link.measures.forEach((_, staff) => {
      const owner = link.staves.findIndex((ss) => ss.includes(staff));
      if (owner >= 0 && todo.has(owner)) return;
      for (let i = 0; i < added; i++) {
        const meas = ctx.doc.createElementNS(null, "Measure");
        const r = add(add(meas, "voice"), "Rest");
        add(r, "durationType", "measure");
        add(r, "duration", fraction(Math.round(link.lengths[original - 1] * 4 * 480), 480));
        edits.push([staffEnds[staff], staffEnds[staff], `${xmlOf(ser, meas)}\n`]);
      }
    });
  // Applied from the end, so earlier offsets stay right; measures added at one staff's end
  // keep the order they were made in.
  const order = edits.map((e, i) => [...e, i] as const).sort((a, b) => b[0] - a[0] || b[1] - a[1] || b[3] - a[3]);
  let out = link.source;
  for (const [s0, e0, t] of order) out = out.slice(0, s0) + t + out.slice(e0);
  void original;
  return { text: out, dropped: ctx.dropped };
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
  const orig = link.measures[staff]?.[m] ?? null;
  const meas = orig ? (orig.cloneNode(false) as Element) : doc.createElementNS(null, "Measure");
  if (orig) for (const c of kids(orig)) if (c.tagName !== "voice") meas.appendChild(c.cloneNode(true));
  // What the original voices hold besides notes, at its position (whole notes).
  const kept = new Map<number, { pos: number; el: Element }[]>();
  (orig ? kids(orig, "voice") : []).forEach((v, vi) => kept.set(vi, keptItems(v, link.lengths[m] ?? 1)));
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
function placeDirections(ctx: Ctx, part: number, k: number, m: number, kept: Map<number, { pos: number; el: Element }[]>): void {
  const { score, doc } = ctx;
  const pool: { vi: number; pos: number; el: Element; d: Direction; used?: boolean }[] = [];
  for (const [vi, list] of kept)
    kept.set(
      vi,
      list.filter((it) => {
        const d = fileDirection(it.el);
        if (d) pool.push({ vi, pos: it.pos, el: it.el, d });
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
    list.push({ pos, el });
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
function keptItems(voice: Element, len: number): { pos: number; el: Element }[] {
  const out: { pos: number; el: Element }[] = [];
  let pos = 0;
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
        break;
      case "Tuplet":
        ratios.push((Number(text(c, "normalNotes")) || 2) / (Number(text(c, "actualNotes")) || 3));
        break;
      case "endTuplet":
        ratios.pop();
        break;
      case "Chord":
      case "Rest": {
        if (GRACE_TAGS.some((g) => kid(c, g))) break;
        const dt = text(c, "durationType");
        if (dt === "measure") pos += text(c, "duration") ? frac(text(c, "duration")) : len;
        else pos += (TYPE_Q[dt] ?? 1) / 4 * (2 - 2 ** -(Number(text(c, "dots")) || 0)) * ratios.reduce((a, b) => a * b, 1);
        break;
      }
      default:
        // Slurs at voice level (older files) are written again from the score.
        if (c.tagName === "Spanner" && ["Slur", "Tie"].includes(c.getAttribute("type") ?? "")) break;
        if (!DROP.has(c.tagName)) out.push({ pos, el: c });
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
function writeVoice(ctx: Ctx, v: Element, part: number, k: number, staff: number, m: number, per: number, key: string, evs: Event[], kept: { pos: number; el: Element }[], accidentals: Map<Element, number | null>): void {
  const { doc } = ctx;
  let cur = 0; // whole notes
  const moveTo = (pos: number) => {
    if (Math.abs(pos - cur) < 1e-9) return;
    const loc = add(v, "location");
    add(loc, "fractions", fraction(Math.round((pos - cur) * 4 * per), per));
    cur = pos;
  };
  let ki = 0;
  const keepUpTo = (pos: number) => {
    while (ki < kept.length && kept[ki].pos <= pos + 1e-9) {
      moveTo(kept[ki].pos);
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
