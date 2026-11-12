// Plucked strings (guitars, basses, harp, banjo...) by Karplus-Strong synthesis: a burst of
// noise circulating in a delay line one period long, softened a little on every pass. It
// sounds like a string, needs no samples, and a note's pitch can be bent while it rings.

/** General MIDI programs that sound better plucked than through the FM synth. */
export const PLUCKED = new Set([24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 46, 104, 105, 106, 107]);

export interface Bend {
  /** Semitones at the top of the bend. */
  alter: number;
  /** Comes back down before the note ends. */
  release: boolean;
  /** Already bent when struck. */
  pre: boolean;
}

interface Voice {
  src: AudioBufferSourceNode;
  gain: GainNode;
}

export class Pluck {
  private cache = new Map<string, AudioBuffer>();
  private voices = new Set<Voice>();
  private out: GainNode;

  constructor(
    private ctx: AudioContext,
    dest: AudioNode = ctx.destination,
  ) {
    this.out = ctx.createGain();
    this.out.gain.value = 0.55;
    this.out.connect(dest);
  }

  /** One note: struck at audio time `t`, damped after `dur` seconds. */
  play(program: number, midi: number, t: number, dur: number, velocity: number, bend?: Bend): void {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.buffer(program, midi);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime((velocity / 127) * 0.9, t);
    // The player's hand stops the string at the end of the note.
    const end = t + Math.max(0.05, dur);
    gain.gain.setTargetAtTime(0, end, 0.035);
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
    src.stop(end + 0.4);
    const voice = { src, gain };
    this.voices.add(voice);
    src.onended = () => this.voices.delete(voice);
  }

  /** Silences everything sounding or scheduled. */
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

  private buffer(program: number, midi: number): AudioBuffer {
    const nylon = program === 24 || program === 46 || program === 104 || program === 107;
    const bass = program >= 32 && program <= 39;
    const key = `${nylon ? "n" : bass ? "b" : "s"}${midi}`;
    let buf = this.cache.get(key);
    if (buf) return buf;
    const sr = this.ctx.sampleRate;
    const freq = 440 * 2 ** ((midi - 69) / 12);
    const period = sr / freq;
    // Low strings ring longer; nylon and bass are darker than steel.
    const seconds = Math.min(4, Math.max(1.2, 3.5 - (midi - 40) * 0.04));
    const n = Math.round(sr * seconds);
    buf = this.ctx.createBuffer(1, n, sr);
    const y = buf.getChannelData(0);
    const p = Math.max(2, Math.floor(period));
    // The pluck: noise, smoothed to taste (more for nylon), with no DC offset.
    const burst = new Float32Array(p + 2);
    for (let i = 0; i < burst.length; i++) burst[i] = Math.random() * 2 - 1;
    for (let pass = 0; pass < (nylon || bass ? 3 : 1); pass++) for (let i = 1; i < burst.length; i++) burst[i] = 0.5 * (burst[i] + burst[i - 1]);
    const mean = burst.reduce((a, b) => a + b, 0) / burst.length;
    for (let i = 0; i < p + 2; i++) y[i] = burst[i] - mean;
    // Each sample is the average of the two a period back (read between samples for
    // exact pitch), a touch quieter: the string loses its brightness, then its sound.
    const loss = Math.pow(0.5, 1 / (seconds * freq * (nylon ? 0.55 : bass ? 0.7 : 0.8)));
    for (let i = p + 2; i < n; i++) {
      const at = i - period;
      const i0 = Math.floor(at);
      const f = at - i0;
      const a = y[i0] * (1 - f) + y[i0 + 1] * f;
      const b = y[i0 - 1] * (1 - f) + y[i0] * f;
      y[i] = loss * 0.5 * (a + b);
    }
    this.cache.set(key, buf);
    return buf;
  }
}
