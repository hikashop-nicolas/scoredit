// Dots, beams and flags (oemer's rhythm_extraction.py).
import { fillConvex, minAreaRect, polygonArea } from "./geom";
import type { NoteGroup } from "./group";
import { close, contours, dilate, ellipseKernel, erode, label, ones, open, u8, type Box, type Img } from "./ndimage";
import { NoteType, pySlice, type NoteHead } from "./notehead";
import { pyRound } from "./py";
import { PySet, uniqueSet } from "./sci";
import { center, type Layers, type Staffs } from "./staff";
import type { Barline } from "./symbols";

function scanDot(noStem: Img<Uint8Array>, noteId: Img<Int32Array>, b: Box, unit: number, min: number, max: number): boolean {
  const { w, h } = noteId;
  let right = b[2] + 1;
  const startY = b[1] - pyRound(unit / 2);
  const [y0, y1] = pySlice(Math.trunc(startY), Math.trunc(b[3]), h);
  for (;;) {
    const x = Math.trunc(right);
    let any = false;
    if (x < w) for (let y = y0; y < y1; y++) if (noteId.d[y * w + x] !== -1) any = true;
    if (any) break;
    right += 1;
    if (right >= b[2] + unit) break;
  }
  const left = b[2] + pyRound(unit * 0.4);
  const [x0, x1] = pySlice(Math.trunc(left), Math.trunc(right), w);
  let px = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) px += noStem.d[y * w + x];
  return min <= px && px <= max;
}

function parseDot(L: Layers, S: Staffs, groups: NoteGroup[], notes: NoteHead[], noteId: Img<Int32Array>) {
  const { w, h } = L.symbols;
  const ns = new Uint8Array(w * h);
  for (let i = 0; i < ns.length; i++) ns[i] = L.symbols.d[i] - L.stems.d[i] - L.clefs.d[i] > 0 ? 1 : 0;
  const k = ellipseKernel(4, 4);
  const noStem = dilate(erode({ w, h, d: ns }, k), k);
  for (const g of groups) {
    const unit = S.unitSize(...center(g.bbox));
    const min = pyRound(unit ** 2 * 0.08);
    const max = pyRound(unit ** 2 * 0.2);
    const dots = g.noteIds.map((nid) => {
      const b = notes[nid].bbox;
      const d = scanDot(noStem, noteId, [b[0], b[1], Math.max(b[2], g.bbox[2]), b[3]], unit, min, max);
      notes[nid].hasDot = d;
      return d;
    });
    const all = dots.every(Boolean);
    const some = dots.some(Boolean);
    if (g.stemUp !== null && all !== some) {
      const t = dots.filter(Boolean).length;
      const to = t >= dots.length - t;
      for (const nid of g.noteIds) notes[nid].hasDot = to;
    }
  }
}

function parseBeams(L: Layers, S: Staffs, groupMap: Img<Int32Array>): Img<Uint8Array> {
  const { w, h } = L.symbols;
  const gp = new Uint8Array(w * h);
  for (let i = 0; i < gp.length; i++) gp[i] = groupMap.d[i] > -1 ? 1 : 0;
  const inStaff = open(u8(L.staff), ones(5, 1));
  const mix = new Uint8Array(w * h);
  for (let i = 0; i < mix.length; i++) mix[i] = L.symbols.d[i] + inStaff.d[i] - gp[i] - L.stems.d[i] - L.clefs.d[i] > 0 ? 1 : 0;
  const m2 = open({ w, h, d: mix }, ones(2, 3));
  const ext = close(u8(L.stems), ones(5, 1));
  const beams = { w, h, d: new Float32Array(w * h) };
  for (let i = 0; i < mix.length; i++) {
    let v = m2.d[i] + ext.d[i] + gp[i];
    if (v > 1) v = 1;
    v = v - gp[i] - L.stems.d[i];
    beams.d[i] = v < 0 ? 0 : v;
  }
  const bu = u8(beams);
  // poly: 0 = beam pixel kept black, 1 = whitened, as oemer's poly_map colours.
  const white = new Uint8Array(w * h);
  for (let i = 0; i < white.length; i++) white[i] = beams.d[i] > 0 ? 0 : 1;
  const c = contours(bu);
  const valid: number[][] = [];
  for (const ct of c.list) {
    const pts: [number, number][] = [];
    const [bx0, by0, bx1, by1] = ct.box;
    for (let y = Math.max(0, by0); y < Math.min(h, by1); y++)
      for (let x = Math.max(0, bx0); x < Math.min(w, bx1); x++) {
        const i = y * w + x;
        if (!ct.hole) {
          if (bu.d[i] && c.fg[i] === ct.label) pts.push([x, y]);
        } else if (bu.d[i]) {
          const isHole = (j: number) => !bu.d[j] && c.bg[j] === ct.label;
          if ((x > 0 && isHole(i - 1)) || (x < w - 1 && isHole(i + 1)) || (y > 0 && isHole(i - w)) || (y < h - 1 && isHole(i + w))) pts.push([x, y]);
        }
      }
    if (!pts.length) continue;
    const r = minAreaRect(pts);
    if (r.corners.some(([x, y]) => x < 0 || y < 0)) continue;
    const cnt = r.corners.map(([x, y]) => [Math.trunc(x), Math.trunc(y)] as [number, number]);
    const cx = (cnt[0][0] + cnt[1][0] + cnt[2][0] + cnt[3][0]) / 4;
    const cy = (cnt[0][1] + cnt[1][1] + cnt[2][1] + cnt[3][1]) / 4;
    const unit = S.unitSize(pyRound(cx), pyRound(cy));
    const inside: number[] = [];
    fillConvex(cnt, w, h, (x, y) => inside.push(y * w + x));
    if (polygonArea(cnt) < unit ** 2 * 0.07) {
      for (const i of inside) white[i] = 1;
      continue;
    }
    const hit = inside.filter((i) => beams.d[i] > 0);
    if (Math.min(r.w, r.h) < unit * 0.2 || hit.length / (inside.length + 1e-8) < 0.4) {
      for (const i of hit) white[i] = 1;
      continue;
    }
    valid.push(hit);
  }
  for (const v of valid) for (const i of v) white[i] = 0;
  const poly = new Uint8Array(w * h);
  for (let i = 0; i < poly.length; i++) poly[i] = white[i] ? 0 : 1;
  if ((globalThis as any).DBG) (globalThis as any).DBG_BEAMS = bu;
  return { w, h, d: poly };
}

interface RegionInfo {
  bbox: Box;
  gids: PySet;
}

function overlapRegions(L: Layers, poly: Img<Uint8Array>, groupMap: Img<Int32Array>, barlines: Barline[]) {
  const { w, h } = poly;
  const ker = ones(3, 3);
  const mixIn = new Uint8Array(w * h);
  for (let i = 0; i < mixIn.length; i++) mixIn[i] = Math.trunc(Math.max(0, poly.d[i] + L.symbols.d[i])) & 255;
  const mix = dilate(erode({ w, h, d: mixIn }, ker), ker);
  const pm = dilate(erode(poly, ker), ker);
  for (const bl of barlines) {
    const [y0, y1] = pySlice(bl.bbox[1], bl.bbox[3], h);
    const [x0, x1] = pySlice(bl.bbox[0], bl.bbox[2], w);
    for (let y = y0; y < y1; y++) {
      mix.d.fill(0, y * w + x0, y * w + x1);
      pm.d.fill(0, y * w + x0, y * w + x1);
    }
  }
  for (let i = 0; i < mix.d.length; i++) if (mix.d[i] > 1) mix.d[i] = 1;
  const reg = label(pm);
  const sym = label(mix);
  // Per symbol label: inclusive box and the groups it touches.
  const sb = new Map<number, { box: Box; gids: Set<number> }>();
  const regSyms = new Map<number, Set<number>>();
  for (let i = 0; i < w * h; i++) {
    const s = sym.map.d[i];
    if (s) {
      const x = i % w;
      const y = (i - x) / w;
      let e = sb.get(s);
      if (!e) sb.set(s, (e = { box: [x, y, x, y], gids: new Set() }));
      else {
        e.box[0] = Math.min(e.box[0], x);
        e.box[2] = Math.max(e.box[2], x);
        e.box[3] = y;
      }
      e.gids.add(groupMap.d[i]);
    }
    const r = reg.map.d[i];
    if (r) {
      let rs = regSyms.get(r);
      if (!rs) regSyms.set(r, (rs = new Set()));
      rs.add(s);
    }
  }
  const out = new Uint8Array(w * h);
  const info = new Map<number, RegionInfo>();
  const keep = new Uint8Array(reg.n + 1);
  for (let idx = 1; idx <= reg.n; idx++) {
    const labels = uniqueSet(regSyms.get(idx) ?? [], 0);
    const all = new Set<number>();
    let box: Box | null = null;
    for (const l of labels) {
      const e = sb.get(l)!;
      for (const g of e.gids) all.add(g);
      box = box ? [Math.min(box[0], e.box[0]), Math.min(box[1], e.box[1]), Math.max(box[2], e.box[2]), Math.max(box[3], e.box[3])] : [...e.box];
    }
    const gids = uniqueSet(all, -1);
    if (!gids.size || !box) continue;
    keep[idx] = 1;
    for (const l of labels) {
      const prev = info.get(l);
      if (prev) {
        const bb = prev.bbox;
        gids.update(prev.gids);
        box = [Math.min(bb[0], box[0]), Math.min(bb[1], box[1]), Math.max(bb[2], box[2]), Math.max(bb[3], box[3])];
      }
      info.set(l, { bbox: box, gids });
    }
  }
  for (let i = 0; i < out.length; i++) out[i] = keep[reg.map.d[i]] && reg.map.d[i] ? 1 : 0;
  return { out: erode(dilate({ w, h, d: out }, ker), ker), info };
}

function refineInfo(info: Map<number, RegionInfo>, groups: NoteGroup[], groupMap: Img<Int32Array>) {
  const { w, h } = groupMap;
  const next = new Map<number, RegionInfo>();
  const rev = new Map<number, number>();
  for (const [reg, inf] of info) {
    next.set(reg, { bbox: [0, 0, 0, 0], gids: new PySet() });
    const bs = [...[...inf.gids].map((g) => groups[g].bbox), inf.bbox];
    const bbox: Box = [Math.min(...bs.map((b) => b[0])), Math.min(...bs.map((b) => b[1])), Math.max(...bs.map((b) => b[2])), Math.max(...bs.map((b) => b[3]))];
    next.get(reg)!.bbox = bbox;
    const vals = new Set<number>();
    const [y0, y1] = pySlice(bbox[1], bbox[3], h);
    const [x0, x1] = pySlice(bbox[0], bbox[2], w);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) vals.add(groupMap.d[y * w + x]);
    for (const gid of uniqueSet(vals, -1)) {
      if (!rev.has(gid)) {
        next.get(reg)!.gids.add(gid);
        rev.set(gid, reg);
        continue;
      }
      const ori = rev.get(gid)!;
      if (ori === reg) continue;
      const ob = next.get(ori)!.bbox;
      const og = next.get(ori)!.gids;
      const nb: Box = [Math.min(ob[0], bbox[0]), Math.min(ob[1], bbox[1]), Math.max(ob[2], bbox[2]), Math.max(ob[3], bbox[3])];
      og.add(gid);
      next.get(reg)!.gids.update(og);
      next.get(reg)!.bbox = nb;
      rev.set(gid, reg);
      next.delete(ori);
      for (const g of og) rev.set(g, reg);
    }
  }
  return next;
}

function stemX(gbox: Box, nboxes: Box[], unit: number, right = true): number {
  const same = nboxes.every((nb) => Math.abs(nb[2] - gbox[2]) < unit / 3);
  if (!same) return pyRound((gbox[0] + gbox[2]) / 2);
  return right ? gbox[2] : gbox[0];
}

function scanBeamFlag(poly: Img<Uint8Array>, S: Staffs, sx: number, sy: number, ex: number, ey: number, th: number): number {
  sx = Math.trunc(sx);
  sy = Math.trunc(sy);
  ex = Math.trunc(ex);
  ey = Math.trunc(ey);
  const counter = new Array<number>(Math.max(0, ex - sx)).fill(0);
  if (ey < sy) [sy, ey] = [ey, sy];
  const unit = S.unitSize(sx, sy);
  const minW = unit * 0.25;
  const maxW = unit * 0.9;
  const { w, h } = poly;
  const at = (y: number, x: number) => {
    const yy = y < 0 ? y + h : y;
    const xx = x < 0 ? x + w : x;
    return yy >= 0 && yy < h && xx >= 0 && xx < w ? poly.d[yy * w + xx] : 0;
  };
  for (let idx = 0, x = sx; x < ex; idx++, x++) {
    let y = sy;
    let last = at(y, x);
    let hit = false;
    let width = 0;
    while (y < ey) {
      hit = false;
      width = 0;
      while (y < ey) {
        const cur = at(y, x);
        if (last ^ cur) {
          hit = last > cur;
          last = cur;
          y++;
          break;
        }
        y++;
        width++;
      }
      if (hit && width >= minW) counter[idx] += Math.ceil(width / maxW);
    }
    if (last === 1) counter[idx] += hit ? Math.ceil(width / maxW) : 1;
  }
  const stat = new Map<number, number>();
  for (const c of counter) stat.set(c, (stat.get(c) ?? 0) + 1);
  const minNum = counter.length * th;
  let acc = 0;
  for (const [c, n] of [...stat].sort((a, b) => b[0] - a[0])) {
    acc += n;
    if (acc > minNum) return c;
  }
  return 0;
}

const TYPE_BY_COUNT: NoteType[] = [NoteType.QUARTER, NoteType.EIGHTH, NoteType.SIXTEENTH, NoteType.THIRTY_SECOND, NoteType.SIXTEENTH];
function typeOf(count: number, issues: string[]): NoteType {
  if (count < TYPE_BY_COUNT.length) return TYPE_BY_COUNT[count];
  issues.push(`${count} beams`);
  return NoteType.SIXTEENTH;
}

function parseInner(poly: Img<Uint8Array>, S: Staffs, g: NoteGroup, setBox: Box, notes: NoteHead[], half: number, th: number, issues: string[]) {
  // Highest note first (stable, as Python's sorted(reverse=True)).
  const nts = g.noteIds.map((id) => notes[id]);
  const idx0 = nts.map((_, i) => i).sort((a, b) => nts[b].staffLinePos - nts[a].staffLinePos || a - b);
  const sorted = idx0.map((i) => nts[i]);
  const getLabel = (nb: Box, up: boolean) => {
    const cx = up ? nb[2] : nb[0];
    const sy = up ? nb[1] : nb[3];
    const ey = up ? setBox[1] : setBox[3];
    return typeOf(scanBeamFlag(poly, S, Math.max(setBox[0], cx - half), sy, Math.min(setBox[2], cx + half), ey, th), issues);
  };
  if (sorted.length === 2) {
    sorted[0].forceLabel(getLabel(sorted[0].bbox, true));
    sorted[1].forceLabel(getLabel(sorted[1].bbox, false));
    sorted[0].stemUp = true;
    sorted[1].stemUp = false;
    g.topNoteIds.push(sorted[0].id);
    g.bottomNoteIds.push(sorted[1].id);
  } else if (g.allSameType) {
    sorted[0].label = getLabel(sorted[0].bbox, true);
    sorted[0].stemUp = true;
    g.topNoteIds.push(sorted[0].id);
    const bt = getLabel(sorted[sorted.length - 1].bbox, false);
    for (const n of sorted.slice(1)) {
      n.label = bt;
      n.stemUp = false;
      g.bottomNoteIds.push(n.id);
    }
  } else {
    let i = 0;
    while (i < sorted.length && sorted[0].label === sorted[i].label) i++;
    if (sorted[0].label === NoteType.HALF_OR_WHOLE) {
      for (const n of sorted.slice(0, i)) {
        n.forceLabel(NoteType.HALF);
        n.stemUp = true;
        g.topNoteIds.push(n.id);
      }
      const bt = getLabel(sorted[sorted.length - 1].bbox, false);
      for (const n of sorted.slice(i)) {
        n.label = bt;
        n.stemUp = false;
        g.bottomNoteIds.push(n.id);
      }
    } else {
      for (const n of sorted.slice(i)) {
        n.forceLabel(NoteType.HALF);
        n.stemUp = false;
        g.bottomNoteIds.push(n.id);
      }
      const top = getLabel(sorted[sorted.length - 1].bbox, true);
      for (const n of sorted.slice(0, i)) {
        n.label = top;
        n.stemUp = true;
        g.topNoteIds.push(n.id);
      }
    }
  }
}

function parseRhythm(beamMap: Img<Uint8Array>, info: Map<number, RegionInfo>, S: Staffs, groups: NoteGroup[], notes: NoteHead[], th: number, issues: string[]) {
  const rev = new Map<number, Box>();
  for (const [, inf] of info) for (const g of inf.gids) rev.set(g, inf.bbox);
  const bin = beamMap;
  for (let gid = 0; gid < groups.length; gid++) {
    const g = groups[gid];
    let gbox = g.bbox;
    const reg = rev.get(gid) ?? gbox;
    let unit = S.unitSize(...center(gbox));
    const half = pyRound(unit / 2);
    if (g.stemUp === null) {
      if (!g.hasStem) {
        for (const nid of g.noteIds) {
          if (notes[nid].label !== NoteType.HALF_OR_WHOLE) {
            notes[nid].invalid = true;
            continue;
          }
          notes[nid].forceLabel(NoteType.WHOLE);
        }
      } else parseInner(bin, S, g, reg, notes, half, th, issues);
      continue;
    }
    // Most common label (ties: first seen; oemer's order there depends on hashing).
    const counts = new Map<NoteType | null, number>();
    for (const nid of g.noteIds) counts.set(notes[nid].label, (counts.get(notes[nid].label) ?? 0) + 1);
    const top = [...counts].sort((a, b) => b[1] - a[1])[0][0];
    if (top === NoteType.HALF_OR_WHOLE) {
      for (const nid of g.noteIds) notes[nid].forceLabel(NoteType.HALF);
      continue;
    }
    if (!rev.has(gid)) {
      for (const nid of g.noteIds) notes[nid].label = NoteType.QUARTER;
      continue;
    }
    gbox = [gbox[0], Math.min(gbox[1], reg[1]), gbox[2], Math.max(gbox[3], reg[3])];
    const nbox = g.noteIds.map((n) => notes[n].bbox);
    unit = S.unitSize(...center(gbox));
    let cx: number;
    let sy: number;
    let ey: number;
    if (g.stemUp) {
      cx = stemX(gbox, nbox, unit);
      sy = Math.min(...nbox.map((b) => b[1]));
      ey = gbox[1];
    } else {
      cx = stemX(gbox, nbox, unit, false);
      sy = Math.max(...nbox.map((b) => b[3]));
      ey = gbox[3];
    }
    const count = scanBeamFlag(bin, S, Math.max(reg[0], cx - half), sy, Math.min(reg[2], cx + half), ey, th);
    for (const nid of g.noteIds) if (notes[nid].label === null) notes[nid].label = typeOf(count, issues);
  }
}

export function extractRhythm(
  L: Layers,
  S: Staffs,
  groups: NoteGroup[],
  notes: NoteHead[],
  noteId: Img<Int32Array>,
  groupMap: Img<Int32Array>,
  barlines: Barline[],
  issues: string[],
) {
  parseDot(L, S, groups, notes, noteId);
  const poly = parseBeams(L, S, groupMap);
  const { out, info } = overlapRegions(L, poly, groupMap, barlines);
  parseRhythm(out, refineInfo(info, groups, groupMap), S, groups, notes, 0.15, issues);
  return { poly, out };
}
