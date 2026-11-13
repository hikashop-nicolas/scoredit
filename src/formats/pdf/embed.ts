// A score file attached to a PDF, as PDF/A-3 associated files are: an EmbeddedFile stream
// in the catalog's /Names /EmbeddedFiles tree and in its /AF, /AFRelationship /Source.
// Written as an incremental update; read back with pdf.js.
import { readMxl } from "../mxl";
import { parseXml } from "../../model/xml";

export const MXL_MIME = "application/vnd.recordare.musicxml";

export interface PdfAttachment {
  /** File name shown by PDF readers, e.g. "Für Elise.mxl". */
  name: string;
  data: Uint8Array;
  /** Media type, e.g. application/vnd.recordare.musicxml. */
  mime: string;
  description?: string;
}

const latin1 = (b: Uint8Array) => new TextDecoder("latin1").decode(b);
const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
// A PDF literal string, ASCII only; other characters become "_".
const literal = (s: string) => `(${s.replace(/[^\x20-\x7e]/g, "_").replace(/[\\()]/g, "\\$&")})`;
// A PDF text string in UTF-16BE, as hex.
const utf16 = (s: string) => `<FEFF${s.split("").map((c) => c.charCodeAt(0).toString(16).padStart(4, "0")).join("")}>`.toUpperCase();
// A PDF name: delimiters and other non-regular characters as #xx.
const pdfName = (s: string) => "/" + s.replace(/[^!-~]|[#/()<>[\]{}%]/g, (c) => "#" + c.charCodeAt(0).toString(16).padStart(2, "0").toUpperCase());

/**
 * `pdf` with `file` attached, appended as an incremental update (the original bytes are kept).
 * Takes a PDF with a classic xref table and a catalog without /Names or /AF, as jsPDF writes.
 */
export function attachFile(pdf: Uint8Array, file: PdfAttachment): Uint8Array {
  const tail = latin1(pdf.subarray(Math.max(0, pdf.length - 4096)));
  const sx = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(tail);
  if (!sx) throw new Error("PDF has no startxref");
  const prev = Number(sx[1]);
  const xref = latin1(pdf.subarray(prev, pdf.length));
  if (!xref.startsWith("xref")) throw new Error("PDF has no classic xref table");
  const tr = xref.indexOf("trailer");
  const trailer = xref.slice(tr, xref.indexOf("startxref", tr));
  const size = Number(/\/Size\s+(\d+)/.exec(trailer)?.[1]);
  const root = /\/Root\s+(\d+)\s+(\d+)\s+R/.exec(trailer);
  if (tr < 0 || !size || !root) throw new Error("PDF trailer lacks /Size or /Root");
  const [cat, gen] = [Number(root[1]), Number(root[2])];
  const offset = xrefOffset(xref.slice(4, tr), cat);
  // The catalog dictionary, to be written again with the attachment added.
  const body = latin1(pdf.subarray(offset, Math.min(pdf.length, offset + 65536)));
  const dict = /^\s*\d+\s+\d+\s+obj\s*(<<[\s\S]*>>)\s*endobj/.exec(body.slice(0, body.indexOf("endobj") + 6))?.[1];
  if (!dict) throw new Error("PDF catalog not found");
  if (/\/(Names|AF)\b/.test(dict)) throw new Error("PDF catalog already has /Names or /AF");

  const [ef, spec, names] = [size, size + 1, size + 2];
  const parts: (string | Uint8Array)[] = [];
  let at = pdf.length;
  const offsets = new Map<number, number>();
  const push = (p: string | Uint8Array) => {
    parts.push(p);
    at += p.length;
  };
  const obj = (n: number, g: number, text: string) => {
    offsets.set(n, at);
    push(`${n} ${g} obj\n${text}\nendobj\n`);
  };
  if (pdf[pdf.length - 1] !== 0x0a) push("\n");
  const d = new Date();
  const p2 = (n: number) => String(n).padStart(2, "0");
  const date = `(D:${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())}Z)`;
  offsets.set(ef, at);
  push(`${ef} 0 obj\n<< /Type /EmbeddedFile /Subtype ${pdfName(file.mime)} /Length ${file.data.length} /Params << /Size ${file.data.length} /ModDate ${date} >> >>\nstream\n`);
  push(file.data);
  push("\nendstream\nendobj\n");
  const desc = file.description ? ` /Desc ${utf16(file.description)}` : "";
  obj(spec, 0, `<< /Type /Filespec /F ${literal(file.name)} /UF ${utf16(file.name)}${desc} /AFRelationship /Source /EF << /F ${ef} 0 R /UF ${ef} 0 R >> >>`);
  obj(names, 0, `<< /Names [${utf16(file.name)} ${spec} 0 R] >>`);
  obj(cat, gen, `${dict.slice(0, -2).trimEnd()}\n/Names << /EmbeddedFiles ${names} 0 R >>\n/AF [${spec} 0 R]\n>>`);

  // Each xref entry is exactly 20 bytes.
  const entry = (n: number, g: number) => `${String(offsets.get(n)).padStart(10, "0")} ${String(g).padStart(5, "0")} n \n`;
  const start = at;
  const id = /\/ID\s*\[[^\]]*\]/.exec(trailer)?.[0] ?? "";
  const info = /\/Info\s+\d+\s+\d+\s+R/.exec(trailer)?.[0] ?? "";
  push(`xref\n${cat} 1\n${entry(cat, gen)}${ef} 3\n${entry(ef, 0)}${entry(spec, 0)}${entry(names, 0)}`);
  push(`trailer\n<< /Size ${size + 3} /Root ${cat} ${gen} R ${info} ${id} /Prev ${prev} >>\nstartxref\n${start}\n%%EOF\n`);

  const out = new Uint8Array(at);
  out.set(pdf);
  let o = pdf.length;
  for (const p of parts) {
    const b = typeof p === "string" ? ascii(p) : p;
    out.set(b, o);
    o += b.length;
  }
  return out;
}

// Where object `n` starts, from the subsections of a classic xref table.
function xrefOffset(table: string, n: number): number {
  const re = /\s*(\d+) (\d+)[ \t]*\r?\n/y;
  let i = 0;
  for (;;) {
    re.lastIndex = i;
    const m = re.exec(table);
    if (!m) break;
    const [first, count] = [Number(m[1]), Number(m[2])];
    const entries = re.lastIndex;
    if (n >= first && n < first + count) {
      const e = table.slice(entries + (n - first) * 20, entries + (n - first) * 20 + 18);
      if (e.endsWith("n")) return Number(e.slice(0, 10));
      break;
    }
    i = entries + count * 20;
  }
  throw new Error(`Object ${n} is not in the xref table`);
}

/**
 * The MusicXML score attached to a PDF, if any: the first .mxl, .musicxml or .xml attachment
 * (or one whose content looks like either) that parses as a MusicXML score.
 */
export async function readEmbeddedScore(bytes: Uint8Array): Promise<Document | null> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const g = globalThis as { pdfjsWorker?: unknown };
  if (!g.pdfjsWorker && !pdfjs.GlobalWorkerOptions.workerSrc) g.pdfjsWorker = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
  const task = pdfjs.getDocument({ data: bytes.slice(), useSystemFonts: false });
  const doc = await task.promise;
  try {
    const files = await doc.getAttachments().catch(() => null);
    if (!files) return null;
    for (const [id, f] of files) {
      const named = /\.(mxl|musicxml|xml)$/i.test(f.filename || f.rawFilename || "");
      const data = f.content ?? (await doc.getAttachmentContent(id).catch(() => null));
      if (!data) continue;
      const zip = data[0] === 0x50 && data[1] === 0x4b;
      if (!named && !zip && !/^\s*(<\?xml|<!DOCTYPE|<score-)/.test(latin1(data.subarray(0, 64)))) continue;
      try {
        const xml = zip ? readMxl(data) : new TextDecoder().decode(data);
        const score = parseXml(xml);
        const root = score.documentElement.tagName;
        if (root === "score-partwise" || root === "score-timewise") return score;
      } catch {
        /* not MusicXML: try the next one */
      }
    }
    return null;
  } finally {
    await task.destroy();
  }
}
