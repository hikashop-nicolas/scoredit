import { OpenSheetMusicDisplay } from "opensheetmusicdisplay";
import { breakSystems, systemOf, type SystemRange } from "../layout/systems";
import type { ScoreDoc } from "../model/score";
import { kid, kids, text } from "../model/xml";
import { t } from "../ui/i18n";
import { injectStyles } from "./styles";

export interface ScoreViewerOptions {
  /** 1 = OSMD's default size (10 px per staff space). Default: 0.6 on a phone-wide container, else 1. */
  zoom?: number;
  /** Shows a fullscreen button in the bar; the host enters fullscreen and calls setReadingMode. */
  onFullscreen?(): void;
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
  /** The end of the bottom bar, where a host can put its own buttons. */
  getBarEnd(): HTMLElement;
  /** Fullscreen reading: the host's buttons in the bar hide. */
  setReadingMode(on: boolean): void;
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
const ZOOM_MIN = 0.3;
const ZOOM_MAX = 3;
const SLIDER_STEPS = 1000;
const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
const sliderToZoom = (v: number) => ZOOM_MIN * (ZOOM_MAX / ZOOM_MIN) ** (v / SLIDER_STEPS);
const zoomToSlider = (z: number) => Math.round((Math.log(clampZoom(z) / ZOOM_MIN) / Math.log(ZOOM_MAX / ZOOM_MIN)) * SLIDER_STEPS);
const svgIcon = (inner: string) =>
  `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
const ICON_FS = svgIcon('<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" x2="14" y1="3" y2="10"/><line x1="3" x2="10" y1="21" y2="14"/>');
const ICON_FS_EXIT = svgIcon('<polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" x2="21" y1="10" y2="3"/><line x1="3" x2="10" y1="21" y2="14"/>');

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
  let zoom = clampZoom(opts.zoom ?? (container.clientWidth > 0 && container.clientWidth < 700 ? 0.6 : 1));
  const shell = document.createElement("div");
  shell.className = "sv-shell";
  const root = document.createElement("div");
  root.className = "sv-root";
  const page = document.createElement("div");
  page.className = "sv-page";
  root.append(page);
  const bar = buildBar();
  shell.append(root, bar.el);
  container.append(shell);

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

  // The page stays hidden until the width model has settled on the first systems, so the
  // calibration re-breaks are never seen.
  let settled = false;
  page.style.visibility = "hidden";
  const settle = () => {
    settled = true;
    page.style.visibility = "";
  };
  const settleTimer = window.setTimeout(settle, 3000);

  /** Breaks the score into systems again, keeping systems [0, keep) as they are. */
  function layout(reweigh = true, keep = 0): void {
    generation++;
    if (keep === 0) {
      page.textContent = "";
      width = page.clientWidth;
      units = width / (UNIT_PX * zoom) - 2 * MARGIN;
    }
    if (reweigh || weights.length !== score.measureCount) weights = Array.from({ length: score.measureCount }, (_, m) => score.measureWeight(m));
    const kept = slots.slice(0, keep);
    for (const s of slots.slice(keep)) s.el.remove();
    const from = keep ? systems[keep - 1].end : 0;
    const shift = (rs: SystemRange[]) => rs.map((r) => ({ start: r.start + from, end: r.end + from }));
    let fresh = shift(breakSystems(weights.slice(from), { ...params, width: units }));
    // The first system also carries the part names and the time signature.
    if (from === 0 && fresh.length > 1 && score.parts.some((p) => p.name)) {
      const first = breakSystems(weights, { ...params, width: units - NAMES_WIDTH - TIME_WIDTH })[0];
      if (first.end < fresh[0].end) {
        fresh = [first, ...breakSystems(weights.slice(first.end), { ...params, width: units }).map((r) => ({ start: r.start + first.end, end: r.end + first.end }))];
      }
    }
    systems = [...systems.slice(0, keep), ...fresh];
    const h = estimate();
    slots = [
      ...kept,
      ...fresh.map((_, k) => {
        const el = document.createElement("div");
        el.className = "sv-system";
        el.dataset.system = String(keep + k);
        el.style.minHeight = `${h}px`;
        page.append(el);
        return { el, osmd: null, height: h, rendering: false };
      }),
    ];
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
      // A title glyph is about 0.7 as wide as it is tall: keep the title within the page.
      r.SheetTitleHeight = Math.min(r.SheetTitleHeight, (1.2 * units) / Math.max(1, score.title.length));
      const shrink = Math.min(1, units / 110);
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
      if (rebreak && !settled) {
        layout(false);
        return;
      }
      slot.osmd = osmd;
      slot.height = slot.el.offsetHeight;
      slot.el.style.minHeight = "";
      opts.onSystemRendered?.(i, performance.now() - t0);
      if (rebreak) {
        // Already on screen: keep everything drawn, re-break only what follows it.
        let last = i;
        slots.forEach((s, k) => (s.osmd || s.rendering) && (last = Math.max(last, k)));
        layout(false, last + 1);
      } else if (!settled && (samples.length >= 4 || i === systems.length - 1)) {
        clearTimeout(settleTimer);
        settle();
      }
    } catch (e) {
      settle();
      opts.onError?.(e);
    } finally {
      slot.rendering = false;
    }
  }

  // Zoom previews as a CSS scale at once and re-lays the score out when it rests, keeping
  // the measure at the top of the view at the top.
  let shown = zoom;
  let zoomTimer = 0;
  function previewZoom(z: number, at?: { x: number; y: number }): void {
    shown = clampZoom(z);
    const rect = root.getBoundingClientRect();
    const ox = at ? at.x - rect.left + root.scrollLeft : root.clientWidth / 2;
    const oy = at ? at.y - rect.top + root.scrollTop : root.scrollTop;
    page.style.transformOrigin = `${ox}px ${oy}px`;
    page.style.transform = shown === zoom ? "" : `scale(${shown / zoom})`;
    bar.sync(shown);
  }
  function commitZoom(): void {
    clearTimeout(zoomTimer);
    if (shown === zoom) return void (page.style.transform = "");
    const top = root.scrollTop + page.offsetTop;
    const at = slots.findIndex((s) => s.el.offsetTop + s.el.offsetHeight > top);
    const measure = at >= 0 ? systems[at].start : 0;
    zoom = shown;
    page.style.transform = "";
    layout(false);
    const i = systemOf(systems, measure);
    root.scrollTop = slots[i] ? slots[i].el.offsetTop - page.offsetTop : 0;
    schedule();
  }
  function zoomTo(z: number, at?: { x: number; y: number }, delay = 250): void {
    previewZoom(z, at);
    clearTimeout(zoomTimer);
    zoomTimer = window.setTimeout(commitZoom, delay);
  }

  function buildBar() {
    const el = document.createElement("div");
    el.className = "sv-bar";
    const grow = document.createElement("span");
    grow.className = "sv-bb-grow";
    const slider = document.createElement("input");
    slider.type = "range";
    slider.className = "sv-zoom";
    slider.min = "0";
    slider.max = String(SLIDER_STEPS);
    slider.step = "1";
    slider.title = t("zoom");
    slider.setAttribute("aria-label", t("zoom"));
    slider.addEventListener("input", () => zoomTo(sliderToZoom(Number(slider.value)), undefined, 400));
    slider.addEventListener("change", () => commitZoom());
    const label = document.createElement("span");
    label.className = "sv-zoom-label";
    el.append(grow, slider, label);
    let fs: HTMLButtonElement | null = null;
    if (opts.onFullscreen) {
      fs = document.createElement("button");
      fs.type = "button";
      fs.className = "sv-bb-btn sv-bb-icon";
      fs.innerHTML = ICON_FS;
      fs.title = t("fullscreen");
      fs.setAttribute("aria-label", t("fullscreen"));
      fs.addEventListener("click", () => opts.onFullscreen?.());
      el.append(fs);
    }
    const end = document.createElement("span");
    end.className = "sv-bar-end";
    el.append(end);
    const sync = (z: number) => {
      slider.value = String(zoomToSlider(z));
      label.textContent = `${Math.round(z * 100)}%`;
    };
    sync(zoom);
    return {
      el,
      end,
      sync,
      reading(on: boolean) {
        if (!fs) return;
        const lbl = t(on ? "exitFullscreen" : "fullscreen");
        fs.innerHTML = on ? ICON_FS_EXIT : ICON_FS;
        fs.title = lbl;
        fs.setAttribute("aria-label", lbl);
      },
    };
  }

  // Two fingers zoom about the point between them.
  const dist = (e: TouchEvent) => Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY) || 1;
  let pinch: { dist: number; zoom: number } | null = null;
  const onTouchStart = (e: TouchEvent) => {
    pinch = e.touches.length === 2 ? { dist: dist(e), zoom: shown } : null;
  };
  const onTouchMove = (e: TouchEvent) => {
    if (!pinch || e.touches.length !== 2) return;
    e.preventDefault();
    clearTimeout(zoomTimer);
    previewZoom(pinch.zoom * (dist(e) / pinch.dist), {
      x: (e.touches[0].clientX + e.touches[1].clientX) / 2,
      y: (e.touches[0].clientY + e.touches[1].clientY) / 2,
    });
  };
  const onTouchEnd = (e: TouchEvent) => {
    if (pinch && e.touches.length < 2) {
      pinch = null;
      commitZoom();
    }
  };
  root.addEventListener("touchstart", onTouchStart, { passive: true });
  root.addEventListener("touchmove", onTouchMove, { passive: false });
  root.addEventListener("touchend", onTouchEnd, { passive: true });
  root.addEventListener("touchcancel", onTouchEnd, { passive: true });

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
      previewZoom(z);
      commitZoom();
    },
    getBarEnd: () => bar.end,
    setReadingMode(on: boolean) {
      shell.classList.toggle("sv-reading", on);
      bar.reading(on);
    },
    relayout: () => layout(true),
    destroy() {
      destroyed = true;
      clearTimeout(settleTimer);
      ro.disconnect();
      root.removeEventListener("scroll", onScroll);
      clearTimeout(resizeTimer);
      clearTimeout(zoomTimer);
      shell.remove();
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
