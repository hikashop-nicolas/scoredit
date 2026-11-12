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
    private core: Core,
    dest: AudioNode = ctx.destination,
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
    this.out.connect(limit).connect(dest);
  }

  /** An empty sampler; sound files are added with addBank. Null if the synth cannot load. */
  static async create(ctx: AudioContext, bytes?: ArrayBuffer, dest?: AudioNode): Promise<Sampler | null> {
    try {
      const core: Core = await import("spessasynth_core");
      await core.BasicSoundBank.ready;
      const syn = new core.SpessaSynthProcessor(ctx.sampleRate, { effectsEnabled: false, eventsEnabled: false });
      const sampler = new Sampler(ctx, syn, new Set(), core, dest);
      if (bytes) sampler.addBank(bytes);
      return sampler;
    } catch (e) {
      console.warn("scoredit: sampler not loaded", e);
      return null;
    }
  }

  private banks = 0;

  /** Adds a SoundFont (SF2/SF3); its instruments take over from the built-in sound. */
  addBank(bytes: ArrayBuffer): void {
    try {
      const bank = this.core.SoundBankLoader.fromArrayBuffer(bytes);
      this.syn.soundBankManager.addSoundBank(bank, `bank${this.banks++}`);
      for (const p of bank.presets) {
        if (p.isGMGSDrum) this.programs.add(DRUMS);
        else if (p.bankMSB === 0) this.programs.add(p.program);
      }
    } catch (e) {
      console.warn("scoredit: sound file not read", e);
    }
  }

  has(program: number): boolean {
    return this.programs.has(program);
  }

  /** The rendered note, if it is ready. */
  buffer(program: number, midi: number): AudioBuffer | undefined {
    return this.cache.get(`${program}:${midi}`);
  }

  /**
   * Renders these notes ([program, midi, longest length in seconds]) in the order given, in
   * slices of a few milliseconds so the page and the playback scheduler never wait on it.
   */
  prepare(notes: Iterable<[number, number, number?]>): Promise<void> {
    const want = new Map<string, number>();
    for (const [p, m, d] of notes) {
      const k = `${p}:${m}`;
      if (this.cache.has(k) || !this.has(p)) continue;
      want.set(k, Math.max(want.get(k) ?? 0, d ?? 0));
    }
    this.queue = this.queue.then(async () => {
      for (const [k, longest] of want) {
        if (this.cache.has(k)) continue;
        const [p, m] = k.split(":").map(Number);
        this.cache.set(k, await this.render(p, m, longest));
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
  private async render(program: number, midi: number, longest: number): Promise<AudioBuffer> {
    const sr = this.ctx.sampleRate;
    // Struck sounds die away; held ones (strings, winds, organ) last as long as the piece holds
    // that note, and no longer.
    const struck = program === DRUMS || program < 16 || (program >= 24 && program < 40) || program === 46 || (program >= 104 && program < 120);
    const seconds = struck ? Math.min(5, Math.max(2.5, 4.5 - (midi - 40) * 0.03)) : Math.min(10, Math.max(1, longest + 0.5));
    const n = Math.round(sr * seconds);
    const buf = this.ctx.createBuffer(2, n, sr);
    const left = buf.getChannelData(0);
    const right = buf.getChannelData(1);
    const syn = this.syn;
    const ch = program === DRUMS ? 9 : 0;
    syn.stopAll(true);
    if (ch === 0) syn.programChange(0, program);
    syn.noteOn(ch, midi, RENDER_VELOCITY);
    let slice = performance.now();
    for (let i = 0; i < n; i += 128) {
      syn.process(left, right, i, Math.min(128, n - i));
      // Give the page back every few milliseconds.
      if (performance.now() - slice > 4) {
        await new Promise((r) => setTimeout(r, 0));
        slice = performance.now();
      }
    }
    syn.noteOff(ch, midi);
    syn.stopAll(true);
    return buf;
  }
}
