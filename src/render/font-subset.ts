// A TrueType font cut down to a few characters, for embedding in a PDF: read from a TrueType
// (glyf) or OpenType CFF font, whose outlines are then converted to quadratic TrueType ones.

interface Table {
  off: number;
  len: number;
}

/** A parsed OpenType font: its tables and the character map. */
export interface Face {
  bytes: Uint8Array;
  view: DataView;
  tables: Map<string, Table>;
  /** Glyph id of a code point, or 0 when the font has none. */
  glyph(cp: number): number;
}

export function readFace(bytes: Uint8Array): Face {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o: number) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  const kind = tag(0);
  if (kind !== "\0\x01\0\0" && kind !== "OTTO" && kind !== "true") throw new Error(kind === "ttcf" ? "font collections are not supported" : kind === "wOFF" || kind === "wOF2" ? "WOFF fonts are not supported: give a .ttf or .otf" : "not an OpenType font");
  const tables = new Map<string, Table>();
  const n = view.getUint16(4);
  for (let i = 0; i < n; i++) tables.set(tag(12 + i * 16), { off: view.getUint32(20 + i * 16), len: view.getUint32(24 + i * 16) });
  for (const t of ["head", "hhea", "hmtx", "maxp", "cmap"]) if (!tables.has(t)) throw new Error(`font has no ${t} table`);
  if (!tables.has("glyf") && !tables.has("CFF ")) throw new Error("font has neither TrueType nor CFF outlines");
  return { bytes, view, tables, glyph: readCmap(view, tables.get("cmap")!.off) };
}

function readCmap(v: DataView, cmap: number): (cp: number) => number {
  let best = -1;
  let rank = 0;
  for (let i = 0, n = v.getUint16(cmap + 2); i < n; i++) {
    const pid = v.getUint16(cmap + 4 + i * 8);
    const eid = v.getUint16(cmap + 6 + i * 8);
    const off = cmap + v.getUint32(cmap + 8 + i * 8);
    const fmt = v.getUint16(off);
    const r = fmt === 12 && (pid === 3 || pid === 0) ? 3 : fmt === 4 && ((pid === 3 && eid === 1) || pid === 0) ? 2 : 0;
    if (r > rank) [best, rank] = [off, r];
  }
  if (best < 0) return () => 0;
  const off = best;
  if (v.getUint16(off) === 12) {
    const groups = v.getUint32(off + 12);
    return (cp) => {
      let [lo, hi] = [0, groups - 1];
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const g = off + 16 + mid * 12;
        if (cp < v.getUint32(g)) hi = mid - 1;
        else if (cp > v.getUint32(g + 4)) lo = mid + 1;
        else return v.getUint32(g + 8) + cp - v.getUint32(g);
      }
      return 0;
    };
  }
  const segs = v.getUint16(off + 6) / 2;
  const ends = off + 14;
  const starts = ends + segs * 2 + 2;
  const deltas = starts + segs * 2;
  const ranges = deltas + segs * 2;
  return (cp) => {
    if (cp > 0xffff) return 0;
    let [lo, hi] = [0, segs - 1];
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (v.getUint16(ends + mid * 2) < cp) lo = mid + 1;
      else hi = mid;
    }
    const start = v.getUint16(starts + lo * 2);
    if (cp < start || cp > v.getUint16(ends + lo * 2)) return 0;
    const delta = v.getInt16(deltas + lo * 2);
    const ro = v.getUint16(ranges + lo * 2);
    if (!ro) return (cp + delta) & 0xffff;
    const g = v.getUint16(ranges + lo * 2 + ro + (cp - start) * 2);
    return g ? (g + delta) & 0xffff : 0;
  };
}

/** The face cut down to these code points (those it has), as a TrueType font. */
export function subsetFace(face: Face, cps: Iterable<number>): Uint8Array {
  const { view: v, tables } = face;
  const map = new Map<number, number>();
  for (const cp of cps) {
    const g = face.glyph(cp);
    if (g) map.set(cp, g);
  }
  const hhea = tables.get("hhea")!.off;
  const numGlyphs = v.getUint16(tables.get("maxp")!.off + 4);
  const glyphs = tables.has("glyf") ? trueTypeGlyphs(face) : cffGlyphs(face);
  // Glyph 0 (.notdef) first, then the glyphs used and the components they are built from.
  const order = [0];
  const index = new Map<number, number>([[0, 0]]);
  const add = (g: number) => {
    if (g >= numGlyphs || index.has(g)) return;
    index.set(g, order.length);
    order.push(g);
    for (const c of glyphs.components(g)) add(c);
  };
  for (const g of [...map.values()].sort((a, b) => a - b)) add(g);

  const glyf: Uint8Array[] = order.map((g) => glyphs.data(g, (c) => index.get(c) ?? 0));
  const loca = new Uint8Array((order.length + 1) * 4);
  const lv = new DataView(loca.buffer);
  let at = 0;
  glyf.forEach((d, i) => {
    lv.setUint32(i * 4, at);
    at += d.length + ((4 - (d.length % 4)) % 4);
  });
  lv.setUint32(order.length * 4, at);
  const glyfBytes = new Uint8Array(at);
  at = 0;
  for (const d of glyf) {
    glyfBytes.set(d, at);
    at += d.length + ((4 - (d.length % 4)) % 4);
  }

  const hmtxOff = tables.get("hmtx")!.off;
  const metrics = v.getUint16(hhea + 34);
  const hmtx = new Uint8Array(order.length * 4);
  const hv = new DataView(hmtx.buffer);
  order.forEach((g, i) => {
    const m = Math.min(g, metrics - 1);
    hv.setUint16(i * 4, v.getUint16(hmtxOff + m * 4));
    hv.setInt16(i * 4 + 2, g < metrics ? v.getInt16(hmtxOff + g * 4 + 2) : v.getInt16(hmtxOff + metrics * 4 + (g - metrics) * 2));
  });

  const copy = (t: string) => {
    const e = tables.get(t);
    return e ? face.bytes.slice(e.off, e.off + e.len) : null;
  };
  const headB = copy("head")!;
  const hdv = new DataView(headB.buffer);
  hdv.setUint32(8, 0);
  hdv.setInt16(50, 1);
  const hheaB = copy("hhea")!;
  new DataView(hheaB.buffer).setUint16(34, order.length);
  const maxp = new Uint8Array(32);
  const mv = new DataView(maxp.buffer);
  const src = tables.get("maxp")!.off;
  if (tables.has("glyf") && v.getUint32(src) === 0x10000) maxp.set(face.bytes.subarray(src, src + 32));
  else {
    mv.setUint32(0, 0x10000);
    mv.setUint16(6, glyphs.maxPoints);
    mv.setUint16(8, glyphs.maxContours);
    mv.setUint16(14, 2);
  }
  mv.setUint16(4, order.length);
  const post = new Uint8Array(32);
  const src32 = tables.get("post");
  if (src32) post.set(face.bytes.subarray(src32.off + 4, src32.off + 16), 4);
  new DataView(post.buffer).setUint32(0, 0x30000);

  const out: [string, Uint8Array][] = [
    ["cmap", writeCmap(new Map([...map].map(([cp, g]) => [cp, index.get(g)!])))],
    ["glyf", glyfBytes],
    ["head", headB],
    ["hhea", hheaB],
    ["hmtx", hmtx],
    ["loca", loca],
    ["maxp", maxp],
    ["post", post],
  ];
  for (const t of ["OS/2", "name", ...(tables.has("glyf") ? ["cvt ", "fpgm", "prep", "gasp"] : [])]) {
    const b = copy(t);
    if (b) out.push([t, b]);
  }
  return writeFont(out);
}

interface Glyphs {
  /** The glyph's glyf record, its component glyph ids renumbered by `id`. */
  data(g: number, id: (g: number) => number): Uint8Array;
  components(g: number): number[];
  maxPoints: number;
  maxContours: number;
}

function trueTypeGlyphs(face: Face): Glyphs {
  const { view: v, tables, bytes } = face;
  const long = v.getInt16(tables.get("head")!.off + 50) === 1;
  const loca = tables.get("loca")!.off;
  const glyf = tables.get("glyf")!.off;
  const span = (g: number): [number, number] => (long ? [v.getUint32(loca + g * 4), v.getUint32(loca + g * 4 + 4)] : [v.getUint16(loca + g * 2) * 2, v.getUint16(loca + g * 2 + 2) * 2]);
  // Walks a composite glyph's components: calls back with the offset of each glyph index.
  const walk = (g: number, each: (at: number) => void) => {
    const [a, b] = span(g);
    if (b <= a || v.getInt16(glyf + a) >= 0) return;
    let p = glyf + a + 10;
    for (;;) {
      const flags = v.getUint16(p);
      each(p + 2);
      p += 4 + (flags & 1 ? 4 : 2) + (flags & 8 ? 2 : flags & 0x40 ? 4 : flags & 0x80 ? 8 : 0);
      if (!(flags & 0x20)) break;
    }
  };
  return {
    data(g, id) {
      const [a, b] = span(g);
      const d = bytes.slice(glyf + a, glyf + Math.max(a, b));
      const dv = new DataView(d.buffer);
      walk(g, (at) => dv.setUint16(at - glyf - a, id(v.getUint16(at))));
      return d;
    },
    components(g) {
      const out: number[] = [];
      walk(g, (at) => out.push(v.getUint16(at)));
      return out;
    },
    maxPoints: 0,
    maxContours: 0,
  };
}

// ---- CFF

interface Index {
  count: number;
  item(i: number): [number, number];
  end: number;
}

function readIndex(b: Uint8Array, at: number): Index {
  const count = (b[at] << 8) | b[at + 1];
  if (!count) return { count, item: () => [0, 0], end: at + 2 };
  const size = b[at + 2];
  const offs = at + 3;
  const data = offs + (count + 1) * size - 1;
  const off = (i: number) => {
    let x = 0;
    for (let k = 0; k < size; k++) x = x * 256 + b[offs + i * size + k];
    return x;
  };
  return { count, item: (i) => [data + off(i), data + off(i + 1)], end: data + off(count) };
}

function readDict(b: Uint8Array, at: number, end: number): Map<number, number[]> {
  const dict = new Map<number, number[]>();
  let ops: number[] = [];
  while (at < end) {
    const c = b[at++];
    if (c <= 21) {
      dict.set(c === 12 ? 1200 + b[at++] : c, ops);
      ops = [];
    } else if (c === 28) {
      ops.push(((b[at] << 24) | (b[at + 1] << 16)) >> 16);
      at += 2;
    } else if (c === 29) {
      ops.push((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]);
      at += 4;
    } else if (c === 30) {
      let s = "";
      for (;;) {
        const x = b[at++];
        const nib = [x >> 4, x & 15];
        let stop = false;
        for (const n of nib) {
          if (n === 15) stop = true;
          else if (!stop) s += n < 10 ? String(n) : ["", "", ".", "E", "E-", "", "-"][n - 8] ?? "";
        }
        if (stop) break;
      }
      ops.push(parseFloat(s));
    } else if (c >= 32 && c <= 246) ops.push(c - 139);
    else if (c >= 247 && c <= 250) ops.push((c - 247) * 256 + b[at++] + 108);
    else if (c >= 251 && c <= 254) ops.push(-(c - 251) * 256 - b[at++] - 108);
  }
  return dict;
}

const bias = (n: number) => (n < 1240 ? 107 : n < 33900 ? 1131 : 32768);

function cffGlyphs(face: Face): Glyphs {
  const b = face.bytes;
  const base = face.tables.get("CFF ")!.off;
  const names = readIndex(b, base + b[base + 2]);
  const tops = readIndex(b, names.end);
  const strings = readIndex(b, tops.end);
  const gsubrs = readIndex(b, strings.end);
  const top = readDict(b, ...tops.item(0));
  const charStrings = readIndex(b, base + top.get(17)![0]);
  const upem = face.view.getUint16(face.tables.get("head")!.off + 18);
  const scale = (top.get(1207)?.[0] ?? 0.001) * upem;
  const privateSubrs = (p: number[] | undefined): Index | null => {
    if (!p) return null;
    const pd = readDict(b, base + p[1], base + p[1] + p[0]);
    const s = pd.get(19);
    return s ? readIndex(b, base + p[1] + s[0]) : null;
  };
  // Local subroutines per glyph: one set, or one per font DICT of a CID-keyed font.
  let localOf: (g: number) => Index | null;
  if (top.has(1236)) {
    const fds = readIndex(b, base + top.get(1236)![0]);
    const subrs = Array.from({ length: fds.count }, (_, i) => privateSubrs(readDict(b, ...fds.item(i)).get(18)));
    const sel = base + top.get(1237)![0];
    if (b[sel] === 0) localOf = (g) => subrs[b[sel + 1 + g]] ?? null;
    else {
      const n = (b[sel + 1] << 8) | b[sel + 2];
      localOf = (g) => {
        for (let i = 0; i < n; i++) {
          const r = sel + 3 + i * 3;
          const next = (b[r + 3] << 8) | b[r + 4];
          if (g >= ((b[r] << 8) | b[r + 1]) && g < next) return subrs[b[r + 2]] ?? null;
        }
        return null;
      };
    }
  } else {
    const subrs = privateSubrs(top.get(18));
    localOf = () => subrs;
  }
  const g: Glyphs = {
    data(gid) {
      if (gid >= charStrings.count) return new Uint8Array(0);
      const contours = charStringContours(b, charStrings.item(gid), gsubrs, localOf(gid), scale);
      const d = encodeGlyph(contours);
      g.maxPoints = Math.max(g.maxPoints, contours.reduce((s, c) => s + c.length, 0));
      g.maxContours = Math.max(g.maxContours, contours.length);
      return d;
    },
    components: () => [],
    maxPoints: 0,
    maxContours: 0,
  };
  return g;
}

/** A contour: points with whether each is on the curve. */
type Contour = [x: number, y: number, on: boolean][];

function charStringContours(b: Uint8Array, [start, end]: [number, number], gsubrs: Index, lsubrs: Index | null, scale: number): Contour[] {
  const contours: Contour[] = [];
  let cur: Contour | null = null;
  let x = 0;
  let y = 0;
  let stems = 0;
  let width = false;
  let stack: number[] = [];
  const close = () => {
    if (cur && cur.length > 1) {
      const [fx, fy] = cur[0];
      const last = cur[cur.length - 1];
      if (last[0] === fx && last[1] === fy && last[2]) cur.pop();
      contours.push(cur);
    }
    cur = null;
  };
  const move = (dx: number, dy: number) => {
    close();
    x += dx;
    y += dy;
    cur = [[x, y, true]];
  };
  const line = (dx: number, dy: number) => {
    x += dx;
    y += dy;
    cur?.push([x, y, true]);
  };
  const curve = (a: number, b2: number, c: number, d: number, e: number, f: number) => {
    const p0 = [x, y];
    const p1 = [x + a, y + b2];
    const p2 = [p1[0] + c, p1[1] + d];
    const p3 = [p2[0] + e, p2[1] + f];
    x = p3[0];
    y = p3[1];
    if (!cur) return;
    // Cubic to quadratics: split in n, each piece's control point from its tangents.
    const len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) + Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) + Math.hypot(p3[0] - p2[0], p3[1] - p2[1]);
    const n = Math.max(1, Math.min(8, Math.ceil(len / (120 / scale))));
    const at = (t: number, k: 0 | 1) => (1 - t) ** 3 * p0[k] + 3 * (1 - t) ** 2 * t * p1[k] + 3 * (1 - t) * t * t * p2[k] + t ** 3 * p3[k];
    const dt = (t: number, k: 0 | 1) => 3 * (1 - t) ** 2 * (p1[k] - p0[k]) + 6 * (1 - t) * t * (p2[k] - p1[k]) + 3 * t * t * (p3[k] - p2[k]);
    for (let i = 0; i < n; i++) {
      const [t0, t1] = [i / n, (i + 1) / n];
      const h = (t1 - t0) / 3;
      const c1 = [at(t0, 0) + dt(t0, 0) * h, at(t0, 1) + dt(t0, 1) * h];
      const c2 = [at(t1, 0) - dt(t1, 0) * h, at(t1, 1) - dt(t1, 1) * h];
      const e0 = [at(t0, 0), at(t0, 1)];
      const e1 = [at(t1, 0), at(t1, 1)];
      cur.push([(3 * (c1[0] + c2[0]) - e0[0] - e1[0]) / 4, (3 * (c1[1] + c2[1]) - e0[1] - e1[1]) / 4, false]);
      cur.push([e1[0], e1[1], true]);
    }
  };
  const hints = () => {
    if (stack.length % 2 && !width) stack.shift();
    width = true;
    stems += stack.length >> 1;
    stack = [];
  };
  const firstArgs = (n: number) => {
    if (!width && stack.length > n) stack.shift();
    width = true;
  };
  let done = false;
  const run = (s: number, e: number, depth: number) => {
    let p = s;
    while (p < e && !done) {
      const op = b[p++];
      if (op >= 32 || op === 28) {
        if (op === 28) {
          stack.push(((b[p] << 24) | (b[p + 1] << 16)) >> 16);
          p += 2;
        } else if (op <= 246) stack.push(op - 139);
        else if (op <= 250) stack.push((op - 247) * 256 + b[p++] + 108);
        else if (op <= 254) stack.push(-(op - 251) * 256 - b[p++] - 108);
        else {
          stack.push(((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) / 65536);
          p += 4;
        }
        continue;
      }
      switch (op) {
        case 1:
        case 3:
        case 18:
        case 23:
          hints();
          break;
        case 19:
        case 20:
          if (stack.length) hints();
          width = true;
          p += (stems + 7) >> 3;
          break;
        case 21:
          firstArgs(2);
          move(stack[0], stack[1]);
          stack = [];
          break;
        case 22:
          firstArgs(1);
          move(stack[0], 0);
          stack = [];
          break;
        case 4:
          firstArgs(1);
          move(0, stack[0]);
          stack = [];
          break;
        case 5:
          for (let i = 0; i + 1 < stack.length; i += 2) line(stack[i], stack[i + 1]);
          stack = [];
          break;
        case 6:
        case 7: {
          let h = op === 6;
          for (const d of stack) {
            h ? line(d, 0) : line(0, d);
            h = !h;
          }
          stack = [];
          break;
        }
        case 8:
        case 24: {
          const curves = op === 24 ? stack.length - 2 : stack.length;
          let i = 0;
          for (; i + 6 <= curves; i += 6) curve(stack[i], stack[i + 1], stack[i + 2], stack[i + 3], stack[i + 4], stack[i + 5]);
          if (op === 24) line(stack[i], stack[i + 1]);
          stack = [];
          break;
        }
        case 25: {
          let i = 0;
          for (; i + 6 < stack.length; i += 2) line(stack[i], stack[i + 1]);
          curve(stack[i], stack[i + 1], stack[i + 2], stack[i + 3], stack[i + 4], stack[i + 5]);
          stack = [];
          break;
        }
        case 26: {
          let i = 0;
          let dx = 0;
          if (stack.length % 4) dx = stack[i++];
          for (; i + 3 < stack.length; i += 4) {
            curve(dx, stack[i], stack[i + 1], stack[i + 2], 0, stack[i + 3]);
            dx = 0;
          }
          stack = [];
          break;
        }
        case 27: {
          let i = 0;
          let dy = 0;
          if (stack.length % 4) dy = stack[i++];
          for (; i + 3 < stack.length; i += 4) {
            curve(stack[i], dy, stack[i + 1], stack[i + 2], stack[i + 3], 0);
            dy = 0;
          }
          stack = [];
          break;
        }
        case 30:
        case 31: {
          let h = op === 31;
          for (let i = 0; i + 3 < stack.length; i += 4) {
            const last = i + 5 === stack.length ? stack[i + 4] : 0;
            if (h) curve(stack[i], 0, stack[i + 1], stack[i + 2], last, stack[i + 3]);
            else curve(0, stack[i], stack[i + 1], stack[i + 2], stack[i + 3], last);
            h = !h;
          }
          stack = [];
          break;
        }
        case 10:
        case 29: {
          const subrs = op === 10 ? lsubrs : gsubrs;
          const i = stack.pop()! + bias(subrs?.count ?? 0);
          if (subrs && i >= 0 && i < subrs.count && depth < 10) run(...subrs.item(i), depth + 1);
          break;
        }
        case 11:
          return;
        case 14:
          firstArgs(stack.length >= 4 ? 4 : 0);
          close();
          done = true;
          return;
        case 12: {
          const op2 = b[p++];
          const s2 = stack;
          if (op2 === 35) {
            curve(s2[0], s2[1], s2[2], s2[3], s2[4], s2[5]);
            curve(s2[6], s2[7], s2[8], s2[9], s2[10], s2[11]);
          } else if (op2 === 34) {
            curve(s2[0], 0, s2[1], s2[2], s2[3], 0);
            curve(s2[4], 0, s2[5], -s2[2], s2[6], 0);
          } else if (op2 === 36) {
            curve(s2[0], s2[1], s2[2], s2[3], s2[4], 0);
            curve(s2[5], 0, s2[6], s2[7], s2[8], -(s2[1] + s2[3] + s2[7]));
          } else if (op2 === 37) {
            const dx = s2[0] + s2[2] + s2[4] + s2[6] + s2[8];
            const dy = s2[1] + s2[3] + s2[5] + s2[7] + s2[9];
            curve(s2[0], s2[1], s2[2], s2[3], s2[4], s2[5]);
            if (Math.abs(dx) > Math.abs(dy)) curve(s2[6], s2[7], s2[8], s2[9], s2[10], -dy);
            else curve(s2[6], s2[7], s2[8], s2[9], -dx, s2[10]);
          }
          stack = [];
          break;
        }
        default:
          stack = [];
      }
    }
  };
  run(start, end, 0);
  close();
  if (scale !== 1) for (const c of contours) for (const pt of c) [pt[0], pt[1]] = [pt[0] * scale, pt[1] * scale];
  return contours;
}

function encodeGlyph(contours: Contour[]): Uint8Array {
  const pts = contours.flat().map(([x, y, on]) => [Math.round(x), Math.round(y), on] as const);
  if (!pts.length) return new Uint8Array(0);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const out = new Uint8Array(10 + contours.length * 2 + 2 + pts.length * 5);
  const v = new DataView(out.buffer);
  v.setInt16(0, contours.length);
  v.setInt16(2, Math.min(...xs));
  v.setInt16(4, Math.min(...ys));
  v.setInt16(6, Math.max(...xs));
  v.setInt16(8, Math.max(...ys));
  let p = 10;
  let n = 0;
  for (const c of contours) {
    n += c.length;
    v.setUint16(p, n - 1);
    p += 2;
  }
  v.setUint16(p, 0);
  p += 2;
  for (const pt of pts) out[p++] = pt[2] ? 1 : 0;
  let last = 0;
  for (const pt of pts) {
    v.setInt16(p, pt[0] - last);
    last = pt[0];
    p += 2;
  }
  last = 0;
  for (const pt of pts) {
    v.setInt16(p, pt[1] - last);
    last = pt[1];
    p += 2;
  }
  return out;
}

function writeCmap(map: Map<number, number>): Uint8Array {
  const bmp = [...map].filter(([cp]) => cp < 0xffff).sort((a, b) => a[0] - b[0]);
  const all = [...map].sort((a, b) => a[0] - b[0]);
  const segs = bmp.length + 1;
  const f4 = new Uint8Array(16 + segs * 8);
  const v4 = new DataView(f4.buffer);
  v4.setUint16(0, 4);
  v4.setUint16(2, f4.length);
  v4.setUint16(6, segs * 2);
  const pow = 2 ** Math.floor(Math.log2(segs));
  v4.setUint16(8, pow * 2);
  v4.setUint16(10, Math.log2(pow));
  v4.setUint16(12, segs * 2 - pow * 2);
  const ends = 14;
  const starts = ends + segs * 2 + 2;
  const deltas = starts + segs * 2;
  [...bmp, [0xffff, 0] as [number, number]].forEach(([cp, g], i) => {
    v4.setUint16(ends + i * 2, cp);
    v4.setUint16(starts + i * 2, cp);
    v4.setUint16(deltas + i * 2, cp === 0xffff ? 1 : (g - cp) & 0xffff);
  });
  const f12 = new Uint8Array(16 + all.length * 12);
  const v12 = new DataView(f12.buffer);
  v12.setUint16(0, 12);
  v12.setUint32(4, f12.length);
  v12.setUint32(12, all.length);
  all.forEach(([cp, g], i) => {
    v12.setUint32(16 + i * 12, cp);
    v12.setUint32(20 + i * 12, cp);
    v12.setUint32(24 + i * 12, g);
  });
  const out = new Uint8Array(4 + 16 + f4.length + f12.length);
  const v = new DataView(out.buffer);
  v.setUint16(2, 2);
  v.setUint16(4, 3);
  v.setUint16(6, 1);
  v.setUint32(8, 20);
  v.setUint16(12, 3);
  v.setUint16(14, 10);
  v.setUint32(16, 20 + f4.length);
  out.set(f4, 20);
  out.set(f12, 20 + f4.length);
  return out;
}

function checksum(b: Uint8Array): number {
  const padded = new Uint8Array(b.length + ((4 - (b.length % 4)) % 4));
  padded.set(b);
  const v = new DataView(padded.buffer);
  let s = 0;
  for (let i = 0; i < padded.length; i += 4) s = (s + v.getUint32(i)) >>> 0;
  return s;
}

function writeFont(tables: [string, Uint8Array][]): Uint8Array {
  tables.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const n = tables.length;
  let size = 12 + n * 16;
  for (const [, d] of tables) size += d.length + ((4 - (d.length % 4)) % 4);
  const out = new Uint8Array(size);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x10000);
  v.setUint16(4, n);
  const pow = 2 ** Math.floor(Math.log2(n));
  v.setUint16(6, pow * 16);
  v.setUint16(8, Math.log2(pow));
  v.setUint16(10, n * 16 - pow * 16);
  let at = 12 + n * 16;
  let headAt = -1;
  tables.forEach(([tag, d], i) => {
    const r = 12 + i * 16;
    for (let k = 0; k < 4; k++) out[r + k] = tag.charCodeAt(k);
    v.setUint32(r + 4, checksum(d));
    v.setUint32(r + 8, at);
    v.setUint32(r + 12, d.length);
    out.set(d, at);
    if (tag === "head") headAt = at;
    at += d.length + ((4 - (d.length % 4)) % 4);
  });
  if (headAt >= 0) v.setUint32(headAt + 8, (0xb1b0afba - checksum(out)) >>> 0);
  return out;
}
