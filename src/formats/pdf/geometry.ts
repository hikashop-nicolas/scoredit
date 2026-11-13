// Page geometry of a score: staves, systems, barlines, stems, beams, from the straight lines
// and shapes a PDF draws. Units are points, y grows down.
import type { PdfSegment, PdfShape } from "./extract";
import type { MusicSymbol } from "./normalize";

export interface HLine {
  y: number;
  x0: number;
  x1: number;
  width: number;
}

export interface VLine {
  x: number;
  y0: number;
  y1: number;
  width: number;
}

export interface Staff {
  /** y of the top and bottom lines, and the distance between two lines. */
  top: number;
  bottom: number;
  space: number;
  x0: number;
  x1: number;
  /** 5 for a staff of notes, 6 (or 4) for a tablature. */
  lines: number;
}

export interface Beam {
  x0: number;
  x1: number;
  /** Centre line at both ends, and thickness. */
  y0: number;
  y1: number;
  thick: number;
}

const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

export const horizontals = (segs: PdfSegment[]): HLine[] =>
  segs.filter((s) => near(s.y0, s.y1, 0.05) && Math.abs(s.x1 - s.x0) > 0.1).map((s) => ({ y: (s.y0 + s.y1) / 2, x0: Math.min(s.x0, s.x1), x1: Math.max(s.x0, s.x1), width: s.width }));

export const verticals = (segs: PdfSegment[]): VLine[] =>
  segs.filter((s) => near(s.x0, s.x1, 0.05) && Math.abs(s.y1 - s.y0) > 0.1).map((s) => ({ x: (s.x0 + s.x1) / 2, y0: Math.min(s.y0, s.y1), y1: Math.max(s.y0, s.y1), width: s.width }));

/** Joins vertical pieces on one x that touch or overlap (barlines drawn staff by staff). */
export function mergeVerticals(lines: VLine[], gap = 1): VLine[] {
  const key = (x: number) => Math.round(x * 10);
  const sorted = [...lines].sort((a, b) => key(a.x) - key(b.x) || a.y0 - b.y0);
  const out: VLine[] = [];
  const open: VLine[] = [];
  for (const l of sorted) {
    const m = open.find((o) => near(o.x, l.x, 0.05) && near(o.width, l.width, 0.05) && l.y0 <= o.y1 + gap && l.y1 >= o.y0 - gap);
    if (m) {
      m.y0 = Math.min(m.y0, l.y0);
      m.y1 = Math.max(m.y1, l.y1);
    } else {
      const c = { ...l };
      out.push(c);
      open.push(c);
      // Only lines at about this x can still take pieces.
      while (open.length && open[0].x < l.x - 0.1) open.shift();
    }
  }
  return out;
}

/**
 * Staves: runs of five (or six) evenly spaced horizontal lines of one width spanning the same
 * x range, then the pieces of one staff (drawn measure by measure) joined left to right.
 */
export function findStaves(hl: HLine[]): Staff[] {
  const groups = new Map<string, HLine[]>();
  for (const l of hl) {
    if (l.x1 - l.x0 < 2) continue;
    const k = `${Math.round(l.x0)}|${Math.round(l.x1)}|${Math.round(l.width * 20)}`;
    const g = groups.get(k) ?? [];
    g.push(l);
    groups.set(k, g);
  }
  const pieces: Staff[] = [];
  for (const g of groups.values()) {
    if (g.length < 4) continue;
    const ys = [...new Set(g.map((l) => Math.round(l.y * 100) / 100))].sort((a, b) => a - b);
    for (let i = 0; i < ys.length; ) {
      // The longest run of even gaps starting here.
      let j = i + 1;
      const sp = ys[j] - ys[i];
      while (j + 1 < ys.length && near(ys[j + 1] - ys[j], sp, Math.max(0.05, sp * 0.03))) j++;
      const n = j - i + 1;
      const x0 = Math.min(...g.map((l) => l.x0));
      const x1 = Math.max(...g.map((l) => l.x1));
      if (sp >= 1.5 && sp <= 25 && (n === 5 || n === 6 || n === 4) && x1 - x0 > Math.min(3 * sp, 40)) {
        pieces.push({ top: ys[i], bottom: ys[j], space: sp, x0, x1, lines: n });
        i = j + 1;
      } else i++;
    }
  }
  pieces.sort((a, b) => a.top - b.top || a.x0 - b.x0);
  const out: Staff[] = [];
  for (const p of pieces) {
    const s = out.find((o) => near(o.top, p.top, 0.1) && o.lines === p.lines && near(o.space, p.space, 0.05) && p.x0 <= o.x1 + Math.max(2, p.space) && p.x1 >= o.x0 - Math.max(2, p.space));
    if (s) {
      s.x0 = Math.min(s.x0, p.x0);
      s.x1 = Math.max(s.x1, p.x1);
    } else out.push({ ...p });
  }
  // Wide enough to hold music (stacks of ledger lines are not staves).
  return out.filter((s) => s.x1 - s.x0 > 6 * s.space).sort((a, b) => a.top - b.top || a.x0 - b.x0);
}

const BRACE = 0xe000;
const BRACKET_TOP = 0xe003;
const BRACKET_BOTTOM = 0xe004;

/**
 * Systems: staves, top to bottom, tied together by a vertical line at their left edge, a
 * brace or a bracket. Returns lists of staff indices.
 */
export function findSystems(staves: Staff[], vl: VLine[], symbols: MusicSymbol[]): number[][] {
  const n = staves.length;
  const parent = staves.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const join = (a: number, b: number) => (parent[find(a)] = find(b));
  const order = staves.map((_, i) => i).sort((a, b) => staves[a].top - staves[b].top);
  for (let k = 0; k + 1 < n; k++) {
    const a = staves[order[k]];
    const b = staves[order[k + 1]];
    if (!near(a.x0, b.x0, Math.max(a.space, 2))) continue;
    const tol = a.space * 0.5;
    const linked =
      vl.some((l) => near(l.x, a.x0, Math.max(1.5, a.space * 0.4)) && l.y0 <= a.bottom + tol && l.y1 >= b.top - tol && l.y1 - l.y0 > b.top - a.bottom) ||
      symbols.some((s) => s.cp === BRACE && s.x < a.x0 && s.x > a.x0 - 4 * a.space && s.y - s.size <= a.top + tol && s.y >= b.bottom - tol);
    if (linked) join(order[k], order[k + 1]);
  }
  // A bracket ties every staff from its top to its bottom.
  for (const t of symbols.filter((s) => s.cp === BRACKET_TOP)) {
    const bot = symbols.filter((s) => s.cp === BRACKET_BOTTOM && near(s.x, t.x, 1) && s.y > t.y).sort((p, q) => p.y - q.y)[0];
    if (!bot) continue;
    const inside = order.filter((i) => staves[i].top >= t.y - staves[i].space && staves[i].bottom <= bot.y + staves[i].space && near(staves[i].x0, t.x, 6 * staves[i].space));
    for (let k = 1; k < inside.length; k++) join(inside[k - 1], inside[k]);
  }
  const sys = new Map<number, number[]>();
  for (const i of order) {
    const r = find(i);
    const l = sys.get(r) ?? [];
    l.push(i);
    sys.set(r, l);
  }
  return [...sys.values()].sort((a, b) => staves[a[0]].top - staves[b[0]].top);
}

/** Staves of a system linked by a brace (one instrument, as a piano), as index ranges into the system. */
export function braceGroups(staves: Staff[], system: number[], symbols: MusicSymbol[]): [number, number][] {
  const out: [number, number][] = [];
  for (const s of symbols) {
    if (s.cp !== BRACE) continue;
    const ks = system.map((i, k) => [staves[i], k] as const).filter(([st]) => s.x < st.x0 && s.x > st.x0 - 5 * st.space && st.top >= s.y - s.size - st.space && st.bottom <= s.y + st.space);
    if (ks.length > 1) out.push([ks[0][1], ks[ks.length - 1][1]]);
  }
  return out;
}

export interface BarLine {
  x0: number;
  x1: number;
  /** thin or thick lines, left to right. */
  kinds: ("thin" | "thick")[];
  /** Staves (system indices) it crosses. */
  staves: number[];
}

/**
 * Barlines of a system: vertical lines that run from a staff's top line to a staff's bottom
 * line, close lines grouped (double, final, repeat barlines).
 */
export function findBarlines(staves: Staff[], system: number[], vl: VLine[], isStem: (l: VLine) => boolean): BarLine[] {
  const ss = system.map((i) => staves[i]);
  const sp = Math.min(...ss.map((s) => s.space));
  const x0 = Math.min(...ss.map((s) => s.x0)) - sp;
  const x1 = Math.max(...ss.map((s) => s.x1)) + sp;
  const tol = sp * 0.35;
  const cands: { l: VLine; staves: number[] }[] = [];
  for (const l of vl) {
    if (l.x < x0 || l.x > x1) continue;
    const startsAtTop = ss.some((s) => near(l.y0, s.top, tol));
    const endsAtBottom = ss.some((s) => near(l.y1, s.bottom, tol));
    if (!startsAtTop || !endsAtBottom) continue;
    const crossed = ss.flatMap((s, k) => (l.y0 <= s.top + tol && l.y1 >= s.bottom - tol && l.x >= s.x0 - sp && l.x <= s.x1 + sp ? [k] : []));
    if (!crossed.length || isStem(l)) continue;
    cands.push({ l, staves: crossed });
  }
  cands.sort((a, b) => a.l.x - b.l.x);
  const thin = Math.min(...cands.map((c) => c.l.width));
  const out: BarLine[] = [];
  for (const c of cands) {
    const kind = c.l.width > thin * 1.8 ? "thick" : "thin";
    const last = out[out.length - 1];
    if (last && c.l.x - c.l.width / 2 - last.x1 < sp * 1.1) {
      if (c.l.x - last.x1 > 0.05 || kind !== last.kinds[last.kinds.length - 1]) last.kinds.push(kind);
      last.x1 = c.l.x + c.l.width / 2;
      last.staves = [...new Set([...last.staves, ...c.staves])].sort((a, b) => a - b);
    } else out.push({ x0: c.l.x - c.l.width / 2, x1: c.l.x + c.l.width / 2, kinds: [kind], staves: c.staves });
  }
  return out;
}

/** Beams: filled four-sided shapes, about half a space thick, with two upright sides. */
export function findBeams(shapes: PdfShape[], segs: PdfSegment[], space: number): Beam[] {
  const out: Beam[] = [];
  for (const s of shapes) {
    if (!s.filled || s.curved) continue;
    const pts = s.points.filter((p, i) => i === 0 || !near(p[0], s.points[0][0], 0.01) || !near(p[1], s.points[0][1], 0.01));
    if (pts.length !== 4) continue;
    const xs = [...new Set(pts.map((p) => Math.round(p[0] * 20) / 20))];
    if (xs.length !== 2) continue;
    const left = pts.filter((p) => near(p[0], s.box.x0, 0.05)).map((p) => p[1]);
    const right = pts.filter((p) => near(p[0], s.box.x1, 0.05)).map((p) => p[1]);
    if (left.length !== 2 || right.length !== 2) continue;
    const thick = Math.abs(left[0] - left[1]);
    if (thick < 0.25 * space || thick > 0.8 * space || !near(thick, Math.abs(right[0] - right[1]), 0.1 * space)) continue;
    if (s.box.x1 - s.box.x0 < 0.4 * space) continue;
    out.push({ x0: s.box.x0, x1: s.box.x1, y0: (left[0] + left[1]) / 2, y1: (right[0] + right[1]) / 2, thick });
  }
  // Thick straight segments too (a beam stroked as a line).
  for (const s of segs) {
    if (s.width < 0.3 * space || s.width > 0.8 * space || near(s.x0, s.x1, 0.05)) continue;
    const [a, b] = s.x0 < s.x1 ? [s, { x0: s.x1, y0: s.y1 }] : [{ x0: s.x1, y0: s.y1 }, s];
    if (Math.abs(b.y0 - a.y0) > Math.abs(b.x0 - a.x0)) continue;
    out.push({ x0: a.x0, x1: b.x0, y0: a.y0, y1: b.y0, thick: s.width });
  }
  return out;
}

/** The beam's centre line at x. */
export const beamY = (b: Beam, x: number) => (b.x1 === b.x0 ? b.y0 : b.y0 + ((b.y1 - b.y0) * (x - b.x0)) / (b.x1 - b.x0));
