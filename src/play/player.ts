import WebAudioTinySynth from "../vendor/tinysynth.js";
import { PLUCKED, Pluck } from "./pluck";
import { heardAt, heardWhen } from "./practice";
import { Sampler } from "./sampler";
import type { SoundDownloads } from "./sounds";
import { quarterToSec, secToQuarter, type ControlEvent, type MeasureSpan, type NoteEvent, type Timeline } from "./timeline";

export interface PlayPosition {
  /** Seconds into the piece (in played order). */
  time: number;
  /** Index in timeline.spans, and the quarter offset in that measure. */
  span: number;
  quarter: number;
}

export interface PlayerOptions {
  /** Recorded instrument sounds; without them, the built-in synth and string model play. */
  sounds?: SoundDownloads | null;
  /** Every animation frame while playing. */
  onPosition?(pos: PlayPosition): void;
  /** Notes starting (true) and ending (false), at the moment they sound. */
  onNotes?(events: NoteEvent[], on: boolean): void;
  onStateChange?(playing: boolean): void;
  /** Playback was moved to `time` by a seek or a restart, not by playing on. */
  onSeek?(time: number): void;
}

const LOOKAHEAD = 0.25;
const TICK_MS = 25;

let shared: WebAudioTinySynth | null = null;
// Every sound goes through one gain: the volume control.
let master: GainNode | null = null;
let volume = 1;
let muted = false;
const level = () => (muted ? 0 : volume);

/** The playback volume, 0 to 1, for the page (all players). */
export function setVolume(v: number, mute = false): void {
  volume = Math.min(1, Math.max(0, v));
  muted = mute;
  if (master) master.gain.setTargetAtTime(level(), master.context.currentTime, 0.015);
}

export function getVolume(): { volume: number; muted: boolean } {
  return { volume, muted };
}

function output(ctx: AudioContext): GainNode {
  if (!master) {
    master = ctx.createGain();
    master.gain.value = level();
    master.connect(ctx.destination);
  }
  return master;
}
let plucked: Pluck | null = null;
// The recorded instruments, one sampler for the page.
let sampler: Promise<Sampler | null> | null = null;
let samplerReady: Sampler | null = null;
// Plucked instruments play on their own synth, on the same audio clock.
function pluck(): Pluck {
  plucked ??= new Pluck(synth().getAudioContext(), master!);
  return plucked;
}
// One synthesizer for the page, created on the first play (a user gesture lets audio start).
function synth(): WebAudioTinySynth {
  if (!shared) {
    shared = new WebAudioTinySynth({ quality: 1, useReverb: 1, voices: 64 });
    // Its output built again on its own context, into the volume.
    const ctx = shared.getAudioContext();
    shared.setAudioContext(ctx, output(ctx));
  }
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
  // Wait mode: playback holds just before `gate` until it is moved; `skip` notes are not sounded.
  private gate: number | null = null;
  private held = false;
  private skip: ((e: NoteEvent) => boolean) | null = null;

  private pedal = pedalSpans([]);

  constructor(
    private timeline: Timeline,
    private opts: PlayerOptions = {},
  ) {
    this.pedal = pedalSpans(timeline.controls);
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  get duration(): number {
    return this.timeline.duration;
  }

  /** Current position in seconds of the piece. */
  get time(): number {
    if (!this.playing) return this.offset;
    if (this.held) return this.offset;
    const ctx = synth().getAudioContext();
    return Math.min(this.timeline.duration, this.stopAt(), (ctx.currentTime - this.startAt) * this.speed);
  }

  // Where playback holds: a moment before the gate, so the notes there are not yet sounding.
  private stopAt(): number {
    return this.gate === null ? Infinity : Math.max(0, this.gate - 1e-3);
  }

  /** Seconds from the audio clock to the ear (the context's output or base latency, 0 when unknown). */
  get outputLatency(): number {
    const ctx = synth().getAudioContext() as AudioContext & { outputLatency?: number };
    return ctx.outputLatency || ctx.baseLatency || 0;
  }

  // Both clocks read together.
  private clock(): { audio: number; perf: number } {
    return { audio: synth().getAudioContext().currentTime, perf: performance.now() };
  }

  /** The piece time heard at `perf` (performance.now() ms, as MIDI messages carry), less `extra` seconds. */
  heardAt(perf: number, extra = 0): number {
    return heardAt(perf, this.clock(), this.startAt, this.speed, this.outputLatency + extra);
  }

  /** When piece time `t` is heard while playing on, in performance.now() ms. */
  heardWhen(t: number, extra = 0): number {
    return heardWhen(t, this.clock(), this.startAt, this.speed, this.outputLatency + extra);
  }

  /** Wait mode: hold playback just before piece time `t` (null: play on freely). */
  setGate(t: number | null): void {
    this.gate = t;
    if (!this.held || (t !== null && t - 1e-3 <= this.offset + 1e-9)) return;
    // Released: the clock goes on from where it held.
    this.held = false;
    this.startAt = synth().getAudioContext().currentTime - this.offset / this.speed;
  }

  /** Whether playback is holding at the gate. */
  get waiting(): boolean {
    return this.playing && this.held;
  }

  /** Notes not to sound (the practised part, which the player plays). */
  setSkip(skip: ((e: NoteEvent) => boolean) | null): void {
    this.skip = skip;
  }

  /** Sounds a note at once on a part's channel (a MIDI key echoed); velocity 0 ends it. */
  live(channel: number, program: number, midi: number, velocity: number): void {
    const s = synth();
    const ctx = s.getAudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    if (velocity > 0) {
      if (channel !== 9) s.send([0xc0 | channel, program]);
      s.send([0x90 | channel, midi, velocity]);
    } else s.send([0x80 | channel, midi, 0]);
  }

  setTimeline(tl: Timeline): void {
    const was = this.playing;
    this.pause();
    this.timeline = tl;
    this.pedal = pedalSpans(tl.controls);
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
    if (this.offset >= this.timeline.duration - 0.01) {
      this.offset = 0;
      this.opts.onSeek?.(0);
    }
    this.held = false;
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
    this.loadSamples();
    this.schedule();
    this.timer = window.setInterval(() => this.schedule(), TICK_MS);
    this.raf = requestAnimationFrame(this.frame);
    this.opts.onStateChange?.(true);
  }

  pause(): void {
    if (!this.playing) return;
    this.offset = this.time;
    this.playing = false;
    this.held = false;
    clearInterval(this.timer);
    cancelAnimationFrame(this.raf);
    const s = synth();
    for (let ch = 0; ch < 16; ch++) {
      s.send([0xb0 | ch, 64, 0]);
      s.send([0xb0 | ch, 120, 0]);
    }
    plucked?.stopAll();
    samplerReady?.stopAll();
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
    this.opts.onSeek?.(this.offset);
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
    this.opts.onSeek?.(0);
    this.report();
  }

  dispose(): void {
    this.pause();
  }

  // Gets the recorded sounds the piece uses (downloads asked for by the host) and renders its
  // notes in the order they come; until then the built-in sound plays.
  private loadSamples(): void {
    const sounds = this.opts.sounds;
    if (!sounds) return;
    const evs = this.timeline.events;
    const notes: [number, number, number][] = [];
    for (let i = this.next; i < evs.length; i++) notes.push([evs[i].program, evs[i].midi, evs[i].dur / this.speed]);
    if (!notes.length) return;
    sampler ??= Sampler.create(synth().getAudioContext(), undefined, master!);
    const programs = [...new Set(notes.map(([p]) => p))];
    void sampler.then(async (s) => {
      if (!s) return;
      for (const bytes of await sounds.fetch(programs.filter((p) => !s.has(p))).catch(() => [])) s.addBank(bytes);
      samplerReady = s;
      return s.prepare(notes);
    });
  }

  private schedule = (): void => {
    const s = synth();
    const now = s.getAudioContext().currentTime;
    if (this.held) return;
    const horizon = Math.min((now - this.startAt + LOOKAHEAD) * this.speed, this.stopAt());
    const evs = this.timeline.events;
    while (this.next < evs.length && evs[this.next].time <= horizon) {
      const e = evs[this.next++];
      if (this.skip?.(e)) continue;
      const on = this.startAt + e.time / this.speed;
      const off = on + Math.max(0.05, e.dur / this.speed - 0.01);
      const program = e.program;
      // Recorded and plucked notes ring on while the pedal is down (the synth does it itself).
      const held = this.startAt + heldUntil(this.pedal, e.channel, (off - this.startAt) * this.speed) / this.speed;
      // The recorded instrument once its note is ready; the string model or the synth until then.
      if (program !== undefined && samplerReady?.has(program) && samplerReady.play(program, e.midi, on, held - on, e.velocity, e.bend)) continue;
      if (program !== undefined && PLUCKED.has(program)) pluck().play(program, e.midi, on, held - on, e.velocity, e.bend);
      else {
        s.send([0x90 | e.channel, e.midi, e.velocity], on);
        s.send([0x80 | e.channel, e.midi, 0], off);
      }
    }
    const ctl = this.timeline.controls;
    while (this.nextCtl < ctl.length && ctl[this.nextCtl].time <= horizon) {
      const c = ctl[this.nextCtl++];
      s.send([0xb0 | c.channel, c.cc, c.value], this.startAt + c.time / this.speed);
    }
    if (this.gate === null && this.next >= evs.length && now - this.startAt >= this.timeline.duration / this.speed + 0.3) {
      this.pause();
      this.offset = this.timeline.duration;
    }
  };

  private frame = (): void => {
    if (!this.playing) return;
    if (!this.held && this.gate !== null && (synth().getAudioContext().currentTime - this.startAt) * this.speed >= this.stopAt()) {
      this.offset = this.stopAt();
      this.held = true;
    }
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

/** Per channel, the [down, up] times of the sustain pedal (CC 64). */
export function pedalSpans(controls: ControlEvent[]): Map<number, [number, number][]> {
  const spans = new Map<number, [number, number][]>();
  const down = new Map<number, number>();
  for (const c of controls) {
    if (c.cc !== 64) continue;
    const at = down.get(c.channel);
    if (c.value >= 64 && at === undefined) down.set(c.channel, c.time);
    else if (c.value < 64 && at !== undefined) {
      if (!spans.has(c.channel)) spans.set(c.channel, []);
      spans.get(c.channel)!.push([at, c.time]);
      down.delete(c.channel);
    }
  }
  for (const [ch, at] of down) {
    if (!spans.has(ch)) spans.set(ch, []);
    spans.get(ch)!.push([at, Infinity]);
  }
  return spans;
}

/** When a note released at piece time t stops sounding: at the pedal's release if it is down. */
export function heldUntil(spans: Map<number, [number, number][]>, channel: number, t: number): number {
  for (const [a, b] of spans.get(channel) ?? []) if (a <= t && t < b) return Number.isFinite(b) ? b : t + 4;
  return t;
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
  // Through the bar's tempo changes and pauses, as the timeline placed its notes.
  const q = Math.min(span.quarters, Math.max(0, secToQuarter(span, t - span.start)));
  return { time: t, span: lo, quarter: q };
}
