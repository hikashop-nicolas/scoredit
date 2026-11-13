// Glyph names from an embedded font program: the CFF charset (glyph id to name), reached
// through the OpenType wrapper pdf.js builds and its cmap (font char to glyph id).
// References: Adobe TN 5176 (CFF), OpenType spec (sfnt, cmap).

/** The ASCII part of the CFF standard strings (SID 0 to 95); later SIDs are rare in music fonts. */
const STD_ASCII = [
  ".notdef", "space", "exclam", "quotedbl", "numbersign", "dollar", "percent", "ampersand", "quoteright", "parenleft", "parenright",
  "asterisk", "plus", "comma", "hyphen", "period", "slash", "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "colon", "semicolon", "less", "equal", "greater", "question", "at",
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split(""),
  "bracketleft", "backslash", "bracketright", "asciicircum", "underscore", "quoteleft",
  ..."abcdefghijklmnopqrstuvwxyz".split(""),
  "braceleft", "bar", "braceright", "asciitilde",
];
const STD_COUNT = 391;

const u16 = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1];
const u32 = (b: Uint8Array, o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const uN = (b: Uint8Array, o: number, n: number) => {
  let v = 0;
  for (let i = 0; i < n; i++) v = v * 256 + b[o + i];
  return v;
};

/** A CFF INDEX at `pos`: its objects as byte ranges, and where the next structure starts. */
export function readIndex(b: Uint8Array, pos: number): { items: [number, number][]; end: number } {
  const count = u16(b, pos);
  if (count === 0) return { items: [], end: pos + 2 };
  const offSize = b[pos + 2];
  const offs: number[] = [];
  for (let i = 0; i <= count; i++) offs.push(uN(b, pos + 3 + i * offSize, offSize));
  const base = pos + 3 + (count + 1) * offSize - 1;
  const items: [number, number][] = [];
  for (let i = 0; i < count; i++) items.push([base + offs[i], base + offs[i + 1]]);
  return { items, end: base + offs[count] };
}

/** A CFF DICT: operator (12 x escaped as 1200 + x) to its operands. */
export function readDict(b: Uint8Array, start: number, end: number): Map<number, number[]> {
  const dict = new Map<number, number[]>();
  let ops: number[] = [];
  for (let p = start; p < end; ) {
    const b0 = b[p];
    if (b0 <= 21) {
      const op = b0 === 12 ? 1200 + b[p + 1] : b0;
      p += b0 === 12 ? 2 : 1;
      dict.set(op, ops);
      ops = [];
    } else if (b0 === 28) {
      ops.push(((b[p + 1] << 24) | (b[p + 2] << 16)) >> 16);
      p += 3;
    } else if (b0 === 29) {
      ops.push(u32(b, p + 1) | 0);
      p += 5;
    } else if (b0 === 30) {
      // Real number: nibbles up to an 0xf terminator; the value is not needed here.
      p++;
      while (p < end && (b[p] & 0x0f) !== 0x0f && (b[p] & 0xf0) !== 0xf0) p++;
      p++;
      ops.push(0);
    } else if (b0 >= 32 && b0 <= 246) {
      ops.push(b0 - 139);
      p++;
    } else if (b0 >= 247 && b0 <= 250) {
      ops.push((b0 - 247) * 256 + b[p + 1] + 108);
      p += 2;
    } else if (b0 >= 251 && b0 <= 254) {
      ops.push(-(b0 - 251) * 256 - b[p + 1] - 108);
      p += 2;
    } else p++;
  }
  return dict;
}

/** Glyph names by glyph id from a bare CFF font (first font of the set), or null for CID fonts. */
export function cffGlyphNames(b: Uint8Array): string[] | null {
  if (b.length < 4 || b[0] !== 1) return null;
  const names = readIndex(b, b[2]);
  const top = readIndex(b, names.end);
  const strings = readIndex(b, top.end);
  if (!top.items.length) return null;
  const dict = readDict(b, top.items[0][0], top.items[0][1]);
  if (dict.has(1230)) return null;
  const csOff = dict.get(17)?.[0];
  if (csOff === undefined) return null;
  const nGlyphs = readIndex(b, csOff).items.length;
  const dec = new TextDecoder("latin1");
  const sidName = (sid: number) => {
    if (sid < STD_ASCII.length) return STD_ASCII[sid];
    if (sid < STD_COUNT) return `sid${sid}`;
    const s = strings.items[sid - STD_COUNT];
    return s ? dec.decode(b.subarray(s[0], s[1])) : `sid${sid}`;
  };
  const out: string[] = [".notdef"];
  const charset = dict.get(15)?.[0] ?? 0;
  if (charset <= 2) {
    // Predefined charsets: only ISOAdobe (SID = glyph id) matters for music fonts.
    for (let g = 1; g < nGlyphs; g++) out.push(sidName(g));
    return out;
  }
  const format = b[charset];
  let p = charset + 1;
  while (out.length < nGlyphs && p < b.length) {
    if (format === 0) {
      out.push(sidName(u16(b, p)));
      p += 2;
    } else {
      const first = u16(b, p);
      const left = format === 1 ? b[p + 2] : u16(b, p + 2);
      p += format === 1 ? 3 : 4;
      for (let i = 0; i <= left && out.length < nGlyphs; i++) out.push(sidName(first + i));
    }
  }
  return out;
}

/** The tables of an OpenType / TrueType font, by tag. */
export function sfntTables(b: Uint8Array): Map<string, Uint8Array> | null {
  if (b.length < 12) return null;
  const tag = String.fromCharCode(b[0], b[1], b[2], b[3]);
  if (tag !== "OTTO" && tag !== "true" && u32(b, 0) !== 0x00010000) return null;
  const n = u16(b, 4);
  const out = new Map<string, Uint8Array>();
  for (let i = 0; i < n; i++) {
    const r = 12 + i * 16;
    if (r + 16 > b.length) break;
    const off = u32(b, r + 8);
    const len = u32(b, r + 12);
    out.set(String.fromCharCode(b[r], b[r + 1], b[r + 2], b[r + 3]), b.subarray(off, Math.min(b.length, off + len)));
  }
  return out;
}

/** A cmap table's best Unicode / symbol subtable (formats 4 and 12): char code to glyph id. */
export function readCmap(t: Uint8Array): Map<number, number> {
  const out = new Map<number, number>();
  const n = u16(t, 2);
  const subs: { pid: number; eid: number; off: number }[] = [];
  for (let i = 0; i < n; i++) subs.push({ pid: u16(t, 4 + i * 8), eid: u16(t, 6 + i * 8), off: u32(t, 8 + i * 8) });
  const rank = (s: { pid: number; eid: number }) => (s.pid === 3 && s.eid === 10 ? 0 : s.pid === 3 ? 1 : s.pid === 0 ? 2 : 3);
  for (const s of subs.sort((a, c) => rank(a) - rank(c))) {
    const f = u16(t, s.off);
    if (f === 4) {
      const segX2 = u16(t, s.off + 6);
      const ends = s.off + 14;
      const starts = ends + segX2 + 2;
      const deltas = starts + segX2;
      const ranges = deltas + segX2;
      for (let i = 0; i < segX2 / 2; i++) {
        const end = u16(t, ends + 2 * i);
        const start = u16(t, starts + 2 * i);
        const delta = u16(t, deltas + 2 * i);
        const ro = u16(t, ranges + 2 * i);
        for (let c = start; c <= end && c !== 0xffff; c++) {
          let g: number;
          if (ro === 0) g = (c + delta) & 0xffff;
          else {
            const at = ranges + 2 * i + ro + 2 * (c - start);
            g = at + 1 < t.length ? u16(t, at) : 0;
            if (g) g = (g + delta) & 0xffff;
          }
          if (g) out.set(c, g);
        }
      }
      return out;
    }
    if (f === 12) {
      const groups = u32(t, s.off + 12);
      for (let i = 0; i < groups; i++) {
        const r = s.off + 16 + i * 12;
        const start = u32(t, r);
        const end = u32(t, r + 4);
        const g0 = u32(t, r + 8);
        for (let c = start; c <= end && c - start < 0x10000; c++) out.set(c, g0 + c - start);
      }
      return out;
    }
  }
  return out;
}

export interface FontProgram {
  data?: Uint8Array;
  /** pdf.js's char code to font char (the code point its converted font's cmap uses). */
  toFontChar?: Map<number, number | string>;
}

const cache = new WeakMap<object, ((code: number) => string | undefined) | null>();

/** A lookup from a PDF char code to the glyph's name in the embedded font, when it has names. */
export function glyphNameLookup(font: FontProgram | undefined): ((code: number) => string | undefined) | null {
  if (!font?.data) return null;
  const hit = cache.get(font);
  if (hit !== undefined) return hit;
  let fn: ((code: number) => string | undefined) | null = null;
  const tables = sfntTables(font.data);
  if (tables) {
    const cff = tables.get("CFF ");
    const names = cff ? cffGlyphNames(cff) : null;
    const cmapT = tables.get("cmap");
    if (names && cmapT) {
      // pdf.js's CFF compiler writes the charset one glyph late (".notdef" again at glyph 1).
      if (names[1] === ".notdef") names.splice(0, 1);
      const cmap = readCmap(cmapT);
      const map = font.toFontChar;
      fn = (code) => {
        const fc = map?.get(code);
        const ch = typeof fc === "string" ? fc.codePointAt(0) : (fc ?? code);
        const gid = ch === undefined ? undefined : cmap.get(ch);
        return gid === undefined ? undefined : names[gid];
      };
    }
  }
  cache.set(font, fn);
  return fn;
}
