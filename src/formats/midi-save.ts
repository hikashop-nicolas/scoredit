import { midiOf, readPitch } from "../edit/notes";
import type { ScoreDoc } from "../model/score";
import { kid, kids, text } from "../model/xml";
import type { Dropped } from "./mscx-write";
import type { MidiEvent, MidiLink } from "./midi";

// Writing an edited score back into the MIDI file it was read from. A MIDI file is a performance,
// so the file stays the source: at load the score's sounding notes are taken as a reference and
// each played note is tied to the written note it became. A save diffs the edited score against
// that reference (bars mapped through measures inserted or deleted) and touches only the note
// on/off events of written notes that changed (pitch, length, place, deleted; added ones get the
// velocity of the nearest played note), and tempo, time and key events that changed. Every other
// event, track and byte stays as it was: an unedited score saves to the very same bytes.

/** A sounding note of a score: tied notes as one, positions in quarters. */
export interface Sounding {
  part: number;
  staff: number;
  pitch: number;
  start: number;
  dur: number;
}

interface Mark {
  pos: number;
  value: number;
  /** Key: mode (1 minor), when the score says. */
  mode?: number;
  /** Time: beats and beat type. */
  n?: number;
  d?: number;
}

interface Snapshot {
  notes: Sounding[];
  /** Start of each measure in quarters, and the end of the last. */
  bars: number[];
  tempos: Mark[];
  times: Mark[];
  keys: Mark[];
  marks: Map<string, number>;
  programs: number[];
  names: string[];
}

const R = (q: number) => Math.round(q * 1e4);

/** The sounding notes, bars, tempo/time/key changes and other marks of a score. */
function snapshot(score: ScoreDoc): Snapshot {
  const marks = new Map<string, number>();
  const count = (k: string) => marks.set(k, (marks.get(k) ?? 0) + 1);
  // Bars: the longest voice of any part in each measure.
  const n = score.measureCount;
  const lens = new Array<number>(n).fill(0);
  const divAt = (p: number, m: number) => Number(text(score.attributesAt(p, m).find((e) => e.tagName === "divisions"))) || 1;
  score.measures.forEach((ms, p) =>
    ms.forEach((meas, m) => {
      let div = divAt(p, m);
      let pos = 0;
      let max = 0;
      for (const c of kids(meas)) {
        if (c.tagName === "attributes") div = Number(text(c, "divisions")) || div;
        const dur = (Number(text(c, "duration")) || 0) / div;
        if (c.tagName === "backup") pos -= dur;
        else if (c.tagName === "forward") pos += dur;
        else if (c.tagName === "note" && !kid(c, "chord") && !kid(c, "grace") && !kid(c, "cue")) pos += dur;
        max = Math.max(max, pos);
      }
      if (!max) {
        const t = [...score.attributesAt(p, m), ...kids(meas, "attributes").flatMap((a) => kids(a, "time"))].filter((e) => e.tagName === "time").pop();
        if (t) max = (text(t, "beats").split("+").reduce((s, x) => s + (Number(x) || 0), 0) * 4) / (Number(text(t, "beat-type")) || 4);
      }
      lens[m] = Math.max(lens[m], max);
    }),
  );
  const bars = [0];
  for (const l of lens) bars.push(bars[bars.length - 1] + l);

  const notes: Sounding[] = [];
  const tempos: Mark[] = [];
  const times: Mark[] = [];
  const keys: Mark[] = [];
  const keyPart = score.parts.findIndex((p) => p.program !== 128);
  score.measures.forEach((ms, p) => {
    const instruments = drumKeys(score, p);
    const open = new Map<number, Sounding[]>();
    let lastTime = "";
    let lastKey = "";
    ms.forEach((meas, m) => {
      let div = divAt(p, m);
      let shift = 0;
      const tr = score.attributesAt(p, m).find((e) => e.tagName === "transpose");
      if (tr) shift = (Number(text(tr, "chromatic")) || 0) + 12 * (Number(text(tr, "octave-change")) || 0);
      const at = bars[m];
      let pos = 0;
      let chordAt = 0;
      const sigs = (attrs: Element) => {
        const t = kid(attrs, "time");
        if (t && p === 0) {
          const nn = text(t, "beats").split("+").reduce((s, x) => s + (Number(x) || 0), 0);
          const d = Number(text(t, "beat-type"));
          if (`${nn}/${d}` !== lastTime) times.push({ pos: at + pos, value: nn * 1000 + d, n: nn, d });
          lastTime = `${nn}/${d}`;
        }
        const k = kid(attrs, "key");
        if (k && kid(k, "fifths") && p === keyPart) {
          const f = Number(text(k, "fifths"));
          if (String(f) !== lastKey) keys.push({ pos: at + pos, value: f, mode: text(k, "mode") === "minor" ? 1 : text(k, "mode") === "major" ? 0 : undefined });
          lastKey = String(f);
        }
        const t2 = kid(attrs, "transpose");
        if (t2) shift = (Number(text(t2, "chromatic")) || 0) + 12 * (Number(text(t2, "octave-change")) || 0);
      };
      for (const c of kids(meas)) {
        if (c.tagName === "attributes") {
          div = Number(text(c, "divisions")) || div;
          sigs(c);
          continue;
        }
        const dur = (Number(text(c, "duration")) || 0) / div;
        if (c.tagName === "backup") pos -= dur;
        else if (c.tagName === "forward") pos += dur;
        else if (c.tagName === "direction" || c.tagName === "sound") {
          const snd = c.tagName === "sound" ? c : kid(c, "sound");
          const bpm = Number(snd?.getAttribute("tempo"));
          const off = (Number(text(c, "offset")) || 0) / div;
          if (bpm > 0) tempos.push({ pos: at + pos + off, value: Math.round(bpm * 1000) / 1000 });
          else for (const dt of kids(c, "direction-type")) for (const x of kids(dt)) if (x.tagName !== "words" || text(x)) count(x.tagName);
        } else if (c.tagName === "harmony") count("harmony");
        else if (c.tagName === "note") {
          if (kid(c, "grace")) {
            count("grace");
            continue;
          }
          if (kid(c, "cue")) continue;
          const start = kid(c, "chord") ? chordAt : pos;
          if (!kid(c, "chord")) {
            chordAt = pos;
            pos += dur;
          }
          if (kid(c, "rest")) continue;
          for (const nots of kids(c, "notations"))
            for (const x of kids(nots)) {
              if (x.tagName === "articulations" || x.tagName === "ornaments" || x.tagName === "technical") for (const y of kids(x)) count(y.tagName);
              else if (x.tagName === "slur" || x.tagName === "glissando" || x.tagName === "slide") {
                if (x.getAttribute("type") === "start") count(x.tagName);
              } else if (x.tagName !== "tied" && x.tagName !== "tuplet") count(x.tagName);
            }
          for (let i = kids(c, "lyric").length; i > 0; i--) count("lyric");
          const pitch = soundingPitch(c, instruments, shift);
          if (pitch === null) {
            count("note");
            continue;
          }
          const ties = kids(c, "tie").map((t) => t.getAttribute("type"));
          const s = at + start;
          const staff = Number(text(c, "staff")) || 1;
          const list = open.get(pitch) ?? [];
          const prev = ties.includes("stop") ? list.find((x) => Math.abs(x.start + x.dur - s) < 1e-6) : undefined;
          let note = prev;
          if (prev) {
            prev.dur = s + dur - prev.start;
            list.splice(list.indexOf(prev), 1);
          } else notes.push((note = { part: p, staff, pitch, start: s, dur }));
          if (ties.includes("start")) open.set(pitch, [...list, note!]);
          else open.set(pitch, list);
        }
      }
    });
  });
  // One tempo at a place, whichever parts mark it.
  const seen = new Set<string>();
  const tempoList = tempos.filter((t) => !seen.has(`${R(t.pos)}|${t.value}`) && !!seen.add(`${R(t.pos)}|${t.value}`)).sort((a, b) => a.pos - b.pos);
  return { notes, bars, tempos: tempoList, times, keys, marks, programs: score.parts.map((p) => p.program ?? 0), names: score.parts.map((p) => p.name) };
}

/** Instrument ids of a drum part and the MIDI keys they play. */
function drumKeys(score: ScoreDoc, p: number): Map<string, number> {
  const out = new Map<string, number>();
  const list = kid(score.root, "part-list");
  const sp = list ? kids(list, "score-part").find((e) => e.getAttribute("id") === score.parts[p]?.id) : undefined;
  for (const mi of sp ? kids(sp, "midi-instrument") : []) {
    const k = Number(text(mi, "midi-unpitched"));
    if (k > 0) out.set(mi.getAttribute("id") ?? "", k - 1);
  }
  return out;
}

function soundingPitch(note: Element, drums: Map<string, number>, shift: number): number | null {
  const p = readPitch(note);
  if (!p) return null;
  if (!p.unpitched) return midiOf(p) + shift;
  const id = p.instrument ?? "";
  const k = drums.get(id) ?? Number(/-I(\d+)$/.exec(id)?.[1] ?? 0) - 1;
  return k >= 0 && k < 128 ? k : null;
}

/** Old quarters to new, through the measures inserted, deleted or replaced since the read. */
function timeMap(before: number[], after: number[], origins: number[] | null): (q: number) => number {
  const nOld = before.length - 1;
  const nNew = after.length - 1;
  const orig = origins ?? Array.from({ length: nNew }, (_, i) => (i < nOld ? i : -1));
  // [old start, old end, new start, new end]: kept measures move whole, the rest between two
  // kept ones maps from its start and is cut at the end of what replaced it.
  const segs: [number, number, number, number][] = [];
  let prevO = -1;
  let runFrom = 0;
  const gap = (nextO: number, m: number) => segs.push([before[prevO + 1], before[nextO], after[runFrom], after[m]]);
  for (let m = 0; m <= nNew; m++) {
    const o = m < nNew ? orig[m] : nOld;
    if (o < 0) continue;
    gap(o, m);
    if (m < nNew) segs.push([before[o], before[o + 1], after[m], after[m + 1]]);
    prevO = o;
    runFrom = m + 1;
  }
  return (q: number) => {
    for (const [a, b, c, d] of segs) if (q >= a - 1e-9 && q < b - 1e-9) return Math.min(c + (q - a), d);
    // Past the last measure: with it.
    return q + (after[nNew] - before[nOld]);
  };
}

/** What a MIDI file needs to take the score's edits: call at load, before any edit. */
export function midiSaver(bytes: Uint8Array, score: ScoreDoc, link: MidiLink): () => { bytes: Uint8Array; dropped: Dropped } {
  const original = bytes.slice();
  const ref = snapshot(score);
  // Each played note to the written note it became: same part and pitch, its start inside it.
  const byPitch = new Map<string, Sounding[]>();
  for (const w of ref.notes) (byPitch.get(`${w.part}|${w.pitch}`) ?? byPitch.set(`${w.part}|${w.pitch}`, []).get(`${w.part}|${w.pitch}`)!).push(w);
  const played = new Map<Sounding, MidiLink["notes"][number]["raw"][]>();
  for (const { raw, part, start } of link.notes) {
    let best: Sounding | undefined;
    for (const w of byPitch.get(`${part}|${raw.pitch}`) ?? [])
      if (start >= w.start - 1e-6 && start < w.start + w.dur - 1e-6 && (!best || Math.abs(w.start - start) < Math.abs(best.start - start))) best = w;
    if (best) (played.get(best) ?? played.set(best, []).get(best)!).push(raw);
  }
  return () => writeBack(original, score, link, ref, played);
}

interface Edit {
  tick?: number;
  bytes?: Uint8Array;
  deleted?: boolean;
}

function writeBack(original: Uint8Array, score: ScoreDoc, link: MidiLink, ref: Snapshot, played: Map<Sounding, MidiLink["notes"][number]["raw"][]>): { bytes: Uint8Array; dropped: Dropped } {
  const file = link.file;
  const ppq = file.ppq;
  const now = snapshot(score);
  const dropped: Dropped = {};
  const drop = (k: string, n = 1) => (dropped[k] = (dropped[k] ?? 0) + n);
  for (const [k, c] of now.marks) if (c > (ref.marks.get(k) ?? 0)) drop(k, c - (ref.marks.get(k) ?? 0));

  const trackOf = new Map<MidiEvent, number>();
  file.chunks.forEach((ch, t) => ch.events?.forEach((ev) => trackOf.set(ev, t)));
  const edits = new Map<MidiEvent, Edit>();
  const inserted: { track: number; tick: number; group: number; bytes: Uint8Array }[] = [];
  const edit = (ev: MidiEvent, e: Edit) => edits.set(ev, { ...edits.get(ev), ...e });

  const map = timeMap(ref.bars, now.bars, score.origins);
  const toTick = (q: number) => Math.max(0, Math.round(q * ppq));
  // Offset in ticks the measure under a place moved by.
  const shiftAt = (q: number) => toTick(map(q)) - toTick(q);

  // Events not tied to a written note move with the measure they are in.
  const linked = new Set<MidiEvent>();
  for (const raws of played.values()) for (const r of raws) linked.add(r.on).add(r.off);
  const metaLinked = new Set<MidiEvent>();

  // ---- Tempo, time and key changes.
  const metaEvents = (type: number) => file.chunks.flatMap((ch) => (ch.events ?? []).filter((e) => e.status === 0xff && e.type === type)).sort((a, b) => a.tick - b.tick);
  const conductor = (type: number) => {
    const e = metaEvents(type)[0];
    return e ? trackOf.get(e)! : Math.max(0, file.chunks.findIndex((c) => c.events));
  };
  const linkMarks = (marks: Mark[], evs: MidiEvent[], value: (e: MidiEvent) => number) => {
    const out = new Map<Mark, MidiEvent>();
    let i = 0;
    for (const mk of marks) {
      for (let j = i; j < evs.length; j++)
        if (value(evs[j]) === mk.value) {
          out.set(mk, evs[j]);
          i = j + 1;
          break;
        }
    }
    return out;
  };
  const tempoOf = (e: MidiEvent) => (e.data!.length >= 3 ? Math.round(60000000 / ((e.data![0] << 16) | (e.data![1] << 8) | e.data![2])) : -1);
  const timeOf = (e: MidiEvent) => (e.data!.length >= 2 ? e.data![0] * 1000 + 2 ** e.data![1] : -1);
  const keyOf = (e: MidiEvent) => (e.data!.length >= 1 ? (e.data![0] << 24) >> 24 : -99);
  const meta = (type: number, data: number[]) => new Uint8Array([0xff, type, data.length, ...data]);
  const diffMarks = (type: number, refMarks: Mark[], nowMarks: Mark[], value: (e: MidiEvent) => number, data: (mk: Mark, old?: MidiEvent) => number[] | null) => {
    const evs = metaEvents(type);
    const links = linkMarks(refMarks, evs, value);
    for (const e of links.values()) metaLinked.add(e);
    const left = new Map<string, Mark[]>();
    const keyOfMark = (pos: number, v: number) => `${R(pos)}|${v}`;
    for (const mk of refMarks) {
      const k = keyOfMark(map(mk.pos), mk.value);
      (left.get(k) ?? left.set(k, []).get(k)!).push(mk);
    }
    const added: Mark[] = [];
    for (const mk of nowMarks) {
      const list = left.get(keyOfMark(mk.pos, mk.value));
      const old = list?.shift();
      if (old) {
        const e = links.get(old);
        if (e && shiftAt(old.pos)) edit(e, { tick: e.tick + shiftAt(old.pos) });
      } else added.push(mk);
    }
    const removed = [...left.values()].flat();
    for (const mk of added) {
      // A change at the place of one removed: that event takes the new value, at its own tick.
      const i = removed.findIndex((r) => R(map(r.pos)) === R(mk.pos) && links.has(r));
      const old = i >= 0 ? links.get(removed.splice(i, 1)[0]) : undefined;
      const d = data(mk, old);
      if (!d) {
        drop(type === 0x58 ? "time" : type === 0x59 ? "key" : "tempo");
        continue;
      }
      if (old) edit(old, { bytes: meta(type, d), tick: old.tick + shiftAt(old.tick / ppq) });
      else inserted.push({ track: conductor(type), tick: toTick(mk.pos), group: 0, bytes: meta(type, d) });
    }
    for (const r of removed) {
      const e = links.get(r);
      if (e) edit(e, { deleted: true });
    }
  };
  diffMarks(0x51, ref.tempos, now.tempos, tempoOf, (mk) => {
    const us = Math.min(0xffffff, Math.max(1, Math.round(60000000 / mk.value)));
    return [(us >> 16) & 0xff, (us >> 8) & 0xff, us & 0xff];
  });
  diffMarks(0x58, ref.times, now.times, timeOf, (mk, old) => {
    const d = Math.log2(mk.d!);
    if (!Number.isInteger(d) || mk.n! < 1 || mk.n! > 255) return null;
    const like = old ?? metaEvents(0x58)[0];
    return [mk.n!, d, like?.data?.[2] ?? 24, like?.data?.[3] ?? 8];
  });
  diffMarks(0x59, ref.keys, now.keys, keyOf, (mk, old) => [mk.value & 0xff, mk.mode ?? old?.data?.[1] ?? metaEvents(0x59)[0]?.data?.[1] ?? 0]);

  // ---- Parts: the edited score's parts against the read ones.
  const origin = (p: number) => (score.partOrigins ? score.partOrigins[p] : p);
  const nowOf = new Map<number, number>();
  now.programs.forEach((_, p) => {
    const o = origin(p);
    if (o >= 0 && o < link.parts.length) nowOf.set(o, p);
  });
  const unitsOfTrack = (t: number) => link.parts.flatMap((lp) => lp.units).filter((u) => u.track === t).length;
  now.programs.forEach((prog, p) => {
    const o = origin(p);
    if (o < 0 || o >= link.parts.length) {
      if (now.notes.some((n) => n.part === p)) drop("part");
      return;
    }
    const lp = link.parts[o];
    if (prog !== ref.programs[o]) {
      if (prog === 128 || ref.programs[o] === 128) drop("instrument");
      else
        for (const u of lp.units) {
          const pc = file.chunks[u.track].events?.find((e) => e.status === (0xc0 | u.channel));
          if (pc) edit(pc, { bytes: new Uint8Array([pc.status, prog & 0x7f]) });
          else inserted.push({ track: u.track, tick: 0, group: 0, bytes: new Uint8Array([0xc0 | u.channel, prog & 0x7f]) });
        }
    }
    if (now.names[p] !== ref.names[o]) {
      if (lp.units.length !== 1 || unitsOfTrack(lp.units[0].track) !== 1) drop("name");
      else {
        const t = lp.units[0].track;
        const nm = file.chunks[t].events?.find((e) => e.status === 0xff && e.type === 0x03);
        const utf = new TextEncoder().encode(now.names[p]);
        const vl = vlq(utf.length);
        const b = new Uint8Array([0xff, 0x03, ...vl, ...utf]);
        if (nm) edit(nm, { bytes: b });
        else inserted.push({ track: t, tick: 0, group: 0, bytes: b });
      }
    }
  });

  // ---- Notes.
  const rawOn = new Map<string, MidiEvent[]>();
  for (const { raw, part } of link.notes) (rawOn.get(String(part)) ?? rawOn.set(String(part), []).get(String(part))!).push(raw.on);
  const offStyle = new Map<string, boolean>();
  for (const { raw } of link.notes) if (!offStyle.has(`${raw.track}|${raw.channel}`)) offStyle.set(`${raw.track}|${raw.channel}`, (raw.off.status & 0xf0) === 0x90);

  for (let o = 0; o < link.parts.length; o++) {
    const p = nowOf.get(o);
    const before = ref.notes.filter((n) => n.part === o).map((n) => ({ w: n, start: map(n.start) }));
    const after = p === undefined ? [] : now.notes.filter((n) => n.part === p);
    const keyOfNote = (pitch: number, start: number, dur: number) => `${pitch}|${R(start)}|${R(dur)}`;
    const left = new Map<string, typeof before>();
    for (const b of before) {
      const k = keyOfNote(b.w.pitch, b.start, b.w.dur);
      (left.get(k) ?? left.set(k, []).get(k)!).push(b);
    }
    const added: Sounding[] = [];
    const move = (b: (typeof before)[number], to?: { pitch?: number; start?: number; dur?: number }) => {
      const shift = toTick(b.start) - toTick(b.w.start);
      for (const r of played.get(b.w) ?? []) {
        const on = r.on;
        const off = r.off;
        const delta = to?.start !== undefined ? toTick(to.start) - toTick(b.start) : 0;
        const onTick = on.tick + shift + delta;
        const e: Edit = {};
        if (onTick !== on.tick) e.tick = onTick;
        if (to?.pitch !== undefined && to.pitch !== r.pitch) e.bytes = new Uint8Array([on.bytes[0], to.pitch, on.bytes[2]]);
        if (Object.keys(e).length) edit(on, e);
        const f: Edit = {};
        const offTick = to?.dur !== undefined ? Math.max(onTick + 1, toTick((to.start ?? b.start) + to.dur)) : off.tick + shift + delta;
        if (offTick !== off.tick) f.tick = offTick;
        if (to?.pitch !== undefined && to.pitch !== r.pitch) f.bytes = new Uint8Array([off.bytes[0], to.pitch, off.bytes[2]]);
        if (Object.keys(f).length) edit(off, f);
      }
    };
    for (const a of after) {
      const b = left.get(keyOfNote(a.pitch, a.start, a.dur))?.shift();
      if (b) move(b);
      else added.push(a);
    }
    const removed = [...left.values()].flat().filter((b) => played.has(b.w));
    // Changed notes: the removed note each added one most likely is.
    const pairs: [(a: Sounding, b: (typeof before)[number]) => boolean, (a: Sounding, b: (typeof before)[number]) => number, (a: Sounding) => { pitch?: number; start?: number; dur?: number }][] = [
      [(a, b) => R(a.start) === R(b.start) && a.pitch === b.w.pitch, (a, b) => Math.abs(a.dur - b.w.dur), (a) => ({ dur: a.dur })],
      [(a, b) => R(a.start) === R(b.start) && R(a.dur) === R(b.w.dur), (a, b) => Math.abs(a.pitch - b.w.pitch), (a) => ({ pitch: a.pitch })],
      [(a, b) => a.pitch === b.w.pitch && R(a.dur) === R(b.w.dur), (a, b) => Math.abs(a.start - b.start), (a) => ({ start: a.start })],
      [(a, b) => R(a.start) === R(b.start), (a, b) => Math.abs(a.pitch - b.w.pitch), (a) => ({ pitch: a.pitch, dur: a.dur })],
    ];
    for (const [fits, cost, change] of pairs) {
      for (let i = 0; i < added.length; i++) {
        const a = added[i];
        let best = -1;
        removed.forEach((b, j) => {
          if (fits(a, b) && (best < 0 || cost(a, b) < cost(a, removed[best]))) best = j;
        });
        if (best < 0) continue;
        move(removed.splice(best, 1)[0], change(a));
        added.splice(i--, 1);
      }
    }
    for (const b of removed)
      for (const r of played.get(b.w) ?? []) {
        edit(r.on, { deleted: true });
        edit(r.off, { deleted: true });
      }
    if (p === undefined) continue;
    const units = link.parts[o].units;
    for (const a of added) {
      const u = units.find((x) => x.staff === a.staff) ?? units[0];
      if (!u) {
        drop("note");
        continue;
      }
      const on = toTick(a.start);
      const off = Math.max(on + 1, toTick(a.start + a.dur));
      // As loud as the nearest note played in the part.
      let vel = 80;
      let dist = Infinity;
      for (const e of rawOn.get(String(o)) ?? []) {
        const d = Math.abs(e.tick - on);
        if (d < dist) [dist, vel] = [d, e.bytes[2]];
      }
      inserted.push({ track: u.track, tick: on, group: 2, bytes: new Uint8Array([0x90 | u.channel, a.pitch, vel]) });
      inserted.push({ track: u.track, tick: off, group: 0, bytes: offStyle.get(`${u.track}|${u.channel}`) ? new Uint8Array([0x90 | u.channel, a.pitch, 0]) : new Uint8Array([0x80 | u.channel, a.pitch, 0]) });
    }
  }

  // Everything else moves with the measure it is in, when measures moved.
  if (score.origins) {
    for (const ch of file.chunks)
      for (const ev of ch.events ?? []) {
        if (linked.has(ev) || metaLinked.has(ev) || edits.get(ev)?.tick !== undefined) continue;
        const s = shiftAt(ev.tick / ppq);
        if (s) edit(ev, { tick: ev.tick + s });
      }
  }

  // ---- Writing: tracks with no change are copied as they were.
  const touched = new Set<number>();
  for (const ev of edits.keys()) touched.add(trackOf.get(ev)!);
  for (const ins of inserted) touched.add(ins.track);
  if (!touched.size) return { bytes: original.slice(), dropped };
  const out: Uint8Array[] = [file.head];
  file.chunks.forEach((ch, t) => {
    if (!touched.has(t) || !ch.events) {
      out.push(ch.raw);
      return;
    }
    out.push(writeTrack(ch.events, ch.eot, ch.tail, edits, inserted.filter((x) => x.track === t), score.origins ? shiftAt : null, ppq));
  });
  out.push(file.trailing);
  const size = out.reduce((s, b) => s + b.length, 0);
  const res = new Uint8Array(size);
  let at = 0;
  for (const b of out) {
    res.set(b, at);
    at += b.length;
  }
  return { bytes: res, dropped };
}

const vlq = (n: number): number[] => {
  const out = [n & 0x7f];
  while ((n >>>= 7)) out.unshift((n & 0x7f) | 0x80);
  return out;
};

/** A track chunk with its events edited, deleted and added; the file's running status kept where it still applies. */
function writeTrack(events: MidiEvent[], eot: number, tail: Uint8Array, edits: Map<MidiEvent, Edit>, inserted: { tick: number; group: number; bytes: Uint8Array }[], shiftAt: ((q: number) => number) | null, ppq: number): Uint8Array {
  type Item = { tick: number; group: number; seq: number; bytes: Uint8Array; running: boolean };
  const isOff = (b: Uint8Array) => (b[0] & 0xf0) === 0x80 || ((b[0] & 0xf0) === 0x90 && b[2] === 0);
  const items: Item[] = [];
  events.forEach((ev, i) => {
    const e = edits.get(ev);
    if (e?.deleted) return;
    const bytes = e?.bytes ?? ev.bytes;
    // A moved event goes before (a note off) or after (a note on) what is at its new tick.
    const moved = e?.tick !== undefined && e.tick !== ev.tick;
    const group = !moved ? 1 : isOff(bytes) ? 0 : (bytes[0] & 0xf0) === 0x90 ? 2 : 1;
    items.push({ tick: e?.tick ?? ev.tick, group, seq: i, bytes, running: ev.running && bytes[0] === ev.bytes[0] });
  });
  inserted.forEach((x, i) => items.push({ tick: x.tick, group: x.group, seq: events.length + i, bytes: x.bytes, running: false }));
  items.sort((a, b) => a.tick - b.tick || a.group - b.group || a.seq - b.seq);
  const body: number[] = [];
  let at = 0;
  let status = 0;
  for (const it of items) {
    body.push(...vlq(it.tick - at));
    at = it.tick;
    const s = it.bytes[0];
    if (s >= 0xf0) {
      for (const b of it.bytes) body.push(b);
      status = 0;
      continue;
    }
    for (let i = it.running && s === status ? 1 : 0; i < it.bytes.length; i++) body.push(it.bytes[i]);
    status = s;
  }
  if (eot >= 0) {
    const end = Math.max(at, eot + (shiftAt ? shiftAt(eot / ppq) : 0));
    body.push(...vlq(end - at), 0xff, 0x2f, 0);
  }
  for (const b of tail) body.push(b);
  const n = body.length;
  const out = new Uint8Array(8 + n);
  out.set([0x4d, 0x54, 0x72, 0x6b, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
  out.set(body, 8);
  return out;
}

/** A score's sounding notes (tied notes as one, positions in quarters), as a save compares them. */
export function soundingNotes(score: ScoreDoc): Sounding[] {
  return snapshot(score).notes;
}
