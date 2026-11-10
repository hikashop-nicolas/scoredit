import type { SystemRange } from "../layout/systems";
import type { ScoreDoc } from "../model/score";
import { clampZoom, createBar, type LayoutMode } from "../ui/bar";
import { createLineView, type LineView } from "./line-view";
import { createPageView, type PageView } from "./page-view";
import { injectStyles } from "./styles";
import type { View } from "./view";

export type { LayoutMode } from "../ui/bar";

export interface ScoreViewerOptions {
  /** "page": lines stacked down the page (default). "line": one long line, sideways, sized to the height. */
  layout?: LayoutMode;
  /** Page zoom; 1 = OSMD's default size (10 px per staff space). Default: 0.6 on a phone-wide container, else 1. */
  zoom?: number;
  /** Shows a fullscreen button in the bar; the host enters fullscreen and calls setReadingMode. */
  onFullscreen?(): void;
  /** The user switched between page and line layout. */
  onLayoutChange?(layout: LayoutMode): void;
  onError?(err: unknown): void;
  /** Called after a page system finished rendering, with its index and time in ms. */
  onSystemRendered?(index: number, ms: number): void;
}

export interface ScoreViewerHandle {
  readonly score: ScoreDoc;
  readonly layout: LayoutMode;
  /** Page systems (empty in line layout). */
  readonly systems: readonly SystemRange[];
  /** The page width model, in OSMD units (for tests and tuning). */
  readonly layoutParams: PageView["layoutParams"] | null;
  /** The line view while in line layout, for playback to drive. */
  readonly line: LineView | null;
  setLayout(layout: LayoutMode): void;
  getZoom(): number;
  setZoom(zoom: number): void;
  /** The end of the bottom bar, where a host can put its own buttons. */
  getBarEnd(): HTMLElement;
  /** Fullscreen reading: the host's buttons in the bar hide. */
  setReadingMode(on: boolean): void;
  /** Lays the score out again, e.g. after it changed. */
  relayout(): void;
  destroy(): void;
}

// The viewer shell: a bottom bar (layout switch, zoom, fullscreen, host slot), pinch zoom,
// and the active layout. The page layout reads like sheet music; the line layout runs the
// score sideways on one line for playing along.
export function createScoreViewer(container: HTMLElement, score: ScoreDoc, opts: ScoreViewerOptions = {}): ScoreViewerHandle {
  injectStyles();
  let mode: LayoutMode = opts.layout ?? "page";
  let pageZoom = clampZoom(opts.zoom ?? (container.clientWidth > 0 && container.clientWidth < 700 ? 0.6 : 1));
  const shell = document.createElement("div");
  shell.className = "sv-shell";
  container.append(shell);

  let view: View;
  let shown = 0;
  let zoomTimer = 0;
  const bar = createBar({
    zoom: pageZoom,
    layout: mode,
    onZoomInput: (z) => zoomTo(z, undefined, 400),
    onZoomCommit: () => commitZoom(),
    onLayout: (m) => {
      setLayout(m);
      opts.onLayoutChange?.(m);
    },
    onFullscreen: opts.onFullscreen,
  });

  function mount(): void {
    const common = { onError: opts.onError, onZoom: (z: number) => ((shown = z), bar.sync(z)) };
    view = mode === "page" ? createPageView(score, { ...common, zoom: pageZoom, onSystemRendered: opts.onSystemRendered }) : createLineView(score, { ...common, zoom: pageZoom });
    shown = view.zoom;
    shell.prepend(view.root);
    bar.sync(view.zoom);
    bar.setLayout(mode);
    bindPinch(view.root);
  }

  function setLayout(m: LayoutMode): void {
    if (m === mode) return;
    if (mode === "page") pageZoom = view.zoom;
    view.destroy();
    mode = m;
    mount();
  }

  function previewZoom(z: number, at?: { x: number; y: number }): void {
    shown = clampZoom(z);
    view.preview(shown, at);
    bar.sync(shown);
  }
  function commitZoom(): void {
    clearTimeout(zoomTimer);
    view.commit(shown);
    if (mode === "page") pageZoom = shown;
  }
  function zoomTo(z: number, at?: { x: number; y: number }, delay = 250): void {
    previewZoom(z, at);
    clearTimeout(zoomTimer);
    zoomTimer = window.setTimeout(commitZoom, delay);
  }

  // Two fingers zoom about the point between them.
  function bindPinch(el: HTMLElement): void {
    const dist = (e: TouchEvent) => Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY) || 1;
    let pinch: { dist: number; zoom: number } | null = null;
    el.addEventListener("touchstart", (e) => (pinch = e.touches.length === 2 ? { dist: dist(e), zoom: shown } : null), { passive: true });
    el.addEventListener(
      "touchmove",
      (e) => {
        if (!pinch || e.touches.length !== 2) return;
        e.preventDefault();
        clearTimeout(zoomTimer);
        previewZoom(pinch.zoom * (dist(e) / pinch.dist), {
          x: (e.touches[0].clientX + e.touches[1].clientX) / 2,
          y: (e.touches[0].clientY + e.touches[1].clientY) / 2,
        });
      },
      { passive: false },
    );
    const end = (e: TouchEvent) => {
      if (pinch && e.touches.length < 2) {
        pinch = null;
        commitZoom();
      }
    };
    el.addEventListener("touchend", end, { passive: true });
    el.addEventListener("touchcancel", end, { passive: true });
  }

  shell.append(bar.el);
  mount();

  return {
    score,
    get layout() {
      return mode;
    },
    get systems() {
      return mode === "page" ? (view as PageView).systems : [];
    },
    get layoutParams() {
      return mode === "page" ? (view as PageView).layoutParams : null;
    },
    get line() {
      return mode === "line" ? (view as LineView) : null;
    },
    setLayout,
    getZoom: () => view.zoom,
    setZoom(z: number) {
      previewZoom(z);
      commitZoom();
    },
    getBarEnd: () => bar.end,
    setReadingMode(on: boolean) {
      shell.classList.toggle("sv-reading", on);
      bar.reading(on);
    },
    relayout: () => view.relayout(),
    destroy() {
      clearTimeout(zoomTimer);
      view.destroy();
      shell.remove();
    },
  };
}
