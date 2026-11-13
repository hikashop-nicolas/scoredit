import { PLAY_PAUSE, PLAY_STRETCH, type ScoreDoc } from "../model/score";
import { kid, kids, text } from "../model/xml";
import type { Bend } from "./pluck";

export interface NoteEvent {
  /** Start and length in seconds, in played order (repeats unrolled). */
  time: number;
  dur: number;
  midi: number;
  velocity: number;
  channel: number;
  /** General MIDI instrument (0-127), 128 for the drum kit. */
  program: number;
  part: number;
  staff: number;
  /** Score measure index, and onset within it in quarter notes. */
  measure: number;
  onset: number;
  /** The <note> element, for highlighting. */
  el: Element;
  /** A grace note (sounds just before its beat). */
  grace?: boolean;
  /** Ornaments that change how the note sounds, expanded once the timeline is built. */
  trillUpper?: number;
  /** Trill starting on the upper note; a mordent (main, lower, main) or inverted one (main, upper, main). */
  trillFromUpper?: boolean;
  mordent?: number;
  /** A turn: the quick notes it plays before settling on the main note. */
  turn?: number[];
  /** Guitar bend, and where the note is played (string 1 = highest), when the score says. */
  bend?: Bend;
  string?: number;
  fret?: number;
  /** A tremolo; for a single-note one, quarters is its written value and strokes include its flags. */
  tremolo?: { type: string; strokes: number; quarters: number };
}

/** A MIDI controller change (the sustain pedal). */
export interface ControlEvent {
  time: number;
  channel: number;
  cc: number;
  value: number;
}

/** One measure as played: where it starts and ends in time. */
export interface MeasureSpan {
  measure: number;
  start: number;
  end: number;
  /** Length in quarter notes. */
  quarters: number;
  /** Tempo changes inside the measure: [quarter offset, seconds per quarter]. */
  tempo: [number, number][];
  /** Silences (caesura, section end): [quarter offset, seconds], taken before what starts there. */
  pauses?: [number, number][];
}

export interface Timeline {
  events: NoteEvent[];
  controls: ControlEvent[];
  spans: MeasureSpan[];
  duration: number;
  /** General MIDI program (0-127) per channel in use. */
  programs: Map<number, number>;
}

const STEP: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const DYN: Record<string, number> = { pppp: 20, ppp: 30, pp: 42, p: 55, mp: 68, mf: 80, f: 95, ff: 108, fff: 118, ffff: 125, sf: 105, sfz: 108, fp: 95 };
const DEFAULT_BPM = 100;
const TYPE_Q: Record<string, number> = { whole: 4, half: 2, quarter: 1, eighth: 0.5, "16th": 0.25, "32nd": 0.125, "64th": 0.0625, "128th": 0.03125 };
// How much slower a fermata plays, by shape (MuseScore's defaults, from its output).
const FERMATA: Record<string, number> = { "": 2, normal: 2, angled: 1.5, square: 3, "double-angled": 1.25, "double-square": 4, "double-dot": 3, "half-curve": 1.5, curlew: 2 };
// Seconds of silence after a caesura, and at a section end (MuseScore's default there).
const CAESURA_PAUSE = 1;
const SECTION_PAUSE = 3;
// A value the file sets (internal attribute), if any.
const setValue = (e: Element | undefined, attr: string): number | null => {
  const v = e?.getAttribute(attr);
  return v != null && v !== "" && Number(v) >= 0 ? Number(v) : null;
};

// Tempo, from <sound tempo> or a metronome mark, keyed by quarter offset in the measure.
function tempoMarks(score: ScoreDoc, m: number): [number, number][] {
  const found = new Map<number, number>();
  score.measures.forEach((ms, p) => {
    const meas = ms[m];
    if (!meas) return;
    let div = Number(text(score.attributesAt(p, m).find((e) => e.tagName === "divisions"))) || 1;
    let pos = 0;
    for (const c of kids(meas)) {
      if (c.tagName === "attributes") div = Number(text(c, "divisions")) || div;
      const dur = Number(text(c, "duration")) || 0;
      if (c.tagName === "backup") pos -= dur;
      else if (c.tagName === "forward") pos += dur;
      else if (c.tagName === "note") {
        if (!kid(c, "chord") && !kid(c, "grace")) pos += dur;
      } else if (c.tagName === "sound" || c.tagName === "direction") {
        const snd = c.tagName === "sound" ? c : kid(c, "sound");
        const q = pos / div;
        const bpm = Number(snd?.getAttribute("tempo"));
        if (bpm > 0) found.set(q, bpm);
        else if (c.tagName === "direction" && !found.has(q)) {
          const metro = c.getElementsByTagName("metronome")[0];
          const per = Number(text(metro ? kid(metro, "per-minute") : null));
          const unit = text(metro ? kid(metro, "beat-unit") : null);
          const scale: Record<string, number> = { whole: 4, half: 2, quarter: 1, eighth: 0.5, "16th": 0.25 };
          const dotted = metro && kid(metro, "beat-unit-dot") ? 1.5 : 1;
          if (per > 0 && scale[unit]) found.set(q, per * scale[unit] * dotted);
        }
      }
    }
  });
  return [...found.entries()].sort((a, b) => a[0] - b[0]);
}

/** Measures in the order they are played: repeats and first/second endings unrolled, a play order followed. */
export function playOrder(score: ScoreDoc): number[] {
  // A play order (an ABC P: line, kept as a "play-order" field) names parts by their rehearsal marks.
  const misc = kid(score.root, "identification")?.getElementsByTagName("miscellaneous-field") ?? [];
  const field = Array.from(misc).find((f) => f.getAttribute("name") === "play-order");
  const letters = field?.textContent?.trim().split(/\s+/).filter((x) => x) ?? [];
  let cur: string | null = null;
  const label = (score.measures[0] ?? []).map((m) => (cur = m.getElementsByTagName("rehearsal")[0]?.textContent?.trim() || cur));
  if (!letters.length || cur === null) return repeatOrder(score, []);
  // Each part repeats within itself; measures before the first part play first.
  const order = repeatOrder(score, label.flatMap((l, i) => (l !== null && l !== label[i - 1] ? [i] : [])));
  const out = order.filter((i) => label[i] === null);
  for (const l of letters) out.push(...order.filter((i) => label[i] === l));
  return out;
}

function repeatOrder(score: ScoreDoc, partStarts: number[]): number[] {
  const ms = score.measures[0] ?? [];
  const n = ms.length;
  const bars = (m: Element) => kids(m, "barline");
  const repeat = (m: Element, dir: string) => bars(m).map((b) => kid(b, "repeat")).find((r) => r?.getAttribute("direction") === dir) ?? null;
  const ending = (m: Element, type: string) => {
    for (const b of bars(m)) {
      const e = kid(b, "ending");
      if (e && e.getAttribute("type") === type) return (e.getAttribute("number") ?? "1").split(/[\s,]+/).map(Number).filter((x) => x > 0);
    }
    return null;
  };
  const endingStop = (from: number) => {
    for (let k = from; k < n; k++) if (ending(ms[k], "stop") || ending(ms[k], "discontinue")) return k;
    return from;
  };
  // Jumps: <sound dacapo|dalsegno|tocoda> where they are read, <sound segno|coda|fine> where they lead.
  const sounds = (m: Element) => Array.from(m.getElementsByTagName("sound"));
  const attr = (m: Element, a: string) => sounds(m).map((x) => x.getAttribute(a)).find((v) => v !== null && v !== "no") ?? null;
  const target = (a: string, name: string) => {
    const k = ms.findIndex((m) => sounds(m).some((x) => x.getAttribute(a) === name || (name === "yes" && x.hasAttribute(a))));
    return k >= 0 ? k : ms.findIndex((m) => attr(m, a) !== null);
  };
  // After a D.C./D.S., repeats are not taken again and only the last ending of a group plays.
  const lastEnding = (k: number) => {
    const stop = endingStop(k);
    return !(stop + 1 < n && ending(ms[stop + 1], "start"));
  };
  const sectionStarts = [...new Set([...(score.sections.length ? score.sections : [0]), ...partStarts])].sort((a, b) => a - b);
  const sectionOf = (i: number) => sectionStarts.filter((s) => s <= i).pop() ?? 0;
  const order: number[] = [];
  let repeatStart = 0;
  let pass = 1;
  let jumped = false;
  let jumpFrom = -1;
  for (let i = 0, guard = 0; i < n && guard < n * 20; guard++) {
    const m = ms[i];
    if (sectionStarts.includes(i) && i !== repeatStart && !jumped) {
      repeatStart = i;
      pass = 1;
    }
    if (repeat(m, "forward") && i !== repeatStart) {
      repeatStart = i;
      pass = 1;
    }
    const nums = ending(m, "start");
    if (nums && (jumped ? !lastEnding(i) : !nums.includes(pass))) {
      i = endingStop(i) + 1;
      continue;
    }
    order.push(i);
    // Fine ends the way back; playback goes on after the measure that jumped.
    if (jumped && attr(m, "fine") !== null) {
      jumped = false;
      i = jumpFrom + 1;
      repeatStart = i;
      pass = 1;
      continue;
    }
    if (jumped) {
      const toCoda = attr(m, "tocoda");
      if (toCoda !== null) {
        const c = target("coda", toCoda);
        if (c > i) {
          i = c;
          continue;
        }
      }
    }
    const back = repeat(m, "backward");
    if (back && !jumped) {
      const times = Number(back.getAttribute("times")) || 2;
      if (pass < times) {
        pass++;
        i = repeatStart;
        continue;
      }
      pass = 1;
      repeatStart = i + 1;
    }
    if (!jumped) {
      if (attr(m, "dacapo") !== null) {
        jumped = true;
        jumpFrom = i;
        i = sectionOf(i);
        continue;
      }
      const ds = attr(m, "dalsegno");
      if (ds !== null) {
        const sg = target("segno", ds);
        if (sg >= 0) {
          jumped = true;
          jumpFrom = i;
          i = sg;
          continue;
        }
      }
    }
    i++;
  }
  return order;
}

// Each part's instrument; parts playing the same instrument share a MIDI channel (there are
// only 16, and an orchestra has more parts), the drums channel 10.
function programsOf(score: ScoreDoc): { channel: number; program: number; drums: boolean }[] {
  const list = kid(score.root, "part-list");
  const sps = list ? kids(list, "score-part") : [];
  const channels = new Map<number, number>();
  let next = 0;
  return score.parts.map((p) => {
    const sp = sps.find((e) => e.getAttribute("id") === p.id);
    const mi = sp?.getElementsByTagName("midi-instrument")[0];
    const prog = Number(text(mi ? kid(mi, "midi-program") : null)) || 1;
    const ch = Number(text(mi ? kid(mi, "midi-channel") : null));
    const drums = ch === 10 || !!sp?.getElementsByTagName("midi-unpitched").length;
    if (drums) return { channel: 9, program: 128, drums };
    const program = Math.min(127, Math.max(0, prog - 1));
    let channel = channels.get(program);
    if (channel === undefined) {
      if (next === 9) next++;
      channel = next > 15 ? 15 : next++;
      channels.set(program, channel);
    }
    return { channel, program, drums };
  });
}

/** Turns the score into timed notes, in played order. */
export function buildTimeline(score: ScoreDoc, opts: { straight?: boolean; bpm?: number } = {}): Timeline {
  // Straight: every measure once, in score order, without repeats or jumps.
  const order = opts.straight ? Array.from({ length: score.measureCount }, (_, m) => m) : playOrder(score);
  // Drum sounds: the instrument a note names, and the General MIDI drum it plays.
  const unpitched = new Map<string, number>();
  for (const mi of Array.from(score.root.getElementsByTagName("midi-instrument"))) {
    const u = Number(text(mi, "midi-unpitched"));
    if (u > 0) unpitched.set(mi.getAttribute("id") ?? "", u - 1);
  }
  const parts = programsOf(score);
  const programs = new Map<number, number>();
  for (const p of parts) if (!p.drums && !programs.has(p.channel)) programs.set(p.channel, p.program);

  // Measure lengths (quarters) and tempo marks, per score measure.
  const lengths = new Map<number, number>();
  const marks = new Map<number, [number, number][]>();
  // Fermatas ([onset, stretch]), caesuras and breaths ([quarter after the note, seconds]) and every onset, per measure.
  const fermatas = new Map<number, [number, number][]>();
  const caesuras = new Map<number, [number, number][]>();
  const onsets = new Map<number, number[]>();
  for (const m of new Set(order)) {
    let len = 0;
    const ferm: [number, number][] = [];
    const caes = new Map<number, number>();
    const starts = new Set<number>();
    score.measures.forEach((ms, p) => {
      const meas = ms[m];
      if (!meas) return;
      let div = Number(text(score.attributesAt(p, m).find((e) => e.tagName === "divisions"))) || 1;
      let pos = 0;
      let last = 0;
      for (const c of kids(meas)) {
        if (c.tagName === "attributes") div = Number(text(c, "divisions")) || div;
        const dur = Number(text(c, "duration")) || 0;
        if (c.tagName === "backup") pos -= dur;
        else if (c.tagName === "forward") pos += dur;
        else if (c.tagName === "note" && !kid(c, "grace")) {
          if (!kid(c, "chord")) {
            last = pos / div;
            starts.add(last);
            pos += dur;
          }
          const nots = kids(c, "notations");
          const fe = nots.flatMap((n) => kids(n, "fermata"))[0];
          if (fe) ferm.push([last, setValue(fe, PLAY_STRETCH) || (FERMATA[text(fe)] ?? 2)]);
          for (const b of nots.flatMap((n) => [...Array.from(n.getElementsByTagName("caesura")), ...Array.from(n.getElementsByTagName("breath-mark"))])) {
            const sec = setValue(b, PLAY_PAUSE) ?? (b.tagName === "caesura" ? CAESURA_PAUSE : 0);
            const q = last + dur / div;
            if (sec > (caes.get(q) ?? 0)) caes.set(q, sec);
          }
        }
        len = Math.max(len, pos / div);
      }
    });
    lengths.set(m, len || 1);
    marks.set(m, tempoMarks(score, m));
    if (ferm.length) fermatas.set(m, ferm);
    if (caes.size) caesuras.set(m, [...caes].sort((a, b) => a[0] - b[0]));
    if (ferm.length) onsets.set(m, [...starts].sort((a, b) => a - b));
  }

  // A fermata slows the tempo from its chord or rest to the next onset in any part, as MuseScore plays it.
  const stretch = (tempo: [number, number][], m: number, quarters: number): [number, number][] => {
    const ferm = fermatas.get(m);
    if (!ferm) return tempo;
    const starts = onsets.get(m) ?? [];
    const ranges = ferm.map(([q, f]) => [q, starts.find((x) => x > q) ?? quarters, f]).filter(([a, b]) => b > a && a < quarters);
    const factor = (q: number) => Math.max(1, ...ranges.filter(([a, b]) => q >= a && q < b).map((r) => r[2]));
    const base = (q: number) => tempo.filter(([from]) => from <= q).pop()![1];
    const cuts = [...new Set([...tempo.map(([q]) => q), ...ranges.flatMap(([a, b]) => [a, b])])].filter((q) => q < quarters).sort((a, b) => a - b);
    const out: [number, number][] = [];
    for (const q of cuts) {
      const spq = base(q) * factor(q);
      if (!out.length || Math.abs(out[out.length - 1][1] - spq) > 1e-12) out.push([q, spq]);
    }
    return out;
  };

  // Lay the played measures out in time.
  // Until the score marks a tempo.
  let secPerQ = 60 / (opts.bpm ?? DEFAULT_BPM);
  let t = 0;
  const spans: MeasureSpan[] = [];
  for (const m of order) {
    const quarters = lengths.get(m)!;
    const tempo: [number, number][] = [[0, secPerQ]];
    for (const [q, bpm] of marks.get(m)!) {
      secPerQ = 60 / bpm;
      if (q <= 0) tempo[0] = [0, secPerQ];
      else tempo.push([q, secPerQ]);
    }
    const span: MeasureSpan = { measure: m, start: t, end: 0, quarters, tempo: stretch(tempo, m, quarters) };
    // A caesura, and the end of a section, are followed by a silence.
    const pauses: [number, number][] = (caesuras.get(m) ?? []).filter(([q]) => q > 0).map(([q, sec]) => [Math.min(q, quarters), sec]);
    if (score.sections.includes(m + 1)) {
      const set = score.measures.map((ms) => setValue(ms[m], PLAY_PAUSE)).find((v) => v !== null);
      pauses.push([quarters, set ?? SECTION_PAUSE]);
    }
    // Zero-length pauses (a breath mark by default) change nothing.
    for (let i = pauses.length - 1; i >= 0; i--) if (!(pauses[i][1] > 0)) pauses.splice(i, 1);
    if (pauses.length) span.pauses = pauses;
    span.end = t + quarterToSec(span, quarters);
    spans.push(span);
    t = span.end;
  }

  // Notes, per pass through each measure.
  const events: NoteEvent[] = [];
  // Seconds each quick note of a trill or turn lasts.
  const steps = new Map<NoteEvent, number>();
  const velocity = parts.map(() => 80);
  const controls: ControlEvent[] = [];
  // Ties left open at the end of a measure, picked up by the next one played.
  const carry = new Map<string, NoteEvent>();
  // The last onset of each voice (part, staff, voice), across bar lines.
  const lastOf = new Map<string, NoteEvent[]>();
  for (const span of spans) {
    const m = span.measure;
    score.measures.forEach((ms, p) => {
      const meas = ms[m];
      if (!meas) return;
      const at = score.attributesAt(p, m);
      let div = Number(text(at.find((e) => e.tagName === "divisions"))) || 1;
      const tr = at.find((e) => e.tagName === "transpose");
      let shift = tr ? (Number(text(tr, "chromatic")) || 0) + 12 * (Number(text(tr, "octave-change")) || 0) : 0;
      let fifths = Number(text(at.find((e) => e.tagName === "key"), "fifths")) || 0;
      let pos = 0;
      let lastOnset = 0;
      const tied = new Map<string, NoteEvent>();
      // Grace notes wait, per voice, for the note they lead into.
      const graces = new Map<string, { el: Element; midi: number; q: number; chord: boolean }[]>();
      const delayed = new Map<string, [onset: number, by: number]>();
      const atQ = (q: number) => span.start + (q >= 0 ? quarterToSec(span, q) : q * span.tempo[0][1]);
      // Before the beat (slashed, or after the last note of a measure) they take time from the
      // note before; on the beat they take it from the note they lead into.
      const layGraces = (vk: string, onset: number, mainQ: number): number => {
        const list = graces.get(vk);
        if (!list?.length) return 0;
        graces.delete(vk);
        const slots: (typeof list)[] = [];
        for (const g of list) {
          if (g.chord && slots.length) slots[slots.length - 1].push(g);
          else slots.push([g]);
        }
        const prev = lastOf.get(`${p}|${vk}`) ?? [];
        const g0 = kid(list[0].el, "grace");
        // Graces after a note take their written lengths; others share the first one's, as MuseScore plays them.
        const after = g0?.getAttribute("steal-time-previous") === "0";
        // Graces ending a trill take its last quick notes, after at least four of the trill's.
        const tr = after ? prev.find((e) => e.trillUpper !== undefined && steps.has(e)) : undefined;
        if (tr) {
          const n = Math.max(Math.round(tr.dur / steps.get(tr)!), 4 + slots.length);
          const slot = tr.dur / n;
          let at = tr.time + (n - slots.length) * slot;
          for (const e of prev) if (e.time + e.dur > at) e.dur = at - e.time;
          for (const e of prev) if (steps.has(e)) steps.set(e, slot);
          for (const sl of slots) {
            for (const g of sl) events.push({ time: at, dur: slot, midi: g.midi, velocity: velocity[p], channel: parts[p].channel, program: parts[p].program, part: p, staff: Number(text(g.el, "staff")) || 1, measure: m, onset, el: g.el, grace: true });
            at += slot;
          }
          return 0;
        }
        const want = after ? slots.reduce((t, sl) => t + sl[0].q, 0) : slots[0][0].q;
        const before = (mainQ <= 0 || g0?.getAttribute("slash") === "yes" || !!g0?.hasAttribute("steal-time-previous")) && atQ(onset - want) >= 0;
        // On the beat, at most half the main note.
        const scale = before ? 1 : Math.min(1, mainQ / 2 / want);
        // Before the beat: at most the second half of the note before.
        const half = prev.length ? Math.max(...prev.map((e) => e.time + e.dur / 2)) : -Infinity;
        let start = before ? Math.max(atQ(onset - want), half) : atQ(onset);
        if (before && start >= atQ(onset)) start = atQ(onset - want);
        const shrink = before ? (atQ(onset) - start) / Math.max(1e-9, atQ(onset) - atQ(onset - want)) : 1;
        let q = before ? onset - want * shrink : onset;
        for (const e of prev) if (e.time < start && e.time + e.dur > start) e.dur = start - e.time;
        for (const sl of slots) {
          const len = (after ? sl[0].q : want / slots.length) * scale * shrink;
          for (const g of sl) events.push({ time: atQ(q), dur: Math.max(0.01, atQ(q + len) - atQ(q)), midi: g.midi, velocity: velocity[p], channel: parts[p].channel, program: parts[p].program, part: p, staff: Number(text(g.el, "staff")) || 1, measure: m, onset, el: g.el, grace: true });
          q += len;
        }
        return before ? 0 : want * scale;
      };
      for (const c of kids(meas)) {
        const dur = Number(text(c, "duration")) || 0;
        switch (c.tagName) {
          case "attributes": {
            div = Number(text(c, "divisions")) || div;
            const kk = kid(c, "key");
            if (kk) fifths = Number(text(kk, "fifths")) || 0;
            const tt = kid(c, "transpose");
            if (tt) shift = (Number(text(tt, "chromatic")) || 0) + 12 * (Number(text(tt, "octave-change")) || 0);
            break;
          }
          case "backup":
            pos -= dur;
            break;
          case "forward":
            pos += dur;
            break;
          case "direction": {
            const pd = c.getElementsByTagName("pedal")[0];
            if (pd) {
              const at = span.start + quarterToSec(span, pos / div);
              const type = pd.getAttribute("type");
              const ch = parts[p].channel;
              if (type === "stop" || type === "change") controls.push({ time: at, channel: ch, cc: 64, value: 0 });
              if (type === "start" || type === "change" || type === "resume") controls.push({ time: at + (type === "change" ? 0.02 : 0), channel: ch, cc: 64, value: 127 });
            }
            const d = c.getElementsByTagName("dynamics")[0];
            const mark = d?.firstElementChild?.tagName;
            const snd = Number(kid(c, "sound")?.getAttribute("dynamics"));
            if (snd > 0) velocity[p] = Math.min(127, Math.round((snd * 90) / 100));
            else if (mark && DYN[mark]) velocity[p] = DYN[mark];
            break;
          }
          case "note": {
            const grace = kid(c, "grace");
            const vk = `${text(c, "staff") || 1}|${text(c, "voice") || 1}`;
            if (grace) {
              const gp = kid(c, "pitch");
              if (!gp) break;
              const gm = (Number(text(gp, "octave")) + 1) * 12 + (STEP[text(gp, "step")] ?? 0) + (Number(text(gp, "alter")) || 0) + shift;
              const q = (TYPE_Q[text(c, "type")] ?? 0.125) * (2 - 2 ** -kids(c, "dot").length);
              (graces.get(vk) ?? graces.set(vk, []).get(vk)!).push({ el: c, midi: gm, q, chord: !!kid(c, "chord") });
              break;
            }
            const chord = !!kid(c, "chord");
            const onset = chord ? lastOnset : pos / div;
            if (!chord) {
              lastOnset = onset;
              pos += dur;
              delayed.set(vk, [onset, kid(c, "rest") ? 0 : layGraces(vk, onset, dur / div)]);
            }
            const dl = delayed.get(vk);
            const late = dl && dl[0] === onset ? dl[1] : 0;
            const pitch = kid(c, "pitch");
            const drum = unpitched.get(kid(c, "instrument")?.getAttribute("id") ?? "");
            if (!pitch && kid(c, "unpitched") && drum !== undefined && !kid(c, "rest")) {
              const q = dur / div;
              const start = span.start + quarterToSec(span, onset);
              events.push({ time: start, dur: span.start + quarterToSec(span, onset + q, true) - start, midi: drum, velocity: velocity[p], channel: 9, program: 128, part: p, staff: Number(text(c, "staff")) || 1, measure: m, onset, el: c });
              break;
            }
            if (!pitch || kid(c, "rest")) break;
            const midi = (Number(text(pitch, "octave")) + 1) * 12 + (STEP[text(pitch, "step")] ?? 0) + (Number(text(pitch, "alter")) || 0) + shift;
            const q = dur / div;
            const ties = kids(c, "tie").map((e) => e.getAttribute("type"));
            const staff = Number(text(c, "staff")) || 1;
            const key = `${p}:${staff}:${midi}`;
            const start = span.start + quarterToSec(span, onset + late);
            const length = span.start + quarterToSec(span, onset + q, true) - start;
            const prev = ties.includes("stop") ? tied.get(key) ?? carry.get(key) : undefined;
            if (prev) {
              prev.dur = start + length - prev.time;
              tied.delete(key);
              carry.delete(key);
              if (ties.includes("start")) tied.set(key, prev);
              break;
            }
            const ev: NoteEvent = { time: start, dur: length, midi, velocity: velocity[p], channel: parts[p].channel, program: parts[p].program, part: p, staff, measure: m, onset, el: c };
            const tm = c.getElementsByTagName("trill-mark")[0];
            const accMark = c.getElementsByTagName("accidental-mark")[0]?.textContent?.trim();
            const ACC: Record<string, number> = { sharp: 1, natural: 0, flat: -1, "double-sharp": 2, "flat-flat": -2 };
            const override = accMark && accMark in ACC ? ACC[accMark] : undefined;
            if (tm) {
              ev.trillUpper = upperNeighbour(text(pitch, "step"), Number(text(pitch, "octave")), fifths, override) + shift;
              ev.trillFromUpper = tm.getAttribute("start-note") === "upper";
              steps.set(ev, ornamentStep(span.tempo.filter(([from]) => from <= onset).pop()![1]));
            } else if (c.getElementsByTagName("turn").length || c.getElementsByTagName("inverted-turn").length) {
              const up = upperNeighbour(text(pitch, "step"), Number(text(pitch, "octave")), fifths) + shift;
              const down = lowerNeighbour(text(pitch, "step"), Number(text(pitch, "octave")), fifths) + shift;
              ev.turn = c.getElementsByTagName("turn").length ? [up, midi, down] : [down, midi, up];
              steps.set(ev, ornamentStep(span.tempo.filter(([from]) => from <= onset).pop()![1]));
            } else if (c.getElementsByTagName("inverted-mordent").length) {
              ev.mordent = upperNeighbour(text(pitch, "step"), Number(text(pitch, "octave")), fifths, override) + shift;
            } else if (c.getElementsByTagName("mordent").length) {
              ev.mordent = lowerNeighbour(text(pitch, "step"), Number(text(pitch, "octave")), fifths, override) + shift;
            }
            const tech = c.getElementsByTagName("technical")[0];
            if (tech) {
              const st = Number(text(tech, "string"));
              const fr = text(tech, "fret");
              if (st > 0 && fr !== "") {
                ev.string = st;
                ev.fret = Number(fr);
              }
              const bends = Array.from(tech.getElementsByTagName("bend"));
              const up = bends.find((b) => !kid(b, "release"));
              if (up || bends.length) {
                const alter = Number(text(up ?? bends[0], "bend-alter")) || 0;
                ev.bend = { alter: Math.abs(alter), release: bends.some((b) => !!kid(b, "release")), pre: !!(up && kid(up, "pre-bend")) };
              }
            }
            const trem = c.getElementsByTagName("tremolo")[0];
            const type = trem?.getAttribute("type") ?? "single";
            // A single-note tremolo divides the written value, so in a tuplet it is as quick as its notes.
            const written = type === "single" && TYPE_Q[text(c, "type")] ? TYPE_Q[text(c, "type")] * (2 - 2 ** -kids(c, "dot").length) : q;
            // A single-note tremolo's flags count with its strokes: an eighth with one stroke plays 16ths.
            const flags = type === "single" ? Math.max(0, Math.round(-Math.log2(TYPE_Q[text(c, "type")] ?? 1))) : 0;
            if (trem) ev.tremolo = { type, strokes: (Number(trem.textContent) || 2) + flags, quarters: written };
            events.push(ev);
            const lo = lastOf.get(`${p}|${vk}`);
            if (lo?.length && lo[0].onset === onset && lo[0].measure === m) lo.push(ev);
            else lastOf.set(`${p}|${vk}`, [ev]);
            if (ties.includes("start")) tied.set(key, ev);
            break;
          }
        }
      }
      // Graces left at the end of the measure sound just before its end.
      for (const vk of [...graces.keys()]) layGraces(vk, span.quarters, 0);
      // Ties that run into the next measure.
      for (const [k, ev] of tied) carry.set(k, ev);
    });
  }
  events.sort((a, b) => a.time - b.time);
  controls.sort((a, b) => a.time - b.time);
  return { events: expand(dedupe(arpeggiate(events)), steps), controls, spans, duration: t, programs };
}

/** Seconds from the start of a measure to quarter offset q in it: after a pause there, or before it for the end of a note. */
export function quarterToSec(span: MeasureSpan, q: number, end = false): number {
  let s = 0;
  for (let i = 0; i < span.tempo.length; i++) {
    const [from, spq] = span.tempo[i];
    const to = i + 1 < span.tempo.length ? span.tempo[i + 1][0] : Infinity;
    if (q <= from) break;
    s += (Math.min(q, to) - from) * spq;
  }
  for (const [at, sec] of span.pauses ?? []) if (at < q || (at === q && !end)) s += sec;
  return s;
}

/** Quarter offset in a measure at `sec` seconds from its start (a pause stays on its quarter). */
export function secToQuarter(span: MeasureSpan, sec: number): number {
  let paused = 0;
  for (const [at, len] of [...(span.pauses ?? [])].sort((a, b) => a[0] - b[0])) {
    const before = quarterToSec({ ...span, pauses: undefined }, at) + paused;
    if (sec <= before) break;
    if (sec <= before + len) return at;
    paused += len;
  }
  sec -= paused;
  let s = 0;
  for (let i = 0; i < span.tempo.length; i++) {
    const [from, spq] = span.tempo[i];
    const to = i + 1 < span.tempo.length ? span.tempo[i + 1][0] : Infinity;
    const segment = (to - from) * spq;
    if (sec <= s + segment) return from + (sec - s) / spq;
    s += segment;
  }
  return span.quarters;
}

const LETTERS = "CDEFGAB";
const SHARPS = "FCGDAEB";
const FLATS = "BEADGCF";

/** MIDI pitch of the scale step above (step, octave) in a key of `fifths`. */
export function upperNeighbour(step: string, octave: number, fifths: number, alter?: number): number {
  const i = LETTERS.indexOf(step);
  return neighbour(LETTERS[(i + 1) % 7], octave + (i === 6 ? 1 : 0), fifths, alter);
}

/** MIDI pitch of the scale step below. */
export function lowerNeighbour(step: string, octave: number, fifths: number, alter?: number): number {
  const i = LETTERS.indexOf(step);
  return neighbour(LETTERS[(i + 6) % 7], octave - (i === 0 ? 1 : 0), fifths, alter);
}

// A step in a key, unless an accidental on the ornament says otherwise.
function neighbour(step: string, oct: number, fifths: number, alter?: number): number {
  const inKey = fifths > 0 && SHARPS.indexOf(step) < fifths ? 1 : fifths < 0 && FLATS.indexOf(step) < -fifths ? -1 : 0;
  return (oct + 1) * 12 + STEP[step] + (alter ?? inKey);
}

// Arpeggiated chords roll from the bottom (or the top), a little apart, within half their length.
function arpeggiate(events: NoteEvent[]): NoteEvent[] {
  // The mark may sit on any note of the chord.
  const arp = new Map<Element, Element | null>();
  const chords = new Map<string, NoteEvent[]>();
  for (const e of events) {
    if (e.grace) continue;
    let head: Element = e.el;
    while (kid(head, "chord") && head.previousElementSibling?.tagName === "note") head = head.previousElementSibling;
    if (!arp.has(head)) {
      let mark: Element | null = null;
      for (let n: Element | null = head; n && n.tagName === "note" && (n === head || kid(n, "chord")); n = n.nextElementSibling) mark ??= n.getElementsByTagName("arpeggiate")[0] ?? null;
      arp.set(head, mark);
    }
    const mark = arp.get(head);
    if (!mark) continue;
    const k = `${e.part}|${e.staff}|${Math.round(e.time * 1000)}|${mark.getAttribute("direction") === "down" ? "down" : "up"}`;
    (chords.get(k) ?? chords.set(k, []).get(k)!).push(e);
  }
  for (const [k, list] of chords) {
    if (list.length < 2) continue;
    const down = k.endsWith("down");
    list.sort((a, b) => (down ? b.midi - a.midi : a.midi - b.midi));
    const step = Math.min(0.05, Math.min(...list.map((e) => e.dur)) / 2 / Math.max(1, list.length - 1));
    list.forEach((e, k) => {
      e.time += k * step;
      e.dur -= k * step;
    });
  }
  return chords.size ? events.sort((a, b) => a.time - b.time) : events;
}

// The same note twice at once in one part (a tab staff linked to the standard staff) sounds
// once, keeping the string, fret and bend the tab staff gives.
function dedupe(events: NoteEvent[]): NoteEvent[] {
  const seen = new Map<string, NoteEvent>();
  return events.filter((e) => {
    const k = `${e.part}|${Math.round(e.time * 1000)}|${e.midi}`;
    const first = seen.get(k);
    if (first) {
      if (first.string === undefined && e.string !== undefined) {
        first.string = e.string;
        first.fret = e.fret;
      }
      first.bend ??= e.bend;
      return false;
    }
    seen.set(k, e);
    return true;
  });
}

// Trill and turn notes: 32nds, 64ths below 60 quarters a minute (as MuseScore plays them).
const ornamentStep = (secPerQuarter: number) => (secPerQuarter > 1 + 1e-9 ? secPerQuarter / 16 : secPerQuarter / 8);

// Trills alternate with the upper note; tremolos repeat a note, or alternate two chords.
function expand(events: NoteEvent[], steps = new Map<NoteEvent, number>()): NoteEvent[] {
  if (!events.some((e) => e.trillUpper !== undefined || e.tremolo || e.mordent !== undefined || e.turn)) return events;
  const out: NoteEvent[] = [];
  const split = (e: NoteEvent, step: number, pick: (k: number) => number, least = 1) => {
    const n = Math.max(least, Math.round(e.dur / step));
    const d = e.dur / n;
    for (let k = 0; k < n; k++) out.push({ ...e, time: e.time + k * d, dur: d, midi: pick(k), trillUpper: undefined, trillFromUpper: undefined, tremolo: undefined });
  };
  const stops = new Map<string, NoteEvent[]>();
  for (const e of events) {
    if (e.tremolo?.type === "stop") {
      const k = `${e.part}|${e.staff}|${Math.round(e.time * 1000)}`;
      (stops.get(k) ?? stops.set(k, []).get(k)!).push(e);
    }
  }
  const used = new Set<NoteEvent>();
  for (const e of events) {
    if (used.has(e)) continue;
    if (e.trillUpper !== undefined) {
      // At least four notes, as MuseScore plays a trill on a short note; without a tempo, about 0.09 s.
      const step = steps.get(e) ?? Math.min(0.12, Math.max(0.06, e.dur / Math.max(1, Math.round(e.dur / 0.09))));
      const first = e.trillFromUpper ? 0 : 1;
      split(e, step, (k) => (k % 2 === first ? e.trillUpper! : e.midi), steps.has(e) ? 4 : 1);
    } else if (e.turn) {
      // Upper, main, lower (or the reverse), then the main note for the rest of its length.
      const step = steps.get(e);
      const quick = step ? Math.min(step, e.dur / 4) : Math.min(0.08, e.dur / 6);
      const base = { ...e, turn: undefined };
      e.turn.forEach((m, k) => out.push({ ...base, time: e.time + k * quick, dur: quick, midi: m }));
      out.push({ ...base, time: e.time + 3 * quick, dur: e.dur - 3 * quick });
    } else if (e.mordent !== undefined) {
      // Two quick notes, then the main note for the rest of its length.
      const quick = Math.min(0.07, e.dur / 4);
      const base = { ...e, mordent: undefined };
      out.push({ ...base, dur: quick }, { ...base, time: e.time + quick, dur: quick, midi: e.mordent }, { ...base, time: e.time + 2 * quick, dur: e.dur - 2 * quick });
    } else if (e.tremolo?.type === "single") {
      const per = (e.tremolo.quarters > 0 ? e.dur / e.tremolo.quarters : e.dur) / 2 ** e.tremolo.strokes;
      split(e, Math.max(0.04, per), () => e.midi);
    } else if (e.tremolo?.type === "start") {
      // The chord paired with this one starts where it ends; both share the whole length.
      const partner = (stops.get(`${e.part}|${e.staff}|${Math.round((e.time + e.dur) * 1000)}`) ?? []).filter((b) => !used.has(b));
      const pairedDur = partner[0]?.dur ?? (stops.get(`${e.part}|${e.staff}|${Math.round((e.time + e.dur) * 1000)}`)?.[0]?.dur ?? 0);
      const total = e.dur + pairedDur;
      const per = Math.max(0.04, (e.tremolo.quarters > 0 ? e.dur / e.tremolo.quarters : e.dur) / 2 ** e.tremolo.strokes);
      const n = Math.max(2, Math.round(total / per));
      const d = total / n;
      for (let k = 0; k < n; k++) {
        if (k % 2 === 0) out.push({ ...e, time: e.time + k * d, dur: d, tremolo: undefined });
        else for (const b of partner) out.push({ ...b, time: e.time + k * d, dur: d, tremolo: undefined });
      }
      for (const b of partner) used.add(b);
    } else if (e.tremolo?.type === "stop") {
      out.push({ ...e, tremolo: undefined }); // no partner found: plays as written
    } else out.push(e);
  }
  return out.sort((a, b) => a.time - b.time);
}
