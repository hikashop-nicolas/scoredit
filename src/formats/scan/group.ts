// Grouping noteheads joined by a stem (oemer's note_group_extraction.py).
import { dilate, label, ones, u8, type Box, type Img } from "./ndimage";
import { NoteType, pySlice, type NoteHead } from "./notehead";
import { mean, pyRound } from "./py";
import { PySet, uniqueSet } from "./sci";
import { center, type Layers, type Staffs } from "./staff";

export class NoteGroup {
  id = 0;
  bbox!: Box; // inclusive max, as oemer's group boxes
  noteIds: number[] = [];
  topNoteIds: number[] = [];
  bottomNoteIds: number[] = [];
  stemUp: boolean | null = null;
  hasStem: boolean | null = null;
  allSameType = false;
  group = 0;
  track = 0;
  get xCenter() {
    return (this.bbox[0] + this.bbox[2]) / 2;
  }
}

// A label map whose labels can be renamed cheaply: pixel label = rep[orig].
class Relabel {
  rep: Int32Array;
  boxes: Int32Array; // per original label: x1, y1, x2, y2 (inclusive)
  constructor(
    public orig: Img<Int32Array>,
    n: number,
  ) {
    this.rep = new Int32Array(n + 1).map((_, i) => i);
    this.boxes = new Int32Array((n + 1) * 4);
    for (let l = 0; l <= n; l++) this.boxes.set([Infinity, Infinity, -1, -1].map((v) => (v === Infinity ? 1 << 30 : v)), l * 4);
    const { w, d } = orig;
    for (let i = 0; i < d.length; i++) {
      const l = d[i];
      const x = i % w;
      const y = (i - x) / w;
      const o = l * 4;
      if (x < this.boxes[o]) this.boxes[o] = x;
      if (y < this.boxes[o + 1]) this.boxes[o + 1] = y;
      if (x > this.boxes[o + 2]) this.boxes[o + 2] = x;
      if (y > this.boxes[o + 3]) this.boxes[o + 3] = y;
    }
  }
  at(i: number) {
    return this.rep[this.orig.d[i]];
  }
  rename(from: number, to: number) {
    for (let k = 0; k < this.rep.length; k++) if (this.rep[k] === from) this.rep[k] = to;
  }
  /** Inclusive box of the pixels currently labelled l. */
  box(l: number): Box | null {
    let b: Box | null = null;
    for (let k = 0; k < this.rep.length; k++) {
      if (this.rep[k] !== l || this.boxes[k * 4 + 2] < 0) continue;
      const o = k * 4;
      b = b
        ? [Math.min(b[0], this.boxes[o]), Math.min(b[1], this.boxes[o + 1]), Math.max(b[2], this.boxes[o + 2]), Math.max(b[3], this.boxes[o + 3])]
        : [this.boxes[o], this.boxes[o + 1], this.boxes[o + 2], this.boxes[o + 3]];
    }
    return b;
  }
}

function groupNoteheads(L: Layers, noteId: Img<Int32Array>, nNotes: number): { groups: Map<number, number[]>; map: Relabel } {
  const ext = dilate(u8(L.stems), ones(3, 2));
  const { w, h } = L.notehead;
  const mix = new Float32Array(w * h);
  for (let i = 0; i < mix.length; i++) {
    const v = L.notehead.d[i] + ext.d[i];
    mix[i] = v > 1 ? 1 : v;
  }
  const lab = label({ w, h, d: mix });
  const map = new Relabel(lab.map, lab.n);
  // Pixel extents of each note id.
  const ext4 = new Int32Array(nNotes * 4).fill(-1);
  const present = new Set<number>();
  for (let i = 0; i < noteId.d.length; i++) {
    const n = noteId.d[i];
    if (n < 0) continue;
    present.add(n);
    const x = i % w;
    const y = (i - x) / w;
    const o = n * 4;
    if (ext4[o] < 0) ext4.set([x, y, x, y], o);
    else {
      ext4[o] = Math.min(ext4[o], x);
      ext4[o + 2] = Math.max(ext4[o + 2], x);
      ext4[o + 3] = Math.max(ext4[o + 3], y);
    }
  }
  const nids = uniqueSet([...present, ...(noteId.d.includes(-1) ? [-1] : [])], -1);
  const groups = new Map<number, number[]>();
  for (const nid of nids) {
    const o = nid * 4;
    const [y0, y1] = pySlice(ext4[o + 1] - 3, ext4[o + 3] + 3, h);
    const [x0, x1] = pySlice(ext4[o], ext4[o + 2], w);
    const vals: number[] = [];
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) vals.push(map.at(y * w + x));
    const labels = uniqueSet(vals, 0);
    if (!labels.size) continue;
    let lab0: number;
    if (labels.size > 1) {
      const inter = labels.intersection(new PySet(groups.keys()));
      if (!inter.size) lab0 = labels.pop();
      else if (inter.size === 1) lab0 = inter.pop();
      else {
        lab0 = inter.pop();
        const tmp = groups.get(lab0)!;
        for (const k of inter) {
          tmp.push(...groups.get(k)!);
          groups.delete(k);
        }
        groups.set(lab0, tmp);
      }
      for (const ll of labels) if (ll !== lab0) map.rename(ll, lab0);
    } else lab0 = labels.pop();
    if (!groups.has(lab0)) groups.set(lab0, []);
    groups.get(lab0)!.push(nid);
  }
  for (let k = 0; k < map.rep.length; k++) if (!groups.has(map.rep[k])) map.rep[k] = 0;
  return { groups, map };
}

function nearbyGid(note: NoteHead, map: Relabel, S: Staffs, ratio = 5): number | null {
  const b = note.bbox;
  const { w } = map.orig;
  const [cx, cy] = center(b);
  const cur = map.at(cy * w + cx);
  const unit = S.unitSize(cx, cy);
  const bw = b[2] - b[0] + 4;
  const sx = b[0] - pyRound(bw / 2);
  const ex = Math.min(sx + bw, w);
  const search = (y: number, bound: number, step: number): [number | null, number | null] => {
    for (;;) {
      if (step > 0 && y >= bound) break;
      if (step < 0 && y < bound) break;
      const yy = Math.trunc(y);
      const [x0, x1] = pySlice(Math.trunc(sx), Math.trunc(ex), w);
      const px: number[] = [];
      const row = yy < 0 ? yy + map.orig.h : yy;
      if (row >= map.orig.h || row < 0) break;
      for (let x = x0; x < x1; x++) px.push(map.at(row * w + x));
      const gids = uniqueSet(px, 0);
      gids.delete(cur);
      if (gids.size) {
        if (gids.size > 1) {
          let best = -1;
          let bc = -1;
          for (const g of gids) {
            const c = px.filter((v) => v === g).length;
            if (c >= bc) {
              bc = c;
              best = g;
            }
          }
          return [best, y];
        }
        return [gids.pop(), y];
      }
      y += step;
    }
    return [null, null];
  };
  const [s1, s2] = S.closest(cx, cy);
  const yUp = Math.min(s1.yUpper, s2.yUpper);
  const yLo = Math.max(s1.yLower, s2.yLower);
  let y = b[1] - 1;
  const [gt, gty] = search(y, Math.max(y - ratio * unit, yUp), -1);
  y = b[3] + 1;
  const [gb, gby] = search(y, Math.min(y + ratio * unit, yLo), 1);
  if (gt !== null && gb !== null) return Math.abs(cy - gty!) < Math.abs(cy - gby!) ? gt : gb;
  return gt ?? gb;
}

function parseStemDirection(groups: Map<number, number[]>, map: Relabel, notes: NoteHead[], S: Staffs): Map<number, number[]> {
  const temp = new Map<number, boolean>();
  for (const [gp, nids] of groups) {
    const gbox = map.box(gp)!;
    const nb = nids.map((n) => notes[n].bbox);
    const nbox = [Math.min(...nb.map((b) => b[0])), Math.min(...nb.map((b) => b[1])), Math.max(...nb.map((b) => b[2])), Math.max(...nb.map((b) => b[3]))];
    const nh = mean(nb.map((b) => b[3] - b[1]));
    const tol = nh * 0.2;
    const higher = gbox[1] < nbox[1] - tol;
    const lower = gbox[3] > nbox[3] + tol;
    if (higher && !lower) {
      temp.set(gp, true);
      for (const n of nids) notes[n].stemUp = true;
      continue;
    }
    if (!higher && lower) {
      temp.set(gp, false);
      for (const n of nids) notes[n].stemUp = false;
      continue;
    }
    if (nids.length === 1) {
      const nid = nids[0];
      const ng = nearbyGid(notes[nid], map, S);
      if (ng !== null && validNewGroup(gp, ng, map, S)) {
        if (temp.has(ng)) notes[nid].stemUp = temp.get(ng)!;
        map.rename(gp, ng);
        groups.get(ng)!.push(nid);
        nids.splice(nids.indexOf(nid), 1);
      }
    }
  }
  return new Map([...groups].filter(([, n]) => n.length > 0));
}

function validNewGroup(ori: number, tar: number, map: Relabel, S: Staffs): boolean {
  const ob = map.box(ori)!;
  const tb = map.box(tar)!;
  const [ox, oy] = center(ob);
  const tx = center(tb)[0];
  return Math.abs(tx - ox) < S.unitSize(ox, oy) * 0.5;
}

function genGroups(groups: Map<number, number[]>, map: Relabel, notes: NoteHead[], S: Staffs): { groups: NoteGroup[]; map: Img<Int32Array> } {
  const out: NoteGroup[] = [];
  const idOf = new Map<number, number>();
  let idx = 0;
  for (const [gid, nids] of groups) {
    const ng = new NoteGroup();
    ng.id = idx;
    ng.noteIds = nids;
    const gbox = map.box(gid)!;
    const nb = nids.map((n) => notes[n].bbox);
    const nbox = [Math.min(...nb.map((b) => b[0])), Math.min(...nb.map((b) => b[1])), Math.max(...nb.map((b) => b[2])), Math.max(...nb.map((b) => b[3]))];
    ng.bbox = gbox;
    for (const n of nids) notes[n].noteGroupId = idx;
    const first = notes[nids[0]];
    if (first.stemUp === null) {
      const nh = mean(nb.map((b) => b[3] - b[1]));
      ng.hasStem = Math.abs(gbox[3] - gbox[1] - (nbox[3] - nbox[1])) > Math.floor(nh / 5);
    } else {
      ng.stemUp = first.stemUp;
      ng.hasStem = true;
    }
    const types = nids.map((n) => notes[n].label);
    ng.allSameType = types.every((t) => t === types[0]);
    let track = first.track;
    let grp = first.group;
    if (!nids.every((n) => notes[n].track === track) || !nids.every((n) => notes[n].group === grp)) {
      const [st] = S.closest((gbox[0] + gbox[2]) / 2, (gbox[1] + gbox[3]) / 2);
      track = st.track;
      grp = st.group;
      for (const n of nids) {
        notes[n].track = st.track;
        notes[n].group = st.group;
      }
    }
    ng.track = track;
    ng.group = grp;
    idOf.set(gid, idx);
    out.push(ng);
    idx++;
  }
  const { w, h } = map.orig;
  const d = new Int32Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = idOf.get(map.at(i)) ?? -1;
  return { groups: out, map: { w, h, d } };
}

export function extractGroups(L: Layers, S: Staffs, notes: NoteHead[], noteId: Img<Int32Array>) {
  const g = groupNoteheads(L, noteId, notes.length);
  const groups = parseStemDirection(g.groups, g.map, notes, S);
  return genGroups(groups, g.map, notes, S);
}

export { NoteType };
