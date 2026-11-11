import { ScoreDoc } from "../model/score";
import { kid, kids, text } from "../model/xml";
import { ScoreEditor, type Caret } from "./editor";
import { readMeasure, writeMeasure, type Event } from "./measure";
import { midiOf, readPitch, type Pitch } from "./notes";

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
}

/** What a rebuild could not enter (the editor does not do these yet), by kind. */
export type Skipped = Record<string, number>;

const NOT_ENTERED: [what: string, test: (n: Element) => boolean][] = [
  ["grace notes", (n) => !!kid(n, "grace")],
  ["slurs", (n) => n.getElementsByTagName("slur").length > 0],
  ["articulations (accents, staccato...)", (n) => n.getElementsByTagName("articulations").length > 0],
  ["ornaments (trills, mordents...)", (n) => n.getElementsByTagName("ornaments").length > 0],
  ["fermatas", (n) => n.getElementsByTagName("fermata").length > 0],
  ["lyrics", (n) => n.getElementsByTagName("lyric").length > 0],
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
          starts.set(i, { quarters: sum, actual, normal });
          i = j + 1;
        }
        evs.forEach((ev, i) => {
          const start = starts.get(i) ?? null;
          const at0: Caret = { part, measure: m, staff, voice, pos: ev.pos / per };
          // A tuplet that starts with a rest is laid out all the same.
          if (ev.rest && start) entries.push({ at: at0, pitches: [], quarters: ev.dur / per, ties: [], tuplet: start });
          if (ev.rest) return;
          const pitches = ev.notes.map(readPitch).filter((p): p is Pitch => !!p);
          if (!pitches.length) return;
          const at: Caret = { part, measure: m, staff, voice, pos: ev.pos / per };
          const entry: Entry = { at, pitches, quarters: ev.dur / per, ties: ev.notes.filter((n) => kids(n, "tie").some((t) => t.getAttribute("type") === "start")).map((n) => midiOf(readPitch(n)!)).filter((x) => Number.isFinite(x)) };
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
  }
  for (const e of entries) if (e.ties.length) ed.tieTo(e.at, e.ties);
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
    for (const [key, list] of voices)
      list.forEach(({ m, per, ev }, i) => {
        if (ev.rest) return;
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
  const [len, tied] = rest.split(" ");
  const name = pitch.startsWith("drum") ? pitch : NAMES[Number(pitch) % 12] + (Math.floor(Number(pitch) / 12) - 1);
  const part = score.parts[Number(p)]?.name || `part ${Number(p) + 1}`;
  return `${part}, bar ${Number(m) + 1}, staff ${staffVoice.split(":")[0]}, beat ${+(Number(beat) + 1).toFixed(3)}: ${name} for ${+Number(len).toFixed(3)} beat${tied ? ", tied on" : ""}`;
}
