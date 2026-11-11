// Recorded instruments from a SoundFont (SF2/SF3) sound pack. Each note a piece needs is
// rendered once by spessasynth (loaded only when a pack is used), kept as an AudioBuffer,
// and played on the audio clock like the plucked-string model: struck, damped at the
// note's end, its pitch bent by retuning the buffer.
import type { Bend } from "./pluck";

type Core = typeof import("spessasynth_core");
type Processor = InstanceType<Core["SpessaSynthProcessor"]>;

interface Voice {
  src: AudioBufferSourceNode;
  gain: GainNode;
}

/** The program number scoredit uses for the drum kit (MIDI channel 10). */
export const DRUMS = 128;

/** Velocity the notes are rendered at; louder or softer notes scale from it. */
const RENDER_VELOCITY = 100;

export class Sampler {
  private cache = new Map<string, AudioBuffer>();
  private voices = new Set<Voice>();
  private out: GainNode;
  private queue: Promise<void> = Promise.resolve();

  private constructor(
    private ctx: AudioContext,
    private syn: Processor,
    readonly programs: Set<number>,
  ) {
    // Recorded samples sit lower than the FM synth: lift them, and keep full chords from clipping.
    this.out = ctx.createGain();
    this.out.gain.value = 3.2;
    const limit = ctx.createDynamicsCompressor();
    limit.threshold.value = -10;
    limit.knee.value = 8;
    limit.ratio.value = 6;
    limit.attack.value = 0.003;
    limit.release.value = 0.2;
    this.out.connect(limit).connect(ctx.destination);
  }

  /** Loads a sound pack; null if it cannot be read. */
  static async create(ctx: AudioContext, bytes: ArrayBuffer): Promise<Sampler | null> {
    try {
      const core: Core = await import("spessasynth_core");
      await core.BasicSoundBank.ready;
      const bank = core.SoundBankLoader.fromArrayBuffer(bytes);
      const syn = new core.SpessaSynthProcessor(ctx.sampleRate, { effectsEnabled: false, eventsEnabled: false });
      syn.soundBankManager.addSoundBank(bank, "pack");
      const programs = new Set(bank.presets.filter((p) => !p.isGMGSDrum && p.bankMSB === 0).map((p) => p.program));
      if (bank.presets.some((p) => p.isGMGSDrum)) programs.add(DRUMS);
      return new Sampler(ctx, syn, programs);
    } catch (e) {
      console.warn("scoredit: sound pack not loaded", e);
      return null;
    }
  }

  has(program: number): boolean {
    return this.programs.has(program);
  }

  /** The rendered note, if it is ready. */
  buffer(program: number, midi: number): AudioBuffer | undefined {
    return this.cache.get(`${program}:${midi}`);
  }

  /** Renders these notes, a few at a time so the page stays responsive. */
  prepare(notes: Iterable<[number, number]>): Promise<void> {
    const todo = [...new Set([...notes].map(([p, m]) => `${p}:${m}`))].filter((k) => !this.cache.has(k) && this.has(Number(k.split(":")[0])));
    this.queue = this.queue.then(async () => {
      for (const k of todo) {
        if (this.cache.has(k)) continue;
        const [p, m] = k.split(":").map(Number);
        this.cache.set(k, this.render(p, m));
        await new Promise((r) => setTimeout(r, 0));
      }
    });
    return this.queue;
  }

  play(program: number, midi: number, t: number, dur: number, velocity: number, bend?: Bend): boolean {
    const buf = this.buffer(program, midi);
    if (!buf) return false;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(velocity / RENDER_VELOCITY, t);
    const end = t + Math.max(0.05, dur);
    gain.gain.setTargetAtTime(0, end, 0.06);
    if (bend && bend.alter) {
      const cents = bend.alter * 100;
      const rise = Math.min(0.18, dur * 0.3);
      src.detune.setValueAtTime(bend.pre ? cents : 0, t);
      if (!bend.pre) src.detune.linearRampToValueAtTime(cents, t + rise);
      if (bend.release) {
        src.detune.setValueAtTime(cents, t + Math.max(rise, dur * 0.6));
        src.detune.linearRampToValueAtTime(0, t + Math.max(rise + 0.05, dur * 0.95));
      }
    }
    src.connect(gain).connect(this.out);
    src.start(t);
    src.stop(Math.min(t + buf.duration, end + 0.6));
    const voice = { src, gain };
    this.voices.add(voice);
    src.onended = () => this.voices.delete(voice);
    return true;
  }

  stopAll(): void {
    const now = this.ctx.currentTime;
    for (const v of this.voices) {
      v.gain.gain.cancelScheduledValues(now);
      v.gain.gain.setTargetAtTime(0, now, 0.01);
      try {
        v.src.stop(now + 0.05);
      } catch {
        /* not started yet */
      }
    }
    this.voices.clear();
  }

  // One note held for a few seconds (low notes longer), as the pack plays it.
  private render(program: number, midi: number): AudioBuffer {
    const sr = this.ctx.sampleRate;
    const seconds = Math.min(5, Math.max(2.5, 4.5 - (midi - 40) * 0.03));
    const n = Math.round(sr * seconds);
    const buf = this.ctx.createBuffer(2, n, sr);
    const left = buf.getChannelData(0);
    const right = buf.getChannelData(1);
    const syn = this.syn;
    const ch = program === DRUMS ? 9 : 0;
    syn.stopAll(true);
    if (ch === 0) syn.programChange(0, program);
    syn.noteOn(ch, midi, RENDER_VELOCITY);
    for (let i = 0; i < n; i += 128) syn.process(left, right, i, Math.min(128, n - i));
    syn.noteOff(ch, midi);
    syn.stopAll(true);
    return buf;
  }
}
