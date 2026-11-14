// From a page's symbols and lines to systems of measures holding chords and rests, with
// pitches, durations and voices. Font-agnostic: it only sees SMuFL code points.
import { beamY, braceGroups, type Beam, findBarlines, findBeams, findStaves, findSystems, horizontals, mergeVerticals, verticals, type HLine, type Staff, type VLine } from "./geometry";
import type { PdfShape } from "./extract";
import { asciiChord, CHORD_TEXT } from "./chords";
import type { MusicSymbol, NormPage, TextRun } from "./normalize";
import { ACCIDENTALS, OTTAVAS, AUGMENTATION_DOT, CLEFS, DYNAMICS, HEAD_LENGTH, REPEAT_DOT, RESTS, REST_WHOLE, TIME_COMMON, TIME_CUT, flag, headKind, timeDigit, tupletDigit, type HeadKind } from "./glyphs";

export interface Head {
  x: number;
  y: number;
  w: number;
  kind: HeadKind;
  staff: number;
  grace: boolean;
  /** Steps (half spaces) below the top line. */
  pos: number;
  /** Accidental shown before it. */
  acc?: number;
  /** Semitones an octave line moves it. */
  shift?: number;
  tieStart?: boolean;
  tieStop?: boolean;
}

export interface Clef {
  sign: string;
  line: number;
  octave: number;
  /** Diatonic index (C4 = 28) of the top line. */
  top: number;
}

export interface PNote {
  step: string;
  octave: number;
  alter: number;
  shown?: number;
  tieStart?: boolean;
  tieStop?: boolean;
  pos: number;
  tab?: { string: number; fret: number };
}

export interface Lyric {
  verse: number;
  text: string;
  syllabic: "single" | "begin" | "middle" | "end";
}

export interface PEvent {
  rest: boolean;
  x: number;
  x1: number;
  /** Vertical centre (rests) or highest head. */
  y: number;
  staff: number;
  /** Quarter length written (notehead and beams) before dots and tuplets. */
  base: number;
  dots: number;
  tuplet?: { actual: number; normal: number };
  grace: boolean;
  up?: boolean;
  heads: Head[];
  notes: PNote[];
  measureRest: boolean;
  voice: number;
  onset: number;
  lyrics: Lyric[];
  /** Tablature: string (1 = top line) and fret of each note. */
  tab?: { string: number; fret: number }[];
  /** The chord of the staff of notes this tablature chord doubles. */
  link?: PEvent;
  /** Tablature without rhythm: the length is a guess. */
  guess?: boolean;
}

export const length = (e: PEvent) => (e.base * (2 - 1 / 2 ** e.dots) * (e.tuplet ? e.tuplet.normal / e.tuplet.actual : 1));

export interface PAttr {
  x: number;
  clef?: Clef;
  key?: number;
  time?: { beats: number; type: number; symbol?: "common" | "cut" };
}

export interface PDirection {
  x: number;
  staff: number;
  dynamics?: string;
  words?: string;
  /** A chord symbol, as ASCII chord text. */
  harmony?: string;
  /** A metronome mark: the beat's quarter length (dots included) and beats per minute. */
  metronome?: { unit: number; dots: number; perMinute: number };
  above: boolean;
  onset?: number;
}

export interface PMeasure {
  x0: number;
  x1: number;
  /** Per staff of the system. */
  events: PEvent[][];
  attrs: PAttr[][];
  dirs: PDirection[];
  /** Barline at the right end: its lines, and repeat dots. */
  right?: { kinds: ("thin" | "thick")[]; repeat: boolean };
  leftRepeat?: boolean;
  /** Volta bracket: its number on the first measure, how it ends on the last. */
  ending?: { number: string; start: boolean; end?: "stop" | "discontinue" };
}

export interface PSystem {
  staves: Staff[];
  measures: PMeasure[];
  /** Staves tied by a brace (one instrument): index ranges into the system. */
  groups: [number, number][];
  /** Text left of each staff (instrument names), by staff index. */
  names: string[];
  /** Whether barlines join staff k to staff k + 1. */
  barLinks: boolean[];
  top: number;
  bottom: number;
  x0: number;
}

export interface PageResult {
  systems: PSystem[];
  /** Text above the first system (title, composer...). */
  header: TextRun[];
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

/** Distance from y to a staff (0 inside it). */
const staffDist = (s: Staff, y: number) => Math.max(0, s.top - y, y - s.bottom);

export function readPage(page: NormPage): PageResult {
  const hl = horizontals(page.segments);
  const vRaw = verticals(page.segments);
  const vl = mergeVerticals(vRaw);
  const allStaves = findStaves(hl);
  const staves = allStaves.filter((s) => s.lines === 5 || s.lines === 6);
  if (!staves.some((s) => s.lines === 5 || s.lines === 6)) return { systems: [], header: page.texts };
  const sysIdx = findSystems(staves, vl, page.symbols);
  const sp = median(staves.filter((s) => s.lines === 5).map((s) => s.space)) || median(staves.map((s) => s.space));
  const beams = findBeams(page.shapes, page.segments, sp);

  // Which system and staff a point belongs to.
  // Music symbols go to staves of notes; tablature only takes rests and flags.
  const sysOf = (x: number, y: number, cp = 0): [number, number] | null => {
    let best: [number, number] | null = null;
    let bd = Infinity;
    const tabOk = RESTS[cp] !== undefined || flag(cp) !== null || cp === AUGMENTATION_DOT;
    sysIdx.forEach((idx, si) =>
      idx.forEach((i, k) => {
        const s = staves[i];
        if (x < s.x0 - 6 * s.space || x > s.x1 + s.space || (s.lines !== 5 && !tabOk)) return;
        const d = staffDist(s, y);
        if (d < bd) {
          bd = d;
          best = [si, k];
        }
      }),
    );
    return best;
  };

  const systems: PSystem[] = sysIdx.map((idx) => {
    const ss = idx.map((i) => staves[i]);
    return { staves: ss, measures: [], groups: braceGroups(staves, idx, page.symbols), names: ss.map(() => ""), barLinks: [], top: ss[0].top, bottom: ss[ss.length - 1].bottom, x0: Math.min(...ss.map((s) => s.x0)) };
  });

  // Symbols per system and staff.
  const placed: Placed[] = [];
  for (const s of page.symbols) {
    const at = sysOf(s.x, s.y, s.cp);
    if (!at) continue;
    const st = systems[at[0]].staves[at[1]];
    if (staffDist(st, s.y) > 10 * st.space) continue;
    placed.push({ ...s, sys: at[0], staff: at[1] });
  }
  const staffOf = (p: Placed) => systems[p.sys].staves[p.staff];
  const tempos = metronomes(page.texts, placed, staffOf, sp);
  const inTempo = new Set(tempos.flatMap((t) => t.used));
  for (let i = placed.length - 1; i >= 0; i--) if (inTempo.has(placed[i])) placed.splice(i, 1);

  // Noteheads.
  const heads: (Head & { sys: number; size: number })[] = [];
  for (const p of placed) {
    const kind = headKind(p.cp);
    if (!kind) continue;
    // A note far from its staff has ledger lines leading to it: between two staves, follow them.
    if (staffDist(staffOf(p), p.y) > staffOf(p).space * 1.2) {
      const sys = systems[p.sys];
      const w = p.w || sp;
      const ledgerTo = (k: number) => {
        const st = sys.staves[k];
        if (!st || st.lines !== 5) return false;
        const y = p.y < st.top ? st.top - st.space : st.bottom + st.space;
        return hl.some((l) => Math.abs(l.y - y) < st.space * 0.15 && l.x1 - l.x0 < st.space * 4 && l.x0 < p.x + w && l.x1 > p.x);
      };
      const other = p.y < staffOf(p).top ? p.staff - 1 : p.staff + 1;
      if (!ledgerTo(p.staff) && ledgerTo(other)) p.staff = other;
    }
    const st = staffOf(p);
    heads.push({ x: p.x, y: p.y, w: p.w || st.space * 1.18, kind, staff: p.staff, sys: p.sys, grace: p.size < st.space * 4 * 0.85, pos: Math.round((p.y - st.top) / (st.space / 2)), size: p.size });
  }

  // Stems: thin verticals with a notehead at one end.
  const attached = (v: VLine, h: Head, space: number) => {
    const tx = space * 0.3;
    const xOk = Math.abs(v.x - h.x) < tx || Math.abs(v.x - (h.x + h.w)) < tx;
    return xOk && h.y >= v.y0 - space * 0.6 && h.y <= v.y1 + space * 0.6;
  };
  const headsNear = (v: VLine) => heads.filter((h) => Math.abs(v.x - h.x) < h.w + sp && h.y > v.y0 - 2 * sp && h.y < v.y1 + 2 * sp);
  const stemOf = new Map<Head, VLine>();
  const stems: { v: VLine; heads: Head[]; up: boolean; sys: number; staff: number }[] = [];
  for (const v of vRaw) {
    if (v.width > sp * 0.3 || v.y1 - v.y0 < sp * 0.9) continue;
    const near = headsNear(v);
    const hs = near.filter((h) => attached(v, h, staves[0] ? systems[(h as { sys: number }).sys].staves[h.staff].space : sp));
    if (!hs.length) continue;
    const st = systems[(hs[0] as { sys: number }).sys].staves[hs[0].staff];
    const top = Math.min(...hs.map((h) => h.y));
    const bot = Math.max(...hs.map((h) => h.y));
    const dTop = Math.abs(top - v.y0);
    const dBot = Math.abs(bot - v.y1);
    if (Math.min(dTop, dBot) > st.space * 0.75) continue;
    stems.push({ v, heads: hs, up: dBot < dTop, sys: (hs[0] as { sys: number }).sys, staff: hs[0].staff });
  }
  // A head goes with its nearest stem.
  for (const s of stems)
    for (const h of s.heads) {
      const cur = stemOf.get(h);
      const d = (v: VLine) => Math.min(Math.abs(v.x - h.x), Math.abs(v.x - h.x - h.w));
      if (!cur || d(s.v) < d(cur)) stemOf.set(h, s.v);
    }
  // Two voices on one note draw the head twice: one for each stem.
  for (const s of stems)
    for (const h of s.heads) {
      if (stemOf.get(h) === s.v) continue;
      const twin = heads.find((o) => o !== h && Math.abs(o.x - h.x) < 0.1 && Math.abs(o.y - h.y) < 0.1 && stemOf.get(o) === stemOf.get(h));
      if (twin && !s.heads.some((o) => o !== h && o !== twin && stemOf.get(o) === s.v && Math.abs(o.y - h.y) < 0.1)) stemOf.set(h, s.v);
    }
  const isStemLine = (l: VLine) => heads.some((h) => attached(l, h, sp) && (Math.abs(h.y - l.y0) < sp * 0.75 || Math.abs(h.y - l.y1) < sp * 0.75));

  // Flags and beams on a stem's free end.
  const flags = placed.filter((p) => flag(p.cp));
  const beamCount = (v: VLine, up: boolean, space: number) => {
    const end = up ? v.y0 : v.y1;
    let n = 0;
    for (const b of beams) {
      if (v.x < b.x0 - space * 0.2 || v.x > b.x1 + space * 0.2) continue;
      // A short stroke across the middle of the stem is a tremolo, not a beam.
      if (b.x1 - b.x0 < space * 2.2 && Math.abs((b.x0 + b.x1) / 2 - v.x) < space * 0.3) continue;
      const y = beamY(b, v.x);
      if (Math.abs(y - end) > space * 4.2) continue;
      if (up ? y >= v.y0 - b.thick && y <= v.y1 - space * 0.8 : y <= v.y1 + b.thick && y >= v.y0 + space * 0.8) n++;
    }
    return n;
  };

  // Chords: heads of one stem, or stemless heads on one x.
  const events: (PEvent & { sys: number; stemLine?: VLine })[] = [];
  const byStem = new Map<VLine, (typeof heads)[number][]>();
  const loose: (typeof heads)[number][] = [];
  for (const h of heads) {
    const v = stemOf.get(h);
    if (v) byStem.set(v, [...(byStem.get(v) ?? []), h]);
    else loose.push(h);
  }
  for (const [v, hs] of byStem) {
    const st = systems[hs[0].sys].staves[hs[0].staff];
    const s = stems.find((q) => q.v === v)!;
    const up = s.up;
    const end = up ? v.y0 : v.y1;
    const fl = flags.filter((f) => f.sys === hs[0].sys && Math.abs(f.x - v.x) < st.space * 0.7 && Math.abs(f.y - end) < st.space * 1.2);
    const nFlags = Math.max(0, ...fl.map((f) => flag(f.cp)!.n));
    const kind = hs.some((h) => h.kind === "black") ? "black" : hs[0].kind;
    const nBeams = nFlags ? 0 : beamCount(v, up, st.space);
    // Beamed half notes are a two-note tremolo: each lasts half of what it shows.
    const base = kind === "black" ? HEAD_LENGTH.black / 2 ** (nFlags + nBeams) : HEAD_LENGTH[kind] / (nBeams ? 2 : 1);
    events.push(chord(hs, base, up, hs[0].sys, v));
  }
  loose.sort((a, b) => a.sys - b.sys || a.staff - b.staff || a.x - b.x);
  for (let i = 0; i < loose.length; ) {
    const st = systems[loose[i].sys].staves[loose[i].staff];
    let j = i + 1;
    while (j < loose.length && loose[j].sys === loose[i].sys && loose[j].staff === loose[i].staff && Math.abs(loose[j].x - loose[i].x) < st.space * 0.5) j++;
    const hs = loose.slice(i, j);
    events.push(chord(hs, HEAD_LENGTH[hs[0].kind], undefined, hs[0].sys));
    i = j;
  }
  function chord(hs: (typeof heads)[number][], base: number, up: boolean | undefined, sys: number, stemLine?: VLine): PEvent & { sys: number; stemLine?: VLine } {
    return {
      rest: false,
      x: Math.min(...hs.map((h) => h.x)),
      x1: Math.max(...hs.map((h) => h.x + h.w)),
      y: Math.min(...hs.map((h) => h.y)),
      staff: hs[0].staff,
      base,
      dots: 0,
      grace: hs.every((h) => h.grace),
      up,
      heads: [...hs].sort((a, b) => b.y - a.y),
      notes: [],
      measureRest: false,
      voice: 1,
      onset: 0,
      lyrics: [],
      sys,
      stemLine,
    };
  }

  // Two stems drawn for one chord (a wide chord, or one split by a gap): one chord.
  events.sort((a, b) => a.sys - b.sys || a.staff - b.staff || a.x - b.x);
  for (let i = events.length - 1; i > 0; i--) {
    const a = events[i - 1];
    const b = events[i];
    if (a.sys !== b.sys || a.staff !== b.staff || a.up === undefined || a.up !== b.up || a.base !== b.base || a.grace !== b.grace) continue;
    if (Math.abs(a.x - b.x) > sp * 0.3 || !a.stemLine || !b.stemLine || Math.abs(a.stemLine.x - b.stemLine.x) > sp * 0.2) continue;
    a.heads = [...a.heads, ...b.heads].sort((p, q) => q.y - p.y);
    a.y = Math.min(a.y, b.y);
    a.x1 = Math.max(a.x1, b.x1);
    events.splice(i, 1);
  }

  // Rests.
  for (const p of placed) {
    const len = RESTS[p.cp];
    if (len === undefined) continue;
    const st = staffOf(p);
    if (p.size < st.space * 4 * 0.85) continue;
    // Vertical centre: whole rests hang from their line, half rests sit on it.
    const y = p.cp === REST_WHOLE ? p.y + st.space * 0.25 : p.cp === 0xe4e4 ? p.y - st.space * 0.25 : p.y;
    events.push({ rest: true, x: p.x, x1: p.x + (p.w || st.space), y, staff: p.staff, base: len, dots: 0, grace: false, heads: [], notes: [], measureRest: false, voice: 1, onset: 0, lyrics: [], sys: p.sys });
  }

  // Augmentation dots go to the nearest chord or rest on their left.
  for (const p of placed) {
    if (p.cp !== AUGMENTATION_DOT) continue;
    const st = staffOf(p);
    let best: PEvent | null = null;
    for (const e of events) {
      if (e.sys !== p.sys || e.staff !== p.staff || e.grace || e.x1 > p.x + st.space * 0.2 || p.x - e.x1 > st.space * 3.2) continue;
      const vOk = e.rest ? Math.abs(p.y - e.y) < st.space * 1.6 : e.heads.some((h) => Math.abs(h.y - p.y) <= st.space * 0.75);
      if (vOk && (!best || e.x1 > best.x1)) best = e;
    }
    if (best) ((best as PEvent & { dotXs?: number[] }).dotXs ??= []).push(p.x);
  }
  for (const e of events) {
    const xs = ((e as PEvent & { dotXs?: number[] }).dotXs ?? []).sort((a, b) => a - b);
    let n = 0;
    let last = -Infinity;
    for (const x of xs) if (x - last > sp * 0.25) (n++, (last = x));
    e.dots = Math.min(n, 3);
  }

  tablature(page, systems, sysIdx.length, vRaw, beams, placed, events);
  ties(page.shapes, heads, systems);

  // Per system: barlines, measures, then what each measure holds.
  systems.forEach((sys, si) => {
    const idx = sysIdx[si];
    const bars = findBarlines(staves, idx, vl, isStemLine);
    const space = median(sys.staves.map((s) => s.space));
    // Staves whose barlines run on into the next staff (one instrument, or a section).
    sys.barLinks = sys.staves.map((_, k) => bars.some((b) => b.x0 > sys.x0 + space && b.staves.includes(k) && b.staves.includes(k + 1)));
    const need = Math.ceil(sys.staves.length / 2);
    const bl = bars.filter((b) => b.staves.length >= need || b.staves.length >= 1);
    const sx0 = sys.x0;
    const sx1 = Math.max(...sys.staves.map((s) => s.x1));
    const dots = placed.filter((p) => p.sys === si && p.cp === REPEAT_DOT);
    const raw: PMeasure[] = [];
    let start = sx0;
    let leftRepeat = false;
    for (const b of bl) {
      const rep = (side: number) => dots.some((d) => (side < 0 ? d.x < b.x0 && d.x > b.x0 - space * 1.6 : d.x > b.x1 && d.x < b.x1 + space * 1.2));
      if (b.x0 - start > space * 0.5) raw.push(newMeasure(start, b.x0, sys.staves.length, leftRepeat, { kinds: b.kinds, repeat: rep(-1) }));
      else if (raw.length) raw[raw.length - 1].right = { kinds: b.kinds, repeat: rep(-1) };
      leftRepeat = rep(1);
      start = b.x1;
    }
    if (sx1 - start > space * 2) raw.push(newMeasure(start, sx1, sys.staves.length, leftRepeat));
    const at = (x: number) => raw.findIndex((m) => x >= m.x0 - space * 0.2 && x < m.x1 + space * 0.2);
    for (const e of events) {
      if (e.sys !== si) continue;
      const m = at((e.x + e.x1) / 2);
      if (m >= 0) raw[m].events[e.staff].push(e);
    }
    // Clefs, key and time signatures.
    const syms = placed.filter((p) => p.sys === si);
    sys.staves.forEach((st, k) => {
      const mine = syms.filter((p) => p.staff === k);
      for (const p of mine) {
        const c = CLEFS[p.cp];
        if (!c) continue;
        const lineFromBottom = (st.bottom - p.y) / st.space + 1;
        const line = Math.round(lineFromBottom);
        const ref = c.sign === "percussion" ? 34 : c.ref;
        const yRef = c.sign === "percussion" ? (st.top + st.bottom) / 2 : p.y;
        const top = ref + Math.round((yRef - st.top) / (st.space / 2));
        const m = at(p.x);
        if (m >= 0) raw[m].attrs[k].push({ x: p.x, clef: { sign: c.sign, line: c.sign === "percussion" ? 2 : line, octave: c.octave, top } });
      }
      // Time signatures: digits above and below the middle line, stacked.
      const digits = mine.filter((p) => timeDigit(p.cp) >= 0 && p.size >= st.space * 4 * 0.85 && p.y > st.top - st.space && p.y < st.bottom + st.space * 1.5).sort((a, b) => a.x - b.x);
      const used = new Set<MusicSymbol>();
      for (const d of digits) {
        if (used.has(d)) continue;
        const group = digits.filter((q) => !used.has(q) && Math.abs(q.x - d.x) < st.space * 2.5);
        group.forEach((q) => used.add(q));
        const mid = (st.top + st.bottom) / 2;
        const num = Number(group.filter((q) => q.y < mid + 0.1).map((q) => timeDigit(q.cp)).join(""));
        const den = Number(group.filter((q) => q.y >= mid + 0.1).map((q) => timeDigit(q.cp)).join(""));
        const m = at(d.x);
        if (num && den && m >= 0) raw[m].attrs[k].push({ x: d.x, time: { beats: num, type: den } });
      }
      for (const p of mine) {
        if (p.cp !== TIME_COMMON && p.cp !== TIME_CUT) continue;
        const m = at(p.x);
        if (m >= 0) raw[m].attrs[k].push({ x: p.x, time: p.cp === TIME_COMMON ? { beats: 4, type: 4, symbol: "common" } : { beats: 2, type: 2, symbol: "cut" } });
      }
    });
    // A time signature after the notes of a measure starts the next one (its barline is not drawn).
    for (let i = 0; i < raw.length; i++) {
      const m = raw[i];
      const firsts = m.events.map((evs) => (evs.length ? Math.min(...evs.map((e) => e.x1)) : Infinity));
      const xs = m.attrs.flatMap((as, k) => as.filter((a) => a.time && a.x > firsts[k] + space * 0.5).map((a) => a.x));
      if (!xs.length) continue;
      const cut = Math.min(...xs) - space * 0.3;
      if (cut <= m.x0 + space || !m.events.some((evs) => evs.some((e) => (e.x + e.x1) / 2 < cut))) continue;
      const right = newMeasure(cut, m.x1, sys.staves.length, false, m.right);
      m.x1 = cut;
      m.right = undefined;
      m.events.forEach((evs, k) => {
        right.events[k] = evs.filter((e) => (e.x + e.x1) / 2 >= cut);
        m.events[k] = evs.filter((e) => (e.x + e.x1) / 2 < cut);
      });
      m.attrs.forEach((as, k) => {
        right.attrs[k] = as.filter((a) => a.x >= cut);
        m.attrs[k] = as.filter((a) => a.x < cut);
      });
      raw.splice(i + 1, 0, right);
    }
    // Accidentals: a key signature, or the accidental of the note on their right.
    sys.staves.forEach((st, k) => {
      const accs = syms.filter((p) => p.staff === k && ACCIDENTALS[p.cp] !== undefined && p.size >= st.space * 4 * 0.85).sort((a, b) => a.x - b.x);
      const hs = heads.filter((h) => h.sys === si && h.staff === k && !h.grace);
      const takeAcc = (a: MusicSymbol) => {
        let best: Head | null = null;
        for (const h of hs) if (Math.abs(h.y - a.y) < st.space * 0.3 && h.x > a.x && h.x - a.x < st.space * 6 && (!best || h.x < best.x)) best = h;
        if (best && best.acc === undefined) best.acc = ACCIDENTALS[a.cp];
      };
      // Accidentals in each measure before its first chord or rest.
      for (const m of raw) {
        const evs = m.events[k];
        const first = evs.length ? Math.min(...evs.map((e) => e.x)) : m.x1;
        const lead = accs.filter((a) => a.x >= m.x0 - space && a.x < first);
        const clef = raw.flatMap((q) => q.attrs[k]).filter((a) => a.clef && (!lead.length || a.x < lead[0].x)).sort((a, b) => a.x - b.x).pop()?.clef;
        const key = keySignature(lead, st, clef?.top ?? 38, hs);
        if (key) m.attrs[k].push(key.attr);
        for (const a of accs) if (a.x >= m.x0 - space && a.x < m.x1 + space * 0.2 && !key?.used.has(a)) takeAcc(a);
      }
    });
    // Measures with nothing to play (a clef and key before a start repeat) give what they hold to the next.
    const kept: PMeasure[] = [];
    let carry: PMeasure | null = null;
    for (const m of raw) {
      const empty = m.events.every((e) => e.length === 0);
      if (empty && m !== raw[raw.length - 1]) {
        carry = carry ? mergeAttrs(carry, m) : m;
        if (m.leftRepeat || m.right?.repeat) carry.leftRepeat ||= m.leftRepeat;
        continue;
      }
      if (empty && m === raw[raw.length - 1]) {
        // Courtesy signatures at the end of the system: carried to the next system.
        if (kept.length) (kept[kept.length - 1] as PMeasure & { courtesy?: PMeasure }).courtesy = m;
        continue;
      }
      if (carry) {
        m.attrs = m.attrs.map((a, i) => [...carry!.attrs[i], ...a]);
        m.leftRepeat ||= carry.leftRepeat;
        carry = null;
      }
      kept.push(m);
    }
    sys.measures = kept;
    for (const m of kept) for (const evs of m.events) evs.sort((a, b) => a.x - b.x);
    // Dynamics: below (or above) a staff, at the x of a chord.
    for (const p of syms) {
      const d = DYNAMICS[p.cp];
      if (!d) continue;
      const m = kept.find((q) => p.x >= q.x0 - space && p.x < q.x1);
      if (m) m.dirs.push({ x: p.x, staff: p.staff, dynamics: d, above: p.y < sys.staves[p.staff].top });
    }
    for (const t of tempos) {
      if (t.sys !== si) continue;
      const m = kept.find((q) => t.x >= q.x0 - space && t.x < q.x1) ?? (t.x < kept[0]?.x0 ? kept[0] : undefined);
      if (m) m.dirs.push({ x: t.x, staff: t.staff, metronome: t.mark, above: true });
    }
    // Dynamics written as two glyphs (p p) are one mark.
    for (const m of kept) {
      m.dirs.sort((a, b) => a.staff - b.staff || a.x - b.x);
      for (let i = m.dirs.length - 1; i > 0; i--) {
        const a = m.dirs[i - 1];
        const b = m.dirs[i];
        if (a.dynamics && b.dynamics && a.staff === b.staff && b.x - a.x < space * 1.6) {
          a.dynamics += b.dynamics;
          m.dirs.splice(i, 1);
        }
      }
    }
  });

  // Octave lines: from the 8 (or 15) to the end of the line after it, dashed or not.
  for (const p of placed) {
    const shift = OTTAVAS[p.cp];
    if (!shift) continue;
    const st = staffOf(p);
    const sign = p.cp === 0xe510 || p.cp === 0xe514 ? (p.y < st.top ? 1 : -1) : Math.sign(shift);
    let end = p.x + (p.w || st.space) + st.space;
    const pieces = hl.filter((l) => Math.abs(l.y - (p.y - p.size * 0.15)) < st.space * 1.5 && l.x0 >= p.x && l.width < st.space * 0.3).sort((a, b) => a.x0 - b.x0);
    for (const l of pieces) if (l.x0 <= end + st.space * 3) end = Math.max(end, l.x1);
    for (const h of heads) if (h.sys === p.sys && h.staff === p.staff && h.x >= p.x - st.space && h.x <= end + st.space * 0.5) h.shift = sign * Math.abs(shift);
  }

  plainChords(page, systems, sp);
  // Text: names left of the systems, lyrics under staves, the header above the first system.
  const header: TextRun[] = [];
  const firstTop = systems[0].top - 4 * sp;
  for (const t of page.texts) {
    if (t.y < firstTop && t.kind !== "chord") {
      header.push(t);
      continue;
    }
    const si = systems.findIndex((s) => t.y > s.top - 6 * sp && t.y < s.bottom + 8 * sp);
    if (si < 0) continue;
    const sys = systems[si];
    if (t.x + 0.3 * t.size * t.str.length < sys.x0 - sp && !/^\d+$/.test(t.str)) {
      // Name of the staff whose middle is nearest; between two joined staves, the upper one.
      let best = 0;
      let bd = Infinity;
      sys.staves.forEach((s, k) => {
        const joined = sys.groups.some(([a, b]) => k >= a && k < b) || sys.barLinks[k];
        const mid = joined && k + 1 < sys.staves.length ? (s.top + sys.staves[k + 1].bottom) / 2 : (s.top + s.bottom) / 2;
        const d = Math.abs(mid - t.y) - (joined ? sp * 0.1 : 0);
        if (d < bd) {
          bd = d;
          best = k;
        }
      });
      sys.names[best] = sys.names[best] ? `${sys.names[best]} ${t.str}` : t.str;
    }
  }
  for (const sys of systems) for (const m of sys.measures) m.events.forEach((evs, k) => assignVoices(evs, sys.staves[k]));
  voltas(page, systems, sp);
  words(page, systems, sp);

  // Staves joined by barlines are one instrument when only the first is named.
  for (const sys of systems) {
    for (let k = 0; k + 1 < sys.staves.length; ) {
      if (!sys.barLinks[k] || sys.groups.some(([a, b]) => k >= a && k <= b) || sys.names[k + 1] || !sys.names[k]) {
        k++;
        continue;
      }
      let e = k + 1;
      while (sys.barLinks[e] && e + 1 < sys.staves.length && !sys.names[e + 1] && !sys.groups.some(([a]) => a === e + 1)) e++;
      sys.groups.push([k, e]);
      k = e + 1;
    }
    sys.groups.sort((a, b) => a[0] - b[0]);
  }
  lyricsOf(page, systems, sp);
  tuplets(page, systems);
  for (const sys of systems)
    for (const m of sys.measures)
      for (const e of m.events.flat()) if (e.link) Object.assign(e, { base: e.link.base, dots: e.link.dots, tuplet: e.link.tuplet, voice: e.link.voice });
  return { systems, header };

  function newMeasure(x0: number, x1: number, n: number, leftRepeat: boolean, right?: PMeasure["right"]): PMeasure {
    return { x0, x1, events: Array.from({ length: n }, () => []), attrs: Array.from({ length: n }, () => []), dirs: [], right, leftRepeat };
  }
}

type Placed = MusicSymbol & { sys: number; staff: number };

/** Metronome marks: a note outside the staff (and its flag and dots) right before "= 100". */
function metronomes(texts: TextRun[], placed: Placed[], staffOf: (p: Placed) => Staff, sp: number) {
  const out: { x: number; sys: number; staff: number; mark: NonNullable<PDirection["metronome"]>; used: Placed[] }[] = [];
  for (const t of texts) {
    const m = /^=\s*(?:c\.\s*|ca\.\s*)?(\d{2,3})(?!\d)/.exec(t.str);
    if (!m) continue;
    const mid = t.y - t.size * 0.3;
    const head = placed
      .filter((q) => headKind(q.cp) && q.x < t.x && t.x - (q.x + (q.w || sp)) < 3 * sp && Math.abs(q.y - mid) < 1.5 * sp && staffDist(staffOf(q), q.y) > sp * 0.5)
      .sort((a, b) => b.x - a.x)[0];
    if (!head) continue;
    const w = head.w || sp;
    const fl = placed.filter((q) => q.sys === head.sys && flag(q.cp) && q.x > head.x - sp && q.x < head.x + w + sp && Math.abs(q.y - head.y) < 4 * sp);
    const dots = placed.filter((q) => q.cp === AUGMENTATION_DOT && q.x > head.x + w * 0.8 && q.x < t.x && Math.abs(q.y - head.y) < sp);
    const n = Math.max(0, ...fl.map((q) => flag(q.cp)!.n));
    const unit = HEAD_LENGTH[headKind(head.cp)!] / 2 ** n;
    out.push({ x: head.x, sys: head.sys, staff: head.staff, mark: { unit, dots: dots.length, perMinute: Number(m[1]) }, used: [head, ...fl, ...dots] });
  }
  return out;
}

/** Tablature: fret numbers on the lines; rhythm from stems under the staff, else from the staff of notes above. */
function tablature(page: NormPage, systems: PSystem[], n: number, vRaw: VLine[], beams: Beam[], placed: (MusicSymbol & { sys: number; staff: number })[], events: (PEvent & { sys: number })[]): void {
  for (let si = 0; si < n; si++) {
    const sys = systems[si];
    sys.staves.forEach((st, k) => {
      if (st.lines === 5) return;
      let frets: { x: number; string: number; fret: number; font: string }[] = [];
      for (const t of page.texts)
        for (const w of t.words) {
          const m = /^\(?(\d{1,2})\)?$/.exec(w.str);
          const cy = t.y - t.size * 0.35;
          if (!m || cy < st.top - st.space * 0.5 || cy > st.bottom + st.space * 0.5 || w.x < st.x0 || w.x > st.x1) continue;
          const line = Math.round((cy - st.top) / st.space);
          if (Math.abs(cy - (st.top + line * st.space)) > st.space * 0.3) continue;
          frets.push({ x: (w.x + w.x1) / 2, string: line + 1, fret: Number(m[1]), font: `${t.font} ${Math.round(t.size * 10)}` });
        }
      // Fret numbers share one font; fingerings and string numbers use others.
      const count = new Map<string, number>();
      for (const f of frets) count.set(f.font, (count.get(f.font) ?? 0) + 1);
      const main = [...count].sort((a, b) => b[1] - a[1])[0]?.[0];
      frets = frets.filter((f) => f.font === main);
      frets.sort((a, b) => a.x - b.x);
      const stems = vRaw.filter((v) => v.y0 > st.bottom - st.space * 0.2 && v.y0 < st.bottom + st.space * 3 && v.x > st.x0 && v.x < st.x1);
      const lens = stems.map((v) => v.y1 - v.y0);
      const full = Math.max(0, ...lens);
      const above = k > 0 && sys.staves[k - 1].lines === 5 ? events.filter((e) => e.sys === si && e.staff === k - 1 && !e.rest && !e.grace) : [];
      for (let i = 0; i < frets.length; ) {
        let j = i + 1;
        while (j < frets.length && frets[j].x - frets[i].x < st.space * 0.6) j++;
        const col = frets.slice(i, j);
        i = j;
        const x = col.reduce((a, f) => a + f.x, 0) / col.length;
        const half = st.space * 0.5;
        const e: PEvent & { sys: number } = { rest: false, x: x - half, x1: x + half, y: st.top, staff: k, base: 1, dots: 0, grace: false, heads: [], notes: [], measureRest: false, voice: 1, onset: 0, lyrics: [], sys: si, tab: col.map((f) => ({ string: f.string, fret: f.fret })) };
        const twins = above.filter((a) => Math.abs((a.x + a.x1) / 2 - x) < st.space * 1.2).sort((a, b) => a.y - b.y);
        const stem = stems.find((v) => Math.abs(v.x - x) < st.space * 0.6);
        if (twins.length) {
          // One chord per voice above: higher strings go with the higher chord.
          const byString = [...col].sort((a, b) => a.string - b.string);
          let at = 0;
          twins.forEach((t, i) => {
            const take = i === twins.length - 1 ? byString.slice(at) : byString.slice(at, at + t.heads.length);
            at += take.length;
            if (take.length) events.push({ ...e, tab: take.map((f) => ({ string: f.string, fret: f.fret })), link: t });
          });
          continue;
        } else if (stem) {
          const end = stem.y1;
          const fl = placed.filter((p) => p.sys === si && flag(p.cp) && Math.abs(p.x - stem.x) < st.space * 0.7 && Math.abs(p.y - end) < st.space * 1.2);
          const nf = Math.max(0, ...fl.map((p) => flag(p.cp)!.n));
          const nb = beams.filter((b) => stem.x >= b.x0 - st.space * 0.2 && stem.x <= b.x1 + st.space * 0.2 && Math.abs(beamY(b, stem.x) - end) < st.space * 2.5 && beamY(b, stem.x) > stem.y0).length;
          e.base = stem.y1 - stem.y0 < full * 0.65 && !nf && !nb ? 2 : 1 / 2 ** (nf || nb);
        } else if (stems.length) e.base = 4;
        else e.guess = true;
        events.push(e);
      }
    });
  }
}

/** Ties: flat curves from a notehead to the next one on the same line or space (or off the end of a system). */
function ties(shapes: PdfShape[], heads: (Head & { sys: number })[], systems: PSystem[]): void {
  for (const c of shapes) {
    if (!c.curved) continue;
    const { x0, x1, y0, y1 } = c.box;
    const at = (x: number) => c.points.reduce((best, p) => (Math.abs(p[0] - x) < Math.abs(best[0] - x) ? p : best), c.points[0])[1];
    const ya = at(x0);
    const yb = at(x1);
    const sys = systems.findIndex((s) => y0 > s.top - 8 * s.staves[0].space && y1 < s.bottom + 8 * s.staves[0].space && x1 > s.x0);
    if (sys < 0) continue;
    const sp = systems[sys].staves[0].space;
    if (y1 - y0 > sp * 1.6 || x1 - x0 < sp * 0.8 || Math.abs(ya - yb) > sp * 0.5) continue;
    const near = heads.filter((h) => h.sys === sys && !h.grace);
    const a = near.filter((h) => x0 >= h.x && x0 <= h.x + h.w + sp && Math.abs(h.y - ya) < sp * 1.1).sort((p, q) => q.x - p.x)[0];
    const b = near.filter((h) => x1 >= h.x - sp && x1 <= h.x + h.w && Math.abs(h.y - yb) < sp * 1.1 && (!a || (h.staff === a.staff && h.pos === a.pos && h.x > a.x))).sort((p, q) => p.x - q.x)[0];
    const st = systems[sys].staves;
    if (a && b) {
      a.tieStart = true;
      b.tieStop = true;
    } else if (a && x1 > Math.max(...st.map((s) => s.x1)) - sp * 2) a.tieStart = true;
    else if (b && !a && x0 < b.x - sp * 0.5 && !near.some((h) => h.staff === b.staff && h.x < b.x && h.x > x0 - sp)) b.tieStop = true;
  }
}

const EXPRESSION = /^\(?((cresc|decresc|dim|rit|rall|accel|espr|stacc|smorz|pizz|arco|riten)\.?|dolce|a tempo|legato|marcato|tranquillo|morendo|subito .+|sempre .+|poco .+|molto .+|più .+|meno .+|con sord.*|senza sord.*)\)?$/i;

/** Tempo marks (bold, above a staff) and expression words: directions at the measure under them. */
function words(page: NormPage, systems: PSystem[], sp: number): void {
  for (const t of page.texts) {
    if (t.kind === "chord") {
      chordAt(t, systems, sp);
      continue;
    }
    const bold = t.bold && !/^[\d.,\s]+$/.test(t.str);
    if (!bold && !EXPRESSION.test(t.str)) continue;
    for (const sys of systems) {
      const k = sys.staves.findIndex((st) => (bold ? t.y < st.top && t.y > st.top - 8 * sp : t.y > st.top - 6 * sp && t.y < st.bottom + 6 * sp));
      if (k < 0 || t.x < sys.x0 - sp) continue;
      const m = sys.measures.find((q) => t.x >= q.x0 - sp && t.x < q.x1);
      if (m) m.dirs.push({ x: t.x, staff: k, words: t.str, above: t.y < sys.staves[k].top });
      break;
    }
  }
}

/**
 * Chord names set in a plain text font (LilyPond's ChordNames, some Finale files): words above a
 * staff that all read as chords, at least two in a system, become chord runs.
 */
function plainChords(page: NormPage, systems: PSystem[], sp: number): void {
  const found = new Map<TextRun, { run: TextRun; sys: number }[]>();
  const perSys = new Map<number, number>();
  for (const t of page.texts) {
    if (t.kind || t.bold || !t.words.length) continue;
    const si = systems.findIndex((sys) => t.x >= sys.x0 - sp && sys.staves.some((st) => t.y < st.top + sp * 0.5 && t.y > st.top - 9 * sp));
    if (si < 0) continue;
    const runs: { run: TextRun; sys: number }[] = [];
    for (const w of t.words) {
      const { str } = asciiChord([...w.str.replace(/Ø/g, "ø")].map((c) => ({ text: c, sup: false })));
      if (!CHORD_TEXT.test(str)) break;
      runs.push({ run: { ...t, str, x: w.x, words: [{ str, x: w.x, x1: w.x1 }], kind: "chord", superscript: [] }, sys: si });
    }
    if (runs.length !== t.words.length) continue;
    found.set(t, runs);
    perSys.set(si, (perSys.get(si) ?? 0) + runs.length);
  }
  const keep = [...found].filter(([, runs]) => (perSys.get(runs[0].sys) ?? 0) >= 2);
  if (!keep.length) return;
  const drop = new Set(keep.map(([t]) => t));
  page.texts = [...page.texts.filter((t) => !drop.has(t)), ...keep.flatMap(([, runs]) => runs.map((r) => r.run))];
}

/** A chord symbol: a harmony at the measure of the staff under it (over the top staff when between). */
function chordAt(t: TextRun, systems: PSystem[], sp: number): void {
  for (const sys of systems) {
    const k = sys.staves.findIndex((st) => t.y < st.top + sp && t.y > st.top - 8 * sp);
    if (k < 0 || t.x < sys.x0 - sp) continue;
    const m = sys.measures.find((q) => t.x >= q.x0 - sp && t.x < q.x1);
    if (m) m.dirs.push({ x: t.x, staff: k, harmony: t.str, above: true });
    return;
  }
}

/** Voltas: open brackets over the top staff, numbered at their start ("1.", "2."). */
function voltas(page: NormPage, systems: PSystem[], sp: number): void {
  for (const sh of page.shapes) {
    if (sh.filled || sh.curved || sh.points.length < 3 || sh.points.length > 4) continue;
    const [a, b, c] = sh.points;
    if (Math.abs(a[0] - b[0]) > 0.2 || Math.abs(b[1] - c[1]) > 0.2 || b[1] >= a[1] || c[0] - b[0] < sp * 2) continue;
    const sys = systems.find((s) => b[1] < s.top && b[1] > s.top - 10 * sp && c[0] > s.x0);
    if (!sys) continue;
    const label = page.texts.find((t) => t.x >= b[0] - 0.5 && t.x < b[0] + sp * 3 && t.y > b[1] && t.y < a[1] + sp && /^\d/.test(t.str));
    if (!label) continue;
    const number = label.str.replace(/[.\s]+$/, "").replace(/\.\s*/g, ", ").replace(/,\s*$/, "").replace(/\s+/g, " ");
    const ms = sys.measures.filter((m) => Math.min(m.x1, c[0]) - Math.max(m.x0, b[0]) > sp);
    if (!ms.length) continue;
    ms[0].ending = { number: number.replace(/, /g, ","), start: true };
    const last = ms[ms.length - 1];
    last.ending = { ...(last.ending ?? { number: ms[0].ending.number, start: false }), end: sh.points.length === 4 ? "stop" : "discontinue" };
  }
}

function mergeAttrs(a: PMeasure, b: PMeasure): PMeasure {
  return { ...b, attrs: b.attrs.map((x, i) => [...a.attrs[i], ...x]) };
}

const SHARPS = [3, 0, 4, 1, 5, 2, 6];
const FLATS = [6, 2, 5, 1, 4, 0, 3];

/** The key signature among the accidentals leading a measure: sharps or flats in their order, after any naturals. */
function keySignature(lead: MusicSymbol[], st: Staff, top: number, hs: Head[]): { attr: PAttr; used: Set<MusicSymbol> } | null {
  if (!lead.length) return null;
  const letter = (a: MusicSymbol) => (((top - Math.round((a.y - st.top) / (st.space / 2))) % 7) + 7) % 7;
  let i = 0;
  const used = new Set<MusicSymbol>();
  while (i < lead.length && ACCIDENTALS[lead[i].cp] === 0) used.add(lead[i++]);
  // Cancelling naturals follow the order of the sharps or flats they cancel.
  const nat = lead.slice(0, i).map(letter);
  if (nat.length && !nat.every((l, k) => l === SHARPS[k]) && !nat.every((l, k) => l === FLATS[k])) return null;
  const type = i < lead.length ? ACCIDENTALS[lead[i].cp] : 0;
  const order = type > 0 ? SHARPS : FLATS;
  let n = 0;
  while (i < lead.length && (type === 1 || type === -1) && ACCIDENTALS[lead[i].cp] === type && letter(lead[i]) === order[n] && n < 7) {
    if (n && lead[i].x - lead[i - 1].x > st.space * 2) break;
    used.add(lead[i]);
    i++;
    n++;
  }
  if (!used.size) return null;
  // Accidentals of the first chord are not a key: none may sit right before a notehead on its line,
  // and the run must end with room before what follows.
  const direct = (a: MusicSymbol) => hs.some((h) => Math.abs(h.y - a.y) < st.space * 0.3 && h.x > a.x && h.x - (a.x + a.w) < st.space);
  if ([...used].some(direct)) return null;
  const lastAcc = [...used].sort((a, b) => b.x - a.x)[0];
  const next = [...hs, ...lead.filter((a) => !used.has(a))].filter((h) => h.x > lastAcc.x).sort((a, b) => a.x - b.x)[0];
  if (next && next.x - (lastAcc.x + lastAcc.w) < st.space * 0.4) return null;
  return { attr: { x: lead[0].x, key: type > 0 ? n : -n }, used };
}

/** Voices of one staff in one measure: one, unless two chords or rests stand in one column. */
export function assignVoices(evs: PEvent[], st: Staff): void {
  const col = st.space * 0.6;
  const main = evs.filter((e) => !e.grace);
  const same = (a: PEvent, b: PEvent) => Math.abs(a.x - b.x) < col || (a.x < b.x1 && b.x < a.x1 && (a.rest || b.rest));
  let multi = false;
  for (let i = 0; i < main.length && !multi; i++) for (let j = i + 1; j < main.length && !multi; j++) if (same(main[i], main[j])) multi = true;
  for (const e of evs) e.voice = 1;
  if (!multi) return;
  const mid = (st.top + st.bottom) / 2;
  for (const e of main) {
    if (e.rest) continue;
    if (e.up !== undefined) e.voice = e.up ? 1 : 2;
  }
  for (const e of main) {
    const partner = main.find((o) => o !== e && !o.rest && same(e, o));
    if (!e.rest) {
      if (e.up === undefined && partner) e.voice = partner.up === undefined ? (partner.y < e.y ? 2 : 1) : partner.voice === 1 ? 2 : 1;
      continue;
    }
    if (partner) e.voice = e.y < partner.y ? 1 : 2;
    else e.voice = e.y < mid - st.space * 0.4 ? 1 : e.y > mid + st.space * 0.4 ? 2 : 1;
  }
  // Grace notes follow the voice of the chord after them.
  for (const g of evs.filter((e) => e.grace)) g.voice = main.find((e) => e.x > g.x)?.voice ?? 1;
}

/** Lyrics: rows of text under a staff, each syllable on the chord it is centred under. */
function lyricsOf(page: NormPage, systems: PSystem[], sp: number): void {
  for (const sys of systems) {
    sys.staves.forEach((st, k) => {
      const below = sys.staves[k + 1]?.top ?? sys.bottom + 12 * sp;
      const runs = page.texts.filter((t) => t.y > st.bottom + sp && t.y < below - sp * 0.5 && t.x > sys.x0 && !t.bold);
      if (!runs.length) return;
      const chords = sys.measures.flatMap((m) => m.events[k].filter((e) => !e.rest && !e.grace));
      if (!chords.length) return;
      // Rows by baseline.
      const rows: number[] = [];
      for (const y of [...new Set(runs.map((r) => Math.round(r.y * 2) / 2))].sort((a, b) => a - b)) if (!rows.length || y - rows[rows.length - 1] > sp * 0.8) rows.push(y);
      const hyphens = horizontals(page.segments).filter((l) => l.x1 - l.x0 < sp * 2 && l.y > st.bottom && l.y < below);
      rows.forEach((ry, verse) => {
        const words = runs.filter((r) => Math.abs(r.y - ry) < sp * 0.8).flatMap((r) => r.words.map((w) => ({ ...w, size: r.size })));
        words.sort((a, b) => a.x - b.x);
        let matched = 0;
        const out: { e: PEvent; w: (typeof words)[number] }[] = [];
        for (const w of words) {
          const c = (w.x + w.x1) / 2;
          let best: PEvent | null = null;
          let bd = Infinity;
          for (const e of chords) {
            const d = Math.abs((e.x + e.x1) / 2 - c);
            if (d < bd) {
              bd = d;
              best = e;
            }
          }
          if (best && (bd < sp * 1.5 || (w.x <= best.x1 && w.x1 >= best.x))) {
            out.push({ e: best, w });
            matched++;
          }
        }
        // Rows that do not line up with notes are not lyrics (tempo or expression text).
        if (matched < words.length * 0.6 || words.every((w) => /^(cresc|dim|decresc|rit|rall|accel|poco|molto|sempre|espr|dolce|a tempo)\b/i.test(w.str.replace(/[().]/g, "")))) return;
        out.forEach(({ e, w }, i) => {
          const next = out[i + 1];
          const prev = out[i - 1];
          const dashAfter = !!next && hyphenBetween(hyphens, w.x1, next.w.x, ry, w.size);
          const dashBefore = !!prev && hyphenBetween(hyphens, prev.w.x1, w.x, ry, w.size);
          const text = w.str.replace(/^-|-$/g, "");
          const after = dashAfter || /-$/.test(w.str);
          const before = dashBefore || /^-/.test(w.str) || (!!prev && /-$/.test(prev.w.str));
          e.lyrics.push({ verse: verse + 1, text, syllabic: before ? (after ? "middle" : "end") : after ? "begin" : "single" });
        });
      });
    });
  }
}

function hyphenBetween(lines: HLine[], x0: number, x1: number, y: number, size: number): boolean {
  return lines.some((l) => l.x0 >= x0 - 0.5 && l.x1 <= x1 + 0.5 && l.y < y && l.y > y - size * 0.7);
}

/** Tuplet numbers (SMuFL digits or small italic text) over a group of chords. */
function tuplets(page: NormPage, systems: PSystem[]): void {
  const marks: { n: number; x: number; y: number }[] = [];
  for (const s of page.symbols) {
    if (tupletDigit(s.cp) < 0) continue;
    const near = page.symbols.filter((q) => tupletDigit(q.cp) >= 0 && Math.abs(q.y - s.y) < 1 && q.x > s.x && q.x - s.x < s.size * 0.6);
    if (page.symbols.some((q) => tupletDigit(q.cp) >= 0 && Math.abs(q.y - s.y) < 1 && q.x < s.x && s.x - q.x < s.size * 0.6)) continue;
    const n = Number([s, ...near].map((q) => tupletDigit(q.cp)).join(""));
    marks.push({ n, x: s.x + (s.w * (1 + near.length)) / 2, y: s.y });
  }
  for (const t of page.texts) {
    const m = /^(\d{1,2})(?::(\d{1,2}))?$/.exec(t.str);
    if (!m || !t.italic) continue;
    marks.push({ n: Number(m[1]), x: (t.words[0]?.x ?? t.x) + ((t.words[0]?.x1 ?? t.x) - (t.words[0]?.x ?? t.x)) / 2, y: t.y - t.size * 0.35 });
  }
  for (const mk of marks) {
    // The staff whose chords the number is nearest to.
    let best: { sys: PSystem; k: number; m: PMeasure; d: number } | null = null;
    for (const sys of systems)
      sys.staves.forEach((st, k) => {
        if (mk.y < st.top - 9 * st.space || mk.y > st.bottom + 9 * st.space) return;
        for (const m of sys.measures) {
          if (mk.x < m.x0 || mk.x > m.x1) continue;
          const d = staffDist(st, mk.y);
          if (!best || d < best.d) best = { sys, k, m, d };
        }
      });
    if (!best) continue;
    const { k, m } = best as { k: number; m: PMeasure };
    const evs = m.events[k].filter((e) => !e.grace);
    if (!evs.length || mk.n < 2) continue;
    // Centred over its group: take the chords nearest the number on both sides, as many as it says.
    const centre = [...evs].sort((a, b) => Math.abs((a.x + a.x1) / 2 - mk.x) - Math.abs((b.x + b.x1) / 2 - mk.x))[0];
    // Grow a run of neighbours around the centre until the run's middle sits under the number.
    const line = evs.filter((e) => e.voice === centre.voice).sort((a, b) => a.x - b.x);
    const ci = line.indexOf(centre);
    let lo = ci;
    let hi = ci;
    const unit = Math.min(...line.slice(Math.max(0, ci - mk.n), ci + mk.n).map((e) => e.base));
    const want = mk.n * unit;
    const sum = () => line.slice(lo, hi + 1).reduce((s, e) => s + e.base * (2 - 1 / 2 ** e.dots), 0);
    while (sum() < want - 1e-6) {
      const left = lo > 0 ? line[lo - 1] : null;
      const right = hi + 1 < line.length ? line[hi + 1] : null;
      if (!left && !right) break;
      const mid = (line[lo].x + line[hi].x1) / 2;
      if (right && (!left || mid <= mk.x)) hi++;
      else lo--;
    }
    if (Math.abs(sum() - want) > 1e-6) continue;
    const normal = mk.n === 3 ? 2 : mk.n === 2 ? 3 : mk.n === 4 ? 3 : mk.n < 8 ? 4 : mk.n < 16 ? 8 : 16;
    const tup = { actual: mk.n, normal };
    for (const e of line.slice(lo, hi + 1)) e.tuplet ??= tup;
  }
}
