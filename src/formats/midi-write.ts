import { INSTRUMENTS } from "../model/instruments";
import type { ScoreDoc } from "../model/score";
import { kid, kids, text } from "../model/xml";
import { buildTimeline, quarterToSec } from "../play/timeline";

// A score as a Standard MIDI File (type 1): a conductor track with tempo, time and key
// signatures, rehearsal marks and the title, then one track per part. Notes come from the
// playback timeline, so repeats, jumps, ties, ornaments and transpositions play as heard.

export interface MidiWriteOptions {
  /** Every measure once, in score order, without repeats or jumps. */
  straight?: boolean;
  /** Shorten staccato notes and stress accents (default true). */
  articulations?: boolean;
  /** Tempo until the score marks one, in quarters a minute (default 120). */
  bpm?: number;
}

const PPQ = 480;

interface TrackEvent {
  tick: number;
  /** Order among events at the same tick: meta, setup, note off, controller, note on. */
  rank: number;
  bytes: number[];
}

const vlq = (n: number): number[] => {
  const out = [n & 0x7f];
  while ((n >>>= 7)) out.unshift((n & 0x7f) | 0x80);
  return out;
};
const utf8 = (s: string) => [...new TextEncoder().encode(s)];
const metaEv = (tick: number, type: number, data: number[]): TrackEvent => ({ tick, rank: 0, bytes: [0xff, type, ...vlq(data.length), ...data] });

function trackChunk(events: TrackEvent[], end: number): number[] {
  events.sort((a, b) => a.tick - b.tick || a.rank - b.rank);
  const body: number[] = [];
  let at = 0;
  for (const e of events) {
    body.push(...vlq(e.tick - at));
    for (const b of e.bytes) body.push(b);
    at = e.tick;
  }
  body.push(...vlq(Math.max(0, end - at)), 0xff, 0x2f, 0);
  const n = body.length;
  return [0x4d, 0x54, 0x72, 0x6b, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff, ...body];
}

// The time signature a measure is under, from its part's attributes.
function timeOf(score: ScoreDoc, p: number, m: number): [number, number] | null {
  let t = score.attributesAt(p, m).find((e) => e.tagName === "time") ?? null;
  for (const a of kids(score.measures[p][m], "attributes")) t = kid(a, "time") ?? t;
  if (!t || kid(t, "senza-misura")) return null;
  const n = text(t, "beats").split("+").reduce((s, x) => s + (Number(x) || 0), 0);
  const d = Number(text(t, "beat-type"));
  return n > 0 && d > 0 ? [n, d] : null;
}

// Concert key (fifths, minor) of a part at the start of a measure.
function keyOf(score: ScoreDoc, p: number, m: number): [number, number] | null {
  const at = score.attributesAt(p, m);
  let k = at.find((e) => e.tagName === "key") ?? null;
  let tr = at.find((e) => e.tagName === "transpose") ?? null;
  for (const a of kids(score.measures[p][m], "attributes")) {
    k = kid(a, "key") ?? k;
    tr = kid(a, "transpose") ?? tr;
  }
  if (!k || !kid(k, "fifths")) return null;
  const chromatic = tr ? Number(text(tr, "chromatic")) || 0 : 0;
  let f = (((Number(text(k, "fifths")) + 7 * chromatic) % 12) + 12) % 12;
  if (f > 6) f -= 12;
  return [f, text(k, "mode") === "minor" ? 1 : 0];
}

// Rehearsal marks in a measure, with their quarter offsets.
function rehearsals(score: ScoreDoc, p: number, m: number): [number, string][] {
  const out: [number, string][] = [];
  let div = Number(text(score.attributesAt(p, m).find((e) => e.tagName === "divisions"))) || 1;
  let pos = 0;
  for (const c of kids(score.measures[p][m])) {
    const dur = Number(text(c, "duration")) || 0;
    if (c.tagName === "attributes") div = Number(text(c, "divisions")) || div;
    else if (c.tagName === "backup") pos -= dur;
    else if (c.tagName === "forward") pos += dur;
    else if (c.tagName === "note" && !kid(c, "chord") && !kid(c, "grace")) pos += dur;
    else if (c.tagName === "direction") for (const r of Array.from(c.getElementsByTagName("rehearsal"))) if (text(r)) out.push([pos / div, text(r)]);
  }
  return out;
}

/** A score as a Standard MIDI File, type 1, 480 ticks a quarter. */
export function writeMidi(score: ScoreDoc, opts: MidiWriteOptions = {}): Uint8Array {
  const tl = buildTimeline(score, { straight: opts.straight, bpm: opts.bpm ?? 120 });
  const spans = tl.spans;
  // Time as runs of one tempo: [seconds, tick, seconds a quarter]. A pause gets a bar of ticks
  // of its own at the tempo that fills it, as MuseScore writes it.
  const runs: [number, number, number][] = [];
  let tick = 0;
  // The bar a pause takes is the measure under it: at a measure's end, the next in score order.
  const lengthOf = new Map(spans.map((s) => [s.measure, s.quarters]));
  const barAt = (m: number, len: number) => {
    const ts = score.measures[0]?.[m] ? timeOf(score, 0, m) : null;
    return lengthOf.get(m) ?? (ts ? (ts[0] * 4) / ts[1] : len);
  };
  spans.forEach((s) => {
    const cuts: [q: number, spq: number, pause: number][] = [...s.tempo.map(([q, spq]): [number, number, number] => [q, spq, 0]), ...(s.pauses ?? []).map(([q, sec]): [number, number, number] => [q, 0, sec])];
    // Pauses before the tempo that starts at the same place.
    cuts.sort((a, b) => a[0] - b[0] || b[2] - a[2]);
    let q = 0;
    let spq = s.tempo[0]?.[1] ?? 0.5;
    let paused = 0;
    for (const [at, tempo, pause] of cuts) {
      if (at !== q) paused = 0;
      tick += (at - q) * PPQ;
      q = at;
      if (pause > 0) {
        const bar = at >= s.quarters ? barAt(s.measure + 1, s.quarters) : barAt(s.measure, s.quarters);
        runs.push([s.start + quarterToSec(s, at, true) + paused, tick, pause / bar]);
        paused += pause;
        tick += bar * PPQ;
        runs.push([s.start + quarterToSec(s, at, true) + paused, tick, spq]);
      } else {
        spq = tempo;
        runs.push([s.start + quarterToSec(s, at), tick, spq]);
      }
    }
    tick += (s.quarters - q) * PPQ;
  });
  // Seconds to ticks, through the run being played then.
  const toTick = (sec: number): number => {
    let lo = 0;
    let hi = runs.length - 1;
    if (hi < 0) return 0;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (runs[mid][0] <= sec + 1e-9) lo = mid;
      else hi = mid - 1;
    }
    const [s0, t0, spq] = runs[lo];
    return Math.max(0, Math.round(t0 + ((sec - s0) / spq) * PPQ));
  };
  const endTick = Math.round(tick);
  const qTick = (i: number, q: number) => toTick(spans[i].start + quarterToSec(spans[i], q));

  // Conductor track.
  const conductor: TrackEvent[] = [];
  if (score.title) conductor.push(metaEv(0, 0x03, utf8(score.title)));
  const rights = text(kid(score.root, "identification"), "rights");
  if (rights) conductor.push(metaEv(0, 0x02, utf8(rights)));
  if (score.composer) conductor.push(metaEv(0, 0x01, utf8(score.composer)));
  // The key comes from the first pitched part.
  const keyPart = Math.max(0, score.parts.findIndex((p) => p.program !== 128));
  let lastTempo = -1;
  let lastTime = "";
  let lastKey = "";
  runs.forEach(([, at, spq], i) => {
    // A run cut short by another at the same tick (a pause at the bar line) needs no tempo.
    if (i + 1 < runs.length && Math.round(runs[i + 1][1]) === Math.round(at)) return;
    const us = Math.min(0xffffff, Math.round(spq * 1e6));
    if (us === lastTempo) return;
    lastTempo = us;
    conductor.push(metaEv(Math.round(at), 0x51, [(us >> 16) & 0xff, (us >> 8) & 0xff, us & 0xff]));
  });
  spans.forEach((s, i) => {
    const tick = qTick(i, 0);
    const ts = score.measures[0]?.[s.measure] ? timeOf(score, 0, s.measure) : null;
    if (ts) {
      let [n, d] = ts;
      // A measure of another length (a pickup) gets its own signature, as it is played.
      if (Math.abs((n * 4) / d - s.quarters) > 1e-6) {
        d = [d, 4, 8, 16, 32, 64].find((x) => Number.isInteger(Math.round(s.quarters * x * 1e6) / 1e6 / 4)) ?? 0;
        n = d ? Math.round((s.quarters * d) / 4) : 0;
      }
      const key = `${n}/${d}`;
      if (n > 0 && n < 256 && key !== lastTime) {
        lastTime = key;
        conductor.push(metaEv(tick, 0x58, [n, Math.log2(d), 24, 8]));
      }
    }
    const ks = score.measures[keyPart]?.[s.measure] ? keyOf(score, keyPart, s.measure) : null;
    if (ks && ks.join() !== lastKey) {
      lastKey = ks.join();
      conductor.push(metaEv(tick, 0x59, [ks[0] & 0xff, ks[1]]));
    }
    for (const [q, mark] of score.measures[0]?.[s.measure] ? rehearsals(score, 0, s.measure) : []) conductor.push(metaEv(qTick(i, q), 0x06, utf8(mark)));
  });
  if (lastTempo < 0) conductor.push(metaEv(0, 0x51, [0x07, 0xa1, 0x20]));

  // Channels: one per part while they last (10 for drums), then shared by sound.
  const list = kid(score.root, "part-list");
  const scoreParts = list ? kids(list, "score-part") : [];
  const byProgram = new Map<number, number>();
  let next = 0;
  let spill = 0;
  const setup = score.parts.map((part) => {
    const sp = scoreParts.find((e) => e.getAttribute("id") === part.id);
    const mi = sp?.getElementsByTagName("midi-instrument")[0];
    const sound = text(sp?.getElementsByTagName("instrument-sound")[0]);
    const drums = part.program === 128;
    const program = drums ? 0 : (part.program ?? INSTRUMENTS.find((d) => d.musescore === sound && !d.drums)?.program ?? 0);
    let channel = 9;
    if (!drums) {
      if (next === 9) next++;
      if (next <= 15) channel = next++;
      else channel = byProgram.get(program) ?? [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15][spill++ % 15];
      if (!byProgram.has(program)) byProgram.set(program, channel);
    }
    const volume = Number(text(mi ? kid(mi, "volume") : null));
    const pan = text(mi ? kid(mi, "pan") : null);
    return { channel, program, drums, volume: text(mi ? kid(mi, "volume") : null) ? volume : NaN, pan: pan ? Number(pan) : NaN, name: part.name || text(sp?.getElementsByTagName("instrument-name")[0]) };
  });

  const tracks: TrackEvent[][] = setup.map((s) => {
    const evs: TrackEvent[] = [];
    if (s.name) evs.push(metaEv(0, 0x03, utf8(s.name)));
    const ch = s.channel;
    if (!s.drums) evs.push({ tick: 0, rank: 1, bytes: [0xc0 | ch, s.program] });
    if (!Number.isNaN(s.volume)) evs.push({ tick: 0, rank: 1, bytes: [0xb0 | ch, 7, Math.max(0, Math.min(127, Math.floor((s.volume * 127) / 100)))] });
    if (!Number.isNaN(s.pan)) evs.push({ tick: 0, rank: 1, bytes: [0xb0 | ch, 10, Math.max(0, Math.min(127, Math.floor(((s.pan + 90) * 127) / 180)))] });
    return evs;
  });

  // Notes, gated by their articulations, then overlaps of one pitch on one channel resolved.
  const shape = opts.articulations !== false;
  type Out = { part: number; channel: number; pitch: number; on: number; off: number; vel: number };
  const notes: Out[] = [];
  const timelineChannels = new Map<number, Set<number>>();
  for (const e of tl.events) {
    const s = setup[e.part];
    if (!s) continue;
    (timelineChannels.get(e.channel) ?? timelineChannels.set(e.channel, new Set()).get(e.channel)!).add(e.part);
    const on = toTick(e.time);
    let off = toTick(e.time + e.dur);
    let vel = e.velocity;
    if (shape && !e.grace) {
      // Marks on any note of a chord apply to the whole chord.
      let head: Element | null = e.el;
      while (head && kid(head, "chord")) head = head.previousElementSibling;
      const chord: Element[] = [];
      for (let n: Element | null = head ?? e.el; n && (n === head || kid(n, "chord")); n = n.nextElementSibling) if (n.tagName === "note") chord.push(n);
      const has = (tag: string) => chord.some((n) => n.getElementsByTagName("articulations")[0]?.getElementsByTagName(tag).length);
      const gate = has("staccatissimo") ? 1 / 3 : has("staccato") || has("spiccato") ? 0.5 : has("strong-accent") ? 2 / 3 : 1;
      off = on + Math.round((off - on) * gate);
      if (has("strong-accent")) vel *= 1.3;
      else if (has("accent")) vel *= 1.2;
    }
    notes.push({ part: e.part, channel: e.channel === 9 ? 9 : s.channel, pitch: e.midi, on, off: Math.max(on + 1, off), vel: Math.max(1, Math.min(127, Math.round(vel))) });
  }
  notes.sort((a, b) => a.channel - b.channel || a.pitch - b.pitch || a.on - b.on || b.off - a.off);
  const keep: Out[] = [];
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    const prev = keep[keep.length - 1];
    if (prev && prev.channel === n.channel && prev.pitch === n.pitch) {
      if (prev.on === n.on) continue; // the same note twice: once is enough
      if (prev.off > n.on) prev.off = n.on;
    }
    if (n.pitch >= 0 && n.pitch <= 127) keep.push(n);
  }
  for (const n of keep) {
    tracks[n.part].push({ tick: n.on, rank: 4, bytes: [0x90 | n.channel, n.pitch, n.vel] }, { tick: n.off, rank: 2, bytes: [0x80 | n.channel, n.pitch, 0] });
  }
  // Pedal changes go to the parts on the channel the timeline gave them.
  for (const c of tl.controls) {
    for (const p of timelineChannels.get(c.channel) ?? []) tracks[p].push({ tick: toTick(c.time), rank: 3, bytes: [0xb0 | setup[p].channel, c.cc, c.value] });
  }

  const end = keep.reduce((m, n) => Math.max(m, n.off), endTick);
  const chunks = [trackChunk(conductor, end), ...tracks.map((t) => trackChunk(t, end))];
  const head = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, (chunks.length >> 8) & 0xff, chunks.length & 0xff, PPQ >> 8, PPQ & 0xff];
  const size = head.length + chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(size);
  out.set(head, 0);
  let o = head.length;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}
