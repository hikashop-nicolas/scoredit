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
  /** A drum: drawn at step/octave, played as this instrument of the part, with this head. */
  unpitched?: boolean;
  instrument?: string;
  notehead?: string;
  /** Where a fretted part plays it: string 1 is the highest. */
  position?: { string: number; fret: number };
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
  const u = kid(note, "unpitched");
  if (u) {
    const instrument = kid(note, "instrument")?.getAttribute("id") ?? undefined;
    const notehead = text(note, "notehead") || undefined;
    return { step: text(u, "display-step") || "E", alter: 0, octave: Number(text(u, "display-octave")) || 4, unpitched: true, instrument, notehead };
  }
  const p = kid(note, "pitch");
  if (!p) return null;
  const out: Pitch = { step: text(p, "step"), alter: Number(text(p, "alter")) || 0, octave: Number(text(p, "octave")) };
  const tech = kid(note, "notations") ? kid(kid(note, "notations")!, "technical") : null;
  if (tech && kid(tech, "string") && kid(tech, "fret")) out.position = { string: Number(text(tech, "string")), fret: Number(text(tech, "fret")) };
  return out;
}

export function setPitch(note: Element, p: Pitch): void {
  kid(note, "rest")?.remove();
  kid(note, "unpitched")?.remove();
  kid(note, "pitch")?.remove();
  const doc = note.ownerDocument;
  if (p.unpitched) {
    const u = add(note, "unpitched");
    for (const [tag, v] of [["display-step", p.step], ["display-octave", p.octave]] as const) {
      const e = doc.createElementNS(null, tag);
      e.textContent = String(v);
      u.appendChild(e);
    }
    kid(note, "instrument")?.remove();
    if (p.instrument) add(note, "instrument", undefined, { id: p.instrument });
    kid(note, "notehead")?.remove();
    if (p.notehead) add(note, "notehead", p.notehead);
    return;
  }
  setPosition(note, p.position ?? null);
  const pitch = add(note, "pitch");
  const put = (tag: string, v: string | number) => {
    const e = doc.createElementNS(null, tag);
    e.textContent = String(v);
    pitch.appendChild(e);
  };
  put("step", p.step);
  if (p.alter) put("alter", p.alter);
  put("octave", p.octave);
}

/** Writes (or clears) a note's string and fret. */
export function setPosition(note: Element, pos: { string: number; fret: number } | null): void {
  const nots = kid(note, "notations");
  const tech = nots ? kid(nots, "technical") : null;
  for (const tag of ["string", "fret"]) for (const e of tech ? kids(tech, tag) : []) e.remove();
  if (tech && !tech.firstElementChild) tech.remove();
  if (nots && !nots.firstElementChild) nots.remove();
  if (!pos) return;
  const n = kid(note, "notations") ?? add(note, "notations");
  const t = kid(n, "technical") ?? n.appendChild(note.ownerDocument.createElementNS(null, "technical"));
  for (const [tag, v] of [["string", pos.string], ["fret", pos.fret]] as const) {
    const e = note.ownerDocument.createElementNS(null, tag);
    e.textContent = String(v);
    t.appendChild(e);
  }
}

/** The easiest place to play a pitch: the lowest fret, on the higher string when equal. */
export function defaultPosition(midi: number, tuning: number[]): { string: number; fret: number } | null {
  let best: { string: number; fret: number } | null = null;
  tuning.forEach((open, i) => {
    const fret = midi - open;
    if (fret < 0 || fret > 24) return;
    if (!best || fret <= best.fret) best = { string: tuning.length - i, fret };
  });
  return best;
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

// ---- Marks: articulations, ornaments, fermatas, slurs, lyrics.

const NOTATION_ORDER = ["tied", "slur", "tuplet", "glissando", "slide", "ornaments", "technical", "articulations", "dynamics", "fermata", "arpeggiate", "non-arpeggiate", "accidental-mark", "other-notation"];

/** A note's <notations>, made when asked. */
export function notationsOf(note: Element, create: true): Element;
export function notationsOf(note: Element, create?: false): Element | null;
export function notationsOf(note: Element, create = false): Element | null {
  return kid(note, "notations") ?? (create ? add(note, "notations") : null);
}

function placeIn(parent: Element, child: Element, order: string[]): Element {
  const rank = order.indexOf(child.tagName);
  const before = kids(parent).find((c) => order.indexOf(c.tagName) > rank) ?? null;
  parent.insertBefore(child, before);
  return child;
}

export const ARTICULATIONS = ["accent", "strong-accent", "staccato", "tenuto", "detached-legato", "staccatissimo", "spiccato", "scoop", "plop", "doit", "falloff", "breath-mark", "caesura", "stress", "unstress", "soft-accent"];
/** Technical marks that are plain signs (bowings, harmonics...): put on and off like accents. */
export const TECHNICAL_MARKS = ["up-bow", "down-bow", "harmonic", "open-string", "stopped", "snap-pizzicato", "thumb-position", "tap", "fingernails", "double-tongue", "triple-tongue", "heel", "toe", "brass-bend", "flip", "smear", "open", "half-muted", "golpe"];
export const ORNAMENTS = ["trill-mark", "turn", "delayed-turn", "inverted-turn", "delayed-inverted-turn", "vertical-turn", "shake", "mordent", "inverted-mordent", "schleifer", "haydn"];

/** The marks on a note: articulation and ornament names, and "fermata". */
export function marksOf(note: Element): string[] {
  // A note may have several <notations>.
  const out: string[] = [];
  for (const nots of kids(note, "notations")) {
    for (const g of kids(nots, "articulations")) for (const a of kids(g)) if (ARTICULATIONS.includes(a.tagName)) out.push(a.tagName);
    for (const g of kids(nots, "ornaments")) for (const o of kids(g)) if (ORNAMENTS.includes(o.tagName)) out.push(o.tagName);
    for (const g of kids(nots, "technical")) for (const t of kids(g)) if (TECHNICAL_MARKS.includes(t.tagName)) out.push(t.tagName);
    if (kid(nots, "fermata")) out.push("fermata");
    if (kid(nots, "arpeggiate")) out.push("arpeggiate");
  }
  return out;
}

/** Puts a mark on a note or takes it off (on omitted: toggles). Returns whether it is on. */
export function setMark(note: Element, mark: string, on?: boolean): boolean {
  const doc = note.ownerDocument;
  const group = mark === "fermata" || mark === "arpeggiate" ? null : ARTICULATIONS.includes(mark) ? "articulations" : TECHNICAL_MARKS.includes(mark) ? "technical" : "ornaments";
  // Any of the note's <notations> may hold it.
  let nots = notationsOf(note);
  let holder = group && nots ? kid(nots, group) : nots;
  let have = holder ? kid(holder, mark) : null;
  for (const n of kids(note, "notations")) {
    const h = group ? kid(n, group) : n;
    const m = h ? kid(h, mark) : null;
    if (m) [nots, holder, have] = [n, h, m];
  }
  const want = on ?? !have;
  if (!want) {
    have?.remove();
    if (group && holder && !holder.firstElementChild) holder.remove();
    if (nots && !nots.firstElementChild) nots.remove();
    return false;
  }
  if (have) return true;
  const n = notationsOf(note, true);
  const parent = group ? (kid(n, group) ?? placeIn(n, doc.createElementNS(null, group), NOTATION_ORDER)) : n;
  const e = doc.createElementNS(null, mark);
  if (mark === "fermata") e.setAttribute("type", "upright");
  if (mark === "tap") e.textContent = "T";
  if (group) parent.appendChild(e);
  else placeIn(n, e, NOTATION_ORDER);
  return true;
}

export interface SlurEnd {
  type: "start" | "stop";
  number: number;
}

export function slursOf(note: Element): SlurEnd[] {
  return kids(note, "notations")
    .flatMap((nots) => kids(nots, "slur")).map((s) => ({ type: s.getAttribute("type") === "stop" ? "stop" : "start", number: Number(s.getAttribute("number")) || 1 }) as SlurEnd).filter((s) => s.type === "start" || s.type === "stop");
}

export function addSlur(note: Element, end: SlurEnd): void {
  const s = note.ownerDocument.createElementNS(null, "slur");
  s.setAttribute("type", end.type);
  s.setAttribute("number", String(end.number));
  placeIn(notationsOf(note, true), s, NOTATION_ORDER);
}

export function removeSlur(note: Element, end: SlurEnd): void {
  const nots = kid(note, "notations");
  for (const s of kids(note, "notations").flatMap((n) => kids(n, "slur"))) if ((s.getAttribute("type") === "stop" ? "stop" : "start") === end.type && (Number(s.getAttribute("number")) || 1) === end.number) s.remove();
  if (nots && !nots.firstElementChild) nots.remove();
}

export interface Lyric {
  number: string;
  syllabic: string;
  text: string;
}

export function lyricsOf(note: Element): Lyric[] {
  return kids(note, "lyric").map((l) => ({ number: l.getAttribute("number") ?? "1", syllabic: text(l, "syllabic") || "single", text: kids(l, "text").map((t) => t.textContent ?? "").join("") }));
}

/** Sets (or, with no text, removes) a note's lyric of one verse. */
export function setLyric(note: Element, number: string, words: string | null, syllabic = "single"): void {
  for (const l of kids(note, "lyric")) if ((l.getAttribute("number") ?? "1") === number) l.remove();
  if (!words) return;
  const doc = note.ownerDocument;
  const l = doc.createElementNS(null, "lyric");
  l.setAttribute("number", number);
  for (const [tag, v] of [["syllabic", syllabic], ["text", words]] as const) {
    const e = doc.createElementNS(null, tag);
    e.textContent = v;
    l.appendChild(e);
  }
  // Verses in order, after the note's other content.
  const later = kids(note, "lyric").find((x) => Number(x.getAttribute("number") ?? 1) > Number(number)) ?? null;
  if (later) note.insertBefore(l, later);
  else placeInNote(note, l);
}

/** Takes marks off a piece of a split note that are only the first piece's (or the last's). */
export function keepMarksFor(note: Element, first: boolean, last: boolean): void {
  const isStop = (e: Element) => e.getAttribute("type") === "stop";
  const isStart = (e: Element) => e.getAttribute("type") === "start" || (e.tagName === "tremolo" && (e.getAttribute("type") ?? "single") === "single");
  if (!first) for (const l of kids(note, "lyric")) l.remove();
  for (const nots of kids(note, "notations")) {
    if (!first) {
      for (const tag of ["articulations", "fermata", "arpeggiate"]) for (const e of kids(nots, tag)) e.remove();
      for (const t of kids(nots, "technical")) for (const c of kids(t)) if (!isStop(c) && c.tagName !== "string" && c.tagName !== "fret") c.remove();
      for (const orn of kids(nots, "ornaments")) for (const o of kids(orn)) if (!isStop(o)) o.remove();
      for (const tag of ["slur", "glissando", "slide"]) for (const e of kids(nots, tag)) if (isStart(e)) e.remove();
    }
    if (!last) {
      for (const tag of ["slur", "glissando", "slide"]) for (const e of kids(nots, tag)) if (isStop(e)) e.remove();
      for (const orn of kids(nots, "ornaments")) for (const o of kids(orn)) if (isStop(o)) o.remove();
      for (const t of kids(nots, "technical")) for (const c of kids(t)) if (isStop(c)) c.remove();
    }
    for (const t of kids(nots, "technical")) if (!t.firstElementChild) t.remove();
    for (const orn of kids(nots, "ornaments")) if (!orn.firstElementChild) orn.remove();
    if (!nots.firstElementChild) nots.remove();
  }
}

/** A grace note of a pitch, before a note: slashed (acciaccatura) or not (appoggiatura). */
export function makeGrace(doc: Document, pitch: Pitch, voice: string, staff: number | undefined, slash: boolean, chord = false): Element {
  const note = doc.createElementNS(null, "note");
  add(note, "grace", undefined, slash ? { slash: "yes" } : undefined);
  if (chord) add(note, "chord");
  setPitch(note, pitch);
  add(note, "voice", voice);
  add(note, "type", "eighth");
  if (staff) add(note, "staff", staff);
  return note;
}

// ---- Spans between two notes: glissandos, slides, trill lines, two-note tremolos.

/** Where a span's ends live: the tag, and the <notations> group holding it (none: notations itself). */
export const SPANS: Record<string, { tag: string; group: string | null }> = {
  glissando: { tag: "glissando", group: null },
  slide: { tag: "slide", group: null },
  "trill line": { tag: "wavy-line", group: "ornaments" },
  tremolo: { tag: "tremolo", group: "ornaments" },
  "hammer-on": { tag: "hammer-on", group: "technical" },
  "pull-off": { tag: "pull-off", group: "technical" },
};

export interface SpanEnd {
  kind: string;
  type: "start" | "stop";
  number: number;
  /** Tremolo strokes, glissando line type. */
  value?: string;
}

/** The span ends on a note (a single-note tremolo is not one: see tremoloOf). */
export function spansOf(note: Element): SpanEnd[] {
  const out: SpanEnd[] = [];
  for (const nots of kids(note, "notations"))
    for (const [kind, { tag, group }] of Object.entries(SPANS))
      for (const holder of group ? kids(nots, group) : [nots])
        for (const e of kids(holder, tag)) {
          const type = e.getAttribute("type");
          if (type !== "start" && type !== "stop") continue;
          out.push({ kind, type, number: Number(e.getAttribute("number")) || 1, value: kind === "tremolo" ? (e.textContent?.trim() || "3") : (e.getAttribute("line-type") ?? undefined) });
        }
  return out;
}

export function addSpan(note: Element, end: SpanEnd): void {
  const { tag, group } = SPANS[end.kind];
  const doc = note.ownerDocument;
  const n = notationsOf(note, true);
  const holder = group ? (kid(n, group) ?? placeIn(n, doc.createElementNS(null, group), NOTATION_ORDER)) : n;
  const e = doc.createElementNS(null, tag);
  e.setAttribute("type", end.type);
  if (end.kind !== "tremolo") e.setAttribute("number", String(end.number));
  if (end.kind === "tremolo") e.textContent = end.value ?? "3";
  if ((end.kind === "hammer-on" || end.kind === "pull-off") && end.type === "start") e.textContent = end.kind === "hammer-on" ? "H" : "P";
  if ((end.kind === "glissando" || end.kind === "slide") && end.value && end.type === "start") e.setAttribute("line-type", end.value);
  if (group) holder.appendChild(e);
  else placeIn(n, e, NOTATION_ORDER);
}

export function removeSpan(note: Element, end: SpanEnd): void {
  const { tag, group } = SPANS[end.kind];
  for (const nots of kids(note, "notations")) {
    for (const holder of group ? kids(nots, group) : [nots]) {
      for (const e of kids(holder, tag)) if (e.getAttribute("type") === end.type && (end.kind === "tremolo" || (Number(e.getAttribute("number")) || 1) === end.number)) e.remove();
      if (group && !holder.firstElementChild) holder.remove();
    }
    if (!nots.firstElementChild) nots.remove();
  }
}

/** A single-note tremolo's strokes (0: none). */
export function tremoloOf(note: Element): number {
  for (const nots of kids(note, "notations"))
    for (const orn of kids(nots, "ornaments"))
      for (const t of kids(orn, "tremolo")) if ((t.getAttribute("type") ?? "single") === "single") return Number(t.textContent) || 3;
  return 0;
}

export function setTremolo(note: Element, strokes: number): void {
  for (const nots of kids(note, "notations")) {
    for (const orn of kids(nots, "ornaments")) {
      for (const t of kids(orn, "tremolo")) if ((t.getAttribute("type") ?? "single") === "single") t.remove();
      if (!orn.firstElementChild) orn.remove();
    }
    if (!nots.firstElementChild) nots.remove();
  }
  if (strokes <= 0) return;
  const doc = note.ownerDocument;
  const n = notationsOf(note, true);
  const orn = kid(n, "ornaments") ?? placeIn(n, doc.createElementNS(null, "ornaments"), NOTATION_ORDER);
  const t = doc.createElementNS(null, "tremolo");
  t.setAttribute("type", "single");
  t.textContent = String(strokes);
  orn.appendChild(t);
}

/** A note's fingering ("" if none). */
export function fingeringOf(note: Element): string {
  for (const nots of kids(note, "notations")) for (const t of kids(nots, "technical")) for (const f of kids(t, "fingering")) return f.textContent?.trim() ?? "";
  return "";
}

/** Sets (or, empty, removes) a note's fingering. */
export function setFingering(note: Element, value: string): void {
  for (const nots of kids(note, "notations")) {
    for (const t of kids(nots, "technical")) {
      for (const f of kids(t, "fingering")) f.remove();
      if (!t.firstElementChild) t.remove();
    }
    if (!nots.firstElementChild) nots.remove();
  }
  if (!value) return;
  const doc = note.ownerDocument;
  const n = notationsOf(note, true);
  const t = kid(n, "technical") ?? placeIn(n, doc.createElementNS(null, "technical"), NOTATION_ORDER);
  const f = doc.createElementNS(null, "fingering");
  f.textContent = value;
  t.insertBefore(f, t.firstChild);
}

// ---- Bends: how far a string is pushed (in semitones), with a pre-bend or a release.

export interface Bend {
  alter: number;
  /** Bent before the note sounds. */
  pre?: boolean;
  /** Let back down. */
  release?: boolean;
}

export function bendsOf(note: Element): Bend[] {
  const out: Bend[] = [];
  for (const nots of kids(note, "notations"))
    for (const t of kids(nots, "technical"))
      for (const b of kids(t, "bend")) out.push({ alter: Number(text(b, "bend-alter")) || 0, ...(kid(b, "pre-bend") ? { pre: true } : {}), ...(kid(b, "release") ? { release: true } : {}) });
  return out;
}

/** Replaces a note's bends (none: takes them off). */
export function setBends(note: Element, bends: Bend[]): void {
  for (const nots of kids(note, "notations")) {
    for (const t of kids(nots, "technical")) {
      for (const b of kids(t, "bend")) b.remove();
      if (!t.firstElementChild) t.remove();
    }
    if (!nots.firstElementChild) nots.remove();
  }
  if (!bends.length) return;
  const doc = note.ownerDocument;
  const n = notationsOf(note, true);
  const t = kid(n, "technical") ?? placeIn(n, doc.createElementNS(null, "technical"), NOTATION_ORDER);
  for (const b of bends) {
    const e = doc.createElementNS(null, "bend");
    const alter = doc.createElementNS(null, "bend-alter");
    alter.textContent = String(b.alter);
    e.appendChild(alter);
    if (b.pre) e.appendChild(doc.createElementNS(null, "pre-bend"));
    if (b.release) e.appendChild(doc.createElementNS(null, "release"));
    t.appendChild(e);
  }
}

// ---- Technical signs with a value: plucks (p i m a), woodwind holes, arrows; and any other.

const HANDLED_TECH = new Set(["string", "fret", "fingering", "hammer-on", "pull-off", "bend", ...TECHNICAL_MARKS]);

/** A pluck's letter, a hole's covering (yes, half, no) or an arrow's direction ("" if none). */
export function techValue(note: Element, tag: "pluck" | "hole" | "arrow"): string {
  for (const nots of kids(note, "notations"))
    for (const t of kids(nots, "technical"))
      for (const e of kids(t, tag)) return tag === "pluck" ? (e.textContent?.trim() ?? "") : tag === "hole" ? text(e, "hole-closed") : text(e, "arrow-direction");
  return "";
}

/** Sets (or, empty, removes) a pluck, hole or arrow. */
export function setTechValue(note: Element, tag: "pluck" | "hole" | "arrow", value: string): void {
  for (const nots of kids(note, "notations")) {
    for (const t of kids(nots, "technical")) {
      for (const e of kids(t, tag)) e.remove();
      if (!t.firstElementChild) t.remove();
    }
    if (!nots.firstElementChild) nots.remove();
  }
  if (!value) return;
  const doc = note.ownerDocument;
  const n = notationsOf(note, true);
  const t = kid(n, "technical") ?? placeIn(n, doc.createElementNS(null, "technical"), NOTATION_ORDER);
  const e = doc.createElementNS(null, tag);
  const inner = tag === "hole" ? "hole-closed" : tag === "arrow" ? "arrow-direction" : null;
  if (inner) {
    const c = doc.createElementNS(null, inner);
    c.textContent = value;
    e.appendChild(c);
  } else e.textContent = value;
  t.appendChild(e);
}

/** Technical signs no other helper handles, as written (for copying them whole). */
export function otherTechnical(note: Element): string[] {
  const ser = new XMLSerializer();
  return kids(note, "notations").flatMap((nots) => kids(nots, "technical").flatMap((t) => kids(t).filter((c) => !HANDLED_TECH.has(c.tagName)).map((c) => ser.serializeToString(c))));
}

/** Adds a technical sign written as XML. */
export function addTechnicalXml(note: Element, xml: string): void {
  const parsed = new DOMParser().parseFromString(`<x>${xml}</x>`, "application/xml").documentElement.firstElementChild;
  if (!parsed) return;
  const doc = note.ownerDocument;
  const n = notationsOf(note, true);
  const t = kid(n, "technical") ?? placeIn(n, doc.createElementNS(null, "technical"), NOTATION_ORDER);
  t.appendChild(doc.importNode(parsed, true));
}
