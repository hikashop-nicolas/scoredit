// Notehead extraction (oemer's notehead_extraction.py).
import { mergeNearby, rmMergeOverlap } from "./bbox";
import { dilate, ellipseKernel, erode, getBbox, label, ones, u8, type Box, type Img } from "./ndimage";
import { pyRound } from "./py";
import { uniqueSet } from "./sci";
import { center, type Layers, type Staff, type Staffs } from "./staff";

export enum NoteType {
  WHOLE = 0,
  HALF = 1,
  QUARTER = 2,
  EIGHTH = 3,
  SIXTEENTH = 4,
  THIRTY_SECOND = 5,
  SIXTY_FOURTH = 6,
  HALF_OR_WHOLE = 9,
}

export type SfnType = "flat" | "sharp" | "natural";

export class NoteHead {
  pitch: number | null = null;
  hasDot = false;
  bbox!: Box;
  stemUp: boolean | null = null;
  stemRight: boolean | null = null;
  track = 0;
  group = 0;
  staffLinePos = 0;
  invalid = false;
  id = 0;
  noteGroupId: number | null = null;
  sfn: SfnType | null = null;
  rawLabel: NoteType | null = null;
  /** oemer's label property: none for a note found invalid. */
  get label(): NoteType | null {
    return this.invalid ? null : this.rawLabel;
  }
  /** oemer's label setter: only sets a label not set yet. */
  set label(l: NoteType | null) {
    if (this.rawLabel === null) this.rawLabel = l;
  }
  forceLabel(l: NoteType) {
    this.rawLabel = l;
  }
}

const W_FACTOR = 0.5;
const H_FACTOR = 0.4;
const SIZE_RATIO = 1.285714;
const CLEF_ZONE = 4.5406916;

function morphNotehead(pred: Img, unit: number): Img<Uint8Array> {
  const small = Math.trunc(pyRound(unit / 3));
  const sk = ellipseKernel(small, small);
  const p = erode(dilate(u8(pred), sk), sk);
  const sw = Math.trunc(pyRound(unit * W_FACTOR));
  const sh = Math.trunc(pyRound(unit * H_FACTOR));
  return dilate(erode(p, ellipseKernel(sw, sh)), ellipseKernel(sw + 1, sh + 1));
}

function adjustBbox(b: Box, nh: Img): Box | null {
  let top = Infinity;
  let bottom = -Infinity;
  for (let y = Math.max(0, b[1]); y < Math.min(nh.h, b[3]); y++)
    for (let x = Math.max(0, b[0]); x < Math.min(nh.w, b[2]); x++)
      if (nh.d[y * nh.w + x] > 0) {
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
  if (top === Infinity) return null;
  return [b[0], top - 1, b[2], bottom + 1];
}

function checkBboxSize(b: Box, nh: Img, unit: number): Box[] {
  const w = b[2] - b[0];
  const h = b[3] - b[1];
  const cx = center(b)[0];
  const noteW = SIZE_RATIO * unit;
  let out: Box[] = [];
  if (Math.abs(w - noteW) > Math.abs(w - noteW * 2)) {
    const l = adjustBbox([b[0], b[1], cx, b[3]], nh);
    const r = adjustBbox([cx, b[1], b[2], b[3]], nh);
    if (l) out.push(...checkBboxSize(l, nh, unit));
    if (r) out.push(...checkBboxSize(r, nh, unit));
  }
  if (out.length) {
    const tmp: Box[] = [];
    for (const x of out) tmp.push(...checkBboxSize(x, nh, unit));
    out = tmp;
  } else {
    const n = Math.trunc(pyRound(h / unit));
    if (n > 0) {
      const sub = Math.floor(h / n);
      for (let i = 0; i < n; i++) out.push([b[0], pyRound(b[1] + i * sub), b[2], pyRound(b[1] + (i + 1) * sub)]);
    }
  }
  return out;
}

function noteheadBboxes(L: Layers, S: Staffs, unit: number, minAreaRatio: number): Box[] {
  const note = morphNotehead(L.notehead, unit);
  const boxes = rmMergeOverlap(getBbox(note));
  const res: Box[] = [];
  for (const b of boxes) res.push(...checkBboxSize(b, L.notehead, S.unitSize(...center(b))));
  return res.filter((b) => {
    const [cx, cy] = center(b);
    const u = S.unitSize(cx, cy);
    if (cx < S.minX + CLEF_ZONE * u || cx > S.maxX) return false;
    const h = b[3] - b[1];
    const w = b[2] - b[0];
    if (h < u * 0.4 || h > u * 5) return false;
    if (w < u * 0.3 * SIZE_RATIO || w > u * 3 * SIZE_RATIO) return false;
    let count = 0;
    for (let y = Math.max(0, b[1]); y < Math.min(note.h, b[3]); y++)
      for (let x = Math.max(0, b[0]); x < Math.min(note.w, b[2]); x++) if (note.d[y * note.w + x] > 0) count++;
    return !(count < h * w * minAreaRatio);
  });
}

/** numpy-style slice bounds: negative starts count from the end. */
export function pySlice(start: number, stop: number, len: number): [number, number] {
  const s = start < 0 ? Math.max(0, start + len) : Math.min(start, len);
  const e = stop < 0 ? Math.max(0, stop + len) : Math.min(stop, len);
  return [s, Math.max(s, e)];
}

// oemer's fill_hole, including its column scan nested in the row loop.
function fillHole(region: Float32Array, w: number, h: number): Float32Array {
  const t = region.slice();
  for (let yi = 0; yi < h; yi++) {
    let cur = 0;
    while (cur < w && !(t[yi * w + cur] > 0)) cur++;
    while (cur < w && t[yi * w + cur] !== 0) cur++;
    const cand: number[] = [];
    while (cur < w && !(t[yi * w + cur] > 0)) cand.push(cur++);
    if (cur < w) for (const x of cand) t[yi * w + x] = 1;
    for (let xi = 0; xi < w; xi++) {
      let c = 0;
      while (c < h && !(t[c * w + xi] > 0)) c++;
      while (c < h && t[c * w + xi] !== 0) c++;
      const cy: number[] = [];
      while (c < h && !(t[c * w + xi] > 0)) cy.push(c++);
      if (c < h) for (const y of cy) t[y * w + xi] = 1;
    }
  }
  return t;
}

function crop(a: Img, b: Box): { d: Float32Array; w: number; h: number } {
  const [y0, y1] = pySlice(b[1], b[3], a.h);
  const [x0, x1] = pySlice(b[0], b[2], a.w);
  const w = x1 - x0;
  const h = y1 - y0;
  const d = new Float32Array(w * h);
  for (let y = 0; y < h; y++) d.set(a.d.subarray((y0 + y) * a.w + x0, (y0 + y) * a.w + x1), y * w);
  return { d, w, h };
}

export { crop };

function genNotes(boxes: Box[], S: Staffs): NoteHead[] {
  return boxes.map((b) => {
    const nn = new NoteHead();
    nn.bbox = b;
    const [cx, cy] = center(b);
    const [s1, s2] = S.closest(cx, cy);
    let master: Staff;
    if (s1.yCenter === s2.yCenter || (s1.yUpper <= cy && cy <= s1.yLower)) master = s1;
    else {
      const [up, lo] = s1.yCenter < s2.yCenter ? [s1, s2] : [s2, s1];
      master = cy < (up.yCenter + lo.yCenter) / 2 ? up : lo;
    }
    nn.group = master.group;
    nn.track = master.track;
    const step = master.unitSize / 2;
    const pos = master.lines.map((l) => l.yCenter).reverse();
    const inter = pos.slice(0, -1).map((c, i) => (c + pos[i + 1]) / 2);
    inter.forEach((v, i) => pos.splice(i * 2 + 1, 0, v));
    const cen = [pos[0] + step, ...pos, pos[pos.length - 1] - step];
    let idx = 0;
    for (let i = 1; i < cen.length; i++) if (Math.abs(cen[i] - cy) < Math.abs(cen[idx] - cy)) idx = i;
    if (idx > 0 && idx < cen.length - 1) nn.staffLinePos = idx;
    else if (idx === 0) nn.staffLinePos = -pyRound(Math.abs(cen[0] - cy) / step);
    else nn.staffLinePos = pyRound(Math.abs(cen[cen.length - 1] - cy) / step) + cen.length - 1;
    return nn;
  });
}

function parseStemInfo(notes: NoteHead[], L: Layers) {
  const { map } = label(dilate(u8(L.stems), ones(3, 2)));
  const { w } = map;
  const sumX = new Map<number, [number, number]>();
  const meanX = (l: number) => {
    if (!sumX.size) {
      for (let i = 0; i < map.d.length; i++) {
        const v = map.d[i];
        if (!v) continue;
        const s = sumX.get(v) ?? [0, 0];
        s[0] += i % w;
        s[1]++;
        sumX.set(v, s);
      }
    }
    const s = sumX.get(l)!;
    return s[0] / s[1];
  };
  for (const n of notes) {
    const b = n.bbox;
    const vals: number[] = [];
    const [y0, y1] = pySlice(b[1], b[3], map.h);
    const [x0, x1] = pySlice(b[0], b[2], map.w);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) vals.push(map.d[y * w + x]);
    const lls = uniqueSet(vals, 0);
    if (!lls.size) continue;
    n.stemRight = meanX(lls.pop()) > (b[0] + b[2]) / 2;
  }
}

/** Noteheads: solid ones first, then hollow ones (half or whole). */
export function extractNotes(L: Layers, S: Staffs): NoteHead[] {
  const unit = S.globalUnitSize();
  const boxes = noteheadBboxes(L, S, unit, 0.5);
  const merged = mergeNearby(boxes, unit * 1.5, 1, 5);
  const solid: Box[] = [];
  const hollow: Box[] = [];
  for (const m of merged) {
    const b: Box = [m[0] - 1, m[1] - 1, m[2] - 1, m[3] - 1];
    const r = crop(L.symbols, b);
    let count = 0;
    for (const v of r.d) if (v > 0) count++;
    if (!count) continue;
    let f = 0;
    for (const v of fillHole(r.d, r.w, r.h)) if (v > 0) f++;
    (f / count > 1.3 ? hollow : solid).push(b);
  }
  const s = genNotes(solid, S);
  const h = genNotes(hollow, S);
  for (const n of h) n.label = NoteType.HALF_OR_WHOLE;
  const notes = [...s, ...h];
  parseStemInfo(notes, L);
  return notes;
}
