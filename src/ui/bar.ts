import { t } from "./i18n";

export type LayoutMode = "page" | "line" | "keys";

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
const ICON_KEYS = svgIcon('<rect x="3" y="13" width="18" height="8" rx="1"/><line x1="8" x2="8" y1="13" y2="21"/><line x1="13" x2="13" y1="13" y2="21"/><line x1="18" x2="18" y1="13" y2="21"/><line x1="6" x2="6" y1="3" y2="9"/><line x1="11" x2="11" y1="5" y2="11"/><line x1="16" x2="16" y1="2" y2="8"/>');
const ICON_KBD = svgIcon('<rect x="2" y="6" width="20" height="12" rx="1"/><line x1="7" x2="7" y1="6" y2="18"/><line x1="12" x2="12" y1="6" y2="18"/><line x1="17" x2="17" y1="6" y2="18"/><rect x="5.5" y="6" width="3" height="7" fill="currentColor"/><rect x="15.5" y="6" width="3" height="7" fill="currentColor"/>');
const ICON_TAB = '<span class="sv-tab-label" aria-hidden="true">TAB</span>';
const ICON_FRETS = svgIcon('<rect x="2" y="7" width="20" height="10" rx="1"/><line x1="8" x2="8" y1="7" y2="17"/><line x1="14" x2="14" y1="7" y2="17"/><line x1="20" x2="20" y1="7" y2="17"/><line x1="2" x2="22" y1="10.5" y2="10.5"/><line x1="2" x2="22" y1="13.5" y2="13.5"/>');
const ICON_PARTS = svgIcon('<line x1="9" x2="21" y1="6" y2="6"/><line x1="9" x2="21" y1="12" y2="12"/><line x1="9" x2="21" y1="18" y2="18"/><polyline points="3 6 4.5 7.5 7 4.5"/><polyline points="3 12 4.5 13.5 7 10.5"/><line x1="3" x2="7" y1="18" y2="18"/>');
const ICON_EDIT = svgIcon('<path d="M4 20h4L19 9l-4-4L4 16z"/><line x1="13.5" x2="17.5" y1="6.5" y2="10.5"/>');
const ICON_VOL = svgIcon('<path d="M4 9v6h3.5L12 19V5L7.5 9H4z" fill="currentColor"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>');
const ICON_MUTED = svgIcon('<path d="M4 9v6h3.5L12 19V5L7.5 9H4z" fill="currentColor"/><line x1="16" x2="21" y1="9.5" y2="14.5"/><line x1="21" x2="16" y1="9.5" y2="14.5"/>');
const ICON_LINE = svgIcon('<line x1="2" x2="22" y1="9" y2="9"/><line x1="2" x2="22" y1="15" y2="15"/><polyline points="17 5 21 12 17 19"/>');

export interface BarOptions {
  zoom: number;
  layout: LayoutMode;
  /** The slider moves: preview this zoom. */
  onZoomInput(z: number): void;
  /** The slider was released. */
  onZoomCommit(): void;
  onLayout(mode: LayoutMode): void;
  /** Shows or hides the keyboard strip under the score. */
  onKeyboard(on: boolean): void;
  /** A fretboard strip, for scores played on frets (instead of the keyboard). */
  fretboard?: boolean;
  onFretboard?(on: boolean): void;
  onPlay(): void;
  /** Playback speed, 1 = as written. */
  onSpeed(speed: number): void;
  /** Playback volume (0 to 1) and mute, as they start. */
  volume?: { value: number; muted: boolean };
  onVolume?(value: number, muted: boolean): void;
  onFullscreen?(): void;
  /** A tab button, for scores with fretted parts. */
  tab?: { on: boolean; toggle(on: boolean): void };
  /** Shows or hides parts: the indices shown, null for all. */
  onParts?(shown: number[] | null): void;
  /** An Edit button, for scores that can be edited. */
  onEdit?(): void;
}

export interface Bar {
  el: HTMLElement;
  end: HTMLElement;
  sync(zoom: number): void;
  setLayout(mode: LayoutMode): void;
  setPlaying(on: boolean): void;
  reading(on: boolean): void;
  /** The parts of the score and those shown (null: all); no button for a single part. */
  setParts(names: string[], shown: number[] | null): void;
  setFretboard(available: boolean): void;
}

/** Puts a pop-up of the bar over its button, kept inside the bar. */
function placePop(pop: HTMLElement, anchor: HTMLElement): void {
  const bar = pop.offsetParent as HTMLElement | null;
  if (!bar) return;
  const room = bar.clientWidth - pop.offsetWidth - 8;
  const left = anchor.offsetLeft + anchor.offsetWidth / 2 - pop.offsetWidth / 2;
  pop.style.left = `${Math.max(8, Math.min(room, left))}px`;
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
  // Volume: the speaker in the bar, its slider in a pop-up above it. With a mouse, hovering
  // opens it and a click mutes; on touch the tap opens it (there is no hover).
  const volWrap = document.createElement("span");
  volWrap.className = "sv-volwrap";
  const volBtn = button(ICON_VOL, t("mute"), () => {
    if (!volTouch) {
      muted = !muted;
      syncVolume();
      o.onVolume?.(volume, muted);
      return;
    }
    volPop.hidden = !volPop.hidden;
    volBtn.setAttribute("aria-expanded", String(!volPop.hidden));
  });
  volBtn.setAttribute("aria-expanded", "false");
  const volPop = document.createElement("div");
  volPop.className = "sv-pop sv-pop-vol";
  volPop.hidden = true;
  const volRange = document.createElement("input");
  volRange.type = "range";
  volRange.min = "0";
  volRange.max = "100";
  volRange.step = "1";
  volRange.setAttribute("aria-label", t("volume"));
  volPop.append(volRange);
  volWrap.append(volBtn, volPop);
  let volume = o.volume?.value ?? 1;
  let muted = o.volume?.muted ?? false;
  let volTouch = false;
  const syncVolume = () => {
    const silent = muted || volume === 0;
    volBtn.innerHTML = silent ? ICON_MUTED : ICON_VOL;
    const lbl = t(muted ? "unmute" : "mute");
    volBtn.title = `${lbl} (${t("volume")} ${Math.round(volume * 100)}%)`;
    volBtn.setAttribute("aria-label", lbl);
    volBtn.setAttribute("aria-pressed", String(muted));
    volRange.value = String(Math.round((muted ? 0 : volume) * 100));
  };
  volRange.addEventListener("input", () => {
    volume = Number(volRange.value) / 100;
    muted = volume === 0;
    syncVolume();
    o.onVolume?.(volume, muted);
  });
  volBtn.addEventListener("pointerdown", (e) => (volTouch = e.pointerType !== "mouse"));
  volBtn.addEventListener("pointerenter", (e) => {
    if (e.pointerType === "mouse") volPop.hidden = false;
  });
  volWrap.addEventListener("pointerleave", (e) => {
    if (e.pointerType === "mouse") volPop.hidden = true;
  });
  // Keyboard: the button mutes, arrows on it change the volume.
  volBtn.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    volume = Math.min(1, Math.max(0, volume + (e.key === "ArrowUp" ? 0.05 : -0.05)));
    muted = false;
    syncVolume();
    o.onVolume?.(volume, muted);
  });
  syncVolume();
  volWrap.hidden = !o.onVolume;
  // Parts: a button opening a list of the parts to tick.
  const partsBtn = button(ICON_PARTS, t("parts"), () => {
    partsPop.hidden = !partsPop.hidden;
    partsBtn.setAttribute("aria-expanded", String(!partsPop.hidden));
    if (!partsPop.hidden) placePop(partsPop, partsBtn);
  });
  partsBtn.setAttribute("aria-expanded", "false");
  partsBtn.hidden = true;
  const partsPop = document.createElement("div");
  partsPop.className = "sv-pop sv-pop-parts";
  partsPop.hidden = true;
  let partBoxes: HTMLInputElement[] = [];
  let allBox: HTMLInputElement | null = null;
  const checkbox = (labelText: string, cls?: string) => {
    const l = document.createElement("label");
    if (cls) l.className = cls;
    const c = document.createElement("input");
    c.type = "checkbox";
    l.append(c, document.createTextNode(labelText));
    l.title = labelText;
    partsPop.append(l);
    return c;
  };
  const shownNow = (): number[] | null => {
    const on = partBoxes.flatMap((b, i) => (b.checked ? [i] : []));
    return on.length === partBoxes.length ? null : on;
  };
  const syncParts = () => {
    const n = partBoxes.filter((b) => b.checked).length;
    if (allBox) {
      allBox.checked = n === partBoxes.length;
      allBox.indeterminate = n > 0 && n < partBoxes.length;
    }
    partsBtn.classList.toggle("is-on", n < partBoxes.length);
    partsBtn.setAttribute("aria-pressed", String(n < partBoxes.length));
  };
  const setParts = (names: string[], shown: number[] | null) => {
    partsPop.replaceChildren();
    partsBtn.hidden = names.length < 2 || !o.onParts;
    if (partsBtn.hidden) partsPop.hidden = true;
    allBox = checkbox(t("allParts"), "sv-all");
    allBox.addEventListener("change", () => {
      // "All" unticked keeps the first part: a score shows at least one.
      partBoxes.forEach((b, i) => (b.checked = allBox!.checked || i === 0));
      syncParts();
      o.onParts?.(shownNow());
    });
    const set = shown ? new Set(shown) : null;
    partBoxes = names.map((name, i) => {
      const b = checkbox(name || `${t("parts")} ${i + 1}`);
      b.checked = !set || set.has(i);
      b.addEventListener("change", () => {
        if (!partBoxes.some((x) => x.checked)) b.checked = true;
        syncParts();
        o.onParts?.(shownNow());
      });
      return b;
    });
    syncParts();
  };
  document.addEventListener("pointerdown", (e) => {
    if (!pop.hidden && !pop.contains(e.target as Node) && e.target !== speedBtn) {
      pop.hidden = true;
      speedBtn.setAttribute("aria-expanded", "false");
    }
    if (!volPop.hidden && !volWrap.contains(e.target as Node)) {
      volPop.hidden = true;
      volBtn.setAttribute("aria-expanded", "false");
    }
    if (!partsPop.hidden && !partsPop.contains(e.target as Node) && !partsBtn.contains(e.target as Node)) {
      partsPop.hidden = true;
      partsBtn.setAttribute("aria-expanded", "false");
    }
  });
  // The three layouts as one segmented control.
  const seg = document.createElement("span");
  seg.className = "sv-seg";
  seg.setAttribute("role", "group");
  const layoutBtns = new Map<LayoutMode, HTMLButtonElement>();
  for (const [m, icon, key] of [
    ["page", ICON_PAGE, "pageView"],
    ["line", ICON_LINE, "lineView"],
    ["keys", ICON_KEYS, "keysView"],
  ] as const) {
    const b = button(icon, t(key), () => o.onLayout(m));
    layoutBtns.set(m, b);
    seg.append(b);
  }
  let kbdOn = false;
  const kbdBtn = button(ICON_KBD, t("keyboard"), () => {
    kbdOn = !kbdOn;
    kbdBtn.setAttribute("aria-pressed", String(kbdOn));
    if (kbdOn && fretOn) {
      fretOn = false;
      fretBtn.setAttribute("aria-pressed", "false");
      o.onFretboard?.(false);
    }
    o.onKeyboard(kbdOn);
  });
  kbdBtn.setAttribute("aria-pressed", "false");
  // Keyboard and fretboard share the space under the score: one at a time.
  let fretOn = false;
  const fretBtn = button(ICON_FRETS, t("fretboard"), () => {
    fretOn = !fretOn;
    fretBtn.setAttribute("aria-pressed", String(fretOn));
    if (fretOn && kbdOn) {
      kbdOn = false;
      kbdBtn.setAttribute("aria-pressed", "false");
      o.onKeyboard(false);
    }
    o.onFretboard?.(fretOn);
  });
  fretBtn.setAttribute("aria-pressed", "false");
  fretBtn.hidden = !o.fretboard;
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
  el.append(playBtn, speedBtn, pop, volWrap, seg, kbdBtn, fretBtn);
  if (o.tab) {
    let tabOn = o.tab.on;
    const tabBtn = button(ICON_TAB, t("tablature"), () => {
      tabOn = !tabOn;
      tabBtn.setAttribute("aria-pressed", String(tabOn));
      o.tab!.toggle(tabOn);
    });
    tabBtn.classList.add("sv-bb-tab");
    tabBtn.setAttribute("aria-pressed", String(tabOn));
    el.append(tabBtn);
  }
  if (o.onEdit) el.append(button(ICON_EDIT, t("edit"), () => o.onEdit?.()));
  el.append(partsBtn, partsPop, grow, slider, label);
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
    for (const [k, b] of layoutBtns) {
      b.classList.toggle("is-on", k === m);
      b.setAttribute("aria-pressed", String(k === m));
    }
    kbdBtn.hidden = m === "keys";
    fretBtn.hidden = m === "keys" || !fretAvailable;
  };
  let fretAvailable = !!o.fretboard;
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
    setParts,
    setFretboard(available: boolean) {
      fretAvailable = available;
      fretBtn.hidden = mode === "keys" || !available;
      if (!available && fretOn) fretBtn.click();
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
