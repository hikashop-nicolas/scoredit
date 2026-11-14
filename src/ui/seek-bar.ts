// The timeline over the bottom bar: where playback is in the piece (bar and time), a track to
// click or drag to move, and the loop as a band with a start handle (green) and an end handle
// (red) that snap to bar lines. A long press, or Shift, then a drag on the track draws a new
// loop over the bars it covers.
import type { MeasureSpan } from "../play/timeline";
import { t } from "./i18n";

export interface SeekBarOptions {
  /** Moves playback to piece time `time` (seconds). */
  onSeek(time: number): void;
  /** The loop set from the bar: measures (indices from 0, both played). */
  onLoop(from: number, to: number): void;
  /** The number the score prints for a measure index (its index + 1 when left out). */
  measureLabel?(measure: number): string;
}

export interface SeekBar {
  el: HTMLElement;
  /** The measures as played and the piece's length; the bar shows once it has them. */
  setTimeline(spans: MeasureSpan[], duration: number): void;
  setTime(time: number): void;
  /** The loop in piece seconds (null: none). */
  setLoop(range: { start: number; end: number } | null): void;
}

/** "m:ss" of a number of seconds. */
export function clock(sec: number): string {
  const s = Math.max(0, Math.floor(sec + 1e-6));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * The spans a loop drawn from piece time `a` to `b` covers: the bar `a` falls in to the bar `b`
 * falls in (either way round), as indices into `spans`.
 */
export function spansBetween(spans: MeasureSpan[], a: number, b: number): [number, number] {
  const at = (x: number) => {
    let i = spans.findIndex((s) => x < s.end - 1e-9);
    if (i < 0) i = spans.length - 1;
    return Math.max(0, i);
  };
  const i = at(Math.min(a, b));
  const j = at(Math.max(a, b));
  return [i, j];
}

/**
 * The measure index a bar number typed by the player names, from the score's own numbers
 * (`labels[m]`): of the measures carrying it (movements number again from 1), the one nearest
 * index `near`. Null when no measure carries it.
 */
export function measureOfLabel(labels: string[], typed: string, near = 0): number | null {
  const want = typed.trim().toLowerCase();
  if (!want) return null;
  let best: number | null = null;
  labels.forEach((l, m) => {
    if (l.toLowerCase() === want && (best === null || Math.abs(m - near) < Math.abs(best - near))) best = m;
  });
  return best;
}

/** The span whose start (or end) is nearest piece time `x`. */
export function nearestSpan(spans: MeasureSpan[], x: number, edge: "start" | "end"): number {
  let best = 0;
  let d = Infinity;
  spans.forEach((s, i) => {
    const e = Math.abs((edge === "start" ? s.start : s.end) - x);
    if (e < d) {
      d = e;
      best = i;
    }
  });
  return best;
}

export function createSeekBar(o: SeekBarOptions): SeekBar {
  const el = document.createElement("div");
  el.className = "sv-seek";
  el.hidden = true;
  const where = document.createElement("span");
  where.className = "sv-seek-where";
  const track = document.createElement("div");
  track.className = "sv-seek-track";
  track.setAttribute("role", "slider");
  track.setAttribute("aria-label", t("seek"));
  track.tabIndex = 0;
  const fill = document.createElement("div");
  fill.className = "sv-seek-fill";
  const band = document.createElement("div");
  band.className = "sv-seek-loop";
  const head = document.createElement("div");
  head.className = "sv-seek-head";
  const handle = (cls: string, label: string) => {
    const h = document.createElement("div");
    h.className = `sv-seek-h ${cls}`;
    h.setAttribute("role", "slider");
    h.setAttribute("aria-label", label);
    h.tabIndex = 0;
    return h;
  };
  const hStart = handle("sv-seek-start", t("loopStart"));
  const hEnd = handle("sv-seek-end", t("loopEnd"));
  track.append(band, fill, head, hStart, hEnd);
  const time = document.createElement("span");
  time.className = "sv-seek-time";
  el.append(where, track, time);

  let spans: MeasureSpan[] = [];
  let duration = 0;
  let now = 0;
  let loop: { start: number; end: number } | null = null;
  // While dragging: the time shown instead of playback's, or the loop being drawn.
  let dragTime: number | null = null;
  let dragLoop: { start: number; end: number } | null = null;

  const pct = (x: number) => `${duration > 0 ? Math.min(100, Math.max(0, (x / duration) * 100)) : 0}%`;
  const spanAt = (x: number) => {
    const i = spans.findIndex((s) => x < s.end - 1e-9);
    return spans[i < 0 ? spans.length - 1 : i];
  };
  function render(): void {
    const shown = dragTime ?? now;
    fill.style.width = pct(shown);
    head.style.left = pct(shown);
    const s = spanAt(shown);
    where.textContent = s ? `${t("barN")} ${o.measureLabel?.(s.measure) ?? s.measure + 1}` : "";
    time.textContent = `${clock(shown)} / ${clock(duration)}`;
    track.setAttribute("aria-valuetext", `${where.textContent}, ${clock(shown)}`);
    const l = dragLoop ?? loop;
    band.hidden = hStart.hidden = hEnd.hidden = !l;
    if (l) {
      band.style.left = hStart.style.left = pct(l.start);
      band.style.width = `calc(${pct(l.end)} - ${pct(l.start)})`;
      hEnd.style.left = pct(l.end);
    }
  }
  const timeAt = (clientX: number) => {
    const r = track.getBoundingClientRect();
    return r.width > 0 ? Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * duration : 0;
  };
  const commitLoop = (i: number, j: number) => {
    const a = spans[Math.min(i, j)];
    const b = spans[Math.max(i, j)];
    if (a && b) o.onLoop(a.measure, b.measure);
  };

  // The track: a click or drag moves playback (on release); a long press or Shift draws a loop.
  track.addEventListener("pointerdown", (e) => {
    if (e.target === hStart || e.target === hEnd || !duration) return;
    e.preventDefault();
    track.setPointerCapture(e.pointerId);
    const from = timeAt(e.clientX);
    let drawing = e.shiftKey;
    let moved = false;
    const press = window.setTimeout(() => {
      if (moved) return;
      drawing = true;
      dragTime = null;
      draw(from);
    }, 450);
    const draw = (x: number) => {
      const [i, j] = spansBetween(spans, from, x);
      dragLoop = { start: spans[i].start, end: spans[j].end };
      render();
    };
    const move = (ev: PointerEvent) => {
      const x = timeAt(ev.clientX);
      if (Math.abs(ev.clientX - e.clientX) > 4) moved = true;
      if (drawing) draw(x);
      else dragTime = x;
      render();
    };
    const up = (ev: PointerEvent) => {
      clearTimeout(press);
      track.removeEventListener("pointermove", move);
      track.removeEventListener("pointerup", up);
      track.removeEventListener("pointercancel", up);
      const x = timeAt(ev.clientX);
      if (drawing) {
        const [i, j] = spansBetween(spans, from, x);
        dragLoop = null;
        commitLoop(i, j);
      } else if (ev.type === "pointerup") o.onSeek(x);
      dragTime = null;
      render();
    };
    if (drawing) draw(from);
    else dragTime = from;
    render();
    track.addEventListener("pointermove", move);
    track.addEventListener("pointerup", up);
    track.addEventListener("pointercancel", up);
  });

  // The handles: dragged, they snap to bar lines; the loop keeps at least one bar.
  const dragHandle = (h: HTMLElement, edge: "start" | "end") => {
    h.addEventListener("pointerdown", (e) => {
      if (!loop) return;
      e.preventDefault();
      e.stopPropagation();
      h.setPointerCapture(e.pointerId);
      const base = loop;
      const ends = () => {
        const i = nearestSpan(spans, base.start, "start");
        const j = nearestSpan(spans, base.end, "end");
        return [i, j];
      };
      let [i, j] = ends();
      const move = (ev: PointerEvent) => {
        const x = timeAt(ev.clientX);
        if (edge === "start") i = Math.min(nearestSpan(spans, x, "start"), j);
        else j = Math.max(nearestSpan(spans, x, "end"), i);
        dragLoop = { start: spans[i].start, end: spans[j].end };
        render();
      };
      const up = () => {
        h.removeEventListener("pointermove", move);
        h.removeEventListener("pointerup", up);
        h.removeEventListener("pointercancel", up);
        if (dragLoop) commitLoop(i, j);
        dragLoop = null;
        render();
      };
      h.addEventListener("pointermove", move);
      h.addEventListener("pointerup", up);
      h.addEventListener("pointercancel", up);
    });
    // Arrows move a handle by a bar.
    h.addEventListener("keydown", (e) => {
      if (!loop || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
      e.preventDefault();
      let i = nearestSpan(spans, loop.start, "start");
      let j = nearestSpan(spans, loop.end, "end");
      const step = e.key === "ArrowLeft" ? -1 : 1;
      if (edge === "start") i = Math.max(0, Math.min(j, i + step));
      else j = Math.min(spans.length - 1, Math.max(i, j + step));
      commitLoop(i, j);
    });
  };
  dragHandle(hStart, "start");
  dragHandle(hEnd, "end");
  // Arrows on the track move a bar back or on.
  track.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const i = spans.indexOf(spanAt(now));
    const s = spans[Math.max(0, Math.min(spans.length - 1, i + (e.key === "ArrowLeft" ? (now - spans[i].start > 0.3 ? 0 : -1) : 1)))];
    if (s) o.onSeek(s.start);
  });

  return {
    el,
    setTimeline(sp, d) {
      spans = sp;
      duration = d;
      el.hidden = !sp.length || !(d > 0);
      render();
    },
    setTime(x) {
      now = x;
      if (!el.hidden) render();
    },
    setLoop(r) {
      loop = r ? { ...r } : null;
      render();
    },
  };
}
