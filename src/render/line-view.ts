import { OpenSheetMusicDisplay } from "opensheetmusicdisplay";
import { patchOsmd, keepRepeatOpen } from "./osmd-patches";

patchOsmd();
import { breakSystems, systemOf, type SystemRange } from "../layout/systems";
import type { ScoreDoc } from "../model/score";
import { applyMarks, collectPositions, hitAt, xAt, type Positions } from "./positions";
import type { PracticeMarks, View, ViewOptions } from "./view";

export interface LineView extends View {
  /** Chunks of measures, each rendered as its own single-line OSMD score. */
  readonly chunks: readonly SystemRange[];
  /** Left edge of measure m in strip pixels (estimated until its chunk is rendered). */
  measureX(m: number): number;
  /** Scrolls so measure m starts at `at` (0..1) of the view width. */
  scrollToMeasure(m: number, at?: number, smooth?: boolean): void;
}

const UNIT_PX = 10;
// A chunk is about this wide (OSMD units): small enough to render in a frame or two.
const CHUNK_UNITS = 70;
const EST = { measureBase: 5, perWeight: 2.6 };
const AHEAD = 1;
const KEEP = 4;
// Room kept above and below the staves, in units.
const PAD = 1;
// Cropping stops this short of the first note (units), so a syllable reaching left survives.
const CROP_SLACK = 0.8;
// Fitting the height never goes past this: a tall desktop window would make giant notes.
const FIT_MAX = 1.6;

interface Chunk {
  el: HTMLDivElement;
  host: HTMLDivElement | null;
  osmd: OpenSheetMusicDisplay | null;
  rendering: boolean;
  /** y of the first staff line in this chunk's own render, in units. */
  y0: number;
  crop: number;
  pos: Positions | null;
}

// The line layout: the whole score on one staff system running sideways, for playing
// along. It is drawn in chunks of measures, each a single-line OSMD render; every chunk
// uses the same gap between staves and is shifted so its staves line up with the others,
// and all but the first have their leading clef and key cropped away so the line reads
// as one. Without a zoom set, the score is sized to the height of the view.
export function createLineView(score: ScoreDoc, opts: ViewOptions & { fit?: boolean }): LineView {
  let zoom = opts.zoom;
  let fit = opts.fit ?? true;
  const root = document.createElement("div");
  root.className = "sv-lroot";
  const strip = document.createElement("div");
  strip.className = "sv-strip";
  root.append(strip);
  const cursor = document.createElement("div");
  cursor.className = "sv-cursor";
  cursor.hidden = true;

  const staves = score.measures.length;
  const weights = Array.from({ length: score.measureCount }, (_, m) => score.measureWeight(m));
  const chunks: SystemRange[] = breakSystems(weights, { ...EST, systemStart: 0, width: CHUNK_UNITS });
  // Shared vertical metrics, in units: gap between staff tops, room above the first staff
  // and below the last staff top. They only grow, and growing re-renders what is drawn.
  let gap = 10;
  let top = 4;
  let bottom = 8;
  let slots: Chunk[] = [];
  let generation = 0;
  let destroyed = false;
  let settled = false;
  root.style.visibility = "hidden";
  const settle = () => {
    settled = true;
    root.style.visibility = "";
  };
  const settleTimer = window.setTimeout(settle, 3000);

  const unit = () => UNIT_PX * zoom;
  const estWidth = (r: SystemRange) => {
    let w = 0;
    for (let m = r.start; m < r.end; m++) w += EST.measureBase + weights[m] * EST.perWeight;
    return w * unit();
  };
  const stripHeight = () => (PAD + top + gap * (countStaves() - 1) + bottom + PAD) * unit();
  let staffCount = 0;
  const countStaves = () => staffCount || staves;

  function fitZoom(): boolean {
    if (!fit) return false;
    const avail = root.clientHeight;
    if (!avail) return false;
    const want = Math.min(FIT_MAX, Math.max(0.3, avail / ((PAD + top + gap * (countStaves() - 1) + bottom + PAD) * UNIT_PX)));
    if (Math.abs(want - zoom) / zoom < 0.04) return false;
    zoom = want;
    opts.onZoom?.(zoom);
    return true;
  }

  function layout(): void {
    generation++;
    strip.textContent = "";
    strip.append(cursor);
    strip.style.height = `${stripHeight()}px`;
    slots = chunks.map((r, i) => {
      const el = document.createElement("div");
      el.className = "sv-chunk";
      el.dataset.chunk = String(i);
      el.style.width = `${estWidth(r)}px`;
      strip.append(el);
      return { el, host: null, osmd: null, rendering: false, y0: 0, crop: 0, pos: null };
    });
    schedule();
  }

  function align(): void {
    strip.style.height = `${stripHeight()}px`;
    for (const s of slots) if (s.host) s.host.style.transform = `translateY(${(PAD + top - s.y0) * unit()}px)`;
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

  async function pump(): Promise<void> {
    const gen = generation;
    const left = root.scrollLeft;
    const view = root.clientWidth || window.innerWidth;
    let next = -1;
    let best = Infinity;
    slots.forEach((s, i) => {
      const x = s.el.offsetLeft;
      const right = x + s.el.offsetWidth;
      const dist = right < left ? left - right : x > left + view ? x - (left + view) : 0;
      if (dist > KEEP * view && s.osmd) {
        s.el.textContent = "";
        s.osmd = null;
        s.host = null;
        s.pos = null;
      }
      if (!s.osmd && !s.rendering && dist <= AHEAD * view && dist < best) {
        best = dist;
        next = i;
      }
    });
    if (next < 0) return;
    await renderChunk(next, gen);
    if (gen === generation) schedule();
  }

  async function renderChunk(i: number, gen: number): Promise<void> {
    const slot = slots[i];
    const range = chunks[i];
    slot.rendering = true;
    try {
      const host = document.createElement("div");
      host.className = "sv-chunk-host";
      const first = i === 0;
      const osmd = new OpenSheetMusicDisplay(host, {
        autoResize: false,
        backend: "svg",
        renderSingleHorizontalStaffline: true,
        drawTitle: false,
        drawSubtitle: false,
        drawComposer: false,
        drawLyricist: false,
        drawCredits: false,
        drawPartNames: first,
        drawPartAbbreviations: false,
      });
      const r = osmd.EngravingRules;
      // Every bar drawn on its own (no multi-bar rests), so playback can point at it.
      r.AutoGenerateMultipleRestMeasuresFromRestMeasures = false;
      r.PageLeftMargin = first ? 1 : 0;
      r.PageRightMargin = 0;
      r.PageTopMargin = 0;
      r.PageBottomMargin = 0;
      // Fixed gaps between staves, the same in every chunk.
      r.MinSkyBottomDistBetweenStaves = -100;
      r.MinimumStaffLineDistance = gap - 4;
      // No title of its own: none drawn (OSMD would write "Untitled Score").
      const xml = score.slice(range.start, range.end);
      await osmd.load(xml, "");
      keepRepeatOpen(osmd, xml);
      if (gen !== generation) return;
      // load() resets OSMD's zoom to 1.
      osmd.zoom = zoom;
      slot.el.textContent = "";
      slot.el.append(host);
      osmd.render();
      const lines = osmd.GraphicSheet.MusicPages[0]?.MusicSystems[0]?.StaffLines ?? [];
      staffCount = lines.length || staffCount;
      // How far apart the staves need to be for what this chunk draws between them.
      let needGap = gap;
      for (let k = 0; k + 1 < lines.length; k++) {
        const below = lines[k].SkyBottomLineCalculator.getBottomLineMax();
        const above = lines[k + 1].SkyBottomLineCalculator.getSkyLineMin();
        needGap = Math.max(needGap, 4 + Math.max(0, below - 4) + Math.max(0, -above) + 1);
      }
      const y0 = lines[0]?.PositionAndShape.AbsolutePosition.y ?? 0;
      const above = lines[0] ? -lines[0].SkyBottomLineCalculator.getSkyLineMin() : 0;
      const below = lines.length ? lines[lines.length - 1].SkyBottomLineCalculator.getBottomLineMax() : 0;
      if (needGap > gap + 0.25) {
        gap = Math.ceil(needGap * 2) / 2;
        fitZoom();
        layout();
        return;
      }
      let grew = false;
      if (above > top) {
        top = above;
        grew = true;
      }
      if (below > bottom) {
        bottom = below;
        grew = true;
      }
      if (fitZoom()) {
        layout();
        return;
      }
      // Crop the clef and key every chunk but the first starts with.
      const u = unit();
      const ms = osmd.GraphicSheet.MeasureList;
      const firstGm = ms[0]?.find((g) => g);
      const crop = !first && firstGm ? Math.max(0, firstGm.PositionAndShape.AbsolutePosition.x + firstGm.beginInstructionsWidth - CROP_SLACK) * u : 0;
      const svg = host.querySelector("svg");
      const w = svg ? Number(svg.getAttribute("width")) : estWidth(range);
      slot.el.style.width = `${Math.max(1, w - crop)}px`;
      host.style.marginLeft = `${-crop}px`;
      slot.crop = crop;
      slot.y0 = y0;
      slot.pos = collectPositions(osmd, range.start, zoom, crop);
      if (marks?.notes.size) applyMarks(slot.pos, marks.notes);
      slot.host = host;
      slot.osmd = osmd;
      if (grew) align();
      else host.style.transform = `translateY(${(PAD + top - y0) * u}px)`;
      if (!settled) {
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

  function measureX(m: number): number {
    const i = systemOf(chunks, m);
    const s = slots[i];
    if (!s) return 0;
    const b = s.pos?.beats.get(m);
    if (b) return s.el.offsetLeft + Math.max(0, b.left);
    const r = chunks[i];
    return s.el.offsetLeft + (s.el.offsetWidth * (m - r.start)) / Math.max(1, r.end - r.start);
  }

  // Zoom previews as a CSS scale, then re-renders the chunks at the new size and keeps the
  // measure at the left of the view in place.
  let shown = zoom;
  function previewZoom(z: number, at?: { x: number; y: number }): void {
    shown = z;
    const rect = root.getBoundingClientRect();
    const ox = at ? at.x - rect.left + root.scrollLeft : root.scrollLeft;
    strip.style.transformOrigin = `${ox}px 0`;
    strip.style.transform = shown === zoom ? "" : `scale(${shown / zoom})`;
  }
  function measureAtLeft(): number {
    const left = root.scrollLeft;
    const i = slots.findIndex((s) => s.el.offsetLeft + s.el.offsetWidth > left);
    return i >= 0 ? chunks[i].start : 0;
  }
  function scrollToMeasure(m: number, at = 0, smooth = false): void {
    const x = measureX(m) - root.clientWidth * at;
    root.scrollTo({ left: Math.max(0, x), behavior: smooth ? "smooth" : "auto" });
    schedule();
  }

  // Playback: the cursor sits at the playing beat and the line slides so it stays at a
  // third of the view from the left.
  function showPosition(m: number, q: number, quarters: number, follow: boolean): void {
    const i = systemOf(chunks, m);
    const s = slots[i];
    if (!s) return;
    const local = s.pos ? xAt(s.pos, m, q, quarters) : null;
    const x = local !== null ? s.el.offsetLeft + local : measureX(m) + ((measureX(m + 1 < score.measureCount ? m + 1 : m) - measureX(m)) * q) / Math.max(quarters, 1e-6);
    cursor.hidden = false;
    cursor.style.transform = `translateX(${x}px)`;
    if (follow) {
      root.scrollLeft = Math.max(0, x - root.clientWidth * 0.3);
      schedule();
    }
  }
  let marks: PracticeMarks | null = null;
  function mark(m: PracticeMarks): void {
    marks = m;
    for (const s of slots) if (s.pos) applyMarks(s.pos, m.notes);
  }
  function highlight(keys: string[], on: boolean): void {
    for (const k of keys) {
      const m = Number(k.split("|")[0]);
      const s = slots[systemOf(chunks, m)];
      for (const g of s?.pos?.notes.get(k) ?? []) g.classList.toggle("sv-on", on);
    }
  }

  const onScroll = () => schedule();
  root.addEventListener("scroll", onScroll, { passive: true });
  // A vertical wheel scrolls the line sideways on a desktop.
  const onWheel = (e: WheelEvent) => {
    if (e.ctrlKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    root.scrollLeft += e.deltaY;
    e.preventDefault();
  };
  root.addEventListener("wheel", onWheel, { passive: false });
  let lastHeight = 0;
  let resizeTimer = 0;
  const ro = new ResizeObserver(() => {
    if (Math.abs(root.clientHeight - lastHeight) < 2) return schedule();
    lastHeight = root.clientHeight;
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      const m = measureAtLeft();
      if (fitZoom() || !slots.length) layout();
      scrollToMeasure(m);
    }, 150);
  });
  ro.observe(root);
  requestAnimationFrame(() => {
    if (destroyed) return;
    lastHeight = root.clientHeight;
    fitZoom();
    layout();
  });

  return {
    root,
    get zoom() {
      return zoom;
    },
    get chunks() {
      return chunks;
    },
    measureX,
    scrollToMeasure,
    showPosition,
    hidePosition: () => (cursor.hidden = true),
    highlight,
    mark,
    hit(cx: number, _cy: number) {
      const x = cx - root.getBoundingClientRect().left + root.scrollLeft;
      const s = slots.find((c) => x >= c.el.offsetLeft && x < c.el.offsetLeft + c.el.offsetWidth);
      return s?.pos ? hitAt(s.pos, x - s.el.offsetLeft) : null;
    },
    preview: previewZoom,
    commit(z: number) {
      shown = z;
      strip.style.transform = "";
      if (z === zoom) return;
      const m = measureAtLeft();
      fit = false;
      zoom = z;
      layout();
      scrollToMeasure(m);
    },
    relayout: layout,
    destroy() {
      destroyed = true;
      clearTimeout(settleTimer);
      clearTimeout(resizeTimer);
      ro.disconnect();
      root.removeEventListener("scroll", onScroll);
      root.removeEventListener("wheel", onWheel);
      root.remove();
    },
  };
}
