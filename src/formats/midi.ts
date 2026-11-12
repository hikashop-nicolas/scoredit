import { CLEFS, DRUM_KIT, INSTRUMENTS } from "../model/instruments";
import { splitLength, spellMidi, writtenFor } from "../edit/notes";
import { t } from "../ui/i18n";

// Standard MIDI files (type 0 and 1) read as a MusicXML score: each beat quantised to the subdivision
// that fits it (32nds, triplets, quintuplets, sextuplets), ties at bar lines, chords, up to four
// voices a staff, keyboards on two staves, channel 10 as a drum kit.

/** Steps per quarter: 32nds (15), triplet (40, 20, 10) and quintuplet (24, 12) values all fit. */
const Q = 120;

interface RawNote {
  track: number;
  channel: number;
  pitch: number;
  start: number;
  end: number;
}

interface Smf {
  ppq: number;
  notes: RawNote[];
  names: Map<number, string>;
  programs: Map<string, number>;
  tempos: { tick: number; bpm: number }[];
  times: { tick: number; n: number; d: number }[];
  keys: { tick: number; fifths: number }[];
  title: string;
}

/** Text in a meta event: UTF-8 when it is, else Latin-1. */
function text(data: Uint8Array): string {
  let s: string;
  try {
    s = new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    s = new TextDecoder("latin1").decode(data);
  }
  // Some writers end names with NULs, which XML refuses.
  return s.replace(/[\x00-\x1f\x7f]/g, " ").trim();
}

/** Reads the events of a standard MIDI file. */
export function parseSmf(bytes: Uint8Array): Smf {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const str = (o: number, n: number) => String.fromCharCode(...bytes.subarray(o, o + n));
  if (str(0, 4) !== "MThd") throw new Error("Not a MIDI file");
  const headLen = view.getUint32(4);
  const tracks = view.getUint16(10);
  const division = view.getUint16(12);
  // SMPTE time (rare in notation files): taken as 480 ticks a quarter.
  const ppq = division & 0x8000 ? 480 : division || 480;
  const out: Smf = { ppq, notes: [], names: new Map(), programs: new Map(), tempos: [], times: [], keys: [], title: "" };
  let o = 8 + headLen;
  for (let tr = 0; tr < tracks && o + 8 <= bytes.length; tr++) {
    const len = view.getUint32(o + 4);
    if (str(o, 4) !== "MTrk") {
      o += 8 + len;
      continue;
    }
    let p = o + 8;
    const end = Math.min(bytes.length, p + len);
    let tick = 0;
    let status = 0;
    const open = new Map<string, number[]>();
    const varint = () => {
      let v = 0;
      for (let i = 0; i < 4 && p < end; i++) {
        const b = bytes[p++];
        v = (v << 7) | (b & 0x7f);
        if (!(b & 0x80)) break;
      }
      return v;
    };
    while (p < end) {
      tick += varint();
      let s = bytes[p];
      if (s & 0x80) p++;
      else s = status; // running status
      if (s === 0xff) {
        const type = bytes[p++];
        const n = varint();
        const data = bytes.subarray(p, p + n);
        p += n;
        if (type === 0x03 && !out.names.has(tr)) out.names.set(tr, text(data));
        else if (type === 0x51 && n >= 3) out.tempos.push({ tick, bpm: Math.round(60000000 / ((data[0] << 16) | (data[1] << 8) | data[2])) });
        else if (type === 0x58 && n >= 2) out.times.push({ tick, n: data[0], d: 2 ** data[1] });
        else if (type === 0x59 && n >= 1) out.keys.push({ tick, fifths: (data[0] << 24) >> 24 });
        else if (type === 0x2f) break;
        continue;
      }
      if (s === 0xf0 || s === 0xf7) {
        p += varint();
        continue;
      }
      status = s;
      const kind = s & 0xf0;
      const ch = s & 0x0f;
      if (kind === 0xc0 || kind === 0xd0) {
        const v = bytes[p++];
        if (kind === 0xc0 && !out.programs.has(`${tr}|${ch}`)) out.programs.set(`${tr}|${ch}`, v);
        continue;
      }
      const a = bytes[p++];
      const b = bytes[p++];
      const key = `${ch}|${a}`;
      if (kind === 0x90 && b > 0) {
        if (!open.has(key)) open.set(key, []);
        open.get(key)!.push(tick);
      }
      else if (kind === 0x80 || kind === 0x90) {
        const starts = open.get(key);
        const start = starts?.shift();
        if (start !== undefined) out.notes.push({ track: tr, channel: ch, pitch: a, start, end: Math.max(tick, start + 1) });
      }
    }
    o += 8 + len;
  }
  if (out.names.size && tracks > 1 && !out.notes.some((n) => n.track === 0)) out.title = out.names.get(0) ?? "";
  for (const list of [out.tempos, out.times, out.keys]) list.sort((a, b) => a.tick - b.tick);
  return out;
}

// ---- Quantising. A lone time goes to the nearest place a simple value can start, straight
// or triplet; the onsets of a beat together pick the subdivision of that beat.

const GRIDS: [step: number, cost: number][] = [
  [Q, 0],
  [Q / 2, 0],
  [Q / 4, 0.02],
  [Q / 3, 0.04],
  [Q / 8, 0.06],
  [Q / 6, 0.08],
];

function snap(steps: number, grids = GRIDS): number {
  let best = Math.round(steps);
  let bestScore = Infinity;
  for (const [g, cost] of grids) {
    const v = Math.round(steps / g) * g;
    const score = Math.abs(steps - v) / Q + cost;
    if (score < bestScore) [bestScore, best] = [score, v];
  }
  return best;
}

// Subdivisions of a beat and what each costs, against the squared error (in quarters) it leaves.
const SUBDIVS: [div: number, cost: number][] = [
  [1, 0],
  [2, 0],
  [4, 0.0003],
  [3, 0.0006],
  [8, 0.002],
  [6, 0.0025],
  [5, 0.003],
  [12, 0.005],
  [10, 0.006],
];

const STRAIGHT_GRIDS = GRIDS.filter(([g]) => [1, 2, 4, 8].includes(Q / g));

/** Snaps times (in quarters) to steps, beat by beat on the subdivision the onsets fit best. */
function beatQuantizer(onsets: number[]): { start: (q: number) => number; end: (q: number) => number } {
  const byBeat = new Map<number, number[]>();
  for (const q of onsets) {
    const b = Math.floor(q + 1e-6);
    const x = q - b;
    if (x < 0.02 || x > 0.98) continue; // on a beat: fits any subdivision
    (byBeat.get(b) ?? byBeat.set(b, []).get(b)!).push(x);
  }
  const div = new Map<number, number>();
  for (const [b, xs] of byBeat) {
    xs.sort((p, q) => p - q);
    const pts = xs.filter((x, i) => i === 0 || x - xs[i - 1] > 0.015);
    let best = 8;
    let bestCost = Infinity;
    for (const [d, cost] of SUBDIVS) {
      let c = cost;
      let prev = -1;
      let prevX = -1;
      for (const x of pts) {
        const k = Math.round(x * d);
        c += (x - k / d) ** 2;
        // Two clearly apart onsets on one place: this subdivision is too coarse.
        if (k === prev && x - prevX > 0.06) c += 0.01;
        prev = k;
        prevX = x;
      }
      if (c < bestCost) [bestCost, best] = [c, d];
    }
    div.set(b, best);
  }
  return {
    start: (q: number) => {
      const b = Math.floor(q + 1e-6);
      const d = div.get(b);
      if (d === undefined) return snap(q * Q);
      return b * Q + Math.round((q - b) * d) * (Q / d);
    },
    // Ends on the finer grid of the same family: a short last note keeps its length.
    end: (q: number) => {
      const b = Math.floor(q + 1e-6);
      const d = div.get(b);
      if (d === undefined) return snap(q * Q);
      if (d % 3 && d % 5) return snap(q * Q, STRAIGHT_GRIDS);
      const f = d === 3 ? 6 : d;
      return b * Q + Math.round((q - b) * f) * (Q / f);
    },
  };
}

interface Ev {
  start: number;
  end: number;
  pitches: number[];
  /** Pitches tied from the chord before in the voice, and into the next. */
  tieIn?: number[];
  tieOut?: number[];
}

/** Voices a staff has at most, as MusicXML numbers them per staff (and MuseScore keeps). */
const MAX_VOICES = 4;

/** Notes as chords (same start, about the same end) in up to four voices: a chord goes to the first voice free by then, or one whose last chord it barely overlaps (cut short), else to a new voice; past four, it joins the chords of the voice that fits its rhythm best. */
function voicesOf(notes: { start: number; end: number; pitch: number }[]): Ev[][] {
  const byStart = new Map<number, { end: number; pitch: number }[]>();
  for (const n of notes) {
    if (!byStart.has(n.start)) byStart.set(n.start, []);
    byStart.get(n.start)!.push(n);
  }
  const evs: Ev[] = [];
  for (const [start, group] of byStart) {
    // Notes held clearly longer than the others make a chord of their own.
    group.sort((a, b) => a.end - b.end);
    let cur: typeof group = [];
    const flush = () => {
      if (!cur.length) return;
      const end = cur[Math.floor(cur.length / 2)].end;
      evs.push({ start, end, pitches: [...new Set(cur.map((g) => g.pitch))].sort((a, b) => a - b) });
      cur = [];
    };
    for (const n of group) {
      if (cur.length && n.end - cur[0].end > Math.max(Q / 2, (cur[0].end - start) / 4)) flush();
      cur.push(n);
    }
    flush();
  }
  // In time order, the higher chord first.
  evs.sort((a, b) => a.start - b.start || b.pitches[b.pitches.length - 1] - a.pitches[a.pitches.length - 1]);
  const voices: Ev[][] = [[]];
  const last = (v: Ev[]) => v[v.length - 1];
  // Held a little past the next start (legato playing), not a line of its own.
  const barely = (p: Ev, start: number) => p.end - start <= Math.min(Q / 4, (p.end - p.start) / 4);
  const mid = (e: Ev) => e.pitches.reduce((a, b) => a + b, 0) / e.pitches.length;
  // Of the voices that can take a chord, the one whose last chord is nearest in pitch.
  const nearest = (list: Ev[][], ev: Ev) => {
    let best: Ev[] | undefined;
    for (const x of list) if (!best || (last(x) && Math.abs(mid(last(x)) - mid(ev)) < Math.abs(mid(last(best)) - mid(ev)))) best = x;
    return best;
  };
  const extra: Ev[] = [];
  for (const ev of evs) {
    let v = voices[0].length ? nearest(voices.filter((x) => last(x).end <= ev.start), ev) ?? nearest(voices.filter((x) => barely(last(x), ev.start)), ev) : voices[0];
    if (!v) {
      if (voices.length < MAX_VOICES) voices.push((v = []));
      else {
        extra.push(ev);
        continue;
      }
    }
    if (last(v) && last(v).end > ev.start) last(v).end = ev.start;
    v.push(ev);
  }
  // A chord cut to nothing is dropped.
  const out = voices.map((v) => legato(v.filter((e) => e.end > e.start))).filter((v) => v.length);
  for (const ev of extra) overlay(out, ev);
  return out;
}

/** A chord no voice is free for joins the voice whose chords fit its rhythm best: split with ties where they do not line up. */
function overlay(voices: Ev[][], ev: Ev): void {
  const mid = (p: number[]) => p.reduce((a, b) => a + b, 0) / p.length;
  let best = voices[0];
  let bestCost = Infinity;
  for (const v of voices) {
    let cost = 0;
    let at = ev.start;
    for (const e of v) {
      if (e.end <= ev.start || e.start >= ev.end) continue;
      if (e.start > at) cost += 0.5; // a gap: a chord of its own there
      if (e.start < ev.start) cost++; // a chord split where this one starts
      if (e.end > ev.end) cost++; // or where it ends
      if (e.start > ev.start) cost++; // this one tied into it
      at = e.end;
    }
    if (at < ev.end) cost += 0.5;
    cost += Math.abs(mid(ev.pitches) - mid(v[Math.max(0, v.findIndex((e) => e.end > ev.start))]?.pitches ?? ev.pitches)) / 100;
    if (cost < bestCost) [best, bestCost] = [v, cost];
  }
  // Split the voice's chords at both ends of this one.
  const add = (list: number[] | undefined, ps: number[]) => [...new Set([...(list ?? []), ...ps])].sort((a, b) => a - b);
  for (const cut of [ev.start, ev.end]) {
    const i = best.findIndex((e) => e.start < cut && e.end > cut);
    if (i < 0) continue;
    const e = best[i];
    best.splice(i, 1, { ...e, end: cut, tieOut: add(undefined, e.pitches) }, { ...e, start: cut, tieIn: add(undefined, e.pitches) });
  }
  // Join the chords inside it, and fill the gaps with chords of its own, tied through.
  const pieces: Ev[] = [];
  let at = ev.start;
  const inside = best.filter((e) => e.start >= ev.start && e.end <= ev.end);
  for (const e of inside) {
    if (e.start > at) pieces.push({ start: at, end: e.start, pitches: ev.pitches });
    e.pitches = add(e.pitches, ev.pitches);
    pieces.push(e);
    at = e.end;
  }
  if (at < ev.end) pieces.push({ start: at, end: ev.end, pitches: ev.pitches });
  for (let i = 0; i + 1 < pieces.length; i++) {
    pieces[i].tieOut = add(pieces[i].tieOut, ev.pitches);
    pieces[i + 1].tieIn = add(pieces[i + 1].tieIn, ev.pitches);
  }
  for (const p of pieces) if (!best.includes(p)) best.push(p);
  best.sort((a, b) => a.start - b.start);
}

/** Notes played detached (most held for at most 3/4 of the time to the next) are written up to the next one; tiny gaps are always closed. */
function legato(v: Ev[]): Ev[] {
  const ratios: number[] = [];
  for (let i = 0; i + 1 < v.length; i++) {
    const ioi = v[i + 1].start - v[i].start;
    if (ioi <= 2 * Q) ratios.push((v[i].end - v[i].start) / ioi);
  }
  ratios.sort((a, b) => a - b);
  const detached = ratios.length >= 4 && ratios[Math.floor(ratios.length / 2)] <= 0.75;
  for (let i = 0; i + 1 < v.length; i++) {
    const next = v[i + 1].start;
    const gap = next - v[i].end;
    // A detached note only grows into a value that starts on its own grid (no syncopation made up).
    const ioi = next - v[i].start;
    if (gap > 0 && (gap <= Q / 8 || (detached && ioi <= 2 * Q && v[i].start % ioi === 0))) v[i].end = next;
  }
  return v;
}

interface Part {
  name: string;
  program: number;
  drums: boolean;
  staves: { clef: [string, number, number]; voices: Ev[][] }[];
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** A MIDI file as MusicXML text. */
export function midiToMusicXml(bytes: Uint8Array): string {
  const smf = parseSmf(bytes);
  const toSteps = (tick: number) => snap((tick / smf.ppq) * Q);
  // Bars: from the time signatures, in steps.
  const times = smf.times.length ? smf.times : [{ tick: 0, n: 4, d: 4 }];
  const lastTick = smf.notes.reduce((m, n) => Math.max(m, n.end), 0);
  const total = toSteps(lastTick);
  const bars: { start: number; len: number; n: number; d: number }[] = [];
  let at = 0;
  let ti = 0;
  let sig = times[0].tick === 0 ? times[0] : { tick: 0, n: 4, d: 4 };
  while (at < Math.max(total, 1)) {
    while (ti < times.length && toSteps(times[ti].tick) <= at) sig = times[ti++];
    const len = Math.max(Q / 8, Math.round((sig.n * 4 * Q) / sig.d));
    bars.push({ start: at, len, n: sig.n, d: sig.d });
    at += len;
  }
  // Parts: a track and channel each; channel 10 is a drum kit.
  const groups = new Map<string, RawNote[]>();
  for (const n of smf.notes) {
    const k = `${n.track}|${n.channel}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(n);
  }
  const channelsOf = new Map<number, Set<number>>();
  for (const n of smf.notes) channelsOf.set(n.track, (channelsOf.get(n.track) ?? new Set()).add(n.channel));
  type Note = { start: number; end: number; pitch: number };
  const units = [...groups]
    .map(([key, list]) => {
      const [track, channel] = key.split("|").map(Number);
      const drums = channel === 9;
      const program = smf.programs.get(key) ?? 0;
      const known = drums ? INSTRUMENTS.find((i) => i.drums) : INSTRUMENTS.find((i) => i.program === program && !i.drums);
      const named = smf.names.get(track);
      const name = named && !(channelsOf.get(track)!.size > 1) ? named : known ? t(`inst_${known.key}`) : named || `Track ${track + 1}`;
      const plain = (q: number) => snap(q * Q);
      const qz = drums ? { start: plain, end: plain } : beatQuantizer(list.map((n) => n.start / smf.ppq));
      const notes: Note[] = list.map((n) => {
        const start = qz.start(n.start / smf.ppq);
        return { start, end: Math.max(start + Q / 8, qz.end(n.end / smf.ppq)), pitch: n.pitch };
      });
      return { track, channel, drums, program, name, notes, clefs: known?.clefs };
    })
    .sort((a, b) => a.track - b.track || a.channel - b.channel);
  const median = (notes: Note[]) => notes.map((n) => n.pitch).sort((a, b) => a - b)[Math.floor(notes.length / 2)];
  // The instrument's own clef when it has one (guitars read an octave up), else by the notes' range.
  const staff = (notes: Note[], own?: string[]): Part["staves"][number] => {
    const c = own?.length === 1 ? CLEFS[own[0]] : undefined;
    return { clef: c ? [c.sign, c.line, c.octave ?? 0] : median(notes) < 55 ? ["F", 4, 0] : ["G", 2, 0], voices: voicesOf(notes) };
  };
  const parts: Part[] = [];
  for (let u = 0; u < units.length; u++) {
    const { drums, program, name, notes, clefs } = units[u];
    const next = units[u + 1];
    if (drums) {
      // Hands up, feet (bass drum, pedal hi-hat) down; a hit lasts to the next one or the next beat.
      const foot = new Set(DRUM_KIT.filter((d) => !d.up).map((d) => d.pitch));
      const line = (list: Note[]) => {
        const v = voicesOf(list.map((n) => ({ ...n, end: n.start + 1 })))[0] ?? [];
        v.forEach((e, i) => (e.end = Math.min((Math.floor(e.start / Q) + 1) * Q, v[i + 1]?.start ?? Infinity)));
        return v;
      };
      const voices = [line(notes.filter((n) => !foot.has(n.pitch))), line(notes.filter((n) => foot.has(n.pitch)))];
      parts.push({ name, program, drums, staves: [{ clef: ["percussion", 2, 0], voices: voices.filter((v) => v.length) }] });
      continue;
    }
    // Two tracks of the same name and sound in a row (a piano as written by notation programs): one part, two staves.
    if (next && !next.drums && next.name === name && next.program === program && units[u + 2]?.name !== name) {
      const [hi, lo] = median(notes) >= median(next.notes) ? [notes, next.notes] : [next.notes, notes];
      parts.push({ name, program, drums, staves: [staff(hi), staff(lo)] });
      u++;
      continue;
    }
    const pitches = notes.map((n) => n.pitch);
    // A keyboard reaching both clefs: two staves, split at middle C.
    if (program <= 23 && pitches.some((p) => p < 55) && pitches.some((p) => p > 67))
      parts.push({
        name,
        program,
        drums,
        staves: [
          { clef: ["G", 2, 0], voices: voicesOf(notes.filter((n) => n.pitch >= 60)) },
          { clef: ["F", 4, 0], voices: voicesOf(notes.filter((n) => n.pitch < 60)) },
        ],
      });
    else parts.push({ name, program, drums, staves: [staff(notes, clefs)] });
  }
  // Keys and tempos in steps, once: a long file has hundreds of them.
  const keySteps = smf.keys.map((k) => ({ step: toSteps(k.tick), fifths: k.fifths }));
  const keyAt = (step: number) => {
    let f = 0;
    for (const k of keySteps) if (k.step <= step) f = k.fifths;
    else break;
    return f;
  };
  const tempoSteps = smf.tempos.slice(1).map((tm) => ({ step: toSteps(tm.tick), bpm: tm.bpm }));
  let tempoAt = 0;

  const out: string[] = [];
  out.push(`<?xml version="1.0" encoding="UTF-8"?>\n<score-partwise version="4.0">`);
  if (smf.title) out.push(`<work><work-title>${esc(smf.title)}</work-title></work>`);
  out.push("<part-list>");
  parts.forEach((p, i) => {
    const id = `P${i + 1}`;
    out.push(`<score-part id="${id}"><part-name>${esc(p.name)}</part-name>`);
    if (p.drums) {
      const used = new Set(p.staves.flatMap((s) => s.voices.flat().flatMap((e) => e.pitches)));
      for (const d of used) out.push(`<score-instrument id="${id}-I${d + 1}"><instrument-name>${esc(DRUM_KIT.find((k) => k.pitch === d)?.name ?? `Drum ${d}`)}</instrument-name></score-instrument>`);
      for (const d of used) out.push(`<midi-instrument id="${id}-I${d + 1}"><midi-channel>10</midi-channel><midi-unpitched>${d + 1}</midi-unpitched></midi-instrument>`);
    } else out.push(`<score-instrument id="${id}-I1"><instrument-name>${esc(p.name)}</instrument-name></score-instrument><midi-instrument id="${id}-I1"><midi-program>${p.program + 1}</midi-program></midi-instrument>`);
    out.push("</score-part>");
  });
  out.push("</part-list>");
  parts.forEach((p, pi) => {
    out.push(`<part id="P${pi + 1}">`);
    const cursors = new Map<number, number>();
    bars.forEach((bar, b) => {
      out.push(`<measure number="${b + 1}">`);
      const prev = bars[b - 1];
      const fifths = keyAt(bar.start);
      const keyChanged = b === 0 || fifths !== keyAt(prev.start);
      const timeChanged = b === 0 || bar.n !== prev.n || bar.d !== prev.d;
      if (b === 0 || keyChanged || timeChanged) {
        out.push("<attributes>");
        if (b === 0) out.push(`<divisions>${Q}</divisions>`);
        if (keyChanged && !p.drums) out.push(`<key><fifths>${fifths}</fifths></key>`);
        if (timeChanged) out.push(`<time><beats>${bar.n}</beats><beat-type>${bar.d}</beat-type></time>`);
        if (b === 0) {
          if (p.staves.length > 1) out.push(`<staves>${p.staves.length}</staves>`);
          p.staves.forEach((s, k) => out.push(`<clef${p.staves.length > 1 ? ` number="${k + 1}"` : ""}><sign>${s.clef[0]}</sign><line>${s.clef[1]}</line>${s.clef[2] ? `<clef-octave-change>${s.clef[2]}</clef-octave-change>` : ""}</clef>`));
        }
        out.push("</attributes>");
      }
      if (b === 0 && pi === 0 && smf.tempos.length) {
        const bpm = smf.tempos[0].bpm;
        out.push(`<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${bpm}</per-minute></metronome></direction-type><sound tempo="${bpm}"/></direction>`);
      }
      if (pi === 0) {
        if (b === 0) tempoAt = 0;
        while (tempoAt < tempoSteps.length && tempoSteps[tempoAt].step < bar.start) tempoAt++;
        for (let i = tempoAt; i < tempoSteps.length && tempoSteps[i].step < bar.start + bar.len; i++) out.push(`<direction><direction-type><words> </words></direction-type><offset>${tempoSteps[i].step - bar.start}</offset><sound tempo="${tempoSteps[i].bpm}"/></direction>`);
      }
      let first = true;
      p.staves.forEach((staff, k) => {
        const voices = staff.voices.length ? staff.voices : [[]];
        voices.forEach((evs, v) => {
          if (!first) out.push(`<backup><duration>${bar.len}</duration></backup>`);
          first = false;
          // A second voice with nothing in the bar is not written.
          const key = k * 4 + v;
          let i = cursors.get(key) ?? 0;
          while (i < evs.length && evs[i].end <= bar.start) i++;
          cursors.set(key, i);
          const inBar: Ev[] = [];
          for (let j = i; j < evs.length && evs[j].start < bar.start + bar.len; j++) if (evs[j].end > bar.start) inBar.push(evs[j]);
          if (v > 0 && !inBar.length) {
            out.push(`<forward><duration>${bar.len}</duration></forward>`);
            return;
          }
          out.push(barVoice(inBar, bar, { voice: k * 4 + v + 1, staff: p.staves.length > 1 ? k + 1 : 0, drums: p.drums, part: `P${pi + 1}`, fifths, compound: bar.d === 8 && bar.n % 3 === 0, first: v === 0 }));
        });
      });
      out.push("</measure>");
    });
    out.push("</part>");
  });
  out.push("</score-partwise>");
  return out.join("");
}

interface Seg {
  start: number;
  len: number;
  pitches: number[] | null;
  tieIn: boolean;
  tieOut: boolean;
  /** Pitches tied in at the start, or out at the end, when not all are. */
  inP?: number[];
  outP?: number[];
}

/** How a beat is written: straight, or as a tuplet of `actual` notes in the time of `normal`. */
interface BeatKind {
  /** Grid step inside the beat, in steps. */
  step: number;
  actual: number;
  normal: number;
}
const STRAIGHT: BeatKind = { step: Q / 8, actual: 1, normal: 1 };
const KINDS: BeatKind[] = [STRAIGHT, { step: Q / 12, actual: 3, normal: 2 }, { step: Q / 10, actual: 5, normal: 4 }];

/** One voice of one bar: notes and rests, cut at tuplet beats, in notatable pieces. */
function barVoice(evs: Ev[], bar: { start: number; len: number }, o: { voice: number; staff: number; drums: boolean; part: string; fifths: number; compound: boolean; first: boolean }): string {
  const barEnd = bar.start + bar.len;
  const beatOf = (x: number) => bar.start + Math.floor((x - bar.start) / Q) * Q;
  // Each beat written the way most of its times fit: straight, triplets (or sextuplets), quintuplets.
  const kinds = new Map<number, BeatKind>();
  for (let b = bar.start; b + Q <= barEnd; b += Q) {
    const marks: number[] = [];
    for (const e of evs) {
      if (e.start > b && e.start < b + Q) marks.push(e.start - b);
      if (e.end > b && e.end < b + Q) marks.push(e.end - b);
    }
    if (!marks.length) continue;
    let best = STRAIGHT;
    let fit = -1;
    for (const k of KINDS) {
      const n = marks.filter((x) => x % k.step === 0).length;
      if (n > fit) [best, fit] = [k, n];
    }
    if (best === STRAIGHT) continue;
    // Six to a beat when the triplet is mostly sixteenths, not eighths.
    const starts = new Set(evs.filter((e) => e.start > b && e.start < b + Q).map((e) => e.start)).size;
    kinds.set(b, best.actual === 3 && starts >= 4 && marks.some((x) => x % (Q / 3) !== 0) ? { step: best.step, actual: 6, normal: 4 } : best);
  }
  const kindOf = (b: number) => kinds.get(b) ?? STRAIGHT;
  // Every time onto its beat's grid.
  const fix = (x: number) => {
    if (x <= bar.start) return bar.start;
    if (x >= barEnd) return barEnd;
    const b = beatOf(x);
    const g = kindOf(b).step;
    return Math.min(barEnd, b + Math.round((x - b) / g) * g);
  };
  const segs: Seg[] = [];
  let at = bar.start;
  for (const e of evs) {
    const s = Math.max(fix(e.start), at);
    const en = fix(e.end);
    if (en <= s) continue;
    if (s > at) segs.push({ start: at, len: s - at, pitches: null, tieIn: false, tieOut: false });
    segs.push({ start: s, len: en - s, pitches: e.pitches, tieIn: e.start < bar.start, tieOut: e.end > barEnd, inP: e.tieIn, outP: e.tieOut });
    at = en;
  }
  if (at < barEnd) segs.push({ start: at, len: barEnd - at, pitches: null, tieIn: false, tieOut: false });
  // Cut at beats written as tuplets, and at beats a note crosses off the beat.
  const cut: Seg[] = [];
  for (const s of segs) {
    let cur = { ...s };
    for (let b = bar.start; b < barEnd; b += Q) {
      const inside = b > cur.start && b < cur.start + cur.len;
      if (!inside) continue;
      const needs = kinds.has(b) || kinds.has(b - Q) || (cur.pitches && (cur.start - bar.start) % Q !== 0);
      if (!needs) continue;
      const head = { ...cur, len: b - cur.start, tieOut: !!cur.pitches, outP: undefined };
      cut.push(head);
      cur = { ...cur, start: b, len: cur.start + cur.len - b, tieIn: !!cur.pitches, inP: undefined };
    }
    cut.push(cur);
  }
  const items: Item[] = [];
  for (const s of cut) {
    const k = s.len < Q ? kindOf(beatOf(s.start)) : STRAIGHT;
    const tup = k.actual > 1 ? k : null;
    // A whole-bar rest.
    if (!s.pitches && s.start === bar.start && s.len === bar.len && o.first) {
      items.push({ pitches: null, at: s.start, duration: s.len, type: null, dots: 0, tieIn: false, tieOut: false, tuplet: null });
      continue;
    }
    // In a tuplet beat, each length is written as actual:normal of a plain value.
    const unit = tup ? (s.len * tup.actual) / tup.normal : s.len;
    const pieces = s.pitches ? pieceValues(Math.round(unit)) : restPieces(s.start - bar.start, Math.round(unit), !!tup);
    let pos = s.start - beatOf(s.start);
    pieces.forEach((w, i) => {
      const dur = tup ? (w.divs * tup.normal) / tup.actual : w.divs;
      const tuplet = tup ? { kind: tup, type: pos === 0 ? "start" : pos + dur >= Q ? "stop" : "in" } : null;
      items.push({ pitches: s.pitches, at: beatOf(s.start) + pos, duration: dur, type: w.type, dots: w.dots, tieIn: (i > 0 || s.tieIn) && !!s.pitches, tieOut: (i < pieces.length - 1 || s.tieOut) && !!s.pitches, inP: i === 0 ? s.inP : undefined, outP: i === pieces.length - 1 ? s.outP : undefined, tuplet });
      pos += dur;
    });
  }
  // Beams: eighths and shorter in a row within a beat (three eighths in compound time).
  const beat = o.compound ? Q * 1.5 : Q;
  const beamable = (it: Item) => it.pitches && it.type && ["eighth", "16th", "32nd", "64th"].includes(it.type);
  for (let i = 0; i < items.length; ) {
    const group = Math.floor((items[i].at - bar.start) / beat);
    let j = i;
    while (j < items.length && beamable(items[j]) && Math.floor((items[j].at - bar.start) / beat) === group) j++;
    if (j - i >= 2) for (let k = i; k < j; k++) items[k].beam = k === i ? "begin" : k === j - 1 ? "end" : "continue";
    i = Math.max(j, i + 1);
  }
  return items.map((it) => noteXml(it, o)).join("");
}

interface Item {
  pitches: number[] | null;
  at: number;
  duration: number;
  type: string | null;
  dots: number;
  tieIn: boolean;
  tieOut: boolean;
  inP?: number[];
  outP?: number[];
  tuplet: { kind: BeatKind; type: string } | null;
  beam?: string;
}

// Written values for a length, worked out once per length: a long file asks thousands of times.
const pieceCache = new Map<number, ReturnType<typeof splitLength>>();
function pieceValues(len: number): ReturnType<typeof splitLength> {
  let v = pieceCache.get(len);
  if (!v) pieceCache.set(len, (v = splitLength(len, Q)));
  return v;
}

/** Rests: plain values, each starting on a multiple of its length. */
function restPieces(pos: number, len: number, tri: boolean): { type: string; dots: number; divs: number }[] {
  const out: { type: string; dots: number; divs: number }[] = [];
  const vals = [Q * 4, Q * 2, Q, Q / 2, Q / 4, Q / 8].map((d) => writtenFor(d, Q)!).filter(Boolean);
  let at = tri ? 0 : pos;
  let left = len;
  while (left > 0) {
    const v = vals.find((x) => x.divs <= left && (tri || at % x.divs === 0)) ?? vals.find((x) => x.divs <= left);
    if (!v) break;
    out.push(v);
    left -= v.divs;
    at += v.divs;
  }
  return out;
}

function noteXml(w: Item, o: { voice: number; staff: number; drums: boolean; part: string; fifths: number }): string {
  const { tuplet } = w;
  const list = w.pitches ?? [null];
  return list
    .map((p, i) => {
      const tieIn = w.tieIn || (p !== null && !!w.inP?.includes(p));
      const tieOut = w.tieOut || (p !== null && !!w.outP?.includes(p));
      const parts: string[] = ["<note>"];
      if (i > 0) parts.push("<chord/>");
      if (p === null) parts.push(w.type ? "<rest/>" : '<rest measure="yes"/>');
      else if (o.drums) {
        const kit = DRUM_KIT.find((k) => k.pitch === p);
        const at = 5 * 7 + 3 - (kit?.line ?? 3);
        parts.push(`<unpitched><display-step>${"CDEFGAB"[((at % 7) + 7) % 7]}</display-step><display-octave>${Math.floor(at / 7)}</display-octave></unpitched>`);
      } else {
        const s = spellMidi(p, o.fifths);
        parts.push(`<pitch><step>${s.step}</step>${s.alter ? `<alter>${s.alter}</alter>` : ""}<octave>${s.octave}</octave></pitch>`);
      }
      parts.push(`<duration>${w.duration}</duration>`);
      if (tieIn) parts.push('<tie type="stop"/>');
      if (tieOut) parts.push('<tie type="start"/>');
      if (p !== null && o.drums) parts.push(`<instrument id="${o.part}-I${p + 1}"/>`);
      parts.push(`<voice>${o.voice}</voice>`);
      if (w.type) parts.push(`<type>${w.type}</type>`);
      for (let d = 0; d < w.dots; d++) parts.push("<dot/>");
      if (tuplet) parts.push(`<time-modification><actual-notes>${tuplet.kind.actual}</actual-notes><normal-notes>${tuplet.kind.normal}</normal-notes></time-modification>`);
      if (p !== null && o.drums) {
        const head = DRUM_KIT.find((k) => k.pitch === p)?.head;
        const xml = ({ cross: "x", diamond: "diamond", "circle-x": "circle-x", triangle: "triangle" } as Record<string, string>)[head ?? ""];
        if (xml) parts.push(`<notehead>${xml}</notehead>`);
      }
      if (o.staff) parts.push(`<staff>${o.staff}</staff>`);
      if (w.beam && i === 0) parts.push(`<beam number="1">${w.beam}</beam>`);
      const nots: string[] = [];
      if (tieIn) nots.push('<tied type="stop"/>');
      if (tieOut) nots.push('<tied type="start"/>');
      if (i === 0 && (tuplet?.type === "start" || tuplet?.type === "stop")) nots.push(`<tuplet type="${tuplet.type}"/>`);
      if (nots.length) parts.push(`<notations>${nots.join("")}</notations>`);
      parts.push("</note>");
      return parts.join("");
    })
    .join("");
}
