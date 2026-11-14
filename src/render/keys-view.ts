import type { ScoreDoc } from "../model/score";
import { handParts } from "../play/practice";
import type { NoteEvent, Timeline } from "../play/timeline";
import { HAND_COLORS, Keyboard, MARK_COLORS, noteLane, shade } from "../ui/keyboard";
import type { PracticeMarks, View, ViewOptions } from "./view";

/** Seconds of music above the keyboard at zoom 1. */
const SECONDS = 4;

/**
 * Colour of a note: per hand for a part on several staves (piano), or for parts that are a
 * hand each ("Right" and "Left" tracks, the piano's two colours whatever their staves), else per part.
 */
export function noteColors(score: ScoreDoc): (e: NoteEvent) => string {
  const hands = handParts(score.parts.map((p) => p.name));
  const multi = score.measures.map((_, p) => !hands.has(p) && score.attributesAt(p, Math.min(1, score.measureCount - 1)).some((a) => a.tagName === "staves" && Number(a.textContent) > 1));
  const firstPiano = hands.size ? -1 : multi.indexOf(true);
  const offset = hands.size || firstPiano >= 0 ? 2 : 0;
  return (e) => {
    const hand = hands.get(e.part);
    if (hand) return HAND_COLORS[hand === "right" ? 0 : 1];
    if (multi[e.part]) {
      const base = e.part === firstPiano ? 0 : 2 + e.part;
      return HAND_COLORS[(base + (e.staff > 1 ? 1 : 0)) % HAND_COLORS.length];
    }
    return HAND_COLORS[(offset + e.part) % HAND_COLORS.length];
  };
}

// Falling notes: no score, the notes drop from the top onto a piano keyboard and sound as
// they reach it, one colour per hand. Driven by the player's time.
export function createKeysView(
  score: ScoreDoc,
  timeline: () => Timeline,
  opts: ViewOptions,
): View & { showTime(t: number): void; readonly keyboard: Keyboard; setLoop(range: { start: number; end: number } | null): void } {
  // The loop (piece seconds): a green line where it starts, a red one where it ends, and the
  // notes past its end dimmed (they are not played: the loop starts again).
  let loop: { start: number; end: number } | null = null;
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
  let marks: PracticeMarks | null = null;

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

  // The notes' bodies, one gradient per colour and lane width (from x = 0, drawn translated):
  // made once rather than for every note on every frame.
  const bodies = new Map<string, CanvasGradient>();
  let bodiesFor: CanvasRenderingContext2D | null = null;
  const bodyOf = (g: CanvasRenderingContext2D, base: string, bw: number) => {
    if (bodiesFor !== g || bodies.size > 512) {
      bodies.clear();
      bodiesFor = g;
    }
    const key = `${base}|${bw}`;
    let body = bodies.get(key);
    if (!body) {
      body = g.createLinearGradient(0, 0, bw, 0);
      body.addColorStop(0, shade(base, 0.12));
      body.addColorStop(1, base);
      bodies.set(key, body);
    }
    return body;
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
    // Lanes behind the notes, one per white key: C to E a shade lighter than F to B, so the
    // groups of black keys can be followed up from the keyboard; a line at each C.
    for (const [m, k] of keys) {
      if (k.black) continue;
      const pc = m % 12;
      g.fillStyle = pc <= 4 ? "#171a20" : "#121418";
      g.fillRect(k.x, 0, k.w, h);
      g.fillStyle = pc === 0 ? "#2a2e36" : "#1a1d23";
      g.fillRect(Math.round(k.x), 0, 1, h);
    }
    const pps = (h / SECONDS) * shown;
    const until = time + h / pps;
    // A gap at the end of each note, so two strokes of one key read as two.
    const gap = Math.max(3, 0.05 * pps);
    // White keys' notes first, black keys' over them, as the keys lie.
    const blacks: number[] = [];
    const first = firstAt(time - maxDur);
    const drawNote = (e: NoteEvent, black: boolean) => {
      const lane = noteLane(keys, e.midi);
      if (!lane) return;
      const bottom = h - (e.time - time) * pps;
      const top = bottom - Math.max(gap + 2, e.dur * pps) + gap;
      const on = e.time <= time && e.time + e.dur > time;
      const mk = marks?.events.get(e);
      const c = mk ? MARK_COLORS[mk] : color(e);
      // A key struck again flashes lighter for a moment.
      if (on) kb.setLit(e.midi, time - e.time < 0.09 ? lighten(c, 0.45) : c);
      const x = lane.x;
      const bw = lane.w;
      const y0 = Math.max(-4, top);
      const y1 = Math.min(h + 4, bottom);
      const r = Math.min(5, bw / 3);
      g.globalAlpha = loop && e.time >= loop.end - 1e-6 ? 0.25 : on ? 1 : 0.92;
      // A body lit from the left, so a bar reads as a solid piece.
      g.fillStyle = bodyOf(g, black ? darken(c, 0.18) : c, bw);
      g.translate(x, 0);
      roundRect(g, 0, y0, bw, y1 - y0, r);
      g.fill();
      g.translate(-x, 0);
      // The strike edge: a light band where the note starts.
      g.fillStyle = lighten(c, 0.55);
      g.fillRect(x + r / 2, Math.max(y0, y1 - 3), Math.max(1, bw - r), Math.min(3, y1 - y0));
      // Black notes lie over white ones: a dark rim keeps them apart.
      if (black) {
        g.strokeStyle = "rgba(0,0,0,.7)";
        g.lineWidth = 1.5;
        roundRect(g, x + 0.75, y0 + 0.75, bw - 1.5, y1 - y0 - 1.5, r);
        g.stroke();
      }
    };
    for (let i = first; i < tl.events.length; i++) {
      const e = tl.events[i];
      if (e.time > until) break;
      if (e.time + e.dur < time) continue;
      if (keys.get(e.midi)?.black) blacks.push(i);
      else drawNote(e, false);
    }
    for (const i of blacks) drawNote(tl.events[i], true);
    g.globalAlpha = 1;
    if (loop) {
      const line = (at: number, colour: string) => {
        const y = h - (at - time) * pps;
        if (y < -2 || y > h + 2) return;
        g.fillStyle = colour;
        g.fillRect(0, Math.round(y) - 1, w, 3);
      };
      line(loop.start, "#22c55e");
      line(loop.end, "#ef4444");
    }
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
    keyboard: kb,
    setLoop(r) {
      loop = r ? { ...r } : null;
      draw();
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
    mark(m: PracticeMarks) {
      marks = m;
      draw();
    },
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
