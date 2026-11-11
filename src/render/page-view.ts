import { OpenSheetMusicDisplay } from "opensheetmusicdisplay";
import { breakSystems, systemOf, type SystemRange } from "../layout/systems";
import { abbreviate, type ScoreDoc } from "../model/score";
import { kid, kids, text } from "../model/xml";
import { collectPositions, hitAt, xAt, type Positions } from "./positions";
import type { View, ViewOptions } from "./view";

/** What a tap or click on the page points at, for editing. */
export interface Pick {
  measure: number;
  quarter: number;
  /** Part (in the rendered score) and staff under the point, with half staff spaces down from its top line. */
  part: number;
  staff: number;
  step: number;
  lines: number;
  /** Client y of that line or space, for showing where a note would go. */
  snapY: number;
  /** The note head under the point, if any. */
  note: Positions["drawn"][number] | null;
}

export interface PageView extends View {
  readonly systems: readonly SystemRange[];
  /** Points to the score after an edit (the same piece) and draws measures [from, to) again. */
  refresh(next: ScoreDoc, from: number, to: number): void;
  pick(clientX: number, clientY: number): Pick | null;
  /** The note-entry caret on a staff at a beat, or none. */
  showCaret(c: { measure: number; quarter: number; part: number; staff: number } | null): void;
  /** Marks the drawn notes of these (measure, onset, part, staff, voice, rank) as selected. */
  select(keys: { measure: number; onset: number; part: number; staff: number; voice: string; rank?: number }[]): void;
  /** The fitted width model, in OSMD units (for tests and tuning). */
  readonly layoutParams: Readonly<{ measureBase: number; perWeight: number; systemStart: number; width: number }>;
}

// Layout constants, in OSMD units (one staff space = 1 unit = 10 px at zoom 1).
const UNIT_PX = 10;
const MARGIN = 2;
const BREAK = { measureBase: 5, perWeight: 2.6, systemStart: 9 };
// Width of one character of a part name, in OSMD units.
const LABEL_CHAR = 0.9;
const TIME_WIDTH = 4;
// How far outside the viewport systems are rendered ahead, and kept, in viewport heights.
const AHEAD = 1;
const KEEP = 4;

interface Slot {
  el: HTMLDivElement;
  osmd: OpenSheetMusicDisplay | null;
  height: number;
  rendering: boolean;
  pos: Positions | null;
}

// The page layout: each system (line) is its own OSMD render of a MusicXML slice, so a
// long score opens at the speed of its first screen and an edit re-renders one line.
export function createPageView(initial: ScoreDoc, opts: ViewOptions): PageView {
  let score = initial;
  let zoom = opts.zoom;
  const root = document.createElement("div");
  root.className = "sv-root";
  const page = document.createElement("div");
  page.className = "sv-page";
  root.append(page);
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
  // Extra room the first system gives up when its part names run longer than allowed for.
  let firstCut = 0;
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

  /** Line breaks for measures from `from` on (the first system gives room to the full part names). */
  function breaksFrom(from: number): SystemRange[] {
    const shift = (rs: SystemRange[], by: number) => rs.map((r) => ({ start: r.start + by, end: r.end + by }));
    // Systems give up room for the part names on their left: full on the first, short after.
    const label = (names: string[]) => (names.some(Boolean) ? Math.max(...names.map((n) => n.length)) * LABEL_CHAR + 2 : 0);
    const later = units - label(score.parts.map((p) => p.abbreviation || (score.parts.length > 1 ? abbreviate(p.name) : "")));
    let fresh = shift(breakSystems(weights.slice(from), { ...params, width: later }), from);
    // The first system also carries the part names and the time signature.
    if (from === 0 && fresh.length > 1 && score.parts.some((p) => p.name)) {
      const first = breakSystems(weights, { ...params, width: units - label(score.parts.map((p) => p.name)) - TIME_WIDTH - firstCut })[0];
      if (first.end < fresh[0].end) fresh = [first, ...shift(breakSystems(weights.slice(first.end), { ...params, width: later }), first.end)];
    }
    return fresh;
  }

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
    const fresh = breaksFrom(from);
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
        return { el, osmd: null, height: h, rendering: false, pos: null };
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
        s.pos = null;
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
        drawPartNames: true,
        drawPartAbbreviations: false,
        stretchLastSystemLine: true,
      });
      const r = osmd.EngravingRules;
      // Every bar drawn on its own (no multi-bar rests), so playback can point at it.
      r.AutoGenerateMultipleRestMeasuresFromRestMeasures = false;
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
      host.style.width = `${width}px`;
      // Drawn again in place: the old drawing stays until the new one is ready.
      const swap = !!slot.osmd;
      if (swap) host.style.cssText += ";position:absolute;left:0;top:0;visibility:hidden";
      else slot.el.textContent = "";
      slot.el.append(host);
      await osmd.load(score.slice(range.start, range.end, { header: first, abbreviate: !first }));
      if (gen !== generation) return;
      // load() resets OSMD's zoom to 1.
      osmd.zoom = zoom;
      osmd.render();
      let rebreak = learn(osmd, range, first);
      const lines = osmd.GraphicSheet.MusicPages.reduce((n, p) => n + p.MusicSystems.length, 0);
      if (!rebreak && first && lines > 1 && range.end - range.start > 1 && firstCut < units / 2) {
        firstCut += units * 0.12;
        rebreak = true;
      } else if (!rebreak && !first && lines > 1 && range.end - range.start > 1 && calibrations < 6) {
        // Still too full for OSMD: widen every measure a little.
        params.measureBase *= 1.1;
        calibrations++;
        rebreak = true;
      }
      if (rebreak && !settled) {
        layout(false);
        return;
      }
      if (swap) {
        for (const c of [...slot.el.children]) if (c !== host && !c.classList.contains("sv-cursor") && !c.classList.contains("sv-caret")) c.remove();
        host.style.position = host.style.left = host.style.top = host.style.visibility = "";
      }
      slot.osmd = osmd;
      slot.pos = collectPositions(osmd, range.start, zoom);
      slotRendered(i);
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
  function previewZoom(z: number, at?: { x: number; y: number }): void {
    shown = z;
    const rect = root.getBoundingClientRect();
    const ox = at ? at.x - rect.left + root.scrollLeft : root.clientWidth / 2;
    const oy = at ? at.y - rect.top + root.scrollTop : root.scrollTop;
    page.style.transformOrigin = `${ox}px ${oy}px`;
    page.style.transform = shown === zoom ? "" : `scale(${shown / zoom})`;
  }
  function commitZoom(): void {
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

  // Playback: a cursor in the playing system; the page scrolls when it leaves the view.
  const cursor = document.createElement("div");
  cursor.className = "sv-cursor";
  // Following: scroll to the playing system when it changes or leaves the view, even before it
  // is drawn (it is drawn once in view). A system taller than the view (a full orchestra on a
  // phone) is scrolled to once, then left for the reader to move around in.
  // Halfway through a system, the next one is brought into view too, so it can be read ahead.
  let followed = -1;
  let ahead = -1;
  function showPosition(m: number, q: number, quarters: number, follow: boolean): void {
    const i = systemOf(systems, m);
    const s = slots[i];
    if (!s) return;
    const x = s.pos ? xAt(s.pos, m, q, quarters) : null;
    if (follow && i === followed && ahead !== i && x !== null && x > s.el.clientWidth / 2 && slots[i + 1]) {
      ahead = i;
      const top = s.el.offsetTop - page.offsetTop;
      const next = slots[i + 1].el;
      const nextBottom = next.offsetTop - page.offsetTop + next.offsetHeight;
      const want = Math.min(top - 12, nextBottom - root.clientHeight + 12);
      if (want > root.scrollTop + 1) {
        root.scrollTo({ top: want, behavior: "smooth" });
        schedule();
      }
    }
    if (follow) {
      const top = s.el.offsetTop - page.offsetTop;
      const bottom = top + s.el.offsetHeight;
      const view = root.clientHeight;
      const tall = s.el.offsetHeight > view;
      const outside = top < root.scrollTop - 1 || top > root.scrollTop + view - 40 || (!tall && bottom > root.scrollTop + view);
      if (i !== followed || (!tall && outside)) {
        root.scrollTo({ top: Math.max(0, top - 12), behavior: i === followed + 1 ? "smooth" : "auto" });
        followed = i;
        schedule();
      }
    }
    if (x === null) {
      cursor.hidden = true;
      return;
    }
    if (cursor.parentElement !== s.el) s.el.append(cursor);
    cursor.hidden = false;
    cursor.style.transform = `translateX(${x}px)`;
    if (s.pos && s.pos.bottom > s.pos.top) {
      const pad = 10 * zoom;
      cursor.style.top = `${s.pos.top - pad}px`;
      cursor.style.bottom = "auto";
      cursor.style.height = `${s.pos.bottom - s.pos.top + 2 * pad}px`;
    }
  }
  function highlight(keys: string[], on: boolean): void {
    for (const k of keys) {
      const s = slots[systemOf(systems, Number(k.split("|")[0]))];
      for (const g of s?.pos?.notes.get(k) ?? []) g.classList.toggle("sv-on", on);
    }
  }

  // ---- Editing: redraw after an edit, picking, caret and selection.
  function refresh(next: ScoreDoc, from: number, to: number): void {
    score = next;
    if (weights.length !== score.measureCount) weights = Array.from({ length: score.measureCount }, (_, m) => score.measureWeight(m));
    else for (let m = Math.max(0, from); m < Math.min(to, weights.length); m++) weights[m] = score.measureWeight(m);
    const i = Math.max(0, systemOf(systems, from));
    const j = Math.max(i, systemOf(systems, Math.max(from, to - 1)));
    const fresh = breaksFrom(systems[i]?.start ?? 0);
    const same = fresh.length >= j - i + 1 && systems.slice(i, j + 1).every((r, k) => r.start === fresh[k].start && r.end === fresh[k].end) && systems.length - i === fresh.length;
    if (!same) {
      layout(false, i);
      return;
    }
    generation++;
    for (let k = i; k <= j; k++) {
      const s = slots[k];
      if (s.osmd) void renderSystem(k, generation);
    }
  }

  let caretAt: { measure: number; quarter: number; part: number; staff: number } | null = null;
  const caret = document.createElement("div");
  caret.className = "sv-caret";
  function showCaret(c: typeof caretAt): void {
    caretAt = c;
    if (!c) return void caret.remove();
    const i = systemOf(systems, c.measure);
    const s = slots[i];
    const box = s?.pos?.staves.find((b) => b.part === c.part && b.staff === c.staff);
    const x = s?.pos ? xAt(s.pos, c.measure, c.quarter, Number.MAX_SAFE_INTEGER) : null;
    if (!s || !box || x === null) return void caret.remove();
    if (caret.parentElement !== s.el) s.el.append(caret);
    const pad = 8 * zoom;
    caret.style.transform = `translateX(${x}px)`;
    caret.style.top = `${box.top - pad}px`;
    caret.style.height = `${box.bottom - box.top + 2 * pad}px`;
  }

  let selected: Parameters<PageView["select"]>[0] = [];
  function select(keys: typeof selected): void {
    for (const g of page.querySelectorAll(".sv-sel")) g.classList.remove("sv-sel");
    selected = keys;
    for (const k of keys) {
      const s = slots[systemOf(systems, k.measure)];
      for (const d of s?.pos?.drawn ?? [])
        if (d.measure === k.measure && Math.abs(d.onset - k.onset) < 1e-6 && d.part === k.part && d.staff === k.staff && d.voice === k.voice && (k.rank === undefined || d.rank === k.rank)) d.g.classList.add("sv-sel");
    }
  }

  // A system drawn (again): the caret and selection in it are put back.
  function slotRendered(i: number): void {
    if (caretAt && systemOf(systems, caretAt.measure) === i) showCaret(caretAt);
    if (selected.some((k) => systemOf(systems, k.measure) === i)) select(selected);
  }

  function pick(cx: number, cy: number): Pick | null {
    for (const s of slots) {
      const r = s.el.getBoundingClientRect();
      if (cy < r.top || cy >= r.bottom || !s.pos) continue;
      const x = cx - r.left;
      const y = cy - r.top;
      const at = hitAt(s.pos, x);
      if (!at) return null;
      // The staff nearest the point.
      let box = s.pos.staves[0];
      let best = Infinity;
      for (const b of s.pos.staves) {
        const d = y < b.top ? b.top - y : y > b.bottom ? y - b.bottom : 0;
        if (d < best) [best, box] = [d, b];
      }
      if (!box) return null;
      const half = (5 * zoom) / 1;
      const step = Math.round((y - box.top) / half);
      // A note head within a staff space of the point.
      let note: Pick["note"] = null;
      let nd = 9 * zoom * 1.4;
      for (const d of s.pos.drawn) {
        if (d.part !== box.part || d.staff !== box.staff) continue;
        const dist = Math.hypot(d.x + 5 * zoom - x, d.y - y);
        if (dist < nd) [nd, note] = [dist, d];
      }
      return { measure: note?.measure ?? at.measure, quarter: note?.onset ?? at.quarter, part: box.part, staff: box.staff, step, lines: box.lines, snapY: r.top + box.top + step * half, note };
    }
    return null;
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
  // Laid out once the root is in the document and has a width.
  requestAnimationFrame(() => !destroyed && layout());

  return {
    root,
    get zoom() {
      return zoom;
    },
    get systems() {
      return systems;
    },
    get layoutParams() {
      return { ...params, width: units };
    },
    preview: previewZoom,
    showPosition,
    hidePosition: () => (cursor.hidden = true),
    refresh,
    pick,
    showCaret,
    select,
    highlight,
    hit(cx: number, cy: number) {
      for (const s of slots) {
        const r = s.el.getBoundingClientRect();
        if (cy < r.top || cy >= r.bottom || !s.pos) continue;
        return hitAt(s.pos, cx - r.left);
      }
      return null;
    },
    commit(z: number) {
      shown = z;
      commitZoom();
    },
    relayout: () => layout(true),
    destroy() {
      destroyed = true;
      clearTimeout(settleTimer);
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
