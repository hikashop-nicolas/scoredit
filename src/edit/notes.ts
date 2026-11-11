import { kid, kids, text } from "../model/xml";

// Building and changing MusicXML <note> elements, in the order the schema wants.

const NOTE_ORDER = ["grace", "cue", "chord", "pitch", "unpitched", "rest", "duration", "tie", "instrument", "footnote", "level", "voice", "type", "dot", "accidental", "time-modification", "stem", "notehead", "notehead-text", "staff", "beam", "notations", "lyric", "play", "listen"];

/** Adds `child` to a note where the schema puts it (after its kind's siblings). */
export function placeInNote(note: Element, child: Element): Element {
  const rank = NOTE_ORDER.indexOf(child.tagName);
  const before = kids(note).find((c) => NOTE_ORDER.indexOf(c.tagName) > rank) ?? null;
  note.insertBefore(child, before);
  return child;
}

function add(note: Element, tag: string, value?: string | number, attrs?: Record<string, string>): Element {
  const e = note.ownerDocument.createElementNS(null, tag);
  if (value !== undefined) e.textContent = String(value);
  if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
  return placeInNote(note, e);
}

export const TYPES: [type: string, quarters: number][] = [
  ["breve", 8],
  ["whole", 4],
  ["half", 2],
  ["quarter", 1],
  ["eighth", 0.5],
  ["16th", 0.25],
  ["32nd", 0.125],
  ["64th", 0.0625],
  ["128th", 0.03125],
];

export interface Written {
  type: string;
  dots: number;
  /** Length in divisions. */
  divs: number;
}

/** The written values a length is made of, longest first, each tied to the next. */
export function splitLength(divs: number, perQuarter: number): Written[] {
  const options: Written[] = [];
  for (const [type, q] of TYPES)
    for (let dots = 0; dots <= 2; dots++) {
      const d = q * perQuarter * (2 - 2 ** -dots);
      if (Number.isInteger(d) && d > 0) options.push({ type, dots, divs: d });
    }
  options.sort((a, b) => b.divs - a.divs || a.dots - b.dots);
  const out: Written[] = [];
  let left = divs;
  while (left > 0) {
    const w = options.find((o) => o.divs <= left);
    if (!w) break; // finer than a 128th: dropped
    out.push(w);
    left -= w.divs;
  }
  return out;
}

/** The single written value for a length, if there is one. */
export function writtenFor(divs: number, perQuarter: number): Written | null {
  const s = splitLength(divs, perQuarter);
  return s.length === 1 ? s[0] : null;
}

export interface Pitch {
  step: string;
  alter: number;
  octave: number;
}

const STEP_SEMIS: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

export function midiOf(p: Pitch): number {
  return (p.octave + 1) * 12 + STEP_SEMIS[p.step] + p.alter;
}

/** Spells a MIDI pitch: sharps in sharp keys and C, flats in flat keys. */
export function spellMidi(midi: number, fifths = 0): Pitch {
  const pc = ((midi % 12) + 12) % 12;
  const SHARP = ["C", "C", "D", "D", "E", "F", "F", "G", "G", "A", "A", "B"];
  const FLAT = ["C", "D", "D", "E", "E", "F", "G", "G", "A", "A", "B", "B"];
  const step = (fifths < 0 ? FLAT : SHARP)[pc];
  let alter = pc - STEP_SEMIS[step];
  if (alter > 6) alter -= 12;
  const octave = Math.floor((midi - STEP_SEMIS[step] - alter) / 12) - 1;
  return { step, alter, octave };
}

/** The alteration the key signature gives a step (fifths > 0 sharps F C G..., < 0 flats B E A...). */
export function keyAlter(step: string, fifths: number): number {
  if (fifths > 0) return "FCGDAEB".slice(0, fifths).includes(step) ? 1 : 0;
  if (fifths < 0) return "BEADGCF".slice(0, -fifths).includes(step) ? -1 : 0;
  return 0;
}

export function readPitch(note: Element): Pitch | null {
  const p = kid(note, "pitch");
  if (!p) return null;
  return { step: text(p, "step"), alter: Number(text(p, "alter")) || 0, octave: Number(text(p, "octave")) };
}

export function setPitch(note: Element, p: Pitch): void {
  kid(note, "rest")?.remove();
  kid(note, "unpitched")?.remove();
  kid(note, "pitch")?.remove();
  const pitch = add(note, "pitch");
  const doc = note.ownerDocument;
  const put = (tag: string, v: string | number) => {
    const e = doc.createElementNS(null, tag);
    e.textContent = String(v);
    pitch.appendChild(e);
  };
  put("step", p.step);
  if (p.alter) put("alter", p.alter);
  put("octave", p.octave);
}

/** Sets a note's length: duration, type and dots (a tuplet's ratio is dropped). */
export function setLength(note: Element, divs: number, w: Written | null): void {
  for (const tag of ["duration", "type", "dot", "time-modification"]) for (const e of kids(note, tag)) e.remove();
  if (!kid(note, "grace")) add(note, "duration", divs);
  if (w) {
    add(note, "type", w.type);
    for (let i = 0; i < w.dots; i++) add(note, "dot");
  }
}

export function noteDuration(note: Element): number {
  return kid(note, "grace") ? 0 : Number(text(note, "duration")) || 0;
}

export function isTied(note: Element, type: "start" | "stop"): boolean {
  return kids(note, "tie").some((t) => t.getAttribute("type") === type);
}

/** Adds or removes a tie of one kind, with its drawn <tied>. */
export function setTie(note: Element, type: "start" | "stop", on: boolean): void {
  for (const t of kids(note, "tie")) if (t.getAttribute("type") === type) t.remove();
  const nots = kid(note, "notations");
  for (const t of nots ? kids(nots, "tied") : []) if (t.getAttribute("type") === type) t.remove();
  if (nots && !nots.firstElementChild) nots.remove();
  if (!on) return;
  // Schema order: tie stop before tie start.
  const tie = note.ownerDocument.createElementNS(null, "tie");
  tie.setAttribute("type", type);
  const starts = kids(note, "tie").filter((t) => t.getAttribute("type") === "start");
  if (type === "stop" && starts.length) note.insertBefore(tie, starts[0]);
  else placeInNote(note, tie);
  const n = kid(note, "notations") ?? add(note, "notations");
  const tied = note.ownerDocument.createElementNS(null, "tied");
  tied.setAttribute("type", type);
  n.insertBefore(tied, type === "stop" ? n.firstChild : null);
}

/** A new note (or rest when pitch is null) of one written value. */
export function makeNote(doc: Document, o: { pitch: Pitch | null; divs: number; written: Written | null; voice: string; staff?: number; chord?: boolean; measureRest?: boolean }): Element {
  const note = doc.createElementNS(null, "note");
  if (o.chord) add(note, "chord");
  if (o.pitch) setPitch(note, o.pitch);
  else add(note, "rest", undefined, o.measureRest ? { measure: "yes" } : undefined);
  setLength(note, o.divs, o.measureRest ? null : o.written);
  add(note, "voice", o.voice);
  if (o.staff) add(note, "staff", o.staff);
  return note;
}

/** The accidental drawn on a note: set, or removed when null. */
export function setAccidental(note: Element, acc: string | null): void {
  kid(note, "accidental")?.remove();
  if (acc) add(note, "accidental", acc);
}

export const ACCIDENTAL: Record<number, string> = { [-2]: "flat-flat", [-1]: "flat", 0: "natural", 1: "sharp", 2: "double-sharp" };

/** Copies a note for one piece of it (a split): same content, new length, no ties yet. */
export function pieceOf(note: Element, divs: number, w: Written | null): Element {
  const c = note.cloneNode(true) as Element;
  setLength(c, divs, w);
  setTie(c, "start", false);
  setTie(c, "stop", false);
  for (const b of kids(c, "beam")) b.remove();
  return c;
}

export { add as addToNote };
