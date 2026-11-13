// PDF export and print pages: the score laid out on paper-sized pages by OSMD's paged mode,
// one SVG per page, then each page drawn into a vector PDF (jsPDF + svg2pdf.js, loaded on use).
import { OpenSheetMusicDisplay } from "opensheetmusicdisplay";
import type { ScoreDoc } from "../model/score";

export type Paper = "a4" | "letter";

export interface PageOptions {
  /** Paper size; A4 by default. */
  paper?: Paper;
  /** Notation size: 1 is OSMD's default, smaller fits more on a page. */
  zoom?: number;
  /** Called with 0 to 1 while laying out and drawing. */
  onProgress?(fraction: number): void;
}

// Paper in PDF points (1/72 inch) and the OSMD page format that matches it.
const PAPER: Record<Paper, { w: number; h: number; format: string }> = {
  a4: { w: 595.28, h: 841.89, format: "A4_P" },
  letter: { w: 612, h: 792, format: "Letter_P" },
};
// Page width OSMD lays out at, in CSS pixels: the paper at 96 dpi.
const PX_PER_PT = 96 / 72;
const pause = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * Ends a volta that is never stopped at the end of the bar it starts in, as MuseScore shows it
 * (its MusicXML export can leave a last ending open); OSMD would draw it on to the next one.
 */
export function closeOpenEndings(xml: string): string {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
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
  const paper = PAPER[opts.paper ?? "a4"];
  const host = document.createElement("div");
  // Laid out off screen: OSMD measures text, so it has to be in the document.
  host.style.cssText = `position:absolute;left:-100000px;top:0;width:${Math.round(paper.w * PX_PER_PT)}px`;
  document.body.append(host);
  try {
    const osmd = new OpenSheetMusicDisplay(host, {
      autoResize: false,
      backend: "svg",
      pageFormat: paper.format,
      pageBackgroundColor: "#FFFFFF",
      drawTitle: true,
      drawSubtitle: true,
      drawComposer: true,
      drawLyricist: true,
      drawCredits: true,
      drawPartNames: true,
    });
    opts.onProgress?.(0.05);
    await pause();
    await osmd.load(closeOpenEndings(score.slice(0, score.measureCount, { header: true })), "");
    osmd.zoom = opts.zoom ?? 0.7;
    opts.onProgress?.(0.2);
    await pause();
    osmd.render();
    opts.onProgress?.(0.6);
    return osmd.Drawer.Backends.map((b) => {
      const svg = (b as unknown as { getSvgElement(): SVGSVGElement }).getSvgElement();
      const page = svg.cloneNode(true) as SVGSVGElement;
      // svg2pdf reads font sizes as pixels: OSMD gives some in points.
      for (const t of page.querySelectorAll("[font-size$='pt']")) t.setAttribute("font-size", `${parseFloat(t.getAttribute("font-size")!) * PX_PER_PT}px`);
      return page;
    });
  } finally {
    host.remove();
  }
}

/** The score as a vector PDF, one page per OSMD page. */
export async function exportPdf(score: ScoreDoc, opts: PageOptions = {}): Promise<Uint8Array> {
  const paper = PAPER[opts.paper ?? "a4"];
  const progress = opts.onProgress;
  const pages = await renderPages(score, { ...opts, onProgress: (f) => progress?.(f * 0.6) });
  const { jsPDF } = await import("jspdf");
  await import("svg2pdf.js");
  const doc = new jsPDF({ unit: "pt", format: [paper.w, paper.h], compress: true });
  doc.setProperties({ title: score.title || "Score", creator: "scoredit" });
  // svg2pdf reads the SVG's layout, so each page is in the document while it is drawn.
  const holder = document.createElement("div");
  holder.style.cssText = "position:absolute;left:-100000px;top:0";
  document.body.append(holder);
  try {
    for (let i = 0; i < pages.length; i++) {
      if (i) doc.addPage([paper.w, paper.h]);
      holder.replaceChildren(pages[i]);
      await doc.svg(pages[i], { x: 0, y: 0, width: paper.w, height: paper.h });
      progress?.(0.6 + (0.4 * (i + 1)) / pages.length);
      await pause();
    }
  } finally {
    holder.remove();
  }
  return new Uint8Array(doc.output("arraybuffer"));
}
