import { ScoreDoc } from "../model/score";
import { kid, kids, text } from "../model/xml";
import { ScoreEditor, type Caret } from "./editor";
import { readMeasure, writeMeasure, type Event } from "./measure";
import { SPANS, TECHNICAL_MARKS, fingeringOf, lyricsOf, marksOf, midiOf, readPitch, slursOf, spansOf, tremoloOf, type Lyric, type Pitch, type SlurEnd, type SpanEnd } from "./notes";

// Rebuilding a score through the editor, as a test of it: an empty copy of the score (bars,
// signatures, clefs, repeats and text kept, every note a rest) gets each note entered again,
// and the two are compared note by note.

/** One note, chord or tuplet start to enter, in the order a person would. */
export interface Entry {
  at: Caret;
  pitches: Pitch[];
  quarters: number;
  /** MIDI pitches tied on to the next event. */
  ties: number[];
  /** The first note of a tuplet: lay out its slots first. */
  tuplet?: { quarters: number; actual: number; normal: number };
  /** A rest to write as it is (it opens a tuplet or carries a fermata). */
  rest?: boolean;
  /** Articulations, ornaments, fermata. */
  marks: string[];
  graces: { pitch: Pitch; slash: boolean; chord: boolean; slurs: SlurEnd[] }[];
  lyrics: Lyric[];
  slurs: SlurEnd[];
  /** Single-note tremolo strokes (0: none). */
  tremolo: number;
  /** Glissandos, slides, trill lines and two-note tremolos starting or ending here. */
  spans: SpanEnd[];
  fingerings: { midi: number; value: string }[];
}

/** What a rebuild could not enter (the editor does not do these yet), by kind. */
export type Skipped = Record<string, number>;

const NOT_ENTERED: [what: string, test: (n: Element) => boolean][] = [
  ["other technical marks (hammer-ons, bends...)", (n) => Array.from(n.getElementsByTagName("technical")).some((t) => kids(t).some((c) => !["string", "fret", "fingering", ...TECHNICAL_MARKS].includes(c.tagName)))],
  ["other ornaments (schleifers, shakes...)", (n) => Array.from(n.getElementsByTagName("ornaments")).some((o) => kids(o).some((c) => !["trill-mark", "turn", "delayed-turn", "inverted-turn", "delayed-inverted-turn", "vertical-turn", "mordent", "inverted-mordent", "wavy-line", "tremolo", "accidental-mark", "haydn", "shake", "schleifer"].includes(c.tagName)))],
];

const TYPE_Q: Record<string, number> = { breve: 8, whole: 4, half: 2, quarter: 1, eighth: 0.5, "16th": 0.25, "32nd": 0.125, "64th": 0.0625, "128th": 0.03125 };

/** The entries that rebuild a score's notes, and what they leave out. */
export function plan(score: ScoreDoc): { entries: Entry[]; skipped: Skipped } {
  const ed = new ScoreEditor(score, { history: false });
  const entries: Entry[] = [];
  const skipped: Skipped = {};
  score.measures.forEach((ms, part) => {
    const link = ed.fretted(part);
    ms.forEach((meas, m) => {
      for (const n of kids(meas, "note")) for (const [what, test] of NOT_ENTERED) if (test(n)) skipped[what] = (skipped[what] ?? 0) + 1;
      const per = ed.info(part, m).perQuarter;
      for (const [key, evs] of readMeasure(meas).voices) {
        const [st, voice] = key.split("|");
        const staff = Number(st);
        // A tab staff drawn from a notation staff is written again by the editor.
        if (link && link.tab === staff && link.notation !== null) continue;
        // Tuplets: from a start mark to a stop mark, or, unmarked, as soon as the notes so far
        // make a whole tuplet (their time over the normal count is a plain note value). The
        // tuplet is as long as its notes together.
        const starts = new Map<number, { quarters: number; actual: number; normal: number }>();
        for (let i = 0; i < evs.length; ) {
          const ratio = kid(evs[i].notes[0], "time-modification");
          if (!ratio) {
            i++;
            continue;
          }
          const actual = Number(text(ratio, "actual-notes")) || 3;
          const normal = Number(text(ratio, "normal-notes")) || 2;
          const marked = (e: (typeof evs)[number], type: string) => Array.from(e.notes[0].getElementsByTagName("tuplet")).some((t) => t.getAttribute("type") === type);
          let j = i;
          let sum = 0;
          for (; j < evs.length && kid(evs[j].notes[0], "time-modification"); j++) {
            sum += evs[j].dur / per;
            if (marked(evs[j], "stop")) break;
            if (!marked(evs[i], "start") && Object.values(TYPE_Q).some((q) => Math.abs(sum / normal - q) < 1e-6)) break;
          }
          // A tuplet missing its last notes (a silence left out) is laid out whole all the same.
          const whole = Object.values(TYPE_Q).some((q) => Math.abs(sum / normal - q) < 1e-6);
          const base = whole ? sum / normal : Math.min(...Object.values(TYPE_Q).filter((q) => q * normal >= sum - 1e-6));
          starts.set(i, { quarters: base * normal, actual, normal });
          i = j + 1;
        }
        evs.forEach((ev, i) => {
          const start = starts.get(i) ?? null;
          const at0: Caret = { part, measure: m, staff, voice, pos: ev.pos / per };
          // A tuplet that starts with a rest is laid out all the same.
          const marks = [...new Set(ev.notes.flatMap(marksOf))];
          const none = { graces: [], lyrics: [], slurs: [], tremolo: 0, spans: [], fingerings: [] };
          // A rest opening a tuplet, or carrying a fermata, is written as it is.
          if (ev.rest && (start || marks.length)) entries.push({ at: at0, pitches: [], quarters: ev.dur / per, ties: [], tuplet: start ?? undefined, rest: true, marks, ...none });
          if (ev.rest) return;
          const pitches = ev.notes.map(readPitch).filter((p): p is Pitch => !!p);
          if (!pitches.length) return;
          const at: Caret = { part, measure: m, staff, voice, pos: ev.pos / per };
          const entry: Entry = {
            at,
            pitches,
            quarters: ev.dur / per,
            marks,
            graces: ev.graces.flatMap((g) => {
              const p = readPitch(g);
              return p ? [{ pitch: p, slash: kid(g, "grace")?.getAttribute("slash") === "yes", chord: !!kid(g, "chord"), slurs: slursOf(g) }] : [];
            }),
            lyrics: ev.notes.flatMap(lyricsOf),
            slurs: ev.notes.flatMap(slursOf),
            tremolo: Math.max(0, ...ev.notes.map(tremoloOf)),
            spans: ev.notes.flatMap(spansOf),
            fingerings: ev.notes.flatMap((n) => {
              const p = readPitch(n);
              const v = fingeringOf(n);
              return p && v ? [{ midi: midiOf(p), value: v }] : [];
            }),
            ties: ev.notes.filter((n) => kids(n, "tie").some((t) => t.getAttribute("type") === "start")).map((n) => midiOf(readPitch(n)!)).filter((x) => Number.isFinite(x)) };
          if (start) entry.tuplet = start;
          entries.push(entry);
        });
      }
    });
  });
  return { entries, skipped };
}

/** A copy of a score with every note taken out: each staff's bars hold a whole-bar rest. */
export function emptyCopy(score: ScoreDoc): ScoreDoc {
  const ed = new ScoreEditor(score, { history: false });
  const lengths = score.measures.map((ms, p) => ms.map((_, m) => ed.info(p, m).length));
  const copy = new ScoreDoc(score.doc.cloneNode(true) as Document);
  copy.sections = score.sections;
  copy.measures.forEach((ms, p) => {
    ms.forEach((meas, m) => {
      const r = readMeasure(meas);
      const staves = [...new Set([...r.voices.keys()].map((k) => Number(k.split("|")[0])))];
      const multi = kids(meas, "note").some((n) => kid(n, "staff"));
      r.voices.clear();
      r.others = r.others.filter((o) => o.el.tagName !== "note");
      for (const st of staves.length ? staves : [1]) {
        const firstVoice = [...readMeasure(score.measures[p][m]).voices.keys()].filter((k) => k.startsWith(`${st}|`)).sort((a, b) => Number(a.split("|")[1]) - Number(b.split("|")[1]))[0]?.split("|")[1] ?? "1";
        const rest = copy.doc.createElementNS(null, "note");
        const r1 = copy.doc.createElementNS(null, "rest");
        r1.setAttribute("measure", "yes");
        rest.appendChild(r1);
        for (const [tag, v] of [["duration", lengths[p][m]], ["voice", firstVoice], ...(multi ? [["staff", st]] : [])] as [string, string | number][]) {
          const e = copy.doc.createElementNS(null, tag);
          e.textContent = String(v);
          rest.appendChild(e);
        }
        r.voices.set(`${st}|${firstVoice}`, [{ pos: 0, dur: lengths[p][m], notes: [rest], graces: [], rest: true }]);
      }
      writeMeasure(meas, r);
    });
  });
  copy.refresh();
  return copy;
}

/** Enters the planned notes into an empty copy, as edit mode would. */
export function rebuild(score: ScoreDoc): { doc: ScoreDoc; skipped: Skipped; entered: number } {
  const { entries, skipped } = plan(score);
  const doc = emptyCopy(score);
  const original = new ScoreEditor(score, { history: false });
  const ed = new ScoreEditor(doc, { history: false, tabCopies: (p) => original.fretted(p)?.notation != null });
  for (const e of entries) {
    if (e.tuplet) ed.tuplet(e.at, e.tuplet.quarters, e.tuplet.actual, e.tuplet.normal);
    if (e.pitches.length) ed.enter(e.at, { pitches: e.pitches, quarters: e.quarters });
    else if (e.rest) {
      ed.enter(e.at, { pitches: null, quarters: e.quarters });
      // Marked at once, so the rest is not merged with its neighbours.
      for (const m of e.marks) ed.mark(e.at, m, true);
    }
  }
  for (const e of entries) if (e.ties.length) ed.tieTo(e.at, e.ties);
  // Then what goes on the notes: grace notes, marks, lyrics, and slurs end to end.
  // Slurs pair by number in time order across a part (one may start in one voice or staff
  // and end in another).
  const ordered = [...entries].sort((a, b) => a.at.part - b.at.part || a.at.measure - b.at.measure || a.at.pos - b.at.pos || a.at.staff - b.at.staff || Number(a.at.voice) - Number(b.at.voice));
  const graceEls = new Map<Entry, Element[]>();
  for (const e of ordered) {
    graceEls.set(e, e.graces.map((g) => ed.addGrace(e.at, g.pitch, g.slash, g.chord).grace).filter((g): g is Element => !!g));
    for (const m of e.marks) ed.mark(e.at, m, true);
    for (const l of e.lyrics) ed.lyric(e.at, l.text, l.syllabic, l.number);
    if (e.tremolo) ed.tremolo(e.at, e.tremolo);
    const ev = e.fingerings.length ? ed.eventAt(e.at) : null;
    for (const f of e.fingerings) {
      const n = ev?.notes.find((x) => { const p = readPitch(x); return !!p && midiOf(p) === f.midi; });
      if (n) ed.fingering(n, f.value);
    }
  }
  // Glissandos, slides, trill lines, two-note tremolos: paired like slurs, kind by kind.
  for (const kind of Object.keys(SPANS)) {
    const items: SlurItem<Entry>[] = [];
    for (const e of ordered) for (const end of e.spans) if (end.kind === kind) items.push({ t: e.at.part * 1e9 + e.at.measure * 1e6 + e.at.pos, order: 100, staff: String(e.at.staff), voice: e.at.voice, end, ref: e });
    for (const [a, b] of pairEnds(items)) {
      const value = a.spans.find((x) => x.kind === kind && x.type === "start")?.value;
      ed.span(kind, a.at, b.at, { add: true, value, trillMark: false });
    }
  }
  // Slurs: the original's ends paired as the comparison pairs them, then drawn end to end.
  type End = { at: Caret; grace?: Element };
  const ends: SlurItem<End>[] = [];
  for (const e of ordered) {
    const t = e.at.measure * 1e6 + e.at.pos;
    e.graces.forEach((g, gi) => {
      const el = graceEls.get(e)?.[gi];
      if (el) for (const end of g.slurs) ends.push({ t, order: gi, staff: String(e.at.staff), voice: e.at.voice, end, ref: { at: e.at, grace: el } });
    });
    for (const end of e.slurs) ends.push({ t, order: 100, staff: String(e.at.staff), voice: e.at.voice, end, ref: { at: e.at } });
  }
  const parts = new Map<number, SlurItem<End>[]>();
  for (const x of ends) parts.set(x.ref.at.part, [...(parts.get(x.ref.at.part) ?? []), x]);
  for (const [a, b] of [...parts.values()].flatMap((list) => pairEnds(list))) {
    if (!a.grace && !b.grace) ed.slur(a.at, b.at, { add: true });
    else {
      const first = a.grace ?? ed.eventAt(a.at)?.notes[0];
      const last = b.grace ?? ed.eventAt(b.at)?.notes[0];
      if (first && last) ed.slurNotes(first, last);
    }
  }
  doc.refresh();
  return { doc, skipped, entered: entries.length };
}

/**
 * Every note of a score as text: part, bar, staff:voice, beat, pitch, length, and "tied" when
 * it is tied on to the same pitch in the next event (a tie into nothing does not count).
 */
export function noteList(score: ScoreDoc): string[] {
  const out: string[] = [];
  const ed = new ScoreEditor(score, { history: false });
  score.measures.forEach((ms, p) => {
    // Each voice's events in order across the bars, to see where ties lead.
    const voices = new Map<string, { m: number; per: number; ev: Event }[]>();
    ms.forEach((meas, m) => {
      const per = ed.info(p, m).perQuarter;
      for (const [key, evs] of readMeasure(meas).voices) {
        const list = voices.get(key) ?? [];
        for (const ev of evs) list.push({ m, per, ev });
        voices.set(key, list);
      }
    });
    const paired = pairedSlurs(voices);
    const spanCounts = pairedSpans(voices);
    // A tab staff drawn from a notation staff shows its marks; only the notes count there.
    const link = ed.fretted(p);
    const derived = (key: string) => !!link && link.notation !== null && key.startsWith(`${link.tab}|`);
    const count = (el: Element, type: "start" | "stop") => paired.get(el)?.[type] ?? 0;
    for (const [key, list] of voices)
      list.forEach(({ m, per, ev }, i) => {
        const at = `${p}|${m}|${key.replace("|", ":")}|${Math.round((ev.pos / per) * 10080) / 10080}`;
        const marks = derived(key) ? [] : [...new Set(ev.notes.flatMap(marksOf))].sort();
        if (marks.length) out.push(`${at}|marks ${marks.join(" ")}${ev.rest ? " (on a rest)" : ""}`);
        if (ev.rest) return;
        for (const g of derived(key) ? [] : ev.graces) {
          const gp = readPitch(g);
          if (gp) out.push(`${at}|grace ${midiOf(gp)}${kid(g, "grace")?.getAttribute("slash") === "yes" ? " slashed" : ""}${kid(g, "chord") ? " chord" : ""}${count(g, "start") + count(g, "stop") ? ` slur${" start".repeat(count(g, "start"))}${" stop".repeat(count(g, "stop"))}` : ""}`);
        }
        for (const l of derived(key) ? [] : ev.notes.flatMap(lyricsOf)) out.push(`${at}|lyric ${l.number} ${l.syllabic} ${l.text}`);
        const starts = ev.notes.reduce((n, x) => n + count(x, "start"), 0);
        const stops = ev.notes.reduce((n, x) => n + count(x, "stop"), 0);
        if (!derived(key)) {
          const tr = Math.max(0, ...ev.notes.map(tremoloOf));
          if (tr) out.push(`${at}|tremolo ${tr} strokes`);
          for (const n of ev.notes) {
            const f = fingeringOf(n);
            const fp = readPitch(n);
            if (f && fp) out.push(`${at}|fingering ${f} on ${midiOf(fp)}`);
          }
          for (const kind of Object.keys(SPANS)) {
            const c = spanCounts.get(kind);
            const a = ev.notes.reduce((x, n) => x + (c?.get(n)?.start ?? 0), 0);
            const b = ev.notes.reduce((x, n) => x + (c?.get(n)?.stop ?? 0), 0);
            if (a || b) out.push(`${at}|${kind} ${a} start ${b} end`);
          }
        }
        if ((starts || stops) && !derived(key)) out.push(`${at}|slurs ${starts} start ${stops} end`);
        const next = list[i + 1]?.ev;
        for (const n of ev.notes) {
          const pitch = readPitch(n);
          if (!pitch) continue;
          const tiedOn = kids(n, "tie").some((t) => t.getAttribute("type") === "start") && !!next && !next.rest && next.notes.some((x) => { const q = readPitch(x); return !!q && midiOf(q) === midiOf(pitch); });
          const q = (x: number) => Math.round((x / per) * 10080) / 10080;
          out.push(`${p}|${m}|${key.replace("|", ":")}|${q(ev.pos)}|${pitch.unpitched ? `drum ${pitch.step}${pitch.octave}` : midiOf(pitch)}|${q(ev.dur)}${tiedOn ? " tied" : ""}`);
        }
      });
  });
  return out;
}

/** Notes in one list and not the other, both ways. */
export function compareNotes(want: ScoreDoc, got: ScoreDoc): { total: number; missing: string[]; extra: string[] } {
  const a = noteList(want);
  const b = noteList(got);
  const count = new Map<string, number>();
  for (const k of b) count.set(k, (count.get(k) ?? 0) + 1);
  const missing: string[] = [];
  for (const k of a) {
    const c = count.get(k) ?? 0;
    if (c > 0) count.set(k, c - 1);
    else missing.push(k);
  }
  const extra = [...count].flatMap(([k, c]) => Array(c).fill(k) as string[]);
  return { total: a.length, missing, extra };
}

const NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
/** A note key from noteList in words: "part 1, bar 37, staff 2, beat 2: E3 for ½ beat (tied on)". */
export function describeNote(key: string, score: ScoreDoc): string {
  const [p, m, staffVoice, beat, pitch, rest] = key.split("|");
  const where = `${score.parts[Number(p)]?.name || `part ${Number(p) + 1}`}, bar ${Number(m) + 1}, staff ${staffVoice.split(":")[0]}, beat ${+(Number(beat) + 1).toFixed(3)}`;
  const kind = pitch.split(" ")[0];
  if (kind === "marks") return `${where}: ${pitch.slice(6).replace(/-/g, " ")}`;
  if (kind === "grace") return `${where}: grace note ${NAMES[Number(pitch.split(" ")[1]) % 12] + (Math.floor(Number(pitch.split(" ")[1]) / 12) - 1)}${pitch.includes("slashed") ? " (slashed)" : ""}`;
  if (kind === "lyric") {
    const [, verse, syl, ...words] = pitch.split(" ");
    return `${where}: lyric "${words.join(" ")}" (verse ${verse}, ${syl})`;
  }
  if (kind === "slurs") return `${where}: ${pitch.slice(6)} of slurs`;
  if (kind === "tremolo" && /strokes/.test(pitch)) return `${where}: ${pitch}`;
  if (kind === "fingering") return `${where}: fingering ${pitch.split(" ")[1]} on ${NAMES[Number(pitch.split(" ")[3]) % 12] + (Math.floor(Number(pitch.split(" ")[3]) / 12) - 1)}`;
  if (["glissando", "slide", "trill", "tremolo"].includes(kind)) return `${where}: ${pitch.replace(/(\d+) start (\d+) end/, "$1 start, $2 end")}`;
  const [len, tied] = rest.split(" ");
  const name = pitch.startsWith("drum") ? pitch : NAMES[Number(pitch) % 12] + (Math.floor(Number(pitch) / 12) - 1);
  const part = score.parts[Number(p)]?.name || `part ${Number(p) + 1}`;
  return `${part}, bar ${Number(m) + 1}, staff ${staffVoice.split(":")[0]}, beat ${+(Number(beat) + 1).toFixed(3)}: ${name} for ${+Number(len).toFixed(3)} beat${tied ? ", tied on" : ""}`;
}

/**
 * Slur ends that pair up (a start with a later stop of its number: same voice, else staff,
 * else part), counted per note. A slur that never ends, or ends without a start, is left out.
 */
function pairedSlurs(voices: Map<string, { m: number; per: number; ev: Event }[]>): Map<Element, { start: number; stop: number }> {
  const ends: SlurItem<Element>[] = [];
  for (const [key, list] of voices) {
    const [staff, voice] = key.split("|");
    for (const { m, per, ev } of list) {
      // A slur ending on a rest is not one edit mode makes; it drops like an unfinished one.
      if (ev.rest) continue;
      const t = m * 1e6 + ev.pos / per;
      ev.graces.forEach((g, gi) => slursOf(g).forEach((end) => ends.push({ t, order: gi, staff, voice, end, ref: g })));
      for (const n of ev.notes) for (const end of slursOf(n)) ends.push({ t, order: 100, staff, voice, end, ref: n });
    }
  }
  const out = new Map<Element, { start: number; stop: number }>();
  const bump = (el: Element, type: "start" | "stop") => {
    const c = out.get(el) ?? { start: 0, stop: 0 };
    c[type]++;
    out.set(el, c);
  };
  for (const [a, b] of pairEnds(ends)) {
    bump(a, "start");
    bump(b, "stop");
  }
  return out;
}

/** A slur end in a part: when, where, and what it belongs to. */
interface SlurItem<T> {
  t: number;
  /** Grace notes (their index) before the event's own notes (100). */
  order: number;
  staff: string;
  voice: string;
  end: { type: "start" | "stop"; number: number };
  ref: T;
}

/**
 * Pairs slur ends in time order: a stop closes the latest open start of its number in the
 * same voice, else staff, else part. Starts that never end, and stops without a start, drop.
 */
function pairEnds<T>(items: SlurItem<T>[]): [T, T][] {
  const sorted = [...items].sort((a, b) => a.t - b.t || a.order - b.order || (a.end.type === "stop" ? -1 : 1) - (b.end.type === "stop" ? -1 : 1));
  const open: SlurItem<T>[] = [];
  const pairs: [T, T][] = [];
  const close = (e: SlurItem<T>): boolean => {
    let i = -1;
    for (let level = 0; level < 3 && i < 0; level++)
      for (let k = open.length - 1; k >= 0 && i < 0; k--) {
        const o = open[k];
        if (o.end.number === e.end.number && (level > 1 || o.staff === e.staff) && (level > 0 || o.voice === e.voice)) i = k;
      }
    if (i < 0) return false;
    pairs.push([open[i].ref, e.ref]);
    open.splice(i, 1);
    return true;
  };
  // A stop closes what was open before; one left over may close a start on the same note
  // (a trill line on a single note).
  let waiting: SlurItem<T>[] = [];
  let at = NaN;
  const flush = () => {
    for (const w of waiting) close(w);
    waiting = [];
  };
  for (const e of sorted) {
    if (e.t !== at || e.order !== 100) flush();
    at = e.t;
    if (e.end.type === "start") open.push(e);
    else if (!close(e) && e.order === 100) waiting.push(e);
  }
  flush();
  return pairs;
}

/** Glissando, slide, trill line and tremolo ends that pair up, counted per note, kind by kind. */
function pairedSpans(voices: Map<string, { m: number; per: number; ev: Event }[]>): Map<string, Map<Element, { start: number; stop: number }>> {
  const out = new Map<string, Map<Element, { start: number; stop: number }>>();
  for (const kind of Object.keys(SPANS)) {
    const items: SlurItem<Element>[] = [];
    for (const [key, list] of voices) {
      const [staff, voice] = key.split("|");
      for (const { m, per, ev } of list) {
        if (ev.rest) continue;
        for (const n of ev.notes) for (const end of spansOf(n)) if (end.kind === kind) items.push({ t: m * 1e6 + ev.pos / per, order: 100, staff, voice, end, ref: ev.notes[0] });
      }
    }
    const counts = new Map<Element, { start: number; stop: number }>();
    for (const [a, b] of pairEnds(items)) {
      const ca = counts.get(a) ?? { start: 0, stop: 0 };
      ca.start++;
      counts.set(a, ca);
      const cb = counts.get(b) ?? { start: 0, stop: 0 };
      cb.stop++;
      counts.set(b, cb);
    }
    out.set(kind, counts);
  }
  return out;
}
