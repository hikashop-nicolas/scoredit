import type { ScoreDoc } from "../model/score";
import { kid, kids, text } from "../model/xml";

export interface NoteEvent {
  /** Start and length in seconds, in played order (repeats unrolled). */
  time: number;
  dur: number;
  midi: number;
  velocity: number;
  channel: number;
  part: number;
  staff: number;
  /** Score measure index, and onset within it in quarter notes. */
  measure: number;
  onset: number;
  /** The <note> element, for highlighting. */
  el: Element;
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
}

export interface Timeline {
  events: NoteEvent[];
  spans: MeasureSpan[];
  duration: number;
  /** General MIDI program (0-127) per channel in use. */
  programs: Map<number, number>;
}

const STEP: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const DYN: Record<string, number> = { pppp: 20, ppp: 30, pp: 42, p: 55, mp: 68, mf: 80, f: 95, ff: 108, fff: 118, ffff: 125, sf: 105, sfz: 108, fp: 95 };
const DEFAULT_BPM = 100;
const GRACE = 0.07;

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

/** Measures in the order they are played: repeats and first/second endings unrolled. */
export function playOrder(score: ScoreDoc): number[] {
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
  const order: number[] = [];
  let repeatStart = 0;
  let pass = 1;
  let jumped = false;
  for (let i = 0, guard = 0; i < n && guard < n * 20; guard++) {
    const m = ms[i];
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
    if (jumped && attr(m, "fine") !== null) break;
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
        i = 0;
        continue;
      }
      const ds = attr(m, "dalsegno");
      if (ds !== null) {
        const sg = target("segno", ds);
        if (sg >= 0) {
          jumped = true;
          i = sg;
          continue;
        }
      }
    }
    i++;
  }
  return order;
}

function programsOf(score: ScoreDoc): { channel: number; program: number; drums: boolean }[] {
  const list = kid(score.root, "part-list");
  const sps = list ? kids(list, "score-part") : [];
  let next = 0;
  return score.parts.map((p) => {
    const sp = sps.find((e) => e.getAttribute("id") === p.id);
    const mi = sp?.getElementsByTagName("midi-instrument")[0];
    const prog = Number(text(mi ? kid(mi, "midi-program") : null)) || 1;
    const ch = Number(text(mi ? kid(mi, "midi-channel") : null));
    const drums = ch === 10 || !!sp?.getElementsByTagName("unpitched").length;
    if (drums) return { channel: 9, program: 0, drums };
    if (next === 9) next++;
    const channel = Math.min(15, next++);
    return { channel, program: Math.min(127, Math.max(0, prog - 1)), drums };
  });
}

/** Turns the score into timed notes, in played order. */
export function buildTimeline(score: ScoreDoc): Timeline {
  const order = playOrder(score);
  const parts = programsOf(score);
  const programs = new Map<number, number>();
  for (const p of parts) if (!p.drums) programs.set(p.channel, p.program);

  // Measure lengths (quarters) and tempo marks, per score measure.
  const lengths = new Map<number, number>();
  const marks = new Map<number, [number, number][]>();
  for (const m of new Set(order)) {
    let len = 0;
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
        else if (c.tagName === "note" && !kid(c, "chord") && !kid(c, "grace")) pos += dur;
        len = Math.max(len, pos / div);
      }
    });
    lengths.set(m, len || 1);
    marks.set(m, tempoMarks(score, m));
  }

  // Lay the played measures out in time.
  let secPerQ = 60 / DEFAULT_BPM;
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
    const span: MeasureSpan = { measure: m, start: t, end: 0, quarters, tempo };
    span.end = t + quarterToSec(span, quarters);
    spans.push(span);
    t = span.end;
  }

  // Notes, per pass through each measure.
  const events: NoteEvent[] = [];
  const velocity = parts.map(() => 80);
  // Ties left open at the end of a measure, picked up by the next one played.
  const carry = new Map<string, NoteEvent>();
  for (const span of spans) {
    const m = span.measure;
    score.measures.forEach((ms, p) => {
      const meas = ms[m];
      if (!meas) return;
      const at = score.attributesAt(p, m);
      let div = Number(text(at.find((e) => e.tagName === "divisions"))) || 1;
      const tr = at.find((e) => e.tagName === "transpose");
      let shift = tr ? (Number(text(tr, "chromatic")) || 0) + 12 * (Number(text(tr, "octave-change")) || 0) : 0;
      let pos = 0;
      let lastOnset = 0;
      const tied = new Map<string, NoteEvent>();
      for (const c of kids(meas)) {
        const dur = Number(text(c, "duration")) || 0;
        switch (c.tagName) {
          case "attributes": {
            div = Number(text(c, "divisions")) || div;
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
            const d = c.getElementsByTagName("dynamics")[0];
            const mark = d?.firstElementChild?.tagName;
            const snd = Number(kid(c, "sound")?.getAttribute("dynamics"));
            if (snd > 0) velocity[p] = Math.min(127, Math.round((snd * 90) / 100));
            else if (mark && DYN[mark]) velocity[p] = DYN[mark];
            break;
          }
          case "note": {
            const grace = kid(c, "grace");
            if (grace) {
              // A grace note sounds short, just ahead of the beat it leads into.
              const gp = kid(c, "pitch");
              if (!gp || kid(c, "chord")) break;
              const gm = (Number(text(gp, "octave")) + 1) * 12 + (STEP[text(gp, "step")] ?? 0) + (Number(text(gp, "alter")) || 0) + shift;
              const at = Math.max(span.start, span.start + quarterToSec(span, pos / div) - GRACE);
              events.push({ time: at, dur: GRACE, midi: gm, velocity: velocity[p], channel: parts[p].channel, part: p, staff: Number(text(c, "staff")) || 1, measure: m, onset: pos / div, el: c });
              break;
            }
            const chord = !!kid(c, "chord");
            const onset = chord ? lastOnset : pos / div;
            if (!chord) {
              lastOnset = onset;
              pos += dur;
            }
            const pitch = kid(c, "pitch");
            if (!pitch || kid(c, "rest")) break;
            const midi = (Number(text(pitch, "octave")) + 1) * 12 + (STEP[text(pitch, "step")] ?? 0) + (Number(text(pitch, "alter")) || 0) + shift;
            const q = dur / div;
            const ties = kids(c, "tie").map((e) => e.getAttribute("type"));
            const staff = Number(text(c, "staff")) || 1;
            const key = `${p}:${staff}:${midi}`;
            const start = span.start + quarterToSec(span, onset);
            const length = span.start + quarterToSec(span, onset + q) - start;
            const prev = ties.includes("stop") ? tied.get(key) ?? carry.get(key) : undefined;
            if (prev) {
              prev.dur = start + length - prev.time;
              tied.delete(key);
              carry.delete(key);
              if (ties.includes("start")) tied.set(key, prev);
              break;
            }
            const ev: NoteEvent = { time: start, dur: length, midi, velocity: velocity[p], channel: parts[p].channel, part: p, staff, measure: m, onset, el: c };
            events.push(ev);
            if (ties.includes("start")) tied.set(key, ev);
            break;
          }
        }
      }
      // Ties that run into the next measure.
      for (const [k, ev] of tied) carry.set(k, ev);
    });
  }
  events.sort((a, b) => a.time - b.time);
  return { events, spans, duration: t, programs };
}

/** Seconds from the start of a measure to quarter offset q in it. */
export function quarterToSec(span: MeasureSpan, q: number): number {
  let s = 0;
  for (let i = 0; i < span.tempo.length; i++) {
    const [from, spq] = span.tempo[i];
    const to = i + 1 < span.tempo.length ? span.tempo[i + 1][0] : Infinity;
    if (q <= from) break;
    s += (Math.min(q, to) - from) * spq;
  }
  return s;
}

/** Quarter offset in a measure at `sec` seconds from its start. */
export function secToQuarter(span: MeasureSpan, sec: number): number {
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
