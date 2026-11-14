// PDF export and print pages: the score laid out on paper-sized pages by OSMD's paged mode,
// one SVG per page, then each page drawn into a vector PDF (jsPDF + svg2pdf.js, loaded on use).
import { zlibSync } from "fflate";
import { OpenSheetMusicDisplay } from "opensheetmusicdisplay";
import type { ScoreDoc } from "../model/score";
import { attachFile, MXL_MIME } from "../formats/pdf/embed";
import { writeMxl } from "../formats/mxl";
import { applyFonts, planFonts, registerFonts, scoreText, type PdfFonts } from "./pdf-fonts";

export type { FontScript, FontSource, PdfFonts } from "./pdf-fonts";

export type Paper = "a4" | "letter";

export interface PageOptions {
  /** Paper size; A4 by default. */
  paper?: Paper;
  /** Notation size: 1 is OSMD's default, smaller fits more on a page. */
  zoom?: number;
  /** Called with 0 to 1 while laying out and drawing, steadily: a long score is laid out a few pages at a time. */
  onProgress?(fraction: number): void;
}

// Paper in PDF points (1/72 inch) and the OSMD page format that matches it.
const PAPER: Record<Paper, { w: number; h: number; format: string }> = {
  a4: { w: 595.28, h: 841.89, format: "A4_P" },
  letter: { w: 612, h: 792, format: "Letter_P" },
};
// Page width OSMD lays out at, in CSS pixels: the paper at 96 dpi.
const PX_PER_PT = 96 / 72;
// Gives the page a turn between steps; a message is not slowed down in a background tab as a timer is.
const pause = () =>
  new Promise<void>((r) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => (ch.port1.close(), r());
    ch.port2.postMessage(0);
  });

/**
 * Ends a volta that is never stopped at the end of the bar it starts in, as MuseScore shows it
 * (its MusicXML export can leave a last ending open); OSMD would draw it on to the next one.
 */
export function closeOpenEndings(xml: string, edit?: (doc: Document) => void): string {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  edit?.(doc);
  for (const part of doc.getElementsByTagName("part")) {
    const open = new Map<string, Element>();
    for (const m of part.getElementsByTagName("measure")) {
      for (const e of m.getElementsByTagName("ending")) {
        const n = e.getAttribute("number") ?? "";
        const type = e.getAttribute("type");
        if (type === "start") {
          for (const [k, at] of open) if (at !== m) closeAt(at, k);
          open.clear();
          open.set(n, m);
        } else open.delete(n);
      }
    }
    for (const [k, at] of open) closeAt(at, k);
  }
  return new XMLSerializer().serializeToString(doc);

  function closeAt(m: Element, number: string): void {
    let bl = [...m.children].find((c) => c.tagName === "barline" && c.getAttribute("location") === "right");
    if (!bl) {
      bl = doc.createElementNS(null, "barline");
      bl.setAttribute("location", "right");
      m.appendChild(bl);
    }
    const end = doc.createElementNS(null, "ending");
    end.setAttribute("number", number);
    end.setAttribute("type", "discontinue");
    // In schema order: after bar-style, footnote, level and wavy-line, before repeat.
    const repeat = [...bl.children].find((c) => c.tagName === "repeat");
    bl.insertBefore(end, repeat ?? null);
  }
}

/** The score on pages: one SVG each, white, sized in CSS pixels at 96 dpi. */
export async function renderPages(score: ScoreDoc, opts: PageOptions = {}): Promise<SVGSVGElement[]> {
  const total = Math.max(1, score.measureCount);
  const out: SVGSVGElement[] = [];
  opts.onProgress?.(0);
  for await (const chunk of layOut(score, opts)) {
    out.push(...chunk.pages);
    opts.onProgress?.(Math.min(1, chunk.to / total));
  }
  return out;
}

/** Pages laid out from measure `from` up to (not including) `to`. */
interface Chunk {
  pages: SVGSVGElement[];
  from: number;
  to: number;
}

// Pages kept from one run of OSMD (each run lays out one more), and about how long a run may take,
// so that progress moves and the page answers without too many runs.
const MIN_PAGES = 4;
const MAX_PAGES = 8;
const CHUNK_MS = 1000;

/**
 * Lays the score out a few pages at a time. Each run of OSMD gets a slice of measures and keeps
 * its pages but the last, which the next slice starts with: systems and pages are filled greedily,
 * so the pages kept are those the whole score laid out at once would have.
 */
async function* layOut(score: ScoreDoc, opts: PageOptions): AsyncGenerator<Chunk> {
  const paper = PAPER[opts.paper ?? "a4"];
  const total = score.measureCount;
  const host = document.createElement("div");
  // Laid out off screen: OSMD measures text, so it has to be in the document.
  host.style.cssText = `position:absolute;left:-100000px;top:0;width:${Math.round(paper.w * PX_PER_PT)}px`;
  document.body.append(host);
  try {
    let start = 0;
    // A first guess, a few pages of a score with this many parts; then measured.
    let size = Math.max(8, Math.round(240 / Math.max(1, score.parts.length)));
    for (;;) {
      const end = Math.min(total, start + size);
      const last = end >= total;
      const began = performance.now();
      // Later slices start on a page that goes on: no room is kept for a title there.
      const head = start === 0;
      const osmd = new OpenSheetMusicDisplay(host, {
        autoResize: false,
        backend: "svg",
        pageFormat: paper.format,
        pageBackgroundColor: "#FFFFFF",
        drawTitle: head,
        drawSubtitle: head,
        drawComposer: head,
        drawLyricist: head,
        drawCredits: head,
        drawPartNames: true,
      });
      await osmd.load(sliceXml(score, start, end), "");
      osmd.zoom = opts.zoom ?? 0.7;
      await pause();
      osmd.render();
      const pages = osmd.GraphicSheet.MusicPages;
      let keep = pages.length;
      let next = end;
      if (!last) {
        // The slice's last system is laid out as an end, and may go to a page of its own: pages are
        // kept up to the one with the system before it, which the next slice starts with.
        keep = pages[pages.length - 1].MusicSystems.length > 1 ? pages.length - 1 : pages.length - 2;
        if (keep < 1) {
          // Nothing can be kept yet: take more measures.
          osmd.clear();
          size *= 2;
          await pause();
          continue;
        }
        next = start + firstMeasure(pages[keep]);
      }
      const svgs = osmd.Drawer.Backends.slice(0, keep).map((b) => {
        const svg = (b as unknown as { getSvgElement(): SVGSVGElement }).getSvgElement();
        const page = svg.cloneNode(true) as SVGSVGElement;
        // svg2pdf reads font sizes as pixels: OSMD gives some in points.
        for (const t of page.querySelectorAll("[font-size$='pt']")) t.setAttribute("font-size", `${parseFloat(t.getAttribute("font-size")!) * PX_PER_PT}px`);
        return page;
      });
      const took = performance.now() - began;
      osmd.clear();
      yield { pages: svgs, from: start, to: next };
      if (last) return;
      // The next slice, from the measures a page held and the time a measure took.
      const perPage = (next - start) / keep;
      const perMeasure = took / (end - start);
      size = Math.round(Math.max(perPage * (MIN_PAGES + 1), Math.min(perPage * (MAX_PAGES + 1), CHUNK_MS / perMeasure)));
      start = next;
      await pause();
    }
  } finally {
    host.remove();
  }
}

interface LaidOutPage {
  MusicSystems: { GraphicalMeasures: ({ parentSourceMeasure: { measureListIndex: number } } | undefined)[][] }[];
}

/** Index in its slice of the first measure on a laid out page. */
function firstMeasure(page: LaidOutPage): number {
  const col = page.MusicSystems[0]?.GraphicalMeasures[0] ?? [];
  return col.find(Boolean)?.parentSourceMeasure.measureListIndex ?? 0;
}

/** MusicXML of measures [a, b): the first slice with the title, later ones as pages that go on. */
function sliceXml(score: ScoreDoc, a: number, b: number): string {
  const xml = score.slice(a, b, { header: a === 0 });
  if (a === 0) return closeOpenEndings(xml);
  return closeOpenEndings(xml, (doc) => {
    // Composer and lyricist go with the title only; later systems name parts by their short names.
    for (const id of [...doc.getElementsByTagName("identification")]) id.remove();
    for (const sp of doc.getElementsByTagName("score-part")) {
      const short = sp.getElementsByTagName("part-abbreviation")[0]?.textContent ?? "";
      const name = sp.getElementsByTagName("part-name")[0];
      if (name) name.textContent = short;
      sp.getElementsByTagName("part-name-display")[0]?.remove();
    }
  });
}

export interface PdfExportOptions extends PageOptions {
  /** Attach the score as compressed MusicXML, so the PDF opens again as this score. Default true. */
  embedScore?: boolean;
  /**
   * Fonts for text the standard PDF fonts lack (Western European only), by script: a URL, bytes or a
   * function giving them, used only when the score has such text. Without one, that text keeps the standard font.
   */
  fonts?: PdfFonts;
}

/** The score as a vector PDF, one page per OSMD page. */
export async function exportPdf(score: ScoreDoc, opts: PdfExportOptions = {}): Promise<Uint8Array> {
  const paper = PAPER[opts.paper ?? "a4"];
  const progress = opts.onProgress;
  progress?.(0);
  const { jsPDF } = await import("jspdf");
  await import("svg2pdf.js");
  fastFlate(jsPDF.API as unknown as FlateApi);
  const shape = (jsPDF.API as unknown as { processArabic(s: string): string }).processArabic;
  const fonts = await planFonts(scoreText(score.root), opts.fonts, shape);
  progress?.(0.02);
  const doc = new jsPDF({ unit: "pt", format: [paper.w, paper.h], compress: true });
  doc.setProperties({ title: score.title || "Score", creator: "scoredit" });
  registerFonts(doc, fonts);
  // Laying a slice out takes about 40% of its time, drawing its pages into the PDF the rest.
  const total = Math.max(1, score.measureCount);
  const at = (measures: number) => progress?.(0.02 + (0.9 * Math.min(measures, total)) / total);
  // svg2pdf reads the SVG's layout, so each page is in the document while it is drawn.
  const holder = document.createElement("div");
  holder.style.cssText = "position:absolute;left:-100000px;top:0";
  document.body.append(holder);
  let n = 0;
  const done: string[] = [];
  let pdf: Uint8Array;
  try {
    for await (const { pages, from, to } of layOut(score, opts)) {
      at(from + 0.4 * (to - from));
      for (let i = 0; i < pages.length; i++) {
        if (n++) doc.addPage([paper.w, paper.h]);
        applyFonts(pages[i], fonts);
        holder.replaceChildren(pages[i]);
        await doc.svg(pages[i], { x: 0, y: 0, width: paper.w, height: paper.h });
        done.push(deflatePage(doc, n));
        at(from + (to - from) * (0.4 + (0.6 * (i + 1)) / pages.length));
        await pause();
      }
    }
    pdf = new Uint8Array(doc.output("arraybuffer"));
  } finally {
    holder.remove();
    for (const c of done) deflated.delete(c);
  }
  progress?.(0.96);
  await pause();
  const out = opts.embedScore === false ? pdf : embedScore(pdf, score);
  progress?.(1);
  return out;
}

interface FlateApi {
  processDataByFilters(data: string, filters?: string | string[]): { data: string; reverseChain: string };
}
const FAST = Symbol("scoredit-fast-flate");
// Page streams deflated as each page was drawn, by content, for jsPDF's output to pick up.
const deflated = new Map<string, string>();

const deflate = (data: string) => {
  const bytes = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i);
  const z = zlibSync(bytes);
  let s = "";
  for (let i = 0; i < z.length; i += 8192) s += String.fromCharCode(...z.subarray(i, i + 8192));
  return s;
};

/** Deflates a drawn page now rather than all pages at the end, where no progress can be told. */
function deflatePage(doc: unknown, n: number): string {
  const content = ((doc as { internal: { pages: string[][] } }).internal.pages[n] ?? []).join("\n");
  deflated.set(content, deflate(content));
  return content;
}

/** jsPDF turns deflated streams into a string a byte at a time, slow on big pages: same bytes, faster. */
function fastFlate(api: FlateApi): void {
  const orig = api.processDataByFilters as FlateApi["processDataByFilters"] & { [FAST]?: boolean };
  if (orig[FAST]) return;
  const fast = (data: string, filters?: string | string[]) => {
    const chain = typeof filters === "string" ? [filters] : (filters ?? []);
    if (chain.length !== 1 || (chain[0] !== "FlateEncode" && chain[0] !== "/FlateEncode")) return orig(data, filters);
    return { data: deflated.get(data) ?? deflate(data), reverseChain: "/FlateDecode" };
  };
  api.processDataByFilters = Object.assign(fast, { [FAST]: true });
}

/** `pdf` with the score attached as "<title>.mxl", which readPdfScore reads back first. */
export function embedScore(pdf: Uint8Array, score: ScoreDoc): Uint8Array {
  const name = (score.title || "Score").replace(/[\\/:*?"<>|\x00-\x1f]+/g, "_").trim().slice(0, 120) || "Score";
  return attachFile(pdf, { name: `${name}.mxl`, data: writeMxl(score.serialize()), mime: MXL_MIME, description: "MusicXML score" });
}
