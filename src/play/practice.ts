// Practice with a MIDI instrument: which notes the player is expected to play, and wait
// mode's state machine, in-time mode's matcher. Pure, so it is tested without a browser.
//
// Rules:
// - The practised notes are those of the chosen parts (all when none are chosen); a hand
//   keeps staff 1 (right) or staff 2 and below (left) of parts written on several staves,
//   and the whole of single-staff parts.
// - Notes starting together (same pass through a measure, same beat) form one group; an
//   arpeggiated chord is one group too.
// - Grace notes are never expected: playing them or not does not block.
// - A trill, turn, mordent or tremolo expects its written note once, struck when it starts.
// - A tied note is not struck again: only its first note is expected.
// - A group is satisfied once each of its pitches has been struck since it became current,
//   in any order; wrong keys are ignored. A key struck earlier (held from the group before,
//   or played early while the previous group was still current) counts only if struck again.
import type { NoteEvent, Timeline } from "./timeline";

/** Which notes the player plays: parts (null for all) and a hand for parts on several staves. */
export interface PracticeTarget {
  parts?: number[] | null;
  hand?: "both" | "right" | "left";
}

/** Notes the player starts together. */
export interface PracticeGroup {
  /** When the first of them sounds, in seconds of the piece. */
  time: number;
  /** Distinct MIDI pitches expected. */
  pitches: number[];
  /** The timeline events they come from (the first of an ornament's quick notes). */
  events: NoteEvent[];
}

/** Whether a timeline note belongs to the practised notes (graces and ornament steps included). */
export function practisedBy(tl: Timeline, target: PracticeTarget): (e: NoteEvent) => boolean {
  const parts = target.parts?.length ? new Set(target.parts) : null;
  const hand = target.hand ?? "both";
  const multi = new Set<number>();
  for (const e of tl.events) if (e.staff > 1) multi.add(e.part);
  return (e) => {
    if (parts && !parts.has(e.part)) return false;
    if (hand === "both" || !multi.has(e.part)) return true;
    return hand === "right" ? e.staff === 1 : e.staff > 1;
  };
}

/** The groups of notes the player is expected to strike, in order. */
export function practiceGroups(tl: Timeline, target: PracticeTarget = {}): PracticeGroup[] {
  const mine = practisedBy(tl, target);
  // The span a time falls in, so a measure's later pass is a group of its own.
  const spanEnd = (t: number) => {
    let lo = 0;
    let hi = tl.spans.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (tl.spans[mid].start <= t + 1e-9) lo = mid;
      else hi = mid - 1;
    }
    return tl.spans[lo]?.end ?? Infinity;
  };
  const groups: PracticeGroup[] = [];
  const open = new Map<string, { g: PracticeGroup; end: number }>();
  for (const e of tl.events) {
    if (!mine(e) || e.grace || (e.expanded && e.expanded.index > 0)) continue;
    const pitch = e.expanded?.main ?? e.midi;
    const k = `${e.measure}|${e.onset}`;
    const o = open.get(k);
    if (o && e.time < o.end) {
      if (!o.g.pitches.includes(pitch)) o.g.pitches.push(pitch);
      o.g.events.push(e);
      continue;
    }
    const g: PracticeGroup = { time: e.time, pitches: [pitch], events: [e] };
    groups.push(g);
    open.set(k, { g, end: spanEnd(e.time) });
  }
  groups.sort((a, b) => a.time - b.time);
  for (const g of groups) g.pitches.sort((a, b) => a - b);
  return groups;
}

/** Wait mode: the current group, the keys down, and whether the group is played. */
export class WaitMatcher {
  private at = 0;
  private struck = new Set<number>();
  /** Keys down now, whatever they are. */
  readonly held = new Set<number>();

  constructor(readonly groups: PracticeGroup[]) {}

  /** Index of the group waited for (groups.length once all are played). */
  get index(): number {
    return this.at;
  }

  get current(): PracticeGroup | null {
    return this.groups[this.at] ?? null;
  }

  get done(): boolean {
    return this.at >= this.groups.length;
  }

  /** Pitches of the current group not struck yet. */
  get missing(): number[] {
    return this.current?.pitches.filter((p) => !this.struck.has(p)) ?? [];
  }

  /** Whether a pitch is part of the current group. */
  expects(pitch: number): boolean {
    return !!this.current?.pitches.includes(pitch);
  }

  /** Waits for the first group starting at or after `time` (seconds); keys must be struck anew. */
  seek(time: number): void {
    const i = this.groups.findIndex((g) => g.time >= time - 1e-6);
    this.at = i < 0 ? this.groups.length : i;
    this.struck.clear();
  }

  /** A key struck; returns true when it completed the current group (the next one is then current). */
  noteOn(pitch: number): boolean {
    this.held.add(pitch);
    const g = this.current;
    if (!g || !g.pitches.includes(pitch)) return false;
    this.struck.add(pitch);
    if (g.pitches.some((p) => !this.struck.has(p))) return false;
    this.at++;
    this.struck.clear();
    return true;
  }

  noteOff(pitch: number): void {
    this.held.delete(pitch);
  }
}

// In-time mode. Playback runs at the chosen speed and each expected note (one per pitch of a
// group) is matched to a key of the same pitch struck within its window.
//
// Rules:
// - Times are piece seconds as heard: the key's MIDI time on the audio clock, less the output
//   latency and the user's offset (see Player.heardAt). Differences are judged in real ms.
// - Window: ±max(80, 120 / speed) ms around the note; on time within ±max(35, 50 / speed) ms,
//   early or late beyond that. A note's window never reaches past halfway to the previous or
//   next expected note of the same pitch, so repeated notes each keep their own.
// - A key matches the unjudged note of its pitch whose window holds it; any other key (no
//   such note, or one already played) is a wrong key and consumes nothing.
// - A note is missed once its window has passed unplayed.
// - Accuracy: on time counts 1, early or late 1/2, over the notes judged plus the wrong keys.

/** Window sizes at speed 1 (ms of real time) and their floors at fast speeds. */
export const TIME_WINDOW = { windowMs: 120, onTimeMs: 50, minWindowMs: 80, minOnTimeMs: 35 };

/** The window and the on-time band at a playback speed, in real ms. */
export function timeWindow(speed: number): { windowMs: number; onTimeMs: number } {
  const s = speed > 0 ? speed : 1;
  return { windowMs: Math.max(TIME_WINDOW.minWindowMs, TIME_WINDOW.windowMs / s), onTimeMs: Math.max(TIME_WINDOW.minOnTimeMs, TIME_WINDOW.onTimeMs / s) };
}

// Notes further ahead than this (piece seconds) cannot have a window open yet.
const LOOK = 1;

export type Timing = "on" | "early" | "late";
export type TimeOutcome = Timing | "missed";

/** One note the player is expected to strike in time. */
export interface ExpectedNote {
  time: number;
  pitch: number;
  /** The timeline events it stands for (a chord's events of that pitch). */
  events: NoteEvent[];
  outcome: TimeOutcome | null;
  /** Signed real ms from the note to the key (negative: early), once played. */
  offsetMs: number | null;
  // Halfway to the neighbouring notes of the same pitch (piece seconds).
  lo: number;
  hi: number;
  inRun: boolean;
}

/** Running counts of an in-time run. */
export interface PracticeCounts {
  onTime: number;
  early: number;
  late: number;
  missed: number;
  wrong: number;
  /** Notes of the run, judged or not. */
  total: number;
  /** 0 to 100, rounded; null before anything was judged. */
  accuracy: number | null;
  /** Mean signed offset of the notes played, real ms (positive: late); for latency calibration. */
  meanOffsetMs: number | null;
}

export class TimeMatcher {
  readonly notes: ExpectedNote[] = [];
  private byPitch = new Map<number, ExpectedNote[]>();
  private cursor = 0;
  private wrong = 0;

  constructor(readonly groups: PracticeGroup[]) {
    for (const g of groups)
      for (const pitch of g.pitches) {
        const events = g.events.filter((e) => (e.expanded?.main ?? e.midi) === pitch);
        this.notes.push({ time: g.time, pitch, events, outcome: null, offsetMs: null, lo: -Infinity, hi: Infinity, inRun: true });
      }
    this.notes.sort((a, b) => a.time - b.time || a.pitch - b.pitch);
    for (const n of this.notes) {
      const list = this.byPitch.get(n.pitch);
      if (list) list.push(n);
      else this.byPitch.set(n.pitch, [n]);
    }
    for (const list of this.byPitch.values())
      for (let i = 0; i < list.length; i++) {
        if (i > 0) list[i].lo = (list[i - 1].time + list[i].time) / 2;
        if (i + 1 < list.length) list[i].hi = (list[i].time + list[i + 1].time) / 2;
      }
  }

  // A note's window in piece seconds at this speed: [start, end).
  private span(n: ExpectedNote, speed: number): [number, number] {
    const w = (timeWindow(speed).windowMs / 1000) * speed;
    return [Math.max(n.time - w, n.lo), Math.min(n.time + w, n.hi)];
  }

  /** Starts a run at piece time `time`: earlier notes are left out, every count back to 0. */
  seek(time: number): void {
    for (const n of this.notes) {
      n.outcome = null;
      n.offsetMs = null;
      n.inRun = n.time >= time - 1e-6;
    }
    this.cursor = 0;
    this.wrong = 0;
  }

  /** A key struck at piece time `time` (as heard); returns how it was judged and the note it played. */
  noteOn(pitch: number, time: number, speed = 1): { outcome: Timing | "wrong"; note: ExpectedNote | null } {
    for (const n of this.byPitch.get(pitch) ?? []) {
      if (!n.inRun) continue;
      const [a, b] = this.span(n, speed);
      if (time < a) break;
      if (time >= b) continue;
      // A key that came in time but was handled after the note was called missed still counts.
      if (n.outcome && n.outcome !== "missed") break;
      const ms = ((time - n.time) / speed) * 1000;
      n.offsetMs = ms;
      n.outcome = Math.abs(ms) <= timeWindow(speed).onTimeMs + 1e-6 ? "on" : ms < 0 ? "early" : "late";
      return { outcome: n.outcome, note: n };
    }
    this.wrong++;
    return { outcome: "wrong", note: null };
  }

  /** Playback reached piece time `time`: returns the notes whose window has just passed unplayed. */
  advance(time: number, speed = 1): ExpectedNote[] {
    const out: ExpectedNote[] = [];
    while (this.cursor < this.notes.length && (this.notes[this.cursor].outcome || !this.notes[this.cursor].inRun)) this.cursor++;
    for (let i = this.cursor; i < this.notes.length; i++) {
      const n = this.notes[i];
      if (n.time > time + LOOK) break;
      if (n.outcome || !n.inRun) continue;
      if (this.span(n, speed)[1] <= time) {
        n.outcome = "missed";
        out.push(n);
      }
    }
    return out;
  }

  /** Unjudged notes whose window holds piece time `time`: the keys to strike now. */
  due(time: number, speed = 1): ExpectedNote[] {
    const out: ExpectedNote[] = [];
    for (let i = this.cursor; i < this.notes.length; i++) {
      const n = this.notes[i];
      if (n.time > time + LOOK) break;
      if (n.outcome || !n.inRun) continue;
      const [a, b] = this.span(n, speed);
      if (time >= a && time < b) out.push(n);
    }
    return out;
  }

  get counts(): PracticeCounts {
    const c = { onTime: 0, early: 0, late: 0, missed: 0, wrong: this.wrong, total: 0 };
    let sum = 0;
    for (const n of this.notes) {
      if (!n.inRun) continue;
      c.total++;
      if (n.outcome === "on") c.onTime++;
      else if (n.outcome === "early") c.early++;
      else if (n.outcome === "late") c.late++;
      else if (n.outcome === "missed") c.missed++;
      if (n.offsetMs !== null) sum += n.offsetMs;
    }
    const played = c.onTime + c.early + c.late;
    const judged = played + c.missed + c.wrong;
    return { ...c, accuracy: judged ? Math.round(((c.onTime + (c.early + c.late) / 2) / judged) * 100) : null, meanOffsetMs: played ? Math.round(sum / played) : null };
  }
}

/**
 * The piece time a key struck at `perf` (performance.now() ms) was played against: its moment
 * on the audio clock (from a reading of both clocks), less the sound's way out (`latency`, s).
 */
export function heardAt(perf: number, clock: { audio: number; perf: number }, startAt: number, speed: number, latency: number): number {
  return (clock.audio + (perf - clock.perf) / 1000 - latency - startAt) * speed;
}

/** When piece time `t` is heard, in performance.now() ms (the inverse of heardAt). */
export function heardWhen(t: number, clock: { audio: number; perf: number }, startAt: number, speed: number, latency: number): number {
  return clock.perf + (startAt + t / speed + latency - clock.audio) * 1000;
}
