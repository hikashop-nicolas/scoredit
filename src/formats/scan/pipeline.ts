// oemer's post-processing, from the two networks' class maps to MusicXML.
import { buildMusicXml } from "./build";
import { coordsFromRows, dewarp, estimateCoords, type SampledLine } from "./dewarp";
import { extractGroups } from "./group";
import type { Img } from "./ndimage";
import { extractNotes, pySlice } from "./notehead";
import { extractRhythm } from "./rhythm";
import { extractStaffs, Staffs, type Layers } from "./staff";
import type { Classifiers } from "./svm";
import { extractSymbols } from "./symbols";

/** Class maps at the same size (unet or classic: 1 staff, 2 symbol, 3 both; seg: 1 stem/rest, 2 notehead, 3 clef/key). */
export interface ClassMaps {
  w: number;
  h: number;
  unet: Uint8Array;
  seg: Uint8Array;
  /** Staff lines already followed across the page (classic detector): deskew from them. */
  lines?: SampledLine[];
}

/** The layers oemer works on; with deskew, each map straightened along the staff lines first. */
export function layersOf(m: ClassMaps, deskew = false): Layers {
  const { w, h } = m;
  const n = w * h;
  const L = (f: (i: number) => number): Img => {
    const d = new Float32Array(n);
    for (let i = 0; i < n; i++) d[i] = f(i);
    return { w, h, d };
  };
  // Bit 1 staff, bit 2 symbol (the classic detector sets both where a symbol crosses a line).
  let staff = L((i) => m.unet[i] & 1);
  let sym = L((i) => (m.unet[i] >> 1) & 1);
  let stems = L((i) => +(m.seg[i] === 1));
  let notehead = L((i) => +(m.seg[i] === 2));
  let clefs = L((i) => +(m.seg[i] === 3));
  const coords = !deskew ? null : m.lines ? coordsFromRows(m.lines, w, h) : estimateCoords(staff);
  if (coords) [staff, sym, stems, notehead, clefs] = [staff, sym, stems, notehead, clefs].map((a) => dewarp(a, coords));
  const symbols = L((i) => Math.min(1, sym.d[i] + clefs.d[i] + stems.d[i]));
  return { staff, symbols, stems, notehead, clefs };
}

export interface Recognised {
  xml: string;
  /** Places where oemer would have stopped with an error; the port carries on. */
  issues: string[];
  debug: Record<string, unknown>;
  maps?: Record<string, Img<Uint8Array>>;
}

export function recognise(L: Layers, cls: Classifiers, title = "Scan"): Recognised {
  const issues: string[] = [];
  const { staffs, zones } = extractStaffs(L, issues);
  const S = new Staffs(staffs, zones);
  const notes = extractNotes(L, S);
  const { w, h } = L.symbols;
  const noteId: Img<Int32Array> = { w, h, d: new Int32Array(w * h).fill(-1) };
  notes.forEach((n, idx) => {
    const b = n.bbox;
    const [y0, y1] = pySlice(b[1], b[3], h);
    const [x0, x1] = pySlice(b[0], b[2], w);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (L.symbols.d[y * w + x] > 0) noteId.d[y * w + x] = idx;
    n.id = idx;
  });
  const { groups, map: groupMap } = extractGroups(L, S, notes, noteId);
  const sym = extractSymbols(L, S, cls, notes, noteId, groupMap, issues);
  const restsBefore = sym.rests.map((r) => ({ bbox: r.bbox, label: r.label, dot: r.hasDot }));
  const maps = extractRhythm(L, S, groups, notes, noteId, groupMap, sym.barlines, issues);
  const rhythm = notes.map((n) => ({ label: n.rawLabel, dot: n.hasDot, invalid: n.invalid, stem_up: n.stemUp }));
  const xml = buildMusicXml(notes, groups, sym, S.globalUnitSize(), S.tracks(), title);
  const debug = {
    zones: zones.map((z) => [z[0], z[1] - 1]),
    staffs: staffs.map((col) => col.map((st) => ({ y: st.yCenter, x: st.xCenter, unit: st.unitSize, track: st.track, group: st.group }))),
    notes: notes.map((n) => ({ bbox: n.bbox, pos: n.staffLinePos, track: n.track, group: n.group })),
    groups: groups.map((g) => ({ bbox: g.bbox, nids: g.noteIds, stem_up: g.stemUp, has_stem: g.hasStem, track: g.track, group: g.group })),
    barlines: sym.barlines.map((b) => b.bbox),
    clefs: sym.clefs.map((c) => ({ bbox: c.bbox, label: c.label })),
    sfns: sym.sfns.map((s) => ({ bbox: s.bbox, label: s.label, note: s.noteId })),
    rests: restsBefore,
    rhythm,
  };
  return { xml, issues, debug, maps };
}
