import WebAudioTinySynth from "../vendor/tinysynth.js";
import { quarterToSec, type MeasureSpan, type NoteEvent, type Timeline } from "./timeline";

export interface PlayPosition {
  /** Seconds into the piece (in played order). */
  time: number;
  /** Index in timeline.spans, and the quarter offset in that measure. */
  span: number;
  quarter: number;
}

export interface PlayerOptions {
  /** Every animation frame while playing. */
  onPosition?(pos: PlayPosition): void;
  /** Notes starting (true) and ending (false), at the moment they sound. */
  onNotes?(events: NoteEvent[], on: boolean): void;
  onStateChange?(playing: boolean): void;
}

const LOOKAHEAD = 0.25;
const TICK_MS = 25;

let shared: WebAudioTinySynth | null = null;
// One synthesizer for the page, created on the first play (a user gesture lets audio start).
function synth(): WebAudioTinySynth {
  shared ??= new WebAudioTinySynth({ quality: 1, useReverb: 1, voices: 64 });
  return shared;
}

// Plays a timeline on the built-in synthesizer: notes are handed to the synth a quarter
// second ahead on the audio clock, and the position is reported every frame.
export class Player {
  private playing = false;
  private startAt = 0; // audio time of piece time 0, at the current speed
  private offset = 0; // piece time where playback (re)started
  private next = 0; // index of the next event to schedule
  private nextCtl = 0; // index of the next controller change
  private timer = 0;
  private raf = 0;
  private speed = 1;
  private sounding: NoteEvent[] = [];

  constructor(
    private timeline: Timeline,
    private opts: PlayerOptions = {},
  ) {}

  get isPlaying(): boolean {
    return this.playing;
  }

  get duration(): number {
    return this.timeline.duration;
  }

  /** Current position in seconds of the piece. */
  get time(): number {
    if (!this.playing) return this.offset;
    const ctx = synth().getAudioContext();
    return Math.min(this.timeline.duration, (ctx.currentTime - this.startAt) * this.speed);
  }

  setTimeline(tl: Timeline): void {
    const was = this.playing;
    this.pause();
    this.timeline = tl;
    this.offset = Math.min(this.offset, tl.duration);
    if (was) this.play();
  }

  setSpeed(s: number): void {
    const t = this.time;
    this.speed = Math.min(2, Math.max(0.25, s));
    if (this.playing) {
      this.pause();
      this.offset = t;
      this.play();
    }
  }

  getSpeed(): number {
    return this.speed;
  }

  play(): void {
    if (this.playing) return;
    if (this.offset >= this.timeline.duration - 0.01) this.offset = 0;
    const s = synth();
    const ctx = s.getAudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    for (const [ch, prog] of this.timeline.programs) s.send([0xc0 | ch, prog]);
    this.startAt = ctx.currentTime + 0.05 - this.offset / this.speed;
    // Controllers in force where playback starts (a pedal held down), then the rest in time.
    const ctl = this.timeline.controls;
    this.nextCtl = ctl.findIndex((c) => c.time >= this.offset - 1e-6);
    if (this.nextCtl < 0) this.nextCtl = ctl.length;
    const state = new Map<string, [number, number, number]>();
    for (let i = 0; i < this.nextCtl; i++) state.set(`${ctl[i].channel}:${ctl[i].cc}`, [ctl[i].channel, ctl[i].cc, ctl[i].value]);
    for (const [ch, cc, v] of state.values()) s.send([0xb0 | ch, cc, v]);
    this.next = this.timeline.events.findIndex((e) => e.time >= this.offset - 1e-6);
    if (this.next < 0) this.next = this.timeline.events.length;
    this.playing = true;
    this.schedule();
    this.timer = window.setInterval(() => this.schedule(), TICK_MS);
    this.raf = requestAnimationFrame(this.frame);
    this.opts.onStateChange?.(true);
  }

  pause(): void {
    if (!this.playing) return;
    this.offset = this.time;
    this.playing = false;
    clearInterval(this.timer);
    cancelAnimationFrame(this.raf);
    const s = synth();
    for (let ch = 0; ch < 16; ch++) {
      s.send([0xb0 | ch, 64, 0]);
      s.send([0xb0 | ch, 120, 0]);
    }
    if (this.sounding.length) this.opts.onNotes?.(this.sounding, false);
    this.sounding = [];
    this.opts.onStateChange?.(false);
  }

  toggle(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  /** Moves to `t` seconds; keeps playing if it was. */
  seek(t: number): void {
    const was = this.playing;
    this.pause();
    this.offset = Math.min(Math.max(0, t), this.timeline.duration);
    this.report();
    if (was) this.play();
  }

  /** Moves to quarter q of measure m: its next pass from the current position, else its first. */
  seekMeasure(m: number, q = 0): void {
    const spans = this.timeline.spans;
    const now = this.time;
    const span = spans.find((s) => s.measure === m && s.end > now) ?? spans.find((s) => s.measure === m);
    if (span) this.seek(span.start + quarterToSec(span, q));
  }

  stop(): void {
    this.pause();
    this.offset = 0;
    this.report();
  }

  dispose(): void {
    this.pause();
  }

  private schedule = (): void => {
    const s = synth();
    const now = s.getAudioContext().currentTime;
    const horizon = (now - this.startAt + LOOKAHEAD) * this.speed;
    const evs = this.timeline.events;
    while (this.next < evs.length && evs[this.next].time <= horizon) {
      const e = evs[this.next++];
      const on = this.startAt + e.time / this.speed;
      const off = on + Math.max(0.05, e.dur / this.speed - 0.01);
      s.send([0x90 | e.channel, e.midi, e.velocity], on);
      s.send([0x80 | e.channel, e.midi, 0], off);
    }
    const ctl = this.timeline.controls;
    while (this.nextCtl < ctl.length && ctl[this.nextCtl].time <= horizon) {
      const c = ctl[this.nextCtl++];
      s.send([0xb0 | c.channel, c.cc, c.value], this.startAt + c.time / this.speed);
    }
    if (this.next >= evs.length && now - this.startAt >= this.timeline.duration / this.speed + 0.3) {
      this.pause();
      this.offset = this.timeline.duration;
    }
  };

  private frame = (): void => {
    if (!this.playing) return;
    const t = this.time;
    // What sounds now: started, not yet ended.
    const evs = this.timeline.events;
    const now: NoteEvent[] = [];
    for (let i = Math.max(0, this.next - 400); i < this.next; i++) {
      const e = evs[i];
      if (e.time <= t && e.time + e.dur > t) now.push(e);
    }
    const ended = this.sounding.filter((e) => !now.includes(e));
    const started = now.filter((e) => !this.sounding.includes(e));
    if (ended.length) this.opts.onNotes?.(ended, false);
    if (started.length) this.opts.onNotes?.(started, true);
    this.sounding = now;
    this.report();
    this.raf = requestAnimationFrame(this.frame);
  };

  private report(): void {
    this.opts.onPosition?.(positionAt(this.timeline.spans, this.time));
  }
}

/** Where in the score piece time `t` falls. */
export function positionAt(spans: MeasureSpan[], t: number): PlayPosition {
  let lo = 0;
  let hi = spans.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (spans[mid].start <= t) lo = mid;
    else hi = mid - 1;
  }
  const span = spans[lo];
  if (!span) return { time: t, span: 0, quarter: 0 };
  // Linear inside a measure is close enough between tempo changes for a cursor.
  const frac = span.end > span.start ? Math.min(1, Math.max(0, (t - span.start) / (span.end - span.start))) : 0;
  let q = frac * span.quarters;
  if (span.tempo.length > 1) {
    let s = 0;
    q = span.quarters;
    for (let i = 0; i < span.tempo.length; i++) {
      const [from, spq] = span.tempo[i];
      const to = i + 1 < span.tempo.length ? span.tempo[i + 1][0] : span.quarters;
      const seg = (to - from) * spq;
      if (t - span.start <= s + seg) {
        q = from + (t - span.start - s) / spq;
        break;
      }
      s += seg;
    }
  }
  return { time: t, span: lo, quarter: q };
}
