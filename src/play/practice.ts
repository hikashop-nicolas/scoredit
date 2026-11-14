// Practice with a MIDI instrument: which notes the player is expected to play, and wait
// mode's state machine. Pure, so it is tested without a browser.
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
