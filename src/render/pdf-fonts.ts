// Text beyond the PDF standard fonts (Western European only): the host gives a font per script,
// fetched only when the score has text in it, cut down to the characters used and embedded.
import type { jsPDF } from "jspdf";
import { readFace, subsetFace, type Face } from "./font-subset";

/** The scripts a font can be given for. */
export type FontScript = "latin" | "greek" | "cyrillic" | "arabic" | "hebrew" | "japanese" | "chinese" | "korean";
/** A TrueType or OpenType (CFF) font: a URL, its bytes, or a function giving them (called only when needed). */
export type FontSource = string | URL | ArrayBuffer | Uint8Array | (() => FontBytes | Promise<FontBytes>);
type FontBytes = ArrayBuffer | Uint8Array | null | undefined;
/** Fonts by script; a script left out, or given as "" or null, falls back to the standard fonts. */
export type PdfFonts = Partial<Record<FontScript, FontSource | null | undefined>>;

// Characters the standard fonts draw (WinAnsiEncoding).
const WIN_ANSI = new Set([0x152, 0x153, 0x160, 0x161, 0x178, 0x17d, 0x17e, 0x192, 0x2c6, 0x2dc, 0x2013, 0x2014, 0x2018, 0x2019, 0x201a, 0x201c, 0x201d, 0x201e, 0x2020, 0x2021, 0x2022, 0x2026, 0x2030, 0x2039, 0x203a, 0x20ac, 0x2122]);
export const isWinAnsi = (cp: number) => (cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff) || WIN_ANSI.has(cp);

type Kind = FontScript | "han" | "kana";
const RANGES: [number, number, Kind][] = [
  [0x370, 0x3ff, "greek"],
  [0x1f00, 0x1fff, "greek"],
  [0x400, 0x52f, "cyrillic"],
  [0x1c80, 0x1c8f, "cyrillic"],
  [0x2de0, 0x2dff, "cyrillic"],
  [0xa640, 0xa69f, "cyrillic"],
  [0x590, 0x5ff, "hebrew"],
  [0xfb1d, 0xfb4f, "hebrew"],
  [0x600, 0x6ff, "arabic"],
  [0x750, 0x77f, "arabic"],
  [0x8a0, 0x8ff, "arabic"],
  [0xfb50, 0xfdff, "arabic"],
  [0xfe70, 0xfeff, "arabic"],
  [0x3040, 0x30ff, "kana"],
  [0x31f0, 0x31ff, "kana"],
  [0xff66, 0xff9f, "kana"],
  [0x1100, 0x11ff, "korean"],
  [0x3130, 0x318f, "korean"],
  [0xa960, 0xa97f, "korean"],
  [0xac00, 0xd7ff, "korean"],
  [0x2e80, 0x2fdf, "han"],
  [0x3000, 0x303f, "han"],
  [0x3190, 0x31ef, "han"],
  [0x3400, 0x4dbf, "han"],
  [0x4e00, 0x9fff, "han"],
  [0xf900, 0xfaff, "han"],
  [0xfe30, 0xfe4f, "han"],
  [0xff00, 0xff65, "han"],
  [0xffe0, 0xffef, "han"],
  [0x20000, 0x3ffff, "han"],
];

/** Which kind of text a character is, or null when the standard fonts draw it (or it draws nothing). */
function kindOf(cp: number): Kind | null {
  if (isWinAnsi(cp) || cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return null;
  // Private use (music symbols), joiners, marks and variation selectors.
  if ((cp >= 0xe000 && cp <= 0xf8ff) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0xfe00 && cp <= 0xfe0f) || cp === 0xfeff) return null;
  for (const [a, b, k] of RANGES) if (cp >= a && cp <= b) return k;
  return "latin";
}

/** The fonts tried in turn for a kind of text; Han follows the kana, as Omnitext's decks do. */
function candidates(kind: Kind, hansLikely: boolean): FontScript[] {
  switch (kind) {
    case "han":
      return hansLikely ? ["chinese", "japanese", "korean"] : ["japanese", "chinese", "korean"];
    case "kana":
      return ["japanese", "chinese"];
    case "greek":
    case "cyrillic":
      return [kind, "latin"];
    case "latin":
      return ["latin", "cyrillic", "greek"];
    default:
      return [kind];
  }
}

const UNDRAWN = new Set(["encoding", "miscellaneous", "source", "relation"]);

/** The text of a MusicXML document a PDF could show (bookkeeping such as the encoding left out). */
export function scoreText(node: Node): string {
  const out: string[] = [];
  const walk = (n: Node) => {
    for (let c = n.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) out.push((c as Text).data);
      else if (c.nodeType === 1 && !UNDRAWN.has((c as Element).tagName)) walk(c);
    }
  };
  walk(node);
  return out.join(" ");
}

/** The fonts a text needs, in order of preference for each kind of character in it. */
export function scriptsFor(text: string): FontScript[] {
  const kinds = new Set<Kind>();
  for (const ch of text) {
    const k = kindOf(ch.codePointAt(0)!);
    if (k) kinds.add(k);
  }
  const hans = !kinds.has("kana");
  return [...new Set([...kinds].map((k) => candidates(k, hans)[0]))];
}

/** A font loaded for the document, with the characters it draws. */
export interface LoadedFont {
  script: FontScript;
  name: string;
  face: Face;
  chars: Set<number>;
}

/** Fonts for a document, and which one draws each character. */
export interface FontPlan {
  fonts: LoadedFont[];
  fontOf: Map<number, LoadedFont>;
}

async function bytesOf(given: FontSource): Promise<Uint8Array | null> {
  const src = typeof given === "function" ? await given() : given;
  if (src == null || src === "") return null;
  if (src instanceof Uint8Array) return src;
  if (src instanceof ArrayBuffer) return new Uint8Array(src);
  const res = await fetch(src);
  if (!res.ok) throw new Error(`font download failed: ${res.status} ${String(src)}`);
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Loads the fonts the text needs (nothing when it is all Western European) and picks one for
 * each character. A font that is missing or fails to load leaves its characters to the next one.
 */
export async function planFonts(text: string, fonts: PdfFonts | undefined, shape: (s: string) => string = (s) => s): Promise<FontPlan> {
  const plan: FontPlan = { fonts: [], fontOf: new Map() };
  const byKind = new Map<Kind, Set<number>>();
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const k = kindOf(cp);
    if (!k) continue;
    if (!byKind.has(k)) byKind.set(k, new Set());
    byKind.get(k)!.add(cp);
  }
  if (!byKind.size || !fonts) return plan;
  const hans = !byKind.has("kana");
  // One face per source: several scripts may share a font.
  const faces = new Map<unknown, Promise<Face | null>>();
  const faceOf = (src: FontSource) => {
    const key = src instanceof URL ? src.href : src;
    if (!faces.has(key))
      faces.set(
        key,
        bytesOf(src)
          .then((b) => (b ? readFace(b) : null))
          .catch((e) => {
            console.warn("scoredit: PDF font not loaded:", e instanceof Error ? e.message : e);
            return null;
          }),
      );
    return faces.get(key)!;
  };
  const loaded = new Map<FontScript, LoadedFont | null>();
  const fontFor = async (script: FontScript) => {
    if (!loaded.has(script)) {
      const src = fonts[script];
      const face = src == null || src === "" ? null : await faceOf(src);
      const same = face && plan.fonts.find((f) => f.face === face);
      const font = same || (face ? { script, name: `scoredit-${script}`, face, chars: new Set<number>() } : null);
      if (font && !same) plan.fonts.push(font);
      loaded.set(script, font);
    }
    return loaded.get(script)!;
  };
  for (const [kind, cps] of byKind) {
    let left = [...cps];
    for (const script of candidates(kind, hans)) {
      if (!left.length) break;
      const font = await fontFor(script);
      if (!font) continue;
      left = left.filter((cp) => !font.face.glyph(cp) || (plan.fontOf.set(cp, font), font.chars.add(cp), false));
    }
    // What none of its own fonts has may be in another one already loaded.
    for (const cp of left) {
      const font = plan.fonts.find((f) => f.face.glyph(cp));
      if (font) plan.fontOf.set(cp, font), font.chars.add(cp);
    }
  }
  // Spaces, digits and punctuation beside the text are drawn in its font when the font has them.
  const common = new Set<number>();
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0x20 && !kindOf(cp)) common.add(cp);
  }
  for (const font of plan.fonts) for (const cp of common) if (font.face.glyph(cp)) font.chars.add(cp);
  // Arabic is drawn in its presentation forms; right-to-left text with its brackets mirrored.
  const rtl = /[֐-ࣿיִ-﷿ﹰ-﻿]/;
  for (const font of plan.fonts) {
    const own = [...font.chars].map((cp) => String.fromCodePoint(cp)).join("");
    if (!rtl.test(own)) continue;
    const extra = shape(text.split(/\s+/).filter((w) => rtl.test(w)).join(" ")) + " ()[]{}<>«»";
    for (const ch of extra) {
      const cp = ch.codePointAt(0)!;
      if (font.face.glyph(cp)) font.chars.add(cp);
    }
  }
  return plan;
}

const binary = (b: Uint8Array) => {
  let s = "";
  for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192));
  return s;
};

/** Embeds the plan's fonts in the document, each cut down to its characters (and the space). */
export function registerFonts(doc: jsPDF, plan: FontPlan): void {
  for (const f of plan.fonts) {
    const file = `${f.name}.ttf`;
    doc.addFileToVFS(file, binary(subsetFace(f.face, [0x20, ...f.chars])));
    doc.addFont(file, f.name, "normal", "Identity-H");
  }
  // Text in these fonts goes in visual order, as PDF draws it; jsPDF's own reordering is turned off for it.
  const ours = new Set(plan.fonts.map((f) => f.name));
  type Line = string | [string, ...unknown[]];
  type Payload = { text: string | Line[]; options: Record<string, unknown>; mutex: { activeFontKey: string; fonts: Record<string, { fontName: string }> } };
  const events = (doc as unknown as { internal: { events: { subscribe(topic: string, fn: (p: Payload) => void): void } } }).internal.events;
  events.subscribe("preProcessText", (p) => {
    if (!ours.has(p.mutex.fonts[p.mutex.activeFontKey]?.fontName)) return;
    const line = (t: Line): Line => (Array.isArray(t) ? [visualOrder(t[0]), ...t.slice(1)] : visualOrder(t));
    p.text = Array.isArray(p.text) ? p.text.map(line) : visualOrder(p.text);
    p.options = { ...p.options, isInputVisual: true, isOutputVisual: true };
  });
}

const RTL = /[֐-ࣿיִ-﷿ﹰ-﻿]/;
const MIRROR: Record<string, string> = { "(": ")", ")": "(", "[": "]", "]": "[", "{": "}", "}": "{", "<": ">", ">": "<", "«": "»", "»": "«" };
type Bidi = "L" | "R" | "AL" | "EN" | "AN" | "N";
function bidiType(c: string): Bidi {
  if (/[֐-׿יִ-ﭏ]/.test(c)) return "R";
  if (/[٠-٩۰-۹]/.test(c)) return "AN";
  if (/[؀-ࣿﭐ-﷿ﹰ-﻿]/.test(c)) return "AL";
  if (/[0-9０-９]/.test(c)) return "EN";
  return /\p{L}|\p{M}/u.test(c) ? "L" : "N";
}

/** A line in the order its characters are drawn left to right (Unicode bidi, one line, no embeddings). */
export function visualOrder(text: string): string {
  if (!RTL.test(text)) return text;
  const chars = [...text];
  const t = chars.map(bidiType);
  const first = t.find((x) => x === "L" || x === "R" || x === "AL");
  const para = first === "L" ? 0 : 1;
  // Numbers after Arabic letters are Arabic numbers.
  let strong: Bidi = para ? "R" : "L";
  for (let i = 0; i < t.length; i++) {
    if (t[i] === "L" || t[i] === "R" || t[i] === "AL") strong = t[i];
    else if (t[i] === "EN" && strong === "AL") t[i] = "AN";
  }
  // Neutrals take the direction around them when both sides agree (numbers count as right-to-left).
  const base = para ? "R" : "L";
  const dir = t.map((x) => (x === "L" ? "L" : x === "N" ? "" : "R"));
  // Paired brackets take the direction of what they enclose, else of what comes before them.
  const open: number[] = [];
  for (let i = 0; i < chars.length; i++) {
    if ("([{".includes(chars[i])) open.push(i);
    else if (")]}".includes(chars[i]) && open.length && "([{".indexOf(chars[open[open.length - 1]]) === ")]}".indexOf(chars[i])) {
      const a = open.pop()!;
      const inside = new Set(dir.slice(a + 1, i).filter(Boolean));
      if (!inside.size) continue;
      const before = dir.slice(0, a).filter(Boolean).pop() ?? base;
      dir[a] = dir[i] = inside.has(base) ? base : before;
    }
  }
  for (let i = 0; i < dir.length; i++) {
    if (dir[i]) continue;
    let j = i;
    while (j < dir.length && !dir[j]) j++;
    const before = i > 0 ? dir[i - 1] : base;
    const after = j < dir.length ? dir[j] : base;
    for (let k = i; k < j; k++) dir[k] = before === after ? before : base;
    i = j - 1;
  }
  const levels = t.map((x, i) => {
    const num = x === "EN" || x === "AN";
    if (para === 0) return num ? 2 : dir[i] === "R" ? 1 : 0;
    return num || dir[i] === "L" ? 2 : 1;
  });
  const out = chars.map((c, i) => (levels[i] % 2 ? (MIRROR[c] ?? c) : c));
  const order = out.map((_, i) => i);
  for (let level = Math.max(...levels); level >= 1; level--) {
    for (let i = 0; i < order.length; i++) {
      if (levels[order[i]] < level) continue;
      let j = i;
      while (j < order.length && levels[order[j]] >= level) j++;
      order.splice(i, j - i, ...order.slice(i, j).reverse());
      i = j;
    }
  }
  return order.map((i) => out[i]).join("");
}

const SVG = "http://www.w3.org/2000/svg";

/** Puts the text of a page in the plan's fonts: whole elements where one font draws all of it, else in runs. */
export function applyFonts(svg: Element, plan: FontPlan): void {
  if (!plan.fonts.length) return;
  const nodes: Text[] = [];
  for (const t of svg.querySelectorAll("text")) {
    const walker = t.ownerDocument.createTreeWalker(t, 4);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
  }
  for (const node of nodes) {
    const chars = [...(node.data ?? "")];
    const fixed: (LoadedFont | null | undefined)[] = chars.map((ch) => {
      const cp = ch.codePointAt(0)!;
      return kindOf(cp) ? (plan.fontOf.get(cp) ?? null) : undefined;
    });
    if (!fixed.some((f) => f)) continue;
    // Spaces, digits and punctuation go with the font beside them when it has them.
    const near = (i: number, step: number) => {
      for (let j = i + step; j >= 0 && j < fixed.length; j += step) if (fixed[j] !== undefined) return fixed[j];
      return null;
    };
    const font = fixed.map((f, i) => {
      if (f !== undefined) return f;
      const cp = chars[i].codePointAt(0)!;
      const l = near(i, -1);
      if (l?.face.glyph(cp)) return l;
      const r = near(i, 1);
      return r?.face.glyph(cp) ? r : null;
    });
    const runs: [LoadedFont | null, string][] = [];
    font.forEach((f, i) => {
      if (runs.length && runs[runs.length - 1][0] === f) runs[runs.length - 1][1] += chars[i];
      else runs.push([f, chars[i]]);
    });
    const parent = node.parentNode as Element;
    if (runs.length === 1 && parent.childNodes.length === 1) {
      setFont(parent, runs[0][0]!);
      continue;
    }
    const frag = node.ownerDocument.createDocumentFragment();
    for (const [f, s] of runs) {
      if (!f) {
        frag.append(s);
        continue;
      }
      const span = node.ownerDocument.createElementNS(SVG, "tspan");
      span.textContent = s;
      setFont(span, f);
      frag.append(span);
    }
    node.replaceWith(frag);
  }
}

// Each font is embedded in one style: bold and italic text in it is drawn upright.
function setFont(el: Element, f: LoadedFont): void {
  el.setAttribute("font-family", f.name);
  el.setAttribute("font-weight", "normal");
  el.setAttribute("font-style", "normal");
  const style = el.getAttribute("style");
  if (style) el.setAttribute("style", style.replace(/font(-family|-weight|-style)?\s*:[^;]*;?/g, ""));
}
