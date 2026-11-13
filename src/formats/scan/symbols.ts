// Barlines, clefs, accidentals and rests (oemer's symbol_extraction.py).
import { filterOutOfRange, filterSmallArea, mergeNearby, rmMergeOverlap } from "./bbox";
import { findLines, line } from "./geom";
import { dilate, erode, getBbox, label, ones, u8, type Box, type Img } from "./ndimage";
import { crop, pySlice, type NoteHead, type SfnType } from "./notehead";
import { mean, pyRound, sortedBy } from "./py";
import { predictRegion, type Classifiers } from "./svm";
import { center, type Layers, type Staffs } from "./staff";

export type ClefType = "G" | "F";
export enum RestType {
  WHOLE_HALF = 1,
  QUARTER = 2,
  EIGHTH = 3,
  SIXTEENTH = 4,
  THIRTY_SECOND = 5,
  SIXTY_FOURTH = 6,
  WHOLE = 7,
  HALF = 8,
}

export interface Clef {
  kind: "clef";
  bbox: Box;
  track: number;
  group: number;
  label: ClefType;
}
export interface Sfn {
  kind: "sfn";
  bbox: Box;
  noteId: number | null;
  isKey: boolean | null;
  track: number;
  group: number;
  label: SfnType;
}
export interface Rest {
  kind: "rest";
  bbox: Box;
  hasDot: boolean | null;
  track: number;
  group: number;
  label: RestType;
}
export interface Barline {
  kind: "barline";
  bbox: Box;
  group: number;
}

export const xCenter = (s: { bbox: Box }) => (s.bbox[0] + s.bbox[2]) / 2;

function filterBarlines(lines: Box[], S: Staffs, minRatio: number): Box[] {
  lines = rmMergeOverlap(filterOutOfRange(lines, S), "merge", 0);
  let unit = 0;
  const valid: Box[] = [];
  for (const l of lines) {
    unit = S.unitSize(...center(l));
    const deg = (Math.atan2(l[3] - l[1], l[2] - l[0]) * 180) / Math.PI;
    if (Math.abs(deg) < 75) continue;
    valid.push(l);
  }
  if (!valid.length) return [];
  const w = Math.max(...valid.map((l) => l[2])) + 10;
  const h = Math.max(...valid.map((l) => l[3])) + 10;
  const canvas = { w, h, d: new Uint8Array(w * h) };
  for (const l of valid) line(l[0], l[1], l[2], l[3], (x, y) => (canvas.d[y * w + x] = 1));
  // oemer reuses the unit size of the last line here.
  let boxes = getBbox(canvas).filter((b) => !(b[3] - b[1] < unit * minRatio));
  boxes = sortedBy(boxes, (b) => b[3] - b[1]);
  const heights = boxes.map((b) => b[3] - b[1]);
  const top5 = mean(heights.slice(-5));
  return boxes.filter((_, i) => heights[i] / top5 > 0.5);
}

function parseBarlines(L: Layers, S: Staffs, groupMap: Img<Int32Array>, minRatio: number): Box[] {
  const { w, h } = L.symbols;
  const cand = new Uint8Array(w * h);
  const noNote = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    cand[i] = L.stems.d[i] - groupMap.d[i] > 1 ? 1 : 0;
    noNote[i] = L.symbols.d[i] - groupMap.d[i] > 1 ? 1 : 0;
  }
  const sym = label({ w, h, d: noNote });
  const hit = new Uint8Array(sym.n + 1);
  for (let i = 0; i < w * h; i++) if (cand[i] && sym.map.d[i]) hit[sym.map.d[i]] = 1;
  const map = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) if (hit[sym.map.d[i]] && sym.map.d[i]) map[i] = 1;
  return filterBarlines(findLines({ w, h, d: map }), S, minRatio);
}

function parseClefsKeys(L: Layers, S: Staffs, cls: Classifiers, unit: number) {
  const ker = ones(Math.trunc(Math.floor(unit / 2)), 1);
  const ck = erode(dilate(u8(L.clefs), ker), ker);
  let boxes = getBbox(ck);
  boxes = filterOutOfRange(boxes, S);
  boxes = rmMergeOverlap(boxes, "merge", 0.3);
  boxes = filterSmallArea(boxes, S, (u) => u ** 2);
  boxes = mergeNearby(boxes, unit * 1.2);
  const ckf: Img = { w: ck.w, h: ck.h, d: Float32Array.from(ck.d) };
  const clefBox: Box[] = [];
  const keyBox: Box[] = [];
  for (const b of boxes) {
    const bw = b[2] - b[0];
    const bh = b[3] - b[1];
    const r = crop(ckf, b);
    let tp = 0;
    for (const v of r.d) if (v > 0) tp++;
    const u = S.unitSize(...center(b));
    if ((bw * bh) / u ** 2 > 3.5 && tp / (bw * bh) < 0.45) clefBox.push(b);
    else if (bw > u / 2 && bh > u / 2) keyBox.push(b);
  }
  const clefs = clefBox.filter((b) => {
    const [cx, cy] = center(b);
    const u = S.unitSize(cx, cy);
    if (b[2] - b[0] < u * 1.5 || b[3] - b[1] < u * 1.5) return false;
    const [st] = S.closest(cx, cy);
    return !(cy < st.yUpper || cy > st.yLower);
  });
  const pred = (bs: Box[], m: keyof Classifiers) =>
    bs.map((b) => {
      const r = crop(ckf, b);
      return predictRegion(cls[m], r.d, r.w, r.h);
    });
  return { clefBox: clefs, keyBox, clefLabel: pred(clefs, "clef"), keyLabel: pred(keyBox, "sfn") };
}

function parseRests(L: Layers, S: Staffs, cls: Classifiers, groupMap: Img<Int32Array>, lineBox: Box[], unit: number) {
  const { w, h } = L.stems;
  const block = new Uint8Array(w * h);
  for (const b of lineBox) {
    const [y0, y1] = pySlice(b[1], b[3], h);
    const [x0, x1] = pySlice(b[0], b[2], w);
    for (let y = y0; y < y1; y++) block.fill(1, y * w + x0, y * w + x1);
  }
  const rests: Img = { w, h, d: new Float32Array(w * h) };
  for (let i = 0; i < w * h; i++) rests.d[i] = Math.max(0, L.stems.d[i] - (groupMap.d[i] > -1 ? 1 : 0) - block[i]);
  let boxes = getBbox(u8(rests));
  boxes = filterOutOfRange(boxes, S);
  boxes = mergeNearby(boxes, unit * 1.2);
  boxes = rmMergeOverlap(boxes);
  boxes = filterSmallArea(boxes, S, (u) => u ** 2 * 0.7);
  const valid: Box[] = [];
  const labels: string[] = [];
  for (const b of boxes) {
    if (b[3] - b[1] > unit * 3.5 || b[2] - b[0] < unit * 0.5) continue;
    const r = crop(rests, b);
    let p = predictRegion(cls.rests, r.d, r.w, r.h);
    if (p.includes("8th")) p = predictRegion(cls.rests_above8, r.d, r.w, r.h);
    // oemer's region is a view: the 0/255 scaling stays in the layer.
    const [y0] = pySlice(b[1], b[3], h);
    const [x0] = pySlice(b[0], b[2], w);
    for (let y = 0; y < r.h; y++) rests.d.set(r.d.subarray(y * r.w, (y + 1) * r.w), (y0 + y) * w + x0);
    valid.push(b);
    labels.push(p);
  }
  return { valid, labels };
}

const REST_NAMES: Record<string, RestType> = {
  rest_whole: RestType.WHOLE_HALF,
  rest_quarter: RestType.QUARTER,
  rest_8th: RestType.EIGHTH,
  rest_16th: RestType.SIXTEENTH,
  rest_32nd: RestType.THIRTY_SECOND,
  rest_64th: RestType.SIXTY_FOURTH,
};

export interface Symbols {
  barlines: Barline[];
  clefs: Clef[];
  sfns: Sfn[];
  rests: Rest[];
}

export function extractSymbols(
  L: Layers,
  S: Staffs,
  cls: Classifiers,
  notes: NoteHead[],
  noteId: Img<Int32Array>,
  groupMap: Img<Int32Array>,
  issues: string[],
): Symbols {
  const lineBox = parseBarlines(L, S, groupMap, 3.75);
  const barlines: Barline[] = lineBox.map((b) => ({ kind: "barline", bbox: b, group: S.closest(...center(b))[0].group }));
  const unit = S.globalUnitSize();
  const ck = parseClefsKeys(L, S, cls, unit);
  const clefs: Clef[] = ck.clefBox.map((b, i) => {
    const [st] = S.closest(...center(b));
    return { kind: "clef", bbox: b, label: ck.clefLabel[i] === "gclef" ? "G" : "F", track: st.track, group: st.group };
  });
  const sfns: Sfn[] = ck.keyBox.map((b, i) => {
    const [cx, cy] = center(b);
    const [st] = S.closest(cx, cy);
    const s: Sfn = { kind: "sfn", bbox: b, label: ck.keyLabel[i] as SfnType, noteId: null, isKey: null, track: st.track, group: st.group };
    const u = Math.trunc(pyRound(S.unitSize(cx, cy)));
    for (let x = b[2]; x < b[2] + u && x < noteId.w; x++) {
      const v = noteId.d[cy * noteId.w + x];
      if (v !== -1) {
        s.noteId = v;
        break;
      }
    }
    if (s.noteId !== null) {
      const n = notes[s.noteId];
      if (s.track !== n.track || s.group !== n.group) issues.push(`accidental ${i} and its note are on different staffs`);
      else {
        n.sfn = s.label;
        s.isKey = false;
      }
    }
    return s;
  });
  const pr = parseRests(L, S, cls, groupMap, lineBox, unit);
  const rests: Rest[] = pr.valid.map((b, i) => {
    const [st] = S.closest(...center(b));
    const r: Rest = { kind: "rest", bbox: b, label: REST_NAMES[pr.labels[i]], hasDot: null, track: st.track, group: st.group };
    const u = Math.trunc(pyRound(S.unitSize(...center(b))));
    let sum = 0;
    for (let y = Math.max(0, b[1]); y < Math.min(L.symbols.h, b[3]); y++)
      for (let x = b[2] + 1; x < b[2] + u && x < L.symbols.w; x++) sum += L.symbols.d[y * L.symbols.w + x];
    if (0 < sum && sum < u ** 2 / 7) r.hasDot = true;
    return r;
  });
  return { barlines, clefs, sfns, rests };
}
