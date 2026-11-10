import { OpenSheetMusicDisplay } from "opensheetmusicdisplay";
import { breakSystems, type SystemRange } from "../layout/systems";
import type { ScoreDoc } from "../model/score";
import { kid, kids, text } from "../model/xml";
import { injectStyles } from "./styles";

export interface ScoreViewerOptions {
  /** 1 = OSMD's default size (10 px per staff space). */
  zoom?: number;
  onError?(err: unknown): void;
  /** Called after a system finished rendering, with its index and time in ms. */
  onSystemRendered?(index: number, ms: number): void;
}

export interface ScoreViewerHandle {
  readonly score: ScoreDoc;
  readonly systems: readonly SystemRange[];
  /** The fitted width model, in OSMD units (for tests and tuning). */
  readonly layoutParams: Readonly<{ measureBase: number; perWeight: number; systemStart: number; width: number }>;
  getZoom(): number;
  setZoom(zoom: number): void;
  /** Re-breaks the systems and re-renders, e.g. after the score changed. */
  relayout(): void;
  destroy(): void;
}

// Layout constants, in OSMD units (one staff space = 1 unit = 10 px at zoom 1).
const UNIT_PX = 10;
const MARGIN = 2;
const BREAK = { measureBase: 5, perWeight: 2.6, systemStart: 9 };
const NAMES_WIDTH = 10;
const TIME_WIDTH = 4;
// How far outside the viewport systems are rendered ahead, and kept, in viewport heights.
const AHEAD = 1;
const KEEP = 4;

interface Slot {
  el: HTMLDivElement;
  osmd: OpenSheetMusicDisplay | null;
  height: number;
  rendering: boolean;
}

// Each system (line) is its own OSMD render of a MusicXML slice, so a long score opens at
// the speed of its first screen and an edit re-renders one line, not the whole score.
export function createScoreViewer(container: HTMLElement, score: ScoreDoc, opts: ScoreViewerOptions = {}): ScoreViewerHandle {
  injectStyles();
  let zoom = opts.zoom ?? 1;
  const root = document.createElement("div");
  root.className = "sv-root";
  const page = document.createElement("div");
  page.className = "sv-page";
  root.append(page);
  container.append(root);

  let systems: SystemRange[] = [];
  let slots: Slot[] = [];
  let width = 0;
  let generation = 0;
  let destroyed = false;
  const staves = countStaves(score);

  const estimate = () => {
    const known = slots.filter((s) => s.osmd).map((s) => s.height);
    if (known.length) return known.reduce((a, b) => a + b, 0) / known.length;
    return (staves * 8 + 6) * UNIT_PX * zoom;
  };

  // The width model starts from a guess and is fitted to the widths OSMD reports for the
  // measures it rendered; when it moves enough, the score is broken again.
  const params = { ...BREAK };
  const samples: [weight: number, need: number][] = [];
  let calibrations = 0;
  let weights: number[] = [];
  let units = 0;

  function learn(osmd: OpenSheetMusicDisplay, range: SystemRange, first: boolean): boolean {
    const r = osmd.EngravingRules;
    osmd.GraphicSheet.MeasureList.forEach((staves, k) => {
      let need = 0;
      let begin = 0;
      for (const gm of staves) {
        if (!gm) continue;
        need = Math.max(need, gm.minimumStaffEntriesWidth + gm.endInstructionsWidth);
        begin = Math.max(begin, gm.beginInstructionsWidth);
      }
      if (need > 0) samples.push([weights[range.start + k], need + r.MeasureLeftMargin + r.MeasureRightMargin]);
      if (k === 0 && !first && begin > 0) params.systemStart = begin;
    });
    if (samples.length < 4 || calibrations >= 3) return false;
    const n = samples.length;
    const mx = samples.reduce((s, [x]) => s + x, 0) / n;
    const my = samples.reduce((s, [, y]) => s + y, 0) / n;
    const vx = samples.reduce((s, [x]) => s + (x - mx) ** 2, 0);
    const b = vx > 0 ? samples.reduce((s, [x, y]) => s + (x - mx) * (y - my), 0) / vx : 0;
    const perWeight = Math.max(0.5, b);
    const measureBase = Math.max(2, my - perWeight * mx) * 1.04;
    const moved = Math.abs(perWeight - params.perWeight) / params.perWeight + Math.abs(measureBase - params.measureBase) / params.measureBase;
    if (moved < 0.15) return false;
    params.perWeight = perWeight;
    params.measureBase = measureBase;
    calibrations++;
    return true;
  }

  function layout(reweigh = true): void {
    generation++;
    for (const s of slots) s.osmd = null;
    page.textContent = "";
    width = page.clientWidth;
    units = width / (UNIT_PX * zoom) - 2 * MARGIN;
    if (reweigh || weights.length !== score.measureCount) weights = Array.from({ length: score.measureCount }, (_, m) => score.measureWeight(m));
    const o = params;
    systems = breakSystems(weights, { ...o, width: units });
    // The first system also carries the part names.
    if (systems.length > 1 && score.parts.some((p) => p.name)) {
      const first = breakSystems(weights, { ...o, width: units - NAMES_WIDTH - TIME_WIDTH })[0];
      if (first.end < systems[0].end) {
        systems = [first, ...breakSystems(weights.slice(first.end), { ...o, width: units }).map((r) => ({ start: r.start + first.end, end: r.end + first.end }))];
      }
    }
    const h = estimate();
    slots = systems.map((_, i) => {
      const el = document.createElement("div");
      el.className = "sv-system";
      el.dataset.system = String(i);
      el.style.minHeight = `${h}px`;
      page.append(el);
      return { el, osmd: null, height: h, rendering: false };
    });
    schedule();
  }

  let queued = false;
  function schedule(): void {
    if (queued || destroyed) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      void pump();
    });
  }

  // Renders the nearest missing system in view, one per frame so scrolling stays smooth,
  // and drops systems far out of view.
  async function pump(): Promise<void> {
    const gen = generation;
    const top = root.scrollTop;
    const view = root.clientHeight || window.innerHeight;
    const pageTop = page.offsetTop;
    let next = -1;
    let best = Infinity;
    slots.forEach((s, i) => {
      const y = s.el.offsetTop - pageTop;
      const bottom = y + s.el.offsetHeight;
      const dist = bottom < top ? top - bottom : y > top + view ? y - (top + view) : 0;
      if (dist > KEEP * view && s.osmd) {
        s.el.style.minHeight = `${s.height}px`;
        s.el.textContent = "";
        s.osmd = null;
      }
      if (!s.osmd && !s.rendering && dist <= AHEAD * view && dist < best) {
        best = dist;
        next = i;
      }
    });
    if (next < 0) return;
    await renderSystem(next, gen);
    if (gen === generation) schedule();
  }

  async function renderSystem(i: number, gen: number): Promise<void> {
    const slot = slots[i];
    const range = systems[i];
    slot.rendering = true;
    const t0 = performance.now();
    try {
      const host = document.createElement("div");
      const first = i === 0;
      const osmd = new OpenSheetMusicDisplay(host, {
        autoResize: false,
        backend: "svg",
        drawTitle: first,
        drawSubtitle: first,
        drawComposer: first,
        drawLyricist: first,
        drawCredits: first,
        drawPartNames: first,
        drawPartAbbreviations: !first,
        stretchLastSystemLine: true,
      });
      const r = osmd.EngravingRules;
      r.PageLeftMargin = MARGIN;
      r.PageRightMargin = MARGIN;
      r.PageTopMargin = first ? 2 : 0;
      r.PageBottomMargin = 0;
      r.RenderMeasureNumbersOnlyAtSystemStart = true;
      // OSMD sizes the title for a printed page; a phone-wide page needs it smaller.
      const shrink = Math.min(1, units / 140);
      r.SheetTitleHeight *= shrink;
      r.SheetSubtitleHeight *= shrink;
      r.SheetComposerHeight *= shrink;
      osmd.zoom = zoom;
      host.style.width = `${width}px`;
      slot.el.textContent = "";
      slot.el.append(host);
      await osmd.load(score.slice(range.start, range.end, { header: first }));
      if (gen !== generation) return;
      osmd.render();
      let rebreak = learn(osmd, range, first);
      const lines = osmd.GraphicSheet.MusicPages.reduce((n, p) => n + p.MusicSystems.length, 0);
      if (!rebreak && !first && lines > 1 && range.end - range.start > 1 && calibrations < 6) {
        // Still too full for OSMD: widen every measure a little.
        params.measureBase *= 1.1;
        calibrations++;
        rebreak = true;
      }
      if (rebreak) {
        layout(false);
        return;
      }
      slot.osmd = osmd;
      slot.height = slot.el.offsetHeight;
      slot.el.style.minHeight = "";
      opts.onSystemRendered?.(i, performance.now() - t0);
    } catch (e) {
      opts.onError?.(e);
    } finally {
      slot.rendering = false;
    }
  }

  const onScroll = () => schedule();
  root.addEventListener("scroll", onScroll, { passive: true });
  let resizeTimer = 0;
  const ro = new ResizeObserver(() => {
    if (Math.abs(page.clientWidth - width) < 2) return schedule();
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => layout(false), 150);
  });
  ro.observe(root);
  layout();

  return {
    score,
    get systems() {
      return systems;
    },
    get layoutParams() {
      return { ...params, width: units };
    },
    getZoom: () => zoom,
    setZoom(z: number) {
      zoom = Math.min(4, Math.max(0.3, z));
      layout(false);
    },
    relayout: () => layout(true),
    destroy() {
      destroyed = true;
      ro.disconnect();
      root.removeEventListener("scroll", onScroll);
      clearTimeout(resizeTimer);
      root.remove();
    },
  };
}

function countStaves(score: ScoreDoc): number {
  let n = 0;
  score.measures.forEach((ms, p) => {
    const at = ms[0] ? kid(ms[0], "attributes") : null;
    const st = score.attributesAt(p, 1).find((e) => e.tagName === "staves") ?? (at ? kid(at, "staves") : null);
    n += Number(text(st)) || 1;
  });
  return Math.max(1, n || kids(score.root, "part").length);
}
