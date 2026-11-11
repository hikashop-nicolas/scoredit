import type { ScoreDoc } from "../model/score";
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
  const sectionStarts = score.sections.length ? score.sections : [0];
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
export function buildTimeline(score: ScoreDoc, opts: { straight?: boolean } = {}): Timeline {
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
  const controls: ControlEvent[] = [];
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
      let fifths = Number(text(at.find((e) => e.tagName === "key"), "fifths")) || 0;
      let pos = 0;
      let lastOnset = 0;
      const tied = new Map<string, NoteEvent>();
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
            if (grace) {
              // A grace note sounds short, just ahead of the beat it leads into.
              const gp = kid(c, "pitch");
              if (!gp || kid(c, "chord")) break;
              const gm = (Number(text(gp, "octave")) + 1) * 12 + (STEP[text(gp, "step")] ?? 0) + (Number(text(gp, "alter")) || 0) + shift;
              const at = Math.max(span.start, span.start + quarterToSec(span, pos / div) - GRACE);
              events.push({ time: at, dur: GRACE, midi: gm, velocity: velocity[p], channel: parts[p].channel, program: parts[p].program, part: p, staff: Number(text(c, "staff")) || 1, measure: m, onset: pos / div, el: c, grace: true });
              break;
            }
            const chord = !!kid(c, "chord");
            const onset = chord ? lastOnset : pos / div;
            if (!chord) {
              lastOnset = onset;
              pos += dur;
            }
            const pitch = kid(c, "pitch");
            const drum = unpitched.get(kid(c, "instrument")?.getAttribute("id") ?? "");
            if (!pitch && kid(c, "unpitched") && drum !== undefined && !kid(c, "rest")) {
              const q = dur / div;
              const start = span.start + quarterToSec(span, onset);
              events.push({ time: start, dur: span.start + quarterToSec(span, onset + q) - start, midi: drum, velocity: velocity[p], channel: 9, program: 128, part: p, staff: Number(text(c, "staff")) || 1, measure: m, onset, el: c });
              break;
            }
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
            const ev: NoteEvent = { time: start, dur: length, midi, velocity: velocity[p], channel: parts[p].channel, program: parts[p].program, part: p, staff, measure: m, onset, el: c };
            const tm = c.getElementsByTagName("trill-mark")[0];
            const accMark = c.getElementsByTagName("accidental-mark")[0]?.textContent?.trim();
            const ACC: Record<string, number> = { sharp: 1, natural: 0, flat: -1, "double-sharp": 2, "flat-flat": -2 };
            const override = accMark && accMark in ACC ? ACC[accMark] : undefined;
            if (tm) {
              ev.trillUpper = upperNeighbour(text(pitch, "step"), Number(text(pitch, "octave")), fifths, override) + shift;
              ev.trillFromUpper = tm.getAttribute("start-note") === "upper";
            } else if (c.getElementsByTagName("turn").length || c.getElementsByTagName("inverted-turn").length) {
              const up = upperNeighbour(text(pitch, "step"), Number(text(pitch, "octave")), fifths) + shift;
              const down = lowerNeighbour(text(pitch, "step"), Number(text(pitch, "octave")), fifths) + shift;
              ev.turn = c.getElementsByTagName("turn").length ? [up, midi, down] : [down, midi, up];
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
            if (trem) ev.tremolo = { type: trem.getAttribute("type") ?? "single", strokes: Number(trem.textContent) || 2, quarters: q };
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
  controls.sort((a, b) => a.time - b.time);
  return { events: expand(dedupe(events)), controls, spans, duration: t, programs };
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

// Trills alternate with the upper note; tremolos repeat a note, or alternate two chords.
function expand(events: NoteEvent[]): NoteEvent[] {
  if (!events.some((e) => e.trillUpper !== undefined || e.tremolo || e.mordent !== undefined || e.turn)) return events;
  const out: NoteEvent[] = [];
  const split = (e: NoteEvent, step: number, pick: (k: number) => number) => {
    const n = Math.max(1, Math.round(e.dur / step));
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
      const step = Math.min(0.12, Math.max(0.06, e.dur / Math.max(1, Math.round(e.dur / 0.09))));
      const first = e.trillFromUpper ? 0 : 1;
      split(e, step, (k) => (k % 2 === first ? e.trillUpper! : e.midi));
    } else if (e.turn) {
      // Upper, main, lower (or the reverse), then the main note for the rest of its length.
      const quick = Math.min(0.08, e.dur / 6);
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
