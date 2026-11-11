import type { ScoreDoc } from "../model/score";
import type { NoteEvent, Timeline } from "../play/timeline";
import { HAND_COLORS, Keyboard, noteLane } from "../ui/keyboard";
import type { View, ViewOptions } from "./view";

/** Seconds of music above the keyboard at zoom 1. */
const SECONDS = 4;

/** Colour of a note: per hand for a part on several staves (piano), else per part. */
export function noteColors(score: ScoreDoc): (e: NoteEvent) => string {
  const multi = score.measures.map((_, p) => score.attributesAt(p, Math.min(1, score.measureCount - 1)).some((a) => a.tagName === "staves" && Number(a.textContent) > 1));
  const firstPiano = multi.indexOf(true);
  return (e) => {
    if (multi[e.part]) {
      const base = e.part === firstPiano ? 0 : 2 + e.part;
      return HAND_COLORS[(base + (e.staff > 1 ? 1 : 0)) % HAND_COLORS.length];
    }
    return HAND_COLORS[(firstPiano >= 0 ? 2 + e.part : e.part) % HAND_COLORS.length];
  };
}

// Falling notes: no score, the notes drop from the top onto a piano keyboard and sound as
// they reach it, one colour per hand. Driven by the player's time.
export function createKeysView(score: ScoreDoc, timeline: () => Timeline, opts: ViewOptions): View & { showTime(t: number): void } {
  let zoom = opts.zoom;
  const root = document.createElement("div");
  root.className = "sv-falls";
  const fall = document.createElement("canvas");
  fall.className = "sv-fall";
  const kb = new Keyboard("sv-keys sv-keys-big");
  root.append(fall, kb.canvas);
  const color = noteColors(score);
  const tl = timeline();
  let lo = 127;
  let hi = 0;
  let maxDur = 0;
  for (const e of tl.events) {
    lo = Math.min(lo, e.midi);
    hi = Math.max(hi, e.midi);
    maxDur = Math.max(maxDur, e.dur);
  }
  kb.setRange(lo, hi);
  let time = 0;
  let shown = zoom;

  // First event at or after time t (binary search).
  const firstAt = (t: number) => {
    let a = 0;
    let b = tl.events.length;
    while (a < b) {
      const m = (a + b) >> 1;
      if (tl.events[m].time < t) a = m + 1;
      else b = m;
    }
    return a;
  };

  function draw(): void {
    kb.clearLit();
    const w = fall.clientWidth;
    const h = fall.clientHeight;
    if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    if (fall.width !== Math.round(w * dpr) || fall.height !== Math.round(h * dpr)) {
      fall.width = Math.round(w * dpr);
      fall.height = Math.round(h * dpr);
    }
    const g = fall.getContext("2d");
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = "#121418";
    g.fillRect(0, 0, w, h);
    kb.draw(); // lays the keys out for this width
    const keys = kb.geometry;
    // Octave guides behind the notes.
    g.fillStyle = "#1c1f25";
    for (const [m, k] of keys) if (m % 12 === 0) g.fillRect(k.x, 0, 1, h);
    const pps = (h / SECONDS) * shown;
    const until = time + h / pps;
    // A gap at the end of each note, so two strokes of one key read as two.
    const gap = Math.max(3, 0.05 * pps);
    for (let i = firstAt(time - maxDur); i < tl.events.length; i++) {
      const e = tl.events[i];
      if (e.time > until) break;
      if (e.time + e.dur < time) continue;
      const lane = noteLane(keys, e.midi);
      if (!lane) continue;
      const black = keys.get(e.midi)!.black;
      const bottom = h - (e.time - time) * pps;
      const top = bottom - Math.max(gap + 2, e.dur * pps) + gap;
      const on = e.time <= time && e.time + e.dur > time;
      const c = color(e);
      // A key struck again flashes lighter for a moment.
      if (on) kb.setLit(e.midi, time - e.time < 0.09 ? lighten(c, 0.45) : c);
      const x = lane.x + 1;
      const bw = Math.max(2, lane.w - 2);
      const y0 = Math.max(-4, top);
      const y1 = Math.min(h + 4, bottom);
      g.globalAlpha = on ? 1 : 0.88;
      g.fillStyle = black ? darken(c, 0.3) : c;
      roundRect(g, x, y0, bw, y1 - y0, Math.min(4, bw / 3));
      g.fill();
      // The strike edge: a light band where the note starts.
      g.fillStyle = lighten(c, 0.55);
      g.fillRect(x, Math.max(y0, y1 - 3), bw, Math.min(3, y1 - y0));
      if (black) {
        g.strokeStyle = "rgba(0,0,0,.55)";
        g.lineWidth = 1;
        roundRect(g, x + 0.5, y0 + 0.5, bw - 1, y1 - y0 - 1, Math.min(4, bw / 3));
        g.stroke();
      }
    }
    g.globalAlpha = 1;
    kb.draw();
  }

  const ro = new ResizeObserver(() => draw());
  ro.observe(root);
  requestAnimationFrame(draw);

  return {
    root,
    get zoom() {
      return zoom;
    },
    showTime(t: number) {
      time = t;
      draw();
    },
    preview(z: number) {
      shown = z;
      draw();
    },
    commit(z: number) {
      zoom = shown = z;
      draw();
    },
    relayout: draw,
    destroy() {
      ro.disconnect();
      root.remove();
    },
    showPosition() {},
    hidePosition() {},
    highlight() {},
    hit: () => null,
  };
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function mix(hex: string, to: number, t: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v: number) => Math.round(v + (to - v) * t);
  return `rgb(${ch((n >> 16) & 255)},${ch((n >> 8) & 255)},${ch(n & 255)})`;
}
const lighten = (hex: string, t: number) => mix(hex, 255, t);
const darken = (hex: string, t: number) => mix(hex, 0, t);
