import type { ScoreDoc } from "../model/score";
import { kid, kids, text } from "../model/xml";
import { fifthsOf, plainKey, transposePitch } from "./transpose";
import { directionOf, directionsAt, makeDirection, type Direction, type TextKind } from "./directions";
import { isAfterGrace, readMeasure, voiceKey, writeMeasure, type Event, type ReadMeasure } from "./measure";
import { TYPES, addOrnamentXml, setOrnamentAccidental, addTechnicalXml, setTechValue, setBends, type Bend, addSpan, removeSpan, setFingering, setTremolo, spansOf, addSlur, defaultPosition, isTied, keepMarksFor, makeGrace, marksOf, placeInNote, removeSlur, setLyric, setMark, setPosition, slursOf, writtenFor, keyAlter, makeNote, midiOf, pieceOf, readPitch, setPitch, setTie, spellMidi, splitLength, type Pitch, type Written } from "./notes";

/** Where the next note goes: a beat in one voice of one staff of a part. */
export interface Caret {
  part: number;
  measure: number;
  /** Staff within the part, from 1. */
  staff: number;
  /** The MusicXML voice id (see voiceId). */
  voice: string;
  /** From the start of the measure, in quarter notes. */
  pos: number;
}

export interface NoteInput {
  /** The chord's pitches; null for a rest. */
  pitches: Pitch[] | null;
  /** Written length in quarter notes (dots included). */
  quarters: number;
  /** Notes to copy instead of new ones (keeping their marks and lyrics). */
  templates?: Element[];
}

/** Copied music: each event's pitches (null for a rest), length and tie on. */
export interface Clip {
  pitches: Pitch[] | null;
  quarters: number;
  tie: boolean;
}

/** What an edit changed: measures [from, to) to draw again, and measures added or removed at the end. */
export interface Change {
  from: number;
  to: number;
  appended: number;
}

// A stretch of a voice: a rest or a chord over a length, tied in and out. `intact` holds the
// original elements while the stretch is unchanged, so what is not edited is kept as it was.
interface Seg {
  len: number;
  notes: Element[] | null;
  graces: Element[];
  tieIn: boolean;
  tieOut: boolean;
  intact: Element[] | null;
  /** A tuplet member: its ratio, written value and bracket marks, kept when the slot is filled. */
  tuplet?: Tuplet;
  /** Entered as it is: not merged with the rests next to it in the write that enters it. */
  keep?: boolean;
}

interface Tuplet {
  ratio: Element;
  type: string;
  dots: number;
  marks: Element[];
}

interface Entry {
  /** "part:measure" of every measure the edit changed (kept with or without history). */
  touched: Set<string>;
  before: Map<string, Element>;
  after: Map<string, Element>;
  appended: number;
  appendedEls: Element[][];
}

// Divisions per quarter after the first edit: fine enough for 128ths, triplets, quintuplets,
// septuplets and nonuplets (1/18 of a beat).
const FINE = 10080;
const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
const lcm = (a: number, b: number) => (a / gcd(a, b)) * b;
const total = (segs: Seg[]) => segs.reduce((s, x) => s + x.len, 0);

// Edits on a ScoreDoc, each one undoable. The measures it touched are copied before the
// change; undo puts the copies back.
export class ScoreEditor {
  private done: Entry[] = [];
  private undone: Entry[] = [];
  private entry: Entry | null = null;
  private fine = new Set<number>();

  /**
   * history: false keeps no undo (for scripted edits of whole scores). tabCopies says which
   * parts' tab staves copy their notation staff, when the score cannot show it (emptied).
   */
  constructor(
    readonly score: ScoreDoc,
    private opts: { history?: boolean; tabCopies?: (part: number) => boolean } = {},
  ) {}

  get canUndo(): boolean {
    return this.done.length > 0;
  }
  get canRedo(): boolean {
    return this.undone.length > 0;
  }

  /** The voice id for the n-th voice (1-4) of a staff, as the part already numbers them. */
  voiceId(part: number, staff: number, n: number): string {
    const ids = new Set<string>();
    for (const m of this.score.measures[part] ?? [])
      for (const note of kids(m, "note")) if ((Number(text(note, "staff")) || 1) === staff) ids.add(text(note, "voice") || "1");
    const sorted = [...ids].sort((a, b) => Number(a) - Number(b));
    if (n <= sorted.length) return sorted[n - 1];
    const guess = String((staff - 1) * 4 + n);
    return ids.has(guess) ? String(Math.max(0, ...[...ids].map(Number)) + 1) : guess;
  }

  /** Divisions, length and key of a measure. */
  info(part: number, measure: number): { perQuarter: number; length: number; fifths: number; beat: number } {
    const meas = this.score.measures[part][measure];
    const attrs = [...this.score.attributesAt(part, measure), ...kids(meas, "attributes").flatMap((a) => kids(a))];
    let perQuarter = 1;
    let beats = 4;
    let beatType = 4;
    let fifths = 0;
    let timed = false;
    for (const a of attrs) {
      if (a.tagName === "divisions") perQuarter = Number(a.textContent) || 1;
      else if (a.tagName === "time" && text(a, "beats")) {
        beats = eval_(text(a, "beats"));
        beatType = Number(text(a, "beat-type")) || 4;
        timed = true;
      } else if (a.tagName === "key" && kid(a, "fifths")) fifths = Number(text(a, "fifths")) || 0;
    }
    let length = Math.round((beats / beatType) * 4 * perQuarter);
    const used = Math.max(0, ...[...readMeasure(meas).voices.values()].map((evs) => evs.reduce((e, v) => Math.max(e, v.pos + v.dur), 0)));
    // A bar is as long as its longest voice (as MuseScore reads one): a pickup, a bar written
    // shorter (or longer) than its time signature. An empty bar takes the time signature.
    if (meas.getAttribute("implicit") === "yes" || !timed || used > 0) length = used || length;
    // Compound time beams by the dotted quarter.
    const beat = beatType === 8 && beats % 3 === 0 ? perQuarter * 1.5 : perQuarter;
    return { perQuarter, length, fifths, beat };
  }

  /** Enters a note, chord or rest at the caret; returns the caret after it. */
  enter(caret: Caret, input: NoteInput, opts: { insert?: boolean } = {}): { caret: Caret; change: Change } {
    return this.transact(() => {
      this.makeFine(caret.part);
      const { perQuarter } = this.info(caret.part, caret.measure);
      let len = Math.round(input.quarters * perQuarter);
      const staves = this.staves(caret.part);
      const doc = this.score.doc;
      const tmpl = input.templates ?? input.pitches?.map((p) => makeNote(doc, { pitch: p, divs: 0, written: null, voice: caret.voice, staff: staves > 1 ? caret.staff : undefined })) ?? null;
      let incoming: Seg[] = [{ len, notes: tmpl, graces: [], tieIn: false, tieOut: false, intact: null, keep: !tmpl }];
      let m = caret.measure;
      let pos = Math.round(caret.pos * perQuarter);
      const start = pos;
      let last = m;
      const key = voiceKey(caret.staff, caret.voice);
      while (incoming.length) {
        this.ensureMeasure(m);
        const { length } = this.info(caret.part, m);
        const segs = this.segsOf(caret.part, m, key, length);
        const [before, from] = cut(segs, pos);
        // Written into a tuplet's slot, a note takes the slot's length and ratio.
        // Written into a tuplet, a note keeps the tuplet's ratio at its own length (a slot, part
        // of one, or several), within what is left of the tuplet.
        if (m === caret.measure && !opts.insert && from[0]?.tuplet) {
          const tp = from[0].tuplet;
          let span = 0;
          for (let k = 0; k < from.length && from[k].tuplet && (k === 0 || !from[k].tuplet!.marks.some((x) => x.getAttribute("type") === "start")); k++) span += from[k].len;
          const a = Number(text(tp.ratio, "actual-notes")) || 3;
          const n = Number(text(tp.ratio, "normal-notes")) || 2;
          if (len <= span && writtenFor(Math.round((len * a) / n), perQuarter)) {
            let used = 0;
            let last: Seg | undefined;
            for (const f of from) {
              if (used >= len) break;
              used += f.len;
              last = f;
            }
            const marks = [...tp.marks.filter((x) => x.getAttribute("type") === "start"), ...(used === len && last?.tuplet ? last.tuplet.marks.filter((x) => x.getAttribute("type") === "stop") : [])];
            incoming = [{ ...incoming[0], len, tuplet: { ratio: tp.ratio, type: "", dots: 0, marks } }];
          }
        }
        const room = length - pos;
        let laid: Seg[];
        if (opts.insert) {
          // What follows moves right; rests at the end of the bar take the push first.
          const seq = [...incoming, ...from];
          let excess = total(seq) - room;
          while (excess > 0 && seq.length && !seq[seq.length - 1].notes && placedAll(seq, incoming)) {
            const r = seq[seq.length - 1];
            if (r.len <= excess) {
              seq.pop();
              excess -= r.len;
            } else {
              seq[seq.length - 1] = { ...r, len: r.len - excess, intact: null };
              excess = 0;
            }
          }
          const [now, later] = cut(seq, room);
          laid = now;
          incoming = later;
        } else {
          const [now, later] = cut(incoming, room);
          let [, after] = cut(from, total(now));
          // The rest of a note written over becomes a rest, as in MuseScore.
          if (after.length && after[0].notes && after[0].tieIn && !after[0].intact) after = [{ ...after[0], notes: null, tieIn: false, tieOut: false, graces: [] }, ...after.slice(1)];
          laid = [...now, ...after];
          incoming = later;
        }
        this.writeVoice(caret.part, m, key, [...before, ...laid], length);
        last = m;
        m++;
        pos = 0;
      }
      this.fixTies(caret.part, key, caret.measure - 1, last + 1);
      return { caret: this.advance(caret.part, caret.measure, start, len, caret), change: { from: caret.measure, to: last + 1, appended: 0 } };
    });
  }

  /** Several edits as one undo step. */
  group<T>(fn: () => T): T {
    return this.transact(fn);
  }

  /** The events of one voice from a's event to b's, both included, in order. */
  eventsBetween(a: Caret, b: Caret): { at: Caret; ev: Event }[] {
    const [from, to] = a.measure < b.measure || (a.measure === b.measure && a.pos <= b.pos) ? [a, b] : [b, a];
    const key = voiceKey(from.staff, from.voice);
    const out: { at: Caret; ev: Event }[] = [];
    for (let m = from.measure; m <= to.measure && m < this.score.measureCount; m++) {
      const per = this.info(from.part, m).perQuarter;
      for (const ev of readMeasure(this.score.measures[from.part][m]).voices.get(key) ?? []) {
        const q = ev.pos / per;
        const end = (ev.pos + ev.dur) / per;
        if (m === from.measure && end <= from.pos) continue;
        if (m === to.measure && q > to.pos) continue;
        out.push({ at: { ...from, measure: m, pos: q }, ev });
      }
    }
    return out;
  }

  /** Copies events as pitches and lengths, for pasting. */
  copy(a: Caret, b: Caret): Clip[] {
    return this.eventsBetween(a, b).map(({ at, ev }) => ({
      pitches: ev.rest ? null : ev.notes.map(readPitch).filter((p): p is Pitch => !!p),
      quarters: ev.dur / this.info(at.part, at.measure).perQuarter,
      tie: !ev.rest && isTied(ev.notes[0], "start"),
    }));
  }

  /** Writes copied events from the caret on (one undo step); returns the caret after them. */
  paste(caret: Caret, clip: Clip[]): { caret: Caret; change: Change } {
    return this.transact(() => {
      let c = caret;
      let to = caret.measure + 1;
      for (const item of clip) {
        const r = this.enter(c, { pitches: item.pitches, quarters: item.quarters });
        if (item.tie) {
          const ev = this.eventAt(c);
          if (ev) for (const n of ev.notes) setTie(n, "start", true);
        }
        to = Math.max(to, r.change.to);
        c = r.caret;
      }
      this.fixTies(caret.part, voiceKey(caret.staff, caret.voice), caret.measure, to);
      return { caret: c, change: { from: caret.measure, to, appended: 0 } };
    });
  }

  /** The event in a voice that covers a beat. */
  eventAt(caret: Caret): Event | null {
    const meas = this.score.measures[caret.part]?.[caret.measure];
    if (!meas) return null;
    const evs = readMeasure(meas).voices.get(voiceKey(caret.staff, caret.voice)) ?? [];
    const pos = Math.round(caret.pos * this.info(caret.part, caret.measure).perQuarter);
    return evs.find((e) => e.pos <= pos && pos < e.pos + e.dur) ?? null;
  }

  /** Turns the event at the caret into a rest (or removes one note of a chord). */
  remove(caret: Caret, note?: Element): Change {
    const ev = this.eventAt(caret);
    if (!ev) return { from: caret.measure, to: caret.measure, appended: 0 };
    if (note && ev.notes.length > 1 && ev.notes.includes(note)) {
      return this.transact(() => {
        this.touch(caret.part, caret.measure);
        note.remove();
        return { from: caret.measure, to: caret.measure + 1, appended: 0 };
      });
    }
    const { perQuarter } = this.info(caret.part, caret.measure);
    return this.enter({ ...caret, pos: ev.pos / perQuarter }, { pitches: null, quarters: ev.dur / perQuarter }).change;
  }

  /** Gives the event at the caret a new length, keeping its pitches. */
  setLength(caret: Caret, quarters: number): { caret: Caret; change: Change } {
    const ev = this.eventAt(caret);
    if (!ev) return { caret, change: { from: caret.measure, to: caret.measure, appended: 0 } };
    const pitches = ev.rest ? null : ev.notes.map(readPitch).filter((p): p is Pitch => !!p);
    const templates = ev.rest ? undefined : ev.notes.map((n) => n.cloneNode(true) as Element);
    return this.enter({ ...caret, pos: ev.pos / this.info(caret.part, caret.measure).perQuarter }, { pitches, quarters, templates });
  }

  /** Adds a pitch to the chord at the caret. */
  addToChord(caret: Caret, pitch: Pitch): Change {
    const ev = this.eventAt(caret);
    if (!ev) return { from: caret.measure, to: caret.measure, appended: 0 };
    if (ev.rest) {
      const { perQuarter } = this.info(caret.part, caret.measure);
      return this.enter({ ...caret, pos: ev.pos / perQuarter }, { pitches: [pitch], quarters: ev.dur / perQuarter }).change;
    }
    return this.transact(() => {
      this.touch(caret.part, caret.measure);
      const base = ev.notes[ev.notes.length - 1];
      const n = base.cloneNode(true) as Element;
      for (const tag of ["tie", "notations", "lyric", "accidental", "beam"]) for (const e of kids(n, tag)) e.remove();
      setPitch(n, pitch);
      if (!kid(n, "chord")) placeInNote(n, this.score.doc.createElementNS(null, "chord"));
      base.after(n);
      const r = readMeasure(this.score.measures[caret.part][caret.measure]);
      writeMeasure(this.score.measures[caret.part][caret.measure], r);
      return { from: caret.measure, to: caret.measure + 1, appended: 0 };
    });
  }

  /**
   * Makes a tuplet at the caret: `actual` rests in the time of `normal`, together `quarters`
   * long (a triplet of eighths: quarters 1, actual 3, normal 2). It stays within the bar.
   */
  tuplet(caret: Caret, quarters: number, actual = 3, normal = 2): Change {
    return this.transact(() => {
      this.makeFine(caret.part);
      const { perQuarter, length } = this.info(caret.part, caret.measure);
      const pos = Math.round(caret.pos * perQuarter);
      const len = Math.round(quarters * perQuarter);
      const member = len / actual;
      const w = writtenFor(len / normal, perQuarter);
      if (!w || !Number.isInteger(member) || pos + len > length) return { from: caret.measure, to: caret.measure, appended: 0 };
      const key = voiceKey(caret.staff, caret.voice);
      const segs = this.segsOf(caret.part, caret.measure, key, length);
      const [before, rest] = cut(segs, pos);
      const [, after] = cut(rest, len);
      const doc = this.score.doc;
      const ratio = doc.createElementNS(null, "time-modification");
      for (const [tag, v] of [["actual-notes", actual], ["normal-notes", normal]] as const) {
        const e = doc.createElementNS(null, tag);
        e.textContent = String(v);
        ratio.appendChild(e);
      }
      const mark = (type: string) => {
        const e = doc.createElementNS(null, "tuplet");
        e.setAttribute("type", type);
        if (type === "start") e.setAttribute("bracket", "yes");
        return e;
      };
      const slots: Seg[] = Array.from({ length: actual }, (_, i) => ({
        len: member,
        notes: null,
        graces: [],
        tieIn: false,
        tieOut: false,
        intact: null,
        tuplet: { ratio, type: w.type, dots: w.dots, marks: i === 0 ? [mark("start")] : i === actual - 1 ? [mark("stop")] : [] },
      }));
      this.writeVoice(caret.part, caret.measure, key, [...before, ...slots, ...after], length);
      return { from: caret.measure, to: caret.measure + 1, appended: 0 };
    });
  }

  /** The drum a part draws nearest a staff position (from its notes), within `reach` steps. */
  drumAt(part: number, step: string, octave: number, reach = 0): Pitch | null {
    const d = (p: { step: string; octave: number }) => p.octave * 7 + "CDEFGAB".indexOf(p.step);
    const want = d({ step, octave });
    let best: Pitch | null = null;
    for (const m of this.score.measures[part] ?? [])
      for (const n of kids(m, "note")) {
        const p = readPitch(n);
        if (!p?.unpitched || Math.abs(d(p) - want) > reach) continue;
        if (!best || Math.abs(d(p) - want) < Math.abs(d(best) - want)) best = p;
        if (d(p) === want) return p;
      }
    return best;
  }

  /**
   * A fretted part's tuning (open strings, lowest first) and its staves: the notation staff
   * and the tab staff drawn from it, when it has both.
   */
  fretted(part: number): { tuning: number[]; notation: number | null; tab: number | null } | null {
    const meas = this.score.measures[part]?.[0];
    if (!meas) return null;
    const attrs = [...this.score.attributesAt(part, 0), ...kids(meas, "attributes").flatMap((a) => kids(a))];
    let tuning: number[] = [];
    let tab: number | null = null;
    const staves = new Set<number>([1]);
    for (const a of attrs) {
      const n = Number(a.getAttribute("number") ?? 1);
      staves.add(n);
      if (a.tagName === "clef" && text(a, "sign") === "TAB") tab = n;
      if (a.tagName === "staff-details" && kids(a, "staff-tuning").length)
        tuning = kids(a, "staff-tuning")
          .sort((x, y) => Number(x.getAttribute("line")) - Number(y.getAttribute("line")))
          .map((t) => midiOf({ step: text(t, "tuning-step"), alter: Number(text(t, "tuning-alter")) || 0, octave: Number(text(t, "tuning-octave")) }));
    }
    if (!tuning.length) return null;
    let notation = [...staves].find((n) => n !== tab) ?? null;
    // Kept in step only when the tab staff holds the same notes as the notation staff.
    if (tab !== null && notation !== null && !this.copies(part, notation, tab)) notation = null;
    return { tuning, notation: tab !== null ? notation : null, tab };
  }

  private copiesCache = new Map<string, boolean>();
  private primed = false;
  private copies(part: number, a: number, b: number): boolean {
    const key = `${part}:${a}:${b}`;
    let same = this.copiesCache.get(key);
    if (same !== undefined) return same;
    if (this.opts.tabCopies) {
      same = this.opts.tabCopies(part);
      this.copiesCache.set(key, same);
      return same;
    }
    const notes = (r: ReturnType<typeof readMeasure>, staff: number) =>
      [...r.voices]
        .filter(([k]) => k.startsWith(`${staff}|`))
        .flatMap(([, evs]) => evs.filter((e) => !e.rest).map((e) => `${e.pos}/${e.dur}/${e.notes.map((n) => midiOf(readPitch(n) ?? { step: "C", alter: 0, octave: 0 })).sort().join(",")}`))
        .sort()
        .join(" ");
    same = this.score.measures[part].every((m) => {
      const r = readMeasure(m);
      return notes(r, a) === notes(r, b);
    });
    this.copiesCache.set(key, same);
    return same;
  }

  /** Whether a part's notes are drums. */
  isDrums(part: number): boolean {
    for (const m of this.score.measures[part] ?? []) if (m.getElementsByTagName("unpitched").length) return true;
    return false;
  }

  /** A drum's name, from the part list. */
  drumName(id: string | undefined): string {
    if (!id) return "";
    for (const si of Array.from(this.score.root.getElementsByTagName("score-instrument"))) if (si.getAttribute("id") === id) return text(si, "instrument-name");
    return "";
  }

  /** The next event (notes only, unless rests too) after the one at the caret, in its voice. */
  nextEvent(caret: Caret, rests = false): Caret | null {
    const ev = this.eventAt(caret);
    if (!ev) return null;
    let at = this.advance(caret.part, caret.measure, ev.pos, ev.dur, caret);
    for (let guard = 0; guard < 10000 && at.measure < this.score.measureCount; guard++) {
      const next = this.eventAt(at);
      if (!next) return null;
      if (rests || !next.rest) return at;
      at = this.advance(at.part, at.measure, next.pos, next.dur, at);
    }
    return null;
  }

  /** Puts a mark (accent, staccato, trill-mark, fermata...) on the event at the caret, or takes it off (on omitted: toggles). */
  mark(caret: Caret, mark: string, on?: boolean): Change {
    const ev = this.eventAt(caret);
    // A rest takes a fermata only.
    if (!ev || (ev.rest && mark !== "fermata")) return { from: caret.measure, to: caret.measure, appended: 0 };
    return this.transact(() => {
      this.touch(caret.part, caret.measure);
      const want = on ?? !ev.notes.some((n) => marksOf(n).includes(mark));
      // On the chord's first note, as MuseScore writes it; off every note.
      // An arpeggio goes on every note of the chord.
      ev.notes.forEach((n, i) => setMark(n, mark, want && (i === 0 || mark === "arpeggiate")));
      return { from: caret.measure, to: caret.measure + 1, appended: 0 };
    });
  }

  /**
   * A slur from the event at a to the one at b (the next note when b is null). By default one
   * already there is taken off instead; add: true always adds (two slurs can share ends).
   */
  slur(a: Caret, b: Caret | null, opts: { add?: boolean } = {}): Change {
    const from = this.eventAt(a);
    const end = b ?? this.nextEvent(a);
    const to = end ? this.eventAt(end) : null;
    if (!from || from.rest || !end || !to || to.rest || to === from) return { from: a.measure, to: a.measure, appended: 0 };
    return this.transact(() => {
      this.touch(a.part, a.measure);
      this.touch(end.part, end.measure);
      const first = from.notes[0];
      const last = to.notes[0];
      const existing = opts.add ? undefined : slursOf(first).find((sl) => sl.type === "start" && slursOf(last).some((x) => x.type === "stop" && x.number === sl.number));
      if (existing) {
        removeSlur(first, existing);
        removeSlur(last, { type: "stop", number: existing.number });
      } else {
        // A number no slur uses in between.
        const used = new Set([...this.eventsBetween(a, end).flatMap(({ ev }) => ev.notes.flatMap((n) => slursOf(n).map((x) => x.number))), ...slursOf(first).map((x) => x.number), ...slursOf(last).map((x) => x.number)]);
        let number = 1;
        while (used.has(number) && number < 16) number++;
        addSlur(first, { type: "start", number });
        addSlur(last, { type: "stop", number });
      }
      return { from: Math.min(a.measure, end.measure), to: Math.max(a.measure, end.measure) + 1, appended: 0 };
    });
  }

  /** A single-note tremolo of 1-4 strokes on the event at the caret (0 takes it off). */
  tremolo(caret: Caret, strokes: number): Change {
    const ev = this.eventAt(caret);
    if (!ev || ev.rest) return { from: caret.measure, to: caret.measure, appended: 0 };
    return this.transact(() => {
      this.touch(caret.part, caret.measure);
      setTremolo(ev.notes[0], strokes);
      return { from: caret.measure, to: caret.measure + 1, appended: 0 };
    });
  }

  /**
   * A span from the event at a to the one at b (the next note when b is null): a glissando,
   * slide, trill line (b may be a itself) or two-note tremolo (value: line type, strokes).
   * One already there is taken off, unless add.
   */
  span(kind: string, a: Caret, b: Caret | null, opts: { value?: string; add?: boolean; trillMark?: boolean } = {}): Change {
    const from = this.eventAt(a);
    const end = b ?? this.nextEvent(a);
    const to = end ? this.eventAt(end) : null;
    const none = { from: a.measure, to: a.measure, appended: 0 };
    if (!from || from.rest || !end || !to || to.rest) return none;
    const same = to.pos === from.pos && end.measure === a.measure;
    if (same && kind !== "trill line") return none;
    return this.transact(() => {
      this.touch(a.part, a.measure);
      this.touch(end.part, end.measure);
      const first = from.notes[0];
      const last = same ? first : to.notes[0];
      const existing = opts.add ? undefined : spansOf(first).find((x) => x.kind === kind && x.type === "start" && spansOf(last).some((y) => y.kind === kind && y.type === "stop" && y.number === x.number));
      if (existing) {
        removeSpan(first, existing);
        removeSpan(last, { ...existing, type: "stop" });
      } else {
        const used = new Set([...spansOf(first), ...spansOf(last)].filter((x) => x.kind === kind).map((x) => x.number));
        let number = 1;
        while (used.has(number) && number < 16) number++;
        // A trill line starts with "tr" unless told otherwise (a wavy line alone).
        if (kind === "trill line" && opts.trillMark !== false) setMark(first, "trill-mark", true);
        addSpan(first, { kind, type: "start", number, value: opts.value });
        addSpan(last, { kind, type: "stop", number, value: opts.value });
      }
      return { from: Math.min(a.measure, end.measure), to: Math.max(a.measure, end.measure) + 1, appended: 0 };
    });
  }

  /** Sets a note's bends (none takes them off). */
  bends(note: Element, bends: Bend[]): Change {
    const at = this.locate(note);
    if (!at) return { from: 0, to: 0, appended: 0 };
    return this.transact(() => {
      this.touch(at.part, at.measure);
      setBends(note, bends);
      return { from: at.measure, to: at.measure + 1, appended: 0 };
    });
  }

  /** Sets a note's pluck letter, hole covering or arrow direction ("" takes it off). */
  techValue(note: Element, tag: "pluck" | "hole" | "arrow", value: string): Change {
    const at = this.locate(note);
    if (!at) return { from: 0, to: 0, appended: 0 };
    return this.transact(() => {
      this.touch(at.part, at.measure);
      setTechValue(note, tag, value);
      return { from: at.measure, to: at.measure + 1, appended: 0 };
    });
  }

  /** Adds an ornament written as XML (a rebuild copying one as it is). */
  addOrnament(note: Element, xml: string): Change {
    const at = this.locate(note);
    if (!at) return { from: 0, to: 0, appended: 0 };
    return this.transact(() => {
      this.touch(at.part, at.measure);
      addOrnamentXml(note, xml);
      return { from: at.measure, to: at.measure + 1, appended: 0 };
    });
  }

  /** Sets the accidental over the ornament of the event at the caret ("" takes it off). */
  ornamentAccidental(caret: Caret, value: string): Change {
    const ev = this.eventAt(caret);
    if (!ev || ev.rest) return { from: caret.measure, to: caret.measure, appended: 0 };
    return this.transact(() => {
      this.touch(caret.part, caret.measure);
      setOrnamentAccidental(ev.notes[0], value);
      return { from: caret.measure, to: caret.measure + 1, appended: 0 };
    });
  }

  /** Adds any technical sign written as XML (a rebuild copying one as it is). */
  addTechnical(note: Element, xml: string): Change {
    const at = this.locate(note);
    if (!at) return { from: 0, to: 0, appended: 0 };
    return this.transact(() => {
      this.touch(at.part, at.measure);
      addTechnicalXml(note, xml);
      return { from: at.measure, to: at.measure + 1, appended: 0 };
    });
  }

  /** Sets a note's fingering ("" takes it off). */
  fingering(note: Element, value: string): Change {
    const at = this.locate(note);
    if (!at) return { from: 0, to: 0, appended: 0 };
    return this.transact(() => {
      this.touch(at.part, at.measure);
      setFingering(note, value);
      return { from: at.measure, to: at.measure + 1, appended: 0 };
    });
  }

  /** A slur from one note element to another (grace notes included). */
  slurNotes(first: Element, last: Element): Change {
    const a = this.locate(first);
    const b = this.locate(last);
    if (!a || !b) return { from: 0, to: 0, appended: 0 };
    return this.transact(() => {
      this.touch(a.part, a.measure);
      this.touch(b.part, b.measure);
      const used = new Set([...slursOf(first), ...slursOf(last)].map((x) => x.number));
      let number = 1;
      while (used.has(number) && number < 16) number++;
      addSlur(first, { type: "start", number });
      addSlur(last, { type: "stop", number });
      return { from: Math.min(a.measure, b.measure), to: Math.max(a.measure, b.measure) + 1, appended: 0 };
    });
  }

  /** A slur from a grace note to the event at the caret (its main note, usually). */
  slurFromGrace(grace: Element, end: Caret): Change {
    const at = this.locate(grace);
    const to = this.eventAt(end);
    if (!at || !to || to.rest) return { from: end.measure, to: end.measure, appended: 0 };
    return this.transact(() => {
      this.touch(at.part, at.measure);
      this.touch(end.part, end.measure);
      const used = new Set([...slursOf(grace), ...slursOf(to.notes[0])].map((x) => x.number));
      let number = 1;
      while (used.has(number) && number < 16) number++;
      addSlur(grace, { type: "start", number });
      addSlur(to.notes[0], { type: "stop", number });
      return { from: at.measure, to: end.measure + 1, appended: 0 };
    });
  }

  /** A grace note before the event at the caret (its first note's pitch unless given); returns it. */
  /** chord: sounds with the grace note before it (a grace chord). */
  addGrace(caret: Caret, pitch?: Pitch, slash = true, chord = false, after = false): { grace: Element | null; change: Change } {
    const ev = this.eventAt(caret);
    const p = pitch ?? (ev && !ev.rest ? readPitch(ev.notes[0]) : null);
    if (!ev || ev.rest || !p) return { grace: null, change: { from: caret.measure, to: caret.measure, appended: 0 } };
    return this.transact(() => {
      this.touch(caret.part, caret.measure);
      const staves = this.staves(caret.part);
      const same = ev.graces.filter((x) => isAfterGrace(x) === after);
      const g = makeGrace(this.score.doc, { ...p, position: undefined }, caret.voice, staves > 1 ? caret.staff : undefined, slash, chord && same.length > 0);
      // A grace note after the chord: following the chord and the ones already after it.
      if (after) {
        kid(g, "grace")!.setAttribute("steal-time-previous", "0");
        const lastEl = same[same.length - 1] ?? ev.notes[ev.notes.length - 1];
        lastEl.parentElement!.insertBefore(g, lastEl.nextSibling);
      } else ev.notes[0].parentElement!.insertBefore(g, ev.notes[0]);
      return { grace: g, change: { from: caret.measure, to: caret.measure + 1, appended: 0 } };
    });
  }

  /** Takes a grace note out. */
  removeGrace(grace: Element): Change {
    const at = this.locate(grace);
    if (!at || !kid(grace, "grace")) return { from: 0, to: 0, appended: 0 };
    return this.transact(() => {
      this.touch(at.part, at.measure);
      grace.remove();
      return { from: at.measure, to: at.measure + 1, appended: 0 };
    });
  }

  /** The dynamics, hairpin ends, text and tempo marks at the caret's beat on its staff. */
  directions(caret: Caret): Direction[] {
    const ev = this.eventAt(caret);
    if (!ev) return [];
    return directionsAt(this.score.measures[caret.part][caret.measure], ev.pos, caret.staff)
      .map(directionOf)
      .filter((d): d is Direction => !!d);
  }

  /** The dynamic at the caret's beat (null takes it off). */
  dynamic(caret: Caret, value: string | null): Change {
    return this.setDirection(caret, (d) => d.kind === "dynamic", value ? { kind: "dynamic", value } : null);
  }

  /** Text of one kind at the caret's beat (empty takes it off). */
  text(caret: Caret, kind: TextKind, words: string | null): Change {
    return this.setDirection(caret, (d) => d.kind === "text" && d.text === kind, words ? { kind: "text", text: kind, words } : null);
  }

  /** A tempo mark at the caret's beat: quarters per minute and its text ("♩ = bpm" when none); null takes it off. */
  tempo(caret: Caret, bpm: number | null, words = ""): Change {
    return this.setDirection(caret, (d) => d.kind === "tempo", bpm ? { kind: "tempo", bpm, words: words || `♩ = ${bpm}` } : null);
  }

  /** Replaces the directions matching at the caret's beat on its staff with one (or none). */
  private setDirection(caret: Caret, match: (d: Direction) => boolean, dir: Direction | null): Change {
    const ev = this.eventAt(caret);
    const none = { from: caret.measure, to: caret.measure, appended: 0 };
    if (!ev) return none;
    const meas = this.score.measures[caret.part][caret.measure];
    const old = directionsAt(meas, ev.pos, caret.staff).filter((d) => {
      const x = directionOf(d);
      return !!x && match(x);
    });
    if (!old.length && !dir) return none;
    return this.transact(() => {
      this.touch(caret.part, caret.measure);
      for (const d of old) d.remove();
      if (dir) {
        const first = ev.graces.find((g) => !isAfterGrace(g)) ?? ev.notes[0];
        first.parentElement!.insertBefore(makeDirection(this.score.doc, dir, this.staves(caret.part) > 1 ? caret.staff : undefined), first);
      }
      return { from: caret.measure, to: caret.measure + 1, appended: 0 };
    });
  }

  /**
   * A hairpin from the event at a to the end of the one at b (a crescendo or diminuendo);
   * type null takes off the one starting at a.
   */
  hairpin(a: Caret, b: Caret | null, type: "crescendo" | "diminuendo" | null): Change {
    const from = this.eventAt(a);
    const none = { from: a.measure, to: a.measure, appended: 0 };
    if (!from) return none;
    const staffNo = this.staves(a.part) > 1 ? a.staff : undefined;
    const wedges = (m: number) =>
      readMeasure(this.score.measures[a.part][m])
        .others.filter((o) => o.el.tagName === "direction" && (Number(text(o.el, "staff")) || 1) === a.staff)
        .flatMap((o) => {
          const d = directionOf(o.el);
          return d?.kind === "wedge" ? [{ pos: o.pos, el: o.el, d }] : [];
        });
    const start = wedges(a.measure).find((w) => Math.abs(w.pos - from.pos) < 1e-9 && w.d.type !== "stop");
    // The stop of a wedge: the next one of its number on the staff.
    const stopOf = (w: { pos: number; el: Element; d: Direction & { kind: "wedge" } }) => {
      for (let m = a.measure; m < this.score.measureCount; m++)
        for (const x of wedges(m)) if (x.d.type === "stop" && x.d.number === w.d.number && (m > a.measure || x.pos >= w.pos)) return x.el;
      return null;
    };
    if (!type) {
      if (!start) return none;
      return this.transact(() => {
        const stop = stopOf(start);
        this.touch(a.part, a.measure);
        start.el.remove();
        if (stop) {
          const at = this.locate(stop);
          if (at) this.touch(at.part, at.measure);
          stop.remove();
        }
        return { from: a.measure, to: this.score.measureCount, appended: 0 };
      });
    }
    const end = b ?? this.nextEvent(a) ?? a;
    const to = this.eventAt(end);
    if (!to) return none;
    return this.transact(() => {
      this.touch(a.part, a.measure);
      this.touch(end.part, end.measure);
      if (start) {
        const stop = stopOf(start);
        const at = stop ? this.locate(stop) : null;
        if (at) this.touch(at.part, at.measure);
        start.el.remove();
        stop?.remove();
      }
      // A number no hairpin in between uses.
      const used = new Set<number>();
      for (let m = a.measure; m <= end.measure; m++) for (const w of wedges(m)) used.add(w.d.number);
      let number = 1;
      while (used.has(number) && number < 16) number++;
      const doc = this.score.doc;
      const first = from.graces.find((g) => !isAfterGrace(g)) ?? from.notes[0];
      first.parentElement!.insertBefore(makeDirection(doc, { kind: "wedge", type, number }, staffNo), first);
      const stop = makeDirection(doc, { kind: "wedge", type: "stop", number }, staffNo);
      // Ending on a barline: at the start of the next bar, as MuseScore keeps it.
      const atBar = to.pos + to.dur >= this.info(end.part, end.measure).length - 1e-9 && end.measure + 1 < this.score.measureCount;
      const next = atBar ? this.eventAt({ ...end, measure: end.measure + 1, pos: 0 }) : null;
      if (next) {
        this.touch(end.part, end.measure + 1);
        const first = next.graces.find((g) => !isAfterGrace(g)) ?? next.notes[0];
        first.parentElement!.insertBefore(stop, first);
      } else {
        const lastEl = [...to.notes, ...to.graces.filter(isAfterGrace)].pop()!;
        lastEl.parentElement!.insertBefore(stop, lastEl.nextSibling);
      }
      return { from: Math.min(a.measure, end.measure), to: Math.max(a.measure, end.measure) + (next ? 2 : 1), appended: 0 };
    });
  }

  /** Sets the lyric of one verse on the event at the caret (no text removes it). */
  lyric(caret: Caret, words: string | null, syllabic = "single", verse = "1"): Change {
    const ev = this.eventAt(caret);
    if (!ev || ev.rest) return { from: caret.measure, to: caret.measure, appended: 0 };
    return this.transact(() => {
      this.touch(caret.part, caret.measure);
      setLyric(ev.notes[0], verse, words, syllabic);
      return { from: caret.measure, to: caret.measure + 1, appended: 0 };
    });
  }

  /**
   * Transposes measures [from, to) of some parts (null: all) by an interval (steps and
   * semitones, negative down), key signatures and chord symbols with them. A range inside
   * the score gets the new key at its start and the old one back after it. Drums stay.
   */
  transposeRange(parts: number[] | null, from: number, to: number, steps: number, semitones: number): Change {
    const count = this.score.measureCount;
    to = Math.min(to, count);
    if (from >= to || (!steps && !semitones)) return { from, to: from, appended: 0 };
    const delta = fifthsOf(steps, semitones);
    const keysIn = (meas: Element) => kids(meas, "attributes").flatMap((a) => kids(a, "key"));
    return this.transact(() => {
      for (const p of parts ?? this.score.measures.map((_, i) => i)) {
        if (this.isDrums(p)) continue;
        const ms = this.score.measures[p];
        const startKey = this.info(p, from).fifths;
        const afterKey = to < count ? this.info(p, to).fifths : null;
        for (let m = from; m < to; m++) this.touch(p, m);
        if (afterKey !== null) this.touch(p, to);
        // Key signatures: those in the range move; the range starts and ends in its own.
        for (let m = from; m < to; m++) for (const k of keysIn(ms[m])) setFifths(k, plainKey((Number(text(k, "fifths")) || 0) + delta));
        if (!keysIn(ms[from]).length) addKey(ms[from], plainKey(startKey + delta));
        if (afterKey !== null && !keysIn(ms[to]).length) addKey(ms[to], afterKey);
        let fifths = plainKey(startKey + delta);
        for (let m = from; m < to; m++) {
          const own = keysIn(ms[m]);
          if (own.length) fifths = Number(text(own[0], "fifths")) || 0;
          for (const n of Array.from(ms[m].getElementsByTagName("note"))) {
            const old = readPitch(n);
            if (!old || old.unpitched) continue;
            const next: Pitch = transposePitch(old, steps, semitones, fifths);
            // On a tab staff: the same string where the fret allows.
            const fret = old.position ? old.position.fret + semitones : -1;
            if (old.position && fret >= 0 && fret <= 24) next.position = { string: old.position.string, fret };
            setPitch(n, next);
            kids(n, "accidental").forEach((a) => a.remove());
          }
          for (const h of Array.from(ms[m].getElementsByTagName("harmony"))) {
            for (const [box, stepTag, alterTag] of [["root", "root-step", "root-alter"], ["bass", "bass-step", "bass-alter"]]) {
              const b = kid(h, box);
              if (!b || !kid(b, stepTag)) continue;
              const q = transposePitch({ step: text(b, stepTag), alter: Number(text(b, alterTag)) || 0, octave: 4 }, steps, semitones, fifths);
              kid(b, stepTag)!.textContent = q.step;
              kid(b, alterTag)?.remove();
              if (q.alter) {
                const a = b.ownerDocument.createElementNS(null, alterTag);
                a.textContent = String(q.alter);
                kid(b, stepTag)!.after(a);
              }
            }
          }
        }
      }
      this.score.refresh();
      return { from, to: Math.min(count, to + 1), appended: 0 };
    });
  }

  /**
   * A key signature from a measure on, in every pitched part: fifths as the given part shows
   * it (other parts get theirs, transposing instruments their written key). Notes keep their
   * pitches. The same key as before removes the measure's own.
   */
  setKey(measure: number, fifths: number, asPart = 0): Change {
    const none = { from: measure, to: measure, appended: 0 };
    if (measure >= this.score.measureCount) return none;
    // A part's written key differs from the concert one by its transposition.
    const offset = (p: number) => {
      const tr = this.score.attributesAt(p, measure).find((e) => e.tagName === "transpose");
      return tr ? -(7 * (Number(text(tr, "chromatic")) || 0) - 12 * (Number(text(tr, "diatonic")) || 0)) : 0;
    };
    const concert = fifths - offset(asPart);
    const keysIn = (meas: Element) => kids(meas, "attributes").flatMap((a) => kids(a, "key"));
    return this.transact(() => {
      this.score.measures.forEach((ms, p) => {
        if (this.isDrums(p)) return;
        const want = plainKey(concert + offset(p));
        const prior = measure > 0 ? (this.score.attributesAt(p, measure).filter((e) => e.tagName === "key").map((k) => Number(text(k, "fifths")) || 0)[0] ?? 0) : null;
        this.touch(p, measure);
        const own = keysIn(ms[measure]);
        if (prior === want) for (const k of own) k.remove();
        else if (own.length) for (const k of own) setFifths(k, want);
        else addKey(ms[measure], want);
        for (const a of kids(ms[measure], "attributes")) if (!a.firstElementChild) a.remove();
      });
      this.score.refresh();
      return { from: measure, to: this.score.measureCount, appended: 0 };
    });
  }

  /**
   * A clef for one staff from a measure on (sign, line, octave change), drawn where MuseScore
   * keeps a change: in the first measure's opening attributes, else at the end of the one before.
   */
  setClef(part: number, staff: number, measure: number, clef: { sign: string; line: number; octave?: number }): Change {
    const none = { from: measure, to: measure, appended: 0 };
    if (measure >= this.score.measureCount) return none;
    const multi = this.staves(part) > 1;
    const forStaff = (e: Element) => e.tagName === "clef" && (Number(e.getAttribute("number")) || 1) === staff;
    const same = (e: Element | undefined) => !!e && text(e, "sign") === clef.sign && (Number(text(e, "line")) || 0) === clef.line && (Number(text(e, "clef-octave-change")) || 0) === (clef.octave ?? 0);
    const make = () => {
      const c = this.score.doc.createElementNS(null, "clef");
      if (multi) c.setAttribute("number", String(staff));
      for (const [tag, v] of [["sign", clef.sign], ["line", clef.line], ...(clef.octave ? [["clef-octave-change", clef.octave]] : [])] as [string, string | number][]) {
        const e = this.score.doc.createElementNS(null, tag);
        e.textContent = String(v);
        c.appendChild(e);
      }
      return c;
    };
    const ms = this.score.measures[part];
    return this.transact(() => {
      if (measure === 0) {
        this.touch(part, 0);
        const attrs = kids(ms[0], "attributes")[0];
        const old = attrs ? kids(attrs).find(forStaff) : undefined;
        if (same(old)) return none;
        const c = make();
        if (old) old.replaceWith(c);
        else if (attrs) placeAttr(attrs, c);
        return { from: 0, to: this.score.measureCount, appended: 0 };
      }
      // Changes already there: at the start of the measure, or at the end of the one before.
      this.touch(part, measure - 1);
      this.touch(part, measure);
      const prev = readMeasure(ms[measure - 1]);
      const len = this.info(part, measure - 1).length;
      for (const o of prev.others) if (o.el.tagName === "attributes" && o.pos >= len - 1e-9) for (const c of kids(o.el).filter(forStaff)) c.remove();
      for (const o of readMeasure(ms[measure]).others) if (o.el.tagName === "attributes" && o.pos <= 0) for (const c of kids(o.el).filter(forStaff)) c.remove();
      for (const meas of [ms[measure - 1], ms[measure]]) for (const a of kids(meas, "attributes")) if (!a.firstElementChild) a.remove();
      this.score.refresh();
      // The clef already in force: nothing to draw.
      if (!same(this.score.attributesAt(part, measure).find(forStaff))) {
        const r = readMeasure(ms[measure - 1]);
        const a = this.score.doc.createElementNS(null, "attributes");
        a.appendChild(make());
        r.others.push({ pos: len, el: a });
        writeMeasure(ms[measure - 1], r);
        this.score.refresh();
      }
      return { from: measure - 1, to: this.score.measureCount, appended: 0 };
    });
  }

  /** Moves a note up or down, with the notes tied to it. */
  transpose(note: Element, semitones: number): Change {
    const at = this.locate(note);
    const p = readPitch(note);
    if (!at || !p || p.unpitched) return { from: 0, to: 0, appended: 0 };
    const { fifths } = this.info(at.part, at.measure);
    const next = spellMidi(midiOf(p) + semitones, fifths);
    return this.retune(note, at, next);
  }

  /** Sets a note's pitch, with the notes tied to it. */
  setNotePitch(note: Element, pitch: Pitch): Change {
    const at = this.locate(note);
    if (!at) return { from: 0, to: 0, appended: 0 };
    return this.retune(note, at, pitch);
  }

  /** Ties the chord at the caret to the next one (made with the same notes if it differs). */
  /** Ties the notes of these MIDI pitches at the caret to the same notes in the next event. */
  tieTo(caret: Caret, midis: number[]): Change {
    const ev = this.eventAt(caret);
    if (!ev || ev.rest) return { from: caret.measure, to: caret.measure, appended: 0 };
    const per = this.info(caret.part, caret.measure).perQuarter;
    const after = this.advance(caret.part, caret.measure, ev.pos, ev.dur, caret);
    const next = this.eventAt(after);
    if (!next || next.rest) return { from: caret.measure, to: caret.measure, appended: 0 };
    void per;
    return this.transact(() => {
      this.touch(caret.part, caret.measure);
      this.touch(after.part, after.measure);
      for (const n of ev.notes) {
        const p = readPitch(n);
        if (!p || !midis.includes(midiOf(p))) continue;
        const m = next.notes.find((x) => samePitch(readPitch(x), p));
        if (!m) continue;
        setTie(n, "start", true);
        setTie(m, "stop", true);
      }
      return { from: caret.measure, to: after.measure + 1, appended: 0 };
    });
  }

  tie(caret: Caret): { caret: Caret; change: Change } {
    const ev = this.eventAt(caret);
    if (!ev || ev.rest) return { caret, change: { from: caret.measure, to: caret.measure, appended: 0 } };
    const pitches = ev.notes.map(readPitch).filter((p): p is Pitch => !!p);
    const { perQuarter } = this.info(caret.part, caret.measure);
    return this.transact(() => {
      let after = this.advance(caret.part, caret.measure, ev.pos, ev.dur, caret);
      let next = this.eventAt(after);
      let change: Change = { from: caret.measure, to: caret.measure + 1, appended: 0 };
      const same = next && !next.rest && sameNotes(next.notes, pitches);
      if (!same) {
        const r = this.enter(after, { pitches, quarters: ev.dur / perQuarter });
        change = { from: caret.measure, to: r.change.to, appended: 0 };
        next = this.eventAt(after);
      }
      if (!next) return { caret: after, change };
      const now = this.eventAt({ ...caret, pos: ev.pos / perQuarter })!;
      this.touch(caret.part, caret.measure);
      this.touch(after.part, after.measure);
      for (const n of now.notes) setTie(n, "start", true);
      for (const n of next.notes) setTie(n, "stop", true);
      after = this.advance(after.part, after.measure, Math.round(after.pos * this.info(after.part, after.measure).perQuarter), next.dur, after);
      return { caret: after, change: { ...change, to: Math.max(change.to, after.measure + 1) } };
    });
  }

  undo(): Change | null {
    const e = this.done.pop();
    if (!e) return null;
    e.after = this.swap(e.before);
    for (let k = 0; k < e.appended; k++) {
      kids(this.score.root, "part").forEach((part, p) => {
        const ms = kids(part, "measure");
        const lastM = ms[ms.length - 1];
        (e.appendedEls[p] ??= []).unshift(lastM);
        lastM.remove();
      });
    }
    this.score.refresh();
    this.undone.push(e);
    return { ...spanOf(e.before), appended: -e.appended };
  }

  redo(): Change | null {
    const e = this.undone.pop();
    if (!e) return null;
    kids(this.score.root, "part").forEach((part, p) => {
      for (const m of e.appendedEls[p] ?? []) part.appendChild(m);
    });
    e.appendedEls = [];
    this.score.refresh();
    e.before = this.swap(e.after);
    this.score.refresh();
    this.done.push(e);
    return { ...spanOf(e.after), appended: e.appended };
  }

  // ---- internals

  private transact<T>(fn: () => T): T {
    if (this.entry) return fn();
    // Which tab staves copy their notation staff is decided before anything changes.
    if (!this.primed) {
      this.primed = true;
      for (let p = 0; p < this.score.measures.length; p++) this.fretted(p);
    }
    this.entry = { touched: new Set(), before: new Map(), after: new Map(), appended: 0, appendedEls: [] };
    try {
      const out = fn();
      this.mirrorTabs();
      if ((this.entry.before.size || this.entry.appended) && this.opts.history !== false) {
        this.done.push(this.entry);
        this.undone = [];
      }
      // Measures keep their elements through an edit; only added ones need reading again.
      if (this.entry.appended) this.score.refresh();
      return out;
    } finally {
      this.entry = null;
    }
  }

  /** A part's tab staff is drawn from its notation staff again in the measures an edit touched. */
  private mirrorTabs(): void {
    const e = this.entry;
    if (!e) return;
    const touched = new Set(e.touched);
    const count = this.score.measureCount;
    for (let m = count - e.appended; m < count; m++) for (let p = 0; p < this.score.measures.length; p++) touched.add(`${p}:${m}`);
    const links = new Map<number, ReturnType<ScoreEditor["fretted"]>>();
    for (const key of touched) {
      const [p, m] = key.split(":").map(Number);
      if (!links.has(p)) links.set(p, this.fretted(p));
      const link = links.get(p);
      if (!link || link.notation === null || link.tab === null || !this.score.measures[p][m]) continue;
      const meas = this.score.measures[p][m];
      const r = readMeasure(meas);
      for (const k of [...r.voices.keys()]) if (k.startsWith(`${link.tab}|`)) r.voices.delete(k);
      for (const [k, evs] of [...r.voices]) {
        const [st, v] = k.split("|");
        if (Number(st) !== link.notation) continue;
        const voice = String(Number(v) + 4 * (link.tab - link.notation));
        const copy = (n: Element) => {
          const c = n.cloneNode(true) as Element;
          for (const s of kids(c, "staff")) s.textContent = String(link.tab);
          for (const s of kids(c, "voice")) s.textContent = voice;
          const pitch = readPitch(c);
          if (pitch && !pitch.position) setPosition(c, defaultPosition(midiOf(pitch), link.tuning));
          return c;
        };
        r.voices.set(voiceKey(link.tab, voice), evs.map((ev) => ({ ...ev, notes: ev.notes.map(copy), graces: ev.graces.map(copy) })));
      }
      writeMeasure(meas, r);
    }
  }

  /** Keeps a copy of a measure before it first changes in this edit. */
  private touch(part: number, measure: number): void {
    const key = `${part}:${measure}`;
    this.score.changing(part, measure);
    this.entry?.touched.add(key);
    if (this.opts.history === false) return;
    const e = this.entry;
    if (!e || e.before.has(key) || measure >= this.score.measures[part].length - e.appended) return;
    e.before.set(key, this.score.measures[part][measure].cloneNode(true) as Element);
  }

  /** Puts copies in place of the live measures; returns copies of what they replaced. */
  private swap(saved: Map<string, Element>): Map<string, Element> {
    const out = new Map<string, Element>();
    for (const [key, copy] of saved) {
      const [p, m] = key.split(":").map(Number);
      const live = this.score.measures[p][m];
      out.set(key, live.cloneNode(true) as Element);
      live.replaceWith(copy.cloneNode(true));
    }
    this.score.refresh();
    return out;
  }

  private staves(part: number): number {
    const st = this.score.attributesAt(part, Math.min(1, this.score.measureCount - 1)).find((a) => a.tagName === "staves");
    const own = kids(this.score.measures[part][0], "attributes").map((a) => kid(a, "staves")).find(Boolean);
    return Number((own ?? st)?.textContent) || 1;
  }

  /** Measures past the end are added to every part, holding a whole-bar rest. */
  private ensureMeasure(m: number): void {
    while (this.score.measureCount <= m) {
      const parts = kids(this.score.root, "part");
      parts.forEach((part, p) => {
        const ms = kids(part, "measure");
        const prev = ms[ms.length - 1];
        const meas = this.score.doc.createElementNS(null, "measure");
        meas.setAttribute("number", String((Number(prev?.getAttribute("number")) || ms.length) + 1));
        part.appendChild(meas);
        this.score.refresh();
        this.score.changing(p, ms.length);
        const { length } = this.info(p, ms.length);
        const staves = this.staves(p);
        for (let s = 1; s <= staves; s++)
          meas.appendChild(makeNote(this.score.doc, { pitch: null, divs: length, written: null, voice: this.voiceId(p, s, 1), staff: staves > 1 ? s : undefined, measureRest: true }));
      });
      if (this.entry) this.entry.appended++;
      this.score.refresh();
    }
  }

  /** A part's durations in divisions fine enough for any edit (once per part). */
  private makeFine(part: number): void {
    if (this.fine.has(part)) return;
    this.fine.add(part);
    let factor = 1;
    for (const m of this.score.measures[part]) {
      for (const c of kids(m)) {
        if (c.tagName === "attributes") {
          const d = kid(c, "divisions");
          if (d) {
            const per = Number(d.textContent) || 1;
            const fine = lcm(per, FINE);
            factor = fine / per;
            d.textContent = String(fine);
          }
        }
        if (factor === 1) continue;
        const dur = kid(c, "duration");
        if (dur) dur.textContent = String(Number(dur.textContent) * factor);
        for (const o of c.getElementsByTagName("offset")) o.textContent = String(Number(o.textContent) * factor);
      }
    }
    this.score.reindex();
  }

  private segsOf(part: number, m: number, key: string, length: number): Seg[] {
    const evs = readMeasure(this.score.measures[part][m]).voices.get(key) ?? [];
    const out: Seg[] = [];
    let at = 0;
    const gap = (to: number) => {
      if (to > at) out.push({ len: to - at, notes: null, graces: [], tieIn: false, tieOut: false, intact: null });
    };
    for (const ev of evs) {
      gap(ev.pos);
      out.push({
        len: ev.dur,
        notes: ev.rest ? null : ev.notes,
        graces: ev.graces,
        tieIn: !ev.rest && isTied(ev.notes[0], "stop"),
        tieOut: !ev.rest && isTied(ev.notes[0], "start"),
        intact: [...ev.graces, ...ev.notes],
        tuplet: tupletOf(ev.notes[0]),
      });
      at = Math.max(at, ev.pos + ev.dur);
    }
    gap(length);
    return out;
  }

  /** Writes one voice of a measure from its stretches; other voices stay. */
  private writeVoice(part: number, m: number, key: string, segs: Seg[], length: number): void {
    this.touch(part, m);
    const meas = this.score.measures[part][m];
    const r: ReadMeasure = readMeasure(meas);
    const { perQuarter, beat } = this.info(part, m);
    const [staffStr, voice] = key.split("|");
    const staff = Number(staffStr);
    const staves = this.staves(part);
    const doc = this.score.doc;
    const events: Event[] = [];
    let pos = 0;
    const first = [...r.voices.keys()].filter((k) => k.startsWith(staffStr + "|")).sort()[0] ?? key;
    // Rests next to each other are written again as one.
    const merged: Seg[] = [];
    for (const seg of segs) {
      const prev = merged[merged.length - 1];
      const marked = (x: Seg) => !!x.intact?.some((n) => kid(n, "notations"));
      if (prev && !prev.notes && !seg.notes && !prev.tuplet && !seg.tuplet && !marked(prev) && !marked(seg) && !prev.keep && !seg.keep) merged[merged.length - 1] = { ...prev, len: prev.len + seg.len, intact: null };
      else merged.push(seg);
    }
    for (const seg of merged) {
      if (seg.intact) {
        events.push({ pos, dur: seg.len, graces: seg.intact.filter((e) => kid(e, "grace")), notes: seg.intact.filter((e) => !kid(e, "grace")), rest: !seg.notes });
      } else if (!seg.notes && seg.len === length && pos === 0 && key === first) {
        events.push({ pos, dur: length, graces: [], notes: [makeNote(doc, { pitch: null, divs: length, written: null, voice, staff: staves > 1 ? staff : undefined, measureRest: true })], rest: true });
      } else if (seg.tuplet) {
        const tp = seg.tuplet;
        const a = Number(text(tp.ratio, "actual-notes")) || 3;
        const nn = Number(text(tp.ratio, "normal-notes")) || 2;
        const fit = writtenFor(Math.round((seg.len * a) / nn), perQuarter);
        const w = { type: fit?.type ?? tp.type, dots: fit?.dots ?? tp.dots, divs: seg.len };
        const notes = seg.notes
          ? seg.notes.map((t) => {
              const c = pieceOf(t, seg.len, w);
              for (const v of kids(c, "voice")) v.textContent = voice;
              if (seg.tieIn) setTie(c, "stop", true);
              if (seg.tieOut) setTie(c, "start", true);
              return c;
            })
          : [makeNote(doc, { pitch: null, divs: seg.len, written: w, voice, staff: staves > 1 ? staff : undefined })];
        for (const n of notes) markTuplet(n, tp);
        events.push({ pos, dur: seg.len, graces: seg.graces, notes, rest: !seg.notes });
      } else {
        const pieces = seg.notes ? splitLength(seg.len, perQuarter) : splitRest(pos, seg.len, perQuarter);
        let at = pos;
        pieces.forEach((w, i) => {
          const notes = seg.notes
            ? seg.notes.map((t) => {
                const c = pieceOf(t, w.divs, w);
                // A piece carried on from a note cut earlier is never its first.
                keepMarksFor(c, i === 0 && !seg.tieIn, i === pieces.length - 1 && !seg.tieOut);
                for (const v of kids(c, "voice")) v.textContent = voice;
                if (i > 0 || seg.tieIn) setTie(c, "stop", true);
                if (i < pieces.length - 1 || seg.tieOut) setTie(c, "start", true);
                return c;
              })
            : [makeNote(doc, { pitch: null, divs: w.divs, written: w, voice, staff: staves > 1 ? staff : undefined })];
          events.push({ pos: at, dur: w.divs, graces: i === 0 ? seg.graces : [], notes, rest: !seg.notes });
          at += w.divs;
        });
      }
      pos += seg.len;
    }
    beam(events, perQuarter, beat);
    r.voices.set(key, events);
    writeMeasure(meas, r);
  }

  /** Ties that lead nowhere (the note after changed) are removed, in one voice. */
  private fixTies(part: number, key: string, from: number, to: number): void {
    const ms = this.score.measures[part];
    const seq: [number, Event][] = [];
    for (let m = Math.max(0, from); m < Math.min(to + 1, ms.length); m++) for (const ev of readMeasure(ms[m]).voices.get(key) ?? []) seq.push([m, ev]);
    seq.forEach(([m, ev], i) => {
      if (ev.rest) return;
      const next = seq[i + 1]?.[1];
      const prev = seq[i - 1]?.[1];
      for (const n of ev.notes) {
        const p = readPitch(n);
        if (isTied(n, "start") && !(next && !next.rest && next.notes.some((x) => samePitch(readPitch(x), p)))) {
          this.touch(part, m);
          setTie(n, "start", false);
        }
        if (isTied(n, "stop") && !(prev && !prev.rest && prev.notes.some((x) => samePitch(readPitch(x), p) && isTied(x, "start")))) {
          this.touch(part, m);
          setTie(n, "stop", false);
        }
      }
    });
  }

  /** The caret `by` divisions after a beat, over barlines. */
  private advance(part: number, measure: number, pos: number, by: number, base: Caret): Caret {
    pos += by;
    while (pos > 0 && measure < this.score.measureCount && pos >= this.info(part, measure).length) {
      pos -= this.info(part, measure).length;
      measure++;
    }
    const per = measure < this.score.measureCount ? this.info(part, measure).perQuarter : this.info(part, measure - 1).perQuarter;
    return { ...base, measure, pos: pos / per };
  }

  private locate(note: Element): { part: number; measure: number } | null {
    const meas = note.parentElement;
    for (let p = 0; p < this.score.measures.length; p++) {
      const m = this.score.measures[p].indexOf(meas!);
      if (m >= 0) return { part: p, measure: m };
    }
    return null;
  }

  private retune(note: Element, at: { part: number; measure: number }, pitch: Pitch): Change {
    return this.transact(() => {
      const key = voiceKey(Number(text(note, "staff")) || 1, text(note, "voice") || "1");
      const old = readPitch(note);
      this.touch(at.part, at.measure);
      setPitch(note, pitch);
      kids(note, "accidental").forEach((a) => a.remove());
      // Notes tied on from this one follow it.
      let m = at.measure;
      let cur = note;
      let to = at.measure + 1;
      while (isTied(cur, "start")) {
        const seq = [...(readMeasure(this.score.measures[at.part][m]).voices.get(key) ?? [])];
        const idx = seq.findIndex((e) => e.notes.includes(cur));
        let next = seq[idx + 1];
        if (!next) {
          m++;
          if (m >= this.score.measures[at.part].length) break;
          next = (readMeasure(this.score.measures[at.part][m]).voices.get(key) ?? [])[0];
        }
        const n = next?.notes.find((x) => samePitch(readPitch(x), old));
        if (!n) break;
        this.touch(at.part, m);
        setPitch(n, pitch);
        kids(n, "accidental").forEach((a) => a.remove());
        cur = n;
        to = m + 1;
      }
      return { from: at.measure, to, appended: 0 };
    });
  }
}

function tupletOf(note: Element): Tuplet | undefined {
  const ratio = kid(note, "time-modification");
  if (!ratio) return undefined;
  const nots = kid(note, "notations");
  return {
    ratio: ratio.cloneNode(true) as Element,
    type: text(note, "type"),
    dots: kids(note, "dot").length,
    marks: nots ? kids(nots, "tuplet").map((t) => t.cloneNode(true) as Element) : [],
  };
}

/** Gives a note its tuplet ratio and bracket marks. */
function markTuplet(note: Element, tp: Tuplet): void {
  placeInNote(note, tp.ratio.cloneNode(true) as Element);
  const old = kid(note, "notations");
  for (const t of old ? kids(old, "tuplet") : []) t.remove();
  if (!tp.marks.length) return;
  const nots = old ?? placeInNote(note, note.ownerDocument.createElementNS(null, "notations"));
  for (const mk of tp.marks) nots.appendChild(mk.cloneNode(true));
}

/** Rests as MuseScore writes them: plain values, each starting on a multiple of its length. */
function splitRest(pos: number, len: number, perQuarter: number): Written[] {
  const out: Written[] = [];
  const end = pos + len;
  while (pos < end) {
    const w = TYPES.map(([type, q]) => ({ type, dots: 0, divs: q * perQuarter })).find((o) => Number.isInteger(o.divs) && o.divs <= end - pos && pos % o.divs === 0);
    if (!w) {
      out.push(...splitLength(end - pos, perQuarter));
      break;
    }
    out.push(w);
    pos += w.divs;
  }
  return out;
}

/** Splits stretches at a length: what comes before and after (a note cut in two is tied). */
function cut(segs: Seg[], at: number): [Seg[], Seg[]] {
  const before: Seg[] = [];
  const after: Seg[] = [];
  let pos = 0;
  for (const s of segs) {
    if (pos + s.len <= at) before.push(s);
    else if (pos >= at) after.push(s);
    else {
      const d = at - pos;
      const tied = !!s.notes;
      const mark = (type: string): Tuplet | undefined => (s.tuplet ? { ...s.tuplet, marks: s.tuplet.marks.filter((x) => x.getAttribute("type") === type) } : undefined);
      before.push({ ...s, len: d, tieOut: tied, intact: null, tuplet: mark("start") });
      after.push({ ...s, len: s.len - d, graces: [], tieIn: tied, intact: null, tuplet: mark("stop") });
    }
    pos += s.len;
  }
  return [before, after];
}

// In insert mode, trailing rests absorb the push only once the new note itself is in.
function placedAll(seq: Seg[], incoming: Seg[]): boolean {
  return seq.length > incoming.length;
}

/** Beams eighths and shorter within each beat; rests and tuplets break a group. */
function beam(events: Event[], perQuarter: number, beatLen: number): void {
  const level = (ev: Event) => {
    if (ev.rest) return 0;
    const n = ev.notes[0];
    const t = text(n, "type");
    return { eighth: 1, "16th": 2, "32nd": 3, "64th": 4, "128th": 5 }[t] ?? 0;
  };
  for (const ev of events) if (level(ev) >= 0) for (const n of ev.notes) for (const b of kids(n, "beam")) b.remove();
  let i = 0;
  while (i < events.length) {
    const lv = level(events[i]);
    if (lv <= 0) {
      i++;
      continue;
    }
    const group = Math.floor(events[i].pos / beatLen);
    let j = i;
    while (j + 1 < events.length && level(events[j + 1]) > 0 && Math.floor(events[j + 1].pos / beatLen) === group) j++;
    if (j > i) {
      const run = events.slice(i, j + 1);
      const lvs = run.map(level);
      run.forEach((ev, k) => {
        const n = ev.notes[0];
        for (let L = 1; L <= lvs[k]; L++) {
          const prevHas = k > 0 && lvs[k - 1] >= L;
          const nextHas = k < run.length - 1 && lvs[k + 1] >= L;
          const kind = prevHas && nextHas ? "continue" : prevHas ? "end" : nextHas ? "begin" : k > 0 ? "backward hook" : "forward hook";
          const b = n.ownerDocument.createElementNS(null, "beam");
          b.setAttribute("number", String(L));
          b.textContent = kind;
          const after = kids(n).find((c) => ["notations", "lyric", "play", "listen"].includes(c.tagName)) ?? null;
          n.insertBefore(b, after);
        }
      });
    }
    i = j + 1;
  }
  void perQuarter;
}

function samePitch(a: Pitch | null, b: Pitch | null): boolean {
  return !!a && !!b && midiOf(a) === midiOf(b);
}

function sameNotes(notes: Element[], pitches: Pitch[]): boolean {
  const a = notes.map((n) => readPitch(n)).filter((p): p is Pitch => !!p).map(midiOf).sort();
  const b = pitches.map(midiOf).sort();
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function spanOf(map: Map<string, Element>): { from: number; to: number } {
  const ms = [...map.keys()].map((k) => Number(k.split(":")[1]));
  return ms.length ? { from: Math.min(...ms), to: Math.max(...ms) + 1 } : { from: 0, to: 0 };
}

/** "3+2" time signatures add up. */
function eval_(beats: string): number {
  return beats.split("+").reduce((s, b) => s + (Number(b) || 0), 0) || 4;
}

export { keyAlter };

function setFifths(key: Element, fifths: number): void {
  let f = kid(key, "fifths");
  if (!f) {
    f = key.ownerDocument.createElementNS(null, "fifths");
    key.insertBefore(f, key.firstChild);
  }
  f.textContent = String(fifths);
}

/** A key signature at the start of a measure (in its first attributes, after divisions). */
function addKey(meas: Element, fifths: number): void {
  const doc = meas.ownerDocument;
  const first = kids(meas).find((c) => c.tagName !== "print" && c.tagName !== "barline");
  let attrs = first?.tagName === "attributes" ? first : null;
  if (!attrs) {
    attrs = doc.createElementNS(null, "attributes");
    meas.insertBefore(attrs, first ?? null);
  }
  const key = doc.createElementNS(null, "key");
  setFifths(key, fifths);
  const div = kid(attrs, "divisions");
  attrs.insertBefore(key, div ? div.nextSibling : attrs.firstChild);
}

/** An element put in attributes in MusicXML's order. */
function placeAttr(attrs: Element, el: Element): void {
  const ORDER = ["footnote", "level", "divisions", "key", "time", "staves", "part-symbol", "instruments", "clef", "staff-details", "transpose", "for-part", "directive", "measure-style"];
  const rank = ORDER.indexOf(el.tagName);
  const after = kids(attrs).find((c) => ORDER.indexOf(c.tagName) > rank);
  attrs.insertBefore(el, after ?? null);
}
