// A piano keyboard drawn on a canvas, with keys lit in a colour per hand or part. Shared by
// the keyboard strip under the score and the falling-notes view.

const BLACK = new Set([1, 3, 6, 8, 10]);
export const isBlack = (midi: number) => BLACK.has(((midi % 12) + 12) % 12);

/** Practice: a key played that was expected, and one that was not. */
export const PRESSED_RIGHT = "#22c55e";
export const PRESSED_WRONG = "#ef4444";
/** In-time practice: a key struck early or late, and a note missed. */
export const PRESSED_NEAR = "#eab308";
export const MISSED = "#8b929c";
/** In-time practice colours of a note by how it was played. */
export const MARK_COLORS = { on: PRESSED_RIGHT, near: PRESSED_NEAR, miss: MISSED } as const;

/** Right hand, left hand, then one colour per further part. */
export const HAND_COLORS = ["#3b82f6", "#f59e0b", "#10b981", "#ec4899", "#8b5cf6", "#ef4444"];

export interface KeyGeom {
  x: number;
  w: number;
  black: boolean;
}

/** Key range covering lo..hi, widened to at least two octaves, starting and ending on white keys. */
export function keyRange(lo: number, hi: number): [number, number] {
  if (!(hi >= lo)) [lo, hi] = [48, 84];
  while (hi - lo < 24) {
    lo -= 1;
    hi += 1;
  }
  lo = Math.max(21, lo);
  hi = Math.min(108, hi);
  while (isBlack(lo)) lo--;
  while (isBlack(hi)) hi++;
  return [lo, hi];
}

/** Geometry of every key in [lo, hi] across `width` px. */
export function layoutKeys(lo: number, hi: number, width: number): Map<number, KeyGeom> {
  const whites: number[] = [];
  for (let m = lo; m <= hi; m++) if (!isBlack(m)) whites.push(m);
  const ww = width / whites.length;
  const out = new Map<number, KeyGeom>();
  whites.forEach((m, i) => out.set(m, { x: i * ww, w: ww, black: false }));
  for (let m = lo; m <= hi; m++) {
    if (!isBlack(m)) continue;
    const left = out.get(m - 1);
    if (!left) continue;
    // As on a piano: C♯ D♯ and F♯ G♯ A♯ lean towards the middle of their group.
    const w = ww * BLACK_WIDTH;
    const centre = left.x + ww + ww * BLACK_SHIFT[m % 12];
    out.set(m, { x: centre - w / 2, w, black: true });
  }
  return out;
}

// A black key's width, and where its centre sits from the line between its white neighbours,
// in white-key widths.
const BLACK_WIDTH = 0.58;
const BLACK_SHIFT: Record<number, number> = { 1: -0.1, 3: 0.1, 6: -0.13, 8: 0, 10: 0.13 };
// Falling notes on black keys are this much of the key's width.
const BLACK_NOTE = 0.84;

/**
 * Where a key's falling notes run: a white key's whole width (less a hairline, so two
 * neighbours read as two), a black key's a little narrower than the key. Black notes are
 * drawn over white ones, as the keys lie.
 */
export function noteLane(keys: Map<number, KeyGeom>, midi: number): { x: number; w: number } | null {
  const k = keys.get(midi);
  if (!k) return null;
  if (k.black) {
    const w = Math.max(2, k.w * BLACK_NOTE);
    return { x: k.x + (k.w - w) / 2, w };
  }
  const inset = Math.min(1.5, k.w * 0.06);
  return { x: k.x + inset, w: Math.max(2, k.w - 2 * inset) };
}

// The channels of a "#rrggbb" or "rgb(r, g, b)" colour.
function rgbOf(c: string): [number, number, number] {
  if (c.startsWith("#")) {
    const n = parseInt(c.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const m = c.match(/\d+(\.\d+)?/g)?.map(Number) ?? [0, 0, 0];
  return [m[0] ?? 0, m[1] ?? 0, m[2] ?? 0];
}

/** A colour mixed towards white (t > 0) or black (t < 0), as "rgb(...)". */
export function shade(c: string, t: number): string {
  const to = t >= 0 ? 255 : 0;
  const a = Math.abs(t);
  const [r, g, b] = rgbOf(c).map((v) => Math.round(v + (to - v) * a));
  return `rgb(${r},${g},${b})`;
}

/** A lighter tint of a colour, for the moment a key is struck. */
export function flash(hex: string, t = 0.45): string {
  return shade(hex, t);
}

// A rectangle with its lower corners rounded (keys hang from the top).
function keyPath(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  g.beginPath();
  g.moveTo(x, y);
  g.lineTo(x + w, y);
  g.lineTo(x + w, y + h - r);
  g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  g.lineTo(x + r, y + h);
  g.quadraticCurveTo(x, y + h, x, y + h - r);
  g.closePath();
}

export class Keyboard {
  readonly canvas: HTMLCanvasElement;
  private lo = 48;
  private hi = 84;
  private lit = new Map<number, string>();
  private keys = new Map<number, KeyGeom>();
  // Practice: keys to play next (outlined) and keys held on the instrument (filled).
  private expected = new Set<number>();
  private pressed = new Map<number, string>();
  // Gradients run down from y = 0, whatever the key's place: one per kind, colour and height,
  // made once rather than for every key on every frame (the falling notes draw 60 a second).
  private grads = new Map<string, CanvasGradient>();
  private gradsFor: CanvasRenderingContext2D | null = null;

  constructor(className = "sv-keys") {
    this.canvas = document.createElement("canvas");
    this.canvas.className = className;
  }

  setRange(lo: number, hi: number): void {
    [this.lo, this.hi] = keyRange(lo, hi);
    this.draw();
  }

  get range(): [number, number] {
    return [this.lo, this.hi];
  }

  /** Key geometry in CSS px of the canvas, after the last draw. */
  get geometry(): Map<number, KeyGeom> {
    return this.keys;
  }

  setLit(midi: number, color: string | null): void {
    if (color) this.lit.set(midi, color);
    else this.lit.delete(midi);
  }

  isLit(midi: number): boolean {
    return this.lit.has(midi);
  }

  clearLit(): void {
    this.lit.clear();
  }

  /** Practice marks: the keys expected next, and the keys held with their colour. */
  setPractice(expected: Iterable<number>, pressed: Map<number, string>): void {
    this.expected = new Set(expected);
    this.pressed = new Map(pressed);
  }

  get practiceMarks(): { expected: number[]; pressed: [number, string][] } {
    return { expected: [...this.expected], pressed: [...this.pressed] };
  }

  /** Lays the keys out for the canvas's width (see geometry) without drawing them. */
  layout(): Map<number, KeyGeom> {
    const w = this.canvas.clientWidth;
    if (w) this.keys = layoutKeys(this.lo, this.hi, w);
    return this.keys;
  }

  private gradient(g: CanvasRenderingContext2D, key: string, height: number, stops: [number, string][]): CanvasGradient {
    if (this.gradsFor !== g || this.grads.size > 256) {
      this.grads.clear();
      this.gradsFor = g;
    }
    const k = `${key}|${height}`;
    let grad = this.grads.get(k);
    if (!grad) {
      grad = g.createLinearGradient(0, 0, 0, height);
      for (const [at, colour] of stops) grad.addColorStop(at, colour);
      this.grads.set(k, grad);
    }
    return grad;
  }

  draw(): void {
    const c = this.canvas;
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    const g = c.getContext("2d");
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.keys = layoutKeys(this.lo, this.hi, w);
    g.fillStyle = "#0e0f12";
    g.fillRect(0, 0, w, h);
    const radius = (k: KeyGeom) => Math.min(4, k.w * 0.14);
    // White keys: ivory, a touch darker under the case and towards their rounded end.
    for (const [m, k] of this.keys) {
      if (k.black) continue;
      const lit = this.pressed.get(m) ?? this.lit.get(m);
      g.fillStyle = lit
        ? this.gradient(g, `w${lit}`, h, [
            [0, shade(lit, -0.12)],
            [0.25, lit],
            [1, shade(lit, 0.12)],
          ])
        : this.gradient(g, "w", h, [
            [0, "#c9cac6"],
            [0.12, "#f4f4f1"],
            [0.85, "#fdfdfb"],
            [1, "#e2e3df"],
          ]);
      keyPath(g, k.x + 0.5, 0, k.w - 1, h - 1, radius(k));
      g.fill();
      if (this.expected.has(m)) this.outline(g, k.x + 2, 2, k.w - 4, h - 5);
      if (m % 12 === 0 && k.w > 9) {
        g.fillStyle = lit ? "rgba(0,0,0,.45)" : "#8a8f98";
        g.font = `${Math.min(11, k.w * 0.55)}px system-ui, sans-serif`;
        g.textAlign = "center";
        g.fillText(`C${Math.floor(m / 12) - 1}`, k.x + k.w / 2, h - 5);
      }
    }
    // Black keys: a shadow on the white keys, a body, and a lighter front edge.
    const bh = h * 0.62;
    for (const [m, k] of this.keys) {
      if (!k.black) continue;
      const lit = this.pressed.get(m) ?? this.lit.get(m);
      g.fillStyle = "rgba(0,0,0,.28)";
      keyPath(g, k.x + 1.5, 0, k.w, bh + 2.5, radius(k));
      g.fill();
      g.fillStyle = this.gradient(g, `b${lit ?? ""}`, bh, [
        [0, lit ? shade(lit, -0.25) : "#121317"],
        [0.7, lit ? lit : "#2a2d34"],
        [1, lit ? shade(lit, -0.1) : "#24272d"],
      ]);
      keyPath(g, k.x, 0, k.w, bh, radius(k));
      g.fill();
      const edge = Math.min(6, bh * 0.08);
      g.fillStyle = lit ? shade(lit, 0.25) : "#454952";
      keyPath(g, k.x + k.w * 0.12, bh - edge - 1.5, k.w * 0.76, edge, radius(k) / 2);
      g.fill();
      if (this.expected.has(m)) this.outline(g, k.x + 1.5, 1.5, k.w - 3, bh - 3);
    }
    // The keys slide under the case: a soft shadow along the top.
    g.fillStyle = this.gradient(g, "case", 6, [
      [0, "rgba(0,0,0,.55)"],
      [1, "rgba(0,0,0,0)"],
    ]);
    g.fillRect(0, 0, w, 6);
  }

  private outline(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
    g.strokeStyle = PRESSED_RIGHT;
    g.lineWidth = 3;
    keyPath(g, x, y, Math.max(1, w), Math.max(1, h), Math.min(3, w / 4));
    g.stroke();
  }
}
