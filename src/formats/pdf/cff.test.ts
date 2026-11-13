import { describe, expect, it } from "vitest";
import { cffGlyphNames, glyphNameLookup, readCmap, readDict, readIndex, sfntTables } from "./cff";
import { emmentalerMapper } from "./emmentaler";
import type { PdfGlyph } from "./extract";
import { DROP } from "./smufl";

const enc = (s: string) => Array.from(new TextEncoder().encode(s));
const u16 = (v: number) => [(v >> 8) & 0xff, v & 0xff];
const u32 = (v: number) => [(v >>> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];

/** A CFF INDEX with 2-byte offsets. */
function index(items: number[][]): number[] {
  if (!items.length) return [0, 0];
  const offs = [1];
  for (const it of items) offs.push(offs[offs.length - 1] + it.length);
  return [...u16(items.length), 2, ...offs.flatMap(u16), ...items.flat()];
}

/** An integer DICT operand in its 5-byte form, so offsets can be patched without changing sizes. */
const int32 = (v: number) => [29, ...u32(v)];

/** A minimal CFF: glyph names given by SID (custom ones go to the String INDEX). */
function buildCff(names: string[], format: 0 | 1 = 0): Uint8Array {
  const custom = names.slice(1).filter((n) => !["space", "period", "zero", "one", "f"].includes(n));
  const std: Record<string, number> = { space: 1, period: 15, zero: 17, one: 18, f: 71 };
  const sid = (n: string) => std[n] ?? 391 + custom.indexOf(n);
  const header = [1, 0, 4, 2];
  const nameIdx = index([enc("Test")]);
  const strIdx = index(custom.map(enc));
  const gsubr = index([]);
  const charStrings = index(names.map(() => [14]));
  let charset: number[];
  if (format === 0) charset = [0, ...names.slice(1).flatMap((n) => u16(sid(n)))];
  else charset = [1, ...names.slice(1).flatMap((n) => [...u16(sid(n)), 0])];
  // Top DICT: charset (15) and CharStrings (17) offsets, patched once the layout is known.
  const topLen = index([[...int32(0), 15, ...int32(0), 17]]).length;
  const base = header.length + nameIdx.length + topLen + strIdx.length + gsubr.length;
  const top = index([[...int32(base + charStrings.length), 15, ...int32(base), 17]]);
  return new Uint8Array([...header, ...nameIdx, ...top, ...strIdx, ...gsubr, ...charStrings, ...charset]);
}

/** A cmap with one format 4 subtable (3,1) mapping consecutive code points from `first`. */
function cmap4(first: number, gids: number[]): number[] {
  const segs = [
    { start: first, end: first + gids.length - 1 },
    { start: 0xffff, end: 0xffff },
  ];
  const segX2 = segs.length * 2;
  // The first segment uses idRangeOffset into the glyph array, the last is the terminator.
  const sub = [
    ...u16(4), ...u16(0), ...u16(0), ...u16(segX2), ...u16(0), ...u16(0), ...u16(0),
    ...segs.flatMap((s) => u16(s.end)), ...u16(0), ...segs.flatMap((s) => u16(s.start)),
    ...u16(0), ...u16(1),
    ...u16(4), ...u16(0),
    ...gids.flatMap(u16),
  ];
  sub.splice(2, 2, ...u16(sub.length));
  return [...u16(0), ...u16(1), ...u16(3), ...u16(1), ...u32(12), ...sub];
}

function sfnt(tables: Record<string, number[]>): Uint8Array {
  const tags = Object.keys(tables);
  let off = 12 + tags.length * 16;
  const dir: number[] = [];
  const body: number[] = [];
  for (const t of tags) {
    dir.push(...enc(t), ...u32(0), ...u32(off), ...u32(tables[t].length));
    body.push(...tables[t]);
    off += tables[t].length;
  }
  return new Uint8Array([...enc("OTTO"), ...u16(tags.length), 0, 0, 0, 0, 0, 0, ...dir, ...body]);
}

describe("CFF structures", () => {
  it("reads an INDEX and the DICT number forms", () => {
    const b = new Uint8Array(index([[1, 2], [3]]));
    const { items, end } = readIndex(b, 0);
    expect(items.map(([s, e]) => Array.from(b.subarray(s, e)))).toEqual([[1, 2], [3]]);
    expect(end).toBe(b.length);
    // 139 is 0, 247 0 is 108, 251 0 is -108, 28 is int16, 29 is int32, 30 a real.
    const d = new Uint8Array([139, 247, 0, 251, 0, 1, 28, 0xff, 0xfe, 29, 0, 1, 0, 0, 2, 30, 0x1a, 0x2f, 3]);
    const dict = readDict(d, 0, d.length);
    expect(dict.get(1)).toEqual([0, 108, -108]);
    expect(dict.get(2)).toEqual([-2, 65536]);
    expect(dict.get(3)).toEqual([0]);
  });

  it("reads glyph names from charset formats 0 and 1", () => {
    const names = [".notdef", "noteheads.s2", "space", "clefs.G", "zero", "f"];
    expect(cffGlyphNames(buildCff(names, 0))).toEqual(names);
    expect(cffGlyphNames(buildCff(names, 1))).toEqual(names);
  });

  it("maps a PDF code to its glyph name through the cmap pdf.js builds", () => {
    const names = [".notdef", "noteheads.s2", "clefs.G", "accidentals.sharp"];
    const data = sfnt({ "CFF ": Array.from(buildCff(names)), cmap: cmap4(0xe000, [1, 2, 3]) });
    const tables = sfntTables(data)!;
    expect(readCmap(tables.get("cmap")!).get(0xe001)).toBe(2);
    const toFontChar = new Map<number, number>([[0, 0xe000], [1, 0xe001], [2, 0xe002]]);
    const look = glyphNameLookup({ data, toFontChar })!;
    expect([0, 1, 2].map(look)).toEqual(["noteheads.s2", "clefs.G", "accidentals.sharp"]);
  });

  it("undoes pdf.js's charset written one glyph late", () => {
    // pdf.js 6 compiles ".notdef" again for glyph 1 and shifts every name by one.
    const shifted = [".notdef", ".notdef", "noteheads.s2", "clefs.G", "accidentals.sharp"];
    const data = sfnt({ "CFF ": Array.from(buildCff(shifted)), cmap: cmap4(0xe000, [1, 2, 3]) });
    const look = glyphNameLookup({ data, toFontChar: new Map([[0, 0xe000], [1, 0xe001]]) })!;
    expect([0, 1].map(look)).toEqual(["noteheads.s2", "clefs.G"]);
  });

  it("gives up on fonts without names", () => {
    expect(glyphNameLookup({ data: new Uint8Array([0, 1, 0, 0, 0, 0]) })).toBeNull();
    expect(glyphNameLookup(undefined)).toBeNull();
  });
});

describe("Emmentaler through its embedded font", () => {
  it("turns renumbered subset codes into SMuFL symbols by glyph name", () => {
    const names = [".notdef", "noteheads.s2", "clefs.G", "fixedwidth.four.alt", "space", "scripts.ictus"];
    const data = sfnt({ "CFF ": Array.from(buildCff(names)), cmap: cmap4(0xe000, [1, 2, 3, 4, 5]) });
    const font = { id: "f1", name: "Emmentaler-20", data, toFontChar: new Map([0, 1, 2, 3, 4].map((c) => [c, 0xe000 + c])) };
    const glyph = (code: number): PdfGlyph => ({ code, unicode: String.fromCharCode(code), font: "Emmentaler-20", fontId: "f1", x: 0, y: 0, size: 20, advance: 5 });
    expect([0, 1, 2, 3, 4].map((c) => emmentalerMapper(glyph(c), font))).toEqual([0xe0a4, 0xe050, 0xe084, null, DROP]);
  });
});
