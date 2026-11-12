// Audio export: the score played into samples, then MP3 or WAV. Recorded instruments are
// rendered straight through the piece by spessasynth; the others play on the built-in synth
// and string model in an OfflineAudioContext. Both run in slices so the page stays responsive.
import type { ScoreDoc } from "../model/score";
import WebAudioTinySynth from "../vendor/tinysynth.js";
import { PLUCKED, Pluck, type Bend } from "./pluck";
import { DRUMS } from "./sampler";
import type { SoundDownloads } from "./sounds";
import { buildTimeline, type NoteEvent, type Timeline } from "./timeline";

export interface AudioExportOptions {
  /** Recorded instruments; without them (or for the ones missing) the built-in sound plays. */
  sounds?: SoundDownloads | null;
  /** Called with 0 to 1 while rendering and encoding. */
  onProgress?(fraction: number): void;
  /** Play swing as written, or at another tempo, as for playback. */
  straight?: boolean;
  bpm?: number;
  sampleRate?: number;
}

export interface RenderedAudio {
  left: Float32Array;
  right: Float32Array;
  sampleRate: number;
}

const TAIL = 2; // seconds after the last note, for releases and the pedal
const LEAD = 0.05; // the first note starts this late, as in playback
// Recorded samples sit lower than the synth (as in playback), and soft notes stay bright.
const SAMPLE_GAIN = 3.2;
const velocityFor = (v: number) => Math.min(127, Math.round(64 + v / 2));

// Gives the page a turn without setTimeout's 4 ms clamp.
const pause = () =>
  new Promise<void>((r) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => r();
    ch.port2.postMessage(0);
  });
const SLICE_MS = 30;

/** Renders the whole score to stereo samples, peak-normalised to -1 dBFS. */
export async function renderAudio(score: ScoreDoc, opts: AudioExportOptions = {}): Promise<RenderedAudio> {
  const sr = opts.sampleRate ?? 44100;
  const tl = buildTimeline(score, { straight: opts.straight, bpm: opts.bpm });
  const n = Math.ceil((tl.duration + LEAD + TAIL) * sr);
  const progress = (f: number) => opts.onProgress?.(Math.min(1, f) * 0.6);
  const programs = [...new Set(tl.events.map((e) => e.program))];
  const banks = opts.sounds ? await opts.sounds.fetch(programs).catch(() => [] as ArrayBuffer[]) : [];
  const sampled = banks.length ? await renderSampled(tl, banks, n, sr, progress) : null;
  const rest = tl.events.filter((e) => !sampled?.programs.has(e.program));
  const synth = rest.length ? await renderSynth(tl, rest, n, sr) : null;
  progress(1);
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const l = (sampled ? sampled.left[i] * SAMPLE_GAIN : 0) + (synth ? synth.left[i] : 0);
    const r = (sampled ? sampled.right[i] * SAMPLE_GAIN : 0) + (synth ? synth.right[i] : 0);
    left[i] = l;
    right[i] = r;
    peak = Math.max(peak, Math.abs(l), Math.abs(r));
  }
  const g = peak > 0 ? 0.89 / peak : 1;
  for (let i = 0; i < n; i++) {
    left[i] *= g;
    right[i] *= g;
  }
  return { left, right, sampleRate: sr };
}

type Core = typeof import("spessasynth_core");

// One pass of the SoundFont synth through the piece: real note ends, pedal and velocity layers.
async function renderSampled(tl: Timeline, banks: ArrayBuffer[], n: number, sr: number, progress: (f: number) => void) {
  const core: Core = await import("spessasynth_core");
  await core.BasicSoundBank.ready;
  const syn = new core.SpessaSynthProcessor(sr, { effectsEnabled: false, eventsEnabled: false });
  const programs = new Set<number>();
  banks.forEach((bytes, i) => {
    try {
      const bank = core.SoundBankLoader.fromArrayBuffer(bytes);
      syn.soundBankManager.addSoundBank(bank, `bank${i}`);
      for (const p of bank.presets) {
        if (p.isGMGSDrum) programs.add(DRUMS);
        else if (p.bankMSB === 0) programs.add(p.program);
      }
    } catch (e) {
      console.warn("scoredit: sound file not read", e);
    }
  });
  // [time, order, action]: controllers first, then note ends, then starts at the same time.
  const q: [number, number, () => void][] = [];
  const channels = new Set<number>();
  for (const e of tl.events) {
    if (!programs.has(e.program)) continue;
    channels.add(e.channel);
    const on = LEAD + e.time;
    const off = on + Math.max(0.05, e.dur - 0.01);
    q.push([on, 2, () => syn.noteOn(e.channel, e.midi, velocityFor(e.velocity))]);
    q.push([off, 1, () => syn.noteOff(e.channel, e.midi)]);
    if (e.bend?.alter) bendSteps(q, e, on, off, (v) => syn.pitchWheel(e.channel, v));
  }
  if (!channels.size) return null;
  for (const c of tl.controls) if (channels.has(c.channel)) q.push([LEAD + c.time, 0, () => syn.controllerChange(c.channel, c.cc as never, c.value)]);
  q.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  for (const [ch, prog] of tl.programs) if (channels.has(ch) && ch !== 9 && prog !== DRUMS) syn.programChange(ch, prog);
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  let qi = 0;
  let slice = performance.now();
  for (let i = 0; i < n; i += 128) {
    const t = i / sr;
    while (qi < q.length && q[qi][0] <= t) q[qi++][2]();
    syn.process(left, right, i, Math.min(128, n - i));
    if (performance.now() - slice > SLICE_MS) {
      progress(i / n);
      await pause();
      slice = performance.now();
    }
  }
  return { left, right, programs };
}

// A guitar bend as pitch-wheel steps (2 semitones each way), back to centre at the note's end.
function bendSteps(q: [number, number, () => void][], e: NoteEvent, on: number, off: number, wheel: (v: number) => void) {
  const b = e.bend as Bend;
  const at = (semis: number) => Math.max(0, Math.min(16383, Math.round(8192 + (semis / 2) * 8192)));
  const dur = off - on;
  const rise = Math.min(0.18, dur * 0.3);
  q.push([on, 1.5, () => wheel(at(b.pre ? b.alter : 0))]);
  if (!b.pre) for (let k = 1; k <= 6; k++) q.push([on + (rise * k) / 6, 0, () => wheel(at((b.alter * k) / 6))]);
  if (b.release) {
    const from = on + Math.max(rise, dur * 0.6);
    const to = on + Math.max(rise + 0.05, dur * 0.95);
    for (let k = 1; k <= 6; k++) q.push([from + ((to - from) * k) / 6, 0, () => wheel(at(b.alter * (1 - k / 6)))]);
  }
  q.push([off + 0.001, 0, () => wheel(8192)]);
}

// The built-in synth and string model, as playback uses them, rendered offline.
async function renderSynth(tl: Timeline, events: NoteEvent[], n: number, sr: number) {
  const ctx = new OfflineAudioContext(2, n, sr);
  const out = ctx.createGain();
  out.connect(ctx.destination);
  const s = new WebAudioTinySynth({ quality: 1, useReverb: 1, voices: 64 });
  s.setAudioContext(ctx as unknown as AudioContext, out);
  const pluck = new Pluck(ctx as unknown as AudioContext, out);
  for (const [ch, prog] of tl.programs) s.send([0xc0 | ch, prog], 0);
  for (const c of tl.controls) s.send([0xb0 | c.channel, c.cc, c.value], LEAD + c.time);
  for (const e of events) {
    const on = LEAD + e.time;
    const len = Math.max(0.05, e.dur - 0.01);
    if (PLUCKED.has(e.program)) pluck.play(e.program, e.midi, on, len, e.velocity, e.bend);
    else {
      s.send([0x90 | e.channel, e.midi, e.velocity], on);
      s.send([0x80 | e.channel, e.midi, 0], on + len);
    }
  }
  const buf = await ctx.startRendering();
  return { left: buf.getChannelData(0), right: buf.getChannelData(1) };
}

interface Mp3Exports {
  memory: WebAssembly.Memory;
  mp3_start(channels: number, rate: number, kbps: number): void;
  mp3_input(n: number): number;
  mp3_push(n: number): number;
  mp3_finish(): number;
  mp3_output(): number;
  mp3_tag(): number;
  mp3_tag_len(): number;
}

let encoder: Promise<Mp3Exports> | null = null;
function mp3Encoder(): Promise<Mp3Exports> {
  encoder ??= import("../vendor/mp3-wasm").then(async ({ default: b64 }) => {
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const { instance } = await WebAssembly.instantiate(bin, {});
    return instance.exports as unknown as Mp3Exports;
  });
  return encoder;
}

/** Encodes stereo samples as a gapless constant-bitrate MP3. */
export async function encodeMp3(audio: RenderedAudio, opts: { kbps?: number; onProgress?(fraction: number): void } = {}): Promise<Uint8Array> {
  const x = await mp3Encoder();
  const { left, right, sampleRate } = audio;
  x.mp3_start(2, sampleRate, opts.kbps ?? 192);
  const parts: Uint8Array[] = [];
  const take = (len: number) => {
    if (len) parts.push(new Uint8Array(x.memory.buffer, x.mp3_output(), len).slice());
  };
  const block = 1152 * 40;
  let slice = performance.now();
  for (let i = 0; i < left.length; i += block) {
    const m = Math.min(block, left.length - i);
    const p = x.mp3_input(m * 2);
    const input = new Float32Array(x.memory.buffer, p, m * 2);
    for (let j = 0; j < m; j++) {
      input[2 * j] = left[i + j];
      input[2 * j + 1] = right[i + j];
    }
    take(x.mp3_push(m * 2));
    if (performance.now() - slice > SLICE_MS) {
      opts.onProgress?.(i / left.length);
      await pause();
      slice = performance.now();
    }
  }
  take(x.mp3_finish());
  const size = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  // The first frame becomes the completed Info tag: gapless and seekable.
  const tagLen = x.mp3_tag_len();
  if (tagLen && tagLen <= out.length) out.set(new Uint8Array(x.memory.buffer, x.mp3_tag(), tagLen), 0);
  opts.onProgress?.(1);
  return out;
}

/** 16-bit stereo WAV. */
export function encodeWav(audio: RenderedAudio): Uint8Array {
  const { left, right, sampleRate } = audio;
  const n = left.length;
  const out = new Uint8Array(44 + n * 4);
  const v = new DataView(out.buffer);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + n * 4, true);
  str(8, "WAVEfmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 2, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 4, true);
  v.setUint16(32, 4, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, n * 4, true);
  const s16 = (f: number) => Math.max(-32768, Math.min(32767, Math.round(f * 32767)));
  for (let i = 0; i < n; i++) {
    v.setInt16(44 + i * 4, s16(left[i]), true);
    v.setInt16(46 + i * 4, s16(right[i]), true);
  }
  return out;
}

/** The score as an MP3 file (rendering then encoding; progress covers both). */
export async function exportMp3(score: ScoreDoc, opts: AudioExportOptions & { kbps?: number } = {}): Promise<Uint8Array> {
  const audio = await renderAudio(score, opts);
  return encodeMp3(audio, { kbps: opts.kbps, onProgress: (f) => opts.onProgress?.(0.6 + f * 0.4) });
}

/** The score as a WAV file. */
export async function exportWav(score: ScoreDoc, opts: AudioExportOptions = {}): Promise<Uint8Array> {
  const audio = await renderAudio(score, opts);
  opts.onProgress?.(1);
  return encodeWav(audio);
}
