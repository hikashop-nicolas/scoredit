import { t } from "./i18n";

export type LayoutMode = "page" | "line";

export const ZOOM_MIN = 0.3;
export const ZOOM_MAX = 3;
export const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
const SLIDER_STEPS = 1000;
const sliderToZoom = (v: number) => ZOOM_MIN * (ZOOM_MAX / ZOOM_MIN) ** (v / SLIDER_STEPS);
const zoomToSlider = (z: number) => Math.round((Math.log(clampZoom(z) / ZOOM_MIN) / Math.log(ZOOM_MAX / ZOOM_MIN)) * SLIDER_STEPS);

const svgIcon = (inner: string) =>
  `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
const ICON_FS = svgIcon('<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" x2="14" y1="3" y2="10"/><line x1="3" x2="10" y1="21" y2="14"/>');
const ICON_FS_EXIT = svgIcon('<polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" x2="21" y1="10" y2="3"/><line x1="3" x2="10" y1="21" y2="14"/>');
// Page: stacked lines. Line: one long staff running sideways.
const ICON_PAGE = svgIcon('<rect x="5" y="3" width="14" height="18" rx="1"/><line x1="8" x2="16" y1="8" y2="8"/><line x1="8" x2="16" y1="12" y2="12"/><line x1="8" x2="16" y1="16" y2="16"/>');
const ICON_PLAY = svgIcon('<polygon points="7 4 20 12 7 20 7 4" fill="currentColor"/>');
const ICON_PAUSE = svgIcon('<rect x="6" y="4" width="4" height="16" fill="currentColor"/><rect x="14" y="4" width="4" height="16" fill="currentColor"/>');
const ICON_LINE = svgIcon('<line x1="2" x2="22" y1="9" y2="9"/><line x1="2" x2="22" y1="15" y2="15"/><polyline points="17 5 21 12 17 19"/>');

export interface BarOptions {
  zoom: number;
  layout: LayoutMode;
  /** The slider moves: preview this zoom. */
  onZoomInput(z: number): void;
  /** The slider was released. */
  onZoomCommit(): void;
  onLayout(mode: LayoutMode): void;
  onPlay(): void;
  /** Playback speed, 1 = as written. */
  onSpeed(speed: number): void;
  onFullscreen?(): void;
}

export interface Bar {
  el: HTMLElement;
  end: HTMLElement;
  sync(zoom: number): void;
  setLayout(mode: LayoutMode): void;
  setPlaying(on: boolean): void;
  reading(on: boolean): void;
}

function button(icon: string, label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "sv-bb-btn sv-bb-icon";
  b.innerHTML = icon;
  b.title = label;
  b.setAttribute("aria-label", label);
  b.addEventListener("click", onClick);
  return b;
}

export function createBar(o: BarOptions): Bar {
  const el = document.createElement("div");
  el.className = "sv-bar";
  let mode = o.layout;
  const playBtn = button(ICON_PLAY, t("play"), () => o.onPlay());
  playBtn.classList.add("sv-bb-play");
  // Speed: a button showing it, opening a slider above the bar.
  const speedBtn = document.createElement("button");
  speedBtn.type = "button";
  speedBtn.className = "sv-bb-btn sv-bb-speed";
  speedBtn.title = t("speed");
  speedBtn.setAttribute("aria-label", t("speed"));
  speedBtn.setAttribute("aria-expanded", "false");
  const pop = document.createElement("div");
  pop.className = "sv-pop";
  pop.hidden = true;
  const speedRange = document.createElement("input");
  speedRange.type = "range";
  speedRange.min = "25";
  speedRange.max = "150";
  speedRange.step = "5";
  speedRange.value = "100";
  speedRange.setAttribute("aria-label", t("speed"));
  const speedLabel = (v: number) => (speedBtn.textContent = `${v}%`);
  speedLabel(100);
  speedRange.addEventListener("input", () => {
    speedLabel(Number(speedRange.value));
    o.onSpeed(Number(speedRange.value) / 100);
  });
  pop.append(speedRange);
  speedBtn.addEventListener("click", () => {
    pop.hidden = !pop.hidden;
    speedBtn.setAttribute("aria-expanded", String(!pop.hidden));
    if (!pop.hidden) speedRange.focus();
  });
  document.addEventListener("pointerdown", (e) => {
    if (!pop.hidden && !pop.contains(e.target as Node) && e.target !== speedBtn) {
      pop.hidden = true;
      speedBtn.setAttribute("aria-expanded", "false");
    }
  });
  const layoutBtn = button(ICON_LINE, "", () => o.onLayout(mode === "page" ? "line" : "page"));
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
  slider.addEventListener("input", () => o.onZoomInput(sliderToZoom(Number(slider.value))));
  slider.addEventListener("change", () => o.onZoomCommit());
  const label = document.createElement("span");
  label.className = "sv-zoom-label";
  el.append(playBtn, speedBtn, pop, layoutBtn, grow, slider, label);
  let fs: HTMLButtonElement | null = null;
  if (o.onFullscreen) {
    fs = button(ICON_FS, t("fullscreen"), () => o.onFullscreen?.());
    el.append(fs);
  }
  const end = document.createElement("span");
  end.className = "sv-bar-end";
  el.append(end);

  const setLayout = (m: LayoutMode) => {
    mode = m;
    // The button offers the other layout.
    const lbl = t(m === "page" ? "lineView" : "pageView");
    layoutBtn.innerHTML = m === "page" ? ICON_LINE : ICON_PAGE;
    layoutBtn.title = lbl;
    layoutBtn.setAttribute("aria-label", lbl);
  };
  const sync = (z: number) => {
    slider.value = String(zoomToSlider(z));
    label.textContent = `${Math.round(z * 100)}%`;
  };
  setLayout(mode);
  sync(o.zoom);
  return {
    el,
    end,
    sync,
    setLayout,
    setPlaying(on: boolean) {
      const lbl = t(on ? "pause" : "play");
      playBtn.innerHTML = on ? ICON_PAUSE : ICON_PLAY;
      playBtn.title = lbl;
      playBtn.setAttribute("aria-label", lbl);
    },
    reading(on: boolean) {
      if (!fs) return;
      const lbl = t(on ? "exitFullscreen" : "fullscreen");
      fs.innerHTML = on ? ICON_FS_EXIT : ICON_FS;
      fs.title = lbl;
      fs.setAttribute("aria-label", lbl);
    },
  };
}
