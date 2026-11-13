// What a score PDF draws, page by page: glyphs (each placed on its own), stroked line
// segments and filled shapes, in points from the page's top-left corner, y down.
// Read with pdf.js (pdfjs-dist, Apache-2.0), loaded on first use.

export interface PdfGlyph {
  /** Character code in its font, and the Unicode it maps to (for SMuFL fonts, the symbol). */
  code: number;
  unicode: string;
  /** The font's name as embedded (subset prefix removed), and its pdf.js id. */
  font: string;
  fontId: string;
  /** Origin of the glyph (left end of its baseline) and the font size, in points. */
  x: number;
  y: number;
  size: number;
  /** How far the glyph moves the pen, in points (its width). */
  advance: number;
}

/** A straight stroked segment: staff and ledger lines, stems, barlines. */
export interface PdfSegment {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  width: number;
}

/** A filled (or curved) path: beams, slurs and ties, hairpins, filled notation drawn as shapes. */
export interface PdfShape {
  /** The path's points, curves reduced to their end and control points. */
  points: [number, number][];
  box: { x0: number; y0: number; x1: number; y1: number };
  filled: boolean;
  stroked: boolean;
  curved: boolean;
  width: number;
}

export interface PdfPage {
  width: number;
  height: number;
  glyphs: PdfGlyph[];
  segments: PdfSegment[];
  shapes: PdfShape[];
  /** Whether the page has images (a scan, or a picture in the score). */
  images: number;
}

export interface PdfFontInfo {
  id: string;
  name: string;
  /** The embedded font program as pdf.js converted it, when kept. */
  data?: Uint8Array;
  /** pdf.js's map from a char code to the code point of that glyph in `data`'s cmap. */
  toFontChar?: Map<number, number | string>;
}

export interface PdfScore {
  pages: PdfPage[];
  fonts: Map<string, PdfFontInfo>;
  info: { title?: string; creator?: string; producer?: string };
}

type Matrix = [number, number, number, number, number, number];
const mul = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];
const apply = (m: Matrix, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const scaleOf = (m: Matrix) => Math.hypot(m[0], m[1]);

interface PdfJsGlyph {
  fontChar: string;
  unicode: string;
  width: number;
  isSpace?: boolean;
  originalCharCode?: number;
}

/** Everything drawn on every page of a PDF. */
export async function extractPdf(bytes: Uint8Array): Promise<PdfScore> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const OPS = pdfjs.OPS as Record<string, number>;
  const task = pdfjs.getDocument({ data: bytes.slice(), fontExtraProperties: true, useSystemFonts: false });
  const doc = await task.promise;
  const meta = await doc.getMetadata().catch(() => null);
  const info = (meta?.info ?? {}) as Record<string, string>;
  const fonts = new Map<string, PdfFontInfo>();
  const pages: PdfPage[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const [, , w, h] = page.view as [number, number, number, number];
    const list = await page.getOperatorList();
    const out: PdfPage = { width: w, height: h, glyphs: [], segments: [], shapes: [], images: 0 };
    // PDF space has y up from the bottom: flip it so y grows down the page.
    let ctm: Matrix = [1, 0, 0, -1, 0, h];
    const stack: { ctm: Matrix; lineWidth: number }[] = [];
    let lineWidth = 1;
    // Text state.
    let tm: Matrix = [1, 0, 0, 1, 0, 0];
    let tlm: Matrix = [1, 0, 0, 1, 0, 0];
    let fontId = "";
    let fontSize = 0;
    let charSpacing = 0;
    let wordSpacing = 0;
    let hScale = 1;
    let leading = 0;
    let rise = 0;
    const fontName = (id: string) => {
      let f = fonts.get(id);
      if (!f) {
        type FontObj = { name?: string; data?: Uint8Array; toFontChar?: unknown };
        let obj: FontObj | null = null;
        try {
          obj = page.commonObjs.get(id) as FontObj;
        } catch {
          obj = null;
        }
        const toFontChar = obj?.toFontChar instanceof Map ? obj.toFontChar : undefined;
        f = { id, name: (obj?.name ?? id).replace(/^[A-Z]{6}\+/, ""), data: obj?.data, toFontChar };
        fonts.set(id, f);
      }
      return f.name;
    };
    const show = (items: (PdfJsGlyph | number | null)[]) => {
      const name = fontName(fontId);
      for (const g of items) {
        if (typeof g === "number") {
          tm = mul(tm, [1, 0, 0, 1, (-g / 1000) * fontSize * hScale, 0]);
          continue;
        }
        if (!g) continue;
        const m = mul(ctm, mul(tm, [fontSize * hScale, 0, 0, fontSize, 0, rise]));
        const [x, y] = apply(m, 0, 0);
        const code = g.originalCharCode ?? g.fontChar.codePointAt(0) ?? 0;
        const advance = ((g.width / 1000) * fontSize + charSpacing + (g.isSpace ? wordSpacing : 0)) * hScale;
        if (!g.isSpace || g.unicode.trim()) out.glyphs.push({ code, unicode: g.unicode, font: name, fontId, x, y, size: scaleOf(m), advance: advance * scaleOf(ctm) * scaleOf(tm) });
        tm = mul(tm, [1, 0, 0, 1, advance, 0]);
      }
    };
    const path = (paintOp: number, data: ArrayLike<number>) => {
      const fill = [OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke].includes(paintOp);
      const stroke = [OPS.stroke, OPS.closeStroke, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke].includes(paintOp);
      if (!fill && !stroke) return;
      const width = lineWidth * scaleOf(ctm);
      // One sub-path at a time: a stroked straight line becomes a segment, the rest shapes.
      let pts: [number, number][] = [];
      let curved = false;
      const flush = () => {
        if (pts.length >= 2 && stroke && !fill && !curved && pts.length === 2) {
          out.segments.push({ x0: pts[0][0], y0: pts[0][1], x1: pts[1][0], y1: pts[1][1], width });
        } else if (pts.length >= 2) {
          const xs = pts.map((q) => q[0]);
          const ys = pts.map((q) => q[1]);
          out.shapes.push({ points: pts, box: { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }, filled: fill, stroked: stroke, curved, width });
        }
        pts = [];
        curved = false;
      };
      for (let k = 0; k < data.length; ) {
        const op = data[k];
        if (op === 0) {
          flush();
          pts.push(apply(ctm, data[k + 1], data[k + 2]));
          k += 3;
        } else if (op === 1) {
          pts.push(apply(ctm, data[k + 1], data[k + 2]));
          k += 3;
        } else if (op === 2) {
          for (let j = 0; j < 3; j++) pts.push(apply(ctm, data[k + 1 + 2 * j], data[k + 2 + 2 * j]));
          curved = true;
          k += 7;
        } else if (op === 3) {
          for (let j = 0; j < 2; j++) pts.push(apply(ctm, data[k + 1 + 2 * j], data[k + 2 + 2 * j]));
          curved = true;
          k += 5;
        } else k += 1;
      }
      flush();
    };
    const { fnArray, argsArray } = list;
    for (let i = 0; i < fnArray.length; i++) {
      const fn = fnArray[i];
      const a = argsArray[i] as unknown[];
      switch (fn) {
        case OPS.save:
          stack.push({ ctm, lineWidth });
          break;
        case OPS.restore: {
          const s = stack.pop();
          if (s) ({ ctm, lineWidth } = s);
          break;
        }
        case OPS.transform:
          ctm = mul(ctm, Array.from(a as ArrayLike<number>) as Matrix);
          break;
        case OPS.paintFormXObjectBegin:
          stack.push({ ctm, lineWidth });
          if (a[0] && (a[0] as ArrayLike<number>).length === 6) ctm = mul(ctm, Array.from(a[0] as ArrayLike<number>) as Matrix);
          break;
        case OPS.paintFormXObjectEnd: {
          const s = stack.pop();
          if (s) ({ ctm, lineWidth } = s);
          break;
        }
        case OPS.setLineWidth:
          lineWidth = a[0] as number;
          break;
        case OPS.constructPath: {
          const d = (a[1] as ArrayLike<number>[])[0];
          if (d) path(a[0] as number, Array.isArray(d) ? d : Object.values(d));
          break;
        }
        case OPS.beginText:
          tm = [1, 0, 0, 1, 0, 0];
          tlm = [1, 0, 0, 1, 0, 0];
          break;
        case OPS.setFont:
          fontId = a[0] as string;
          fontSize = a[1] as number;
          break;
        case OPS.setCharSpacing:
          charSpacing = a[0] as number;
          break;
        case OPS.setWordSpacing:
          wordSpacing = a[0] as number;
          break;
        case OPS.setHScale:
          hScale = (a[0] as number) / 100;
          break;
        case OPS.setLeading:
          leading = a[0] as number;
          break;
        case OPS.setTextRise:
          rise = a[0] as number;
          break;
        case OPS.setTextMatrix:
          tm = tlm = Array.from((Array.isArray(a[0]) || ArrayBuffer.isView(a[0]) ? a[0] : a) as ArrayLike<number>) as Matrix;
          break;
        case OPS.moveText:
          tm = tlm = mul(tlm, [1, 0, 0, 1, a[0] as number, a[1] as number]);
          break;
        case OPS.setLeadingMoveText:
          leading = -(a[1] as number);
          tm = tlm = mul(tlm, [1, 0, 0, 1, a[0] as number, a[1] as number]);
          break;
        case OPS.nextLine:
          tm = tlm = mul(tlm, [1, 0, 0, 1, 0, -leading]);
          break;
        case OPS.showText:
        case OPS.showSpacedText:
          show(a[0] as (PdfJsGlyph | number)[]);
          break;
        case OPS.nextLineShowText:
          tm = tlm = mul(tlm, [1, 0, 0, 1, 0, -leading]);
          show(a[0] as (PdfJsGlyph | number)[]);
          break;
        case OPS.nextLineSetSpacingShowText:
          wordSpacing = a[0] as number;
          charSpacing = a[1] as number;
          tm = tlm = mul(tlm, [1, 0, 0, 1, 0, -leading]);
          show(a[2] as (PdfJsGlyph | number)[]);
          break;
        case OPS.paintImageXObject:
        case OPS.paintInlineImageXObject:
        case OPS.paintImageMaskXObject:
          out.images++;
          break;
      }
    }
    pages.push(out);
    page.cleanup();
  }
  await task.destroy();
  return { pages, fonts, info: { title: info.Title || undefined, creator: info.Creator || undefined, producer: info.Producer || undefined } };
}
