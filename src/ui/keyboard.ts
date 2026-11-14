// A piano keyboard drawn on a canvas, with keys lit in a colour per hand or part. Shared by
// the keyboard strip under the score and the falling-notes view.

const BLACK = new Set([1, 3, 6, 8, 10]);
export const isBlack = (midi: number) => BLACK.has(((midi % 12) + 12) % 12);

/** Practice: a key played that was expected, and one that was not. */
export const PRESSED_RIGHT = "#22c55e";
export const PRESSED_WRONG = "#ef4444";

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
    if (left) out.set(m, { x: left.x + ww * 0.68, w: ww * 0.64, black: true });
  }
  return out;
}

/**
 * The span of a key as seen from above, where it meets the falling notes: for a white key,
 * the part between its black neighbours, so it never reads as the black key beside it.
 */
export function noteLane(keys: Map<number, KeyGeom>, midi: number): { x: number; w: number } | null {
  const k = keys.get(midi);
  if (!k) return null;
  if (k.black) return { x: k.x, w: k.w };
  const left = keys.get(midi - 1);
  const right = keys.get(midi + 1);
  const x0 = left?.black ? left.x + left.w : k.x;
  const x1 = right?.black ? right.x : k.x + k.w;
  return { x: x0, w: Math.max(2, x1 - x0) };
}

/** A lighter tint of a #rrggbb colour, for the moment a key is struck. */
export function flash(hex: string, t = 0.45): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v: number) => Math.round(v + (255 - v) * t);
  return `rgb(${ch((n >> 16) & 255)},${ch((n >> 8) & 255)},${ch(n & 255)})`;
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
    g.fillStyle = "#1b1d22";
    g.fillRect(0, 0, w, h);
    for (const [m, k] of this.keys) {
      if (k.black) continue;
      g.fillStyle = this.pressed.get(m) ?? this.lit.get(m) ?? "#fbfbf8";
      g.fillRect(k.x + 0.5, 0, k.w - 1, h - 1);
      if (this.expected.has(m)) this.outline(g, k.x + 2, 2, k.w - 4, h - 5);
      if (m % 12 === 0 && k.w > 9) {
        g.fillStyle = "#8a8f98";
        g.font = `${Math.min(11, k.w * 0.55)}px system-ui, sans-serif`;
        g.textAlign = "center";
        g.fillText(`C${Math.floor(m / 12) - 1}`, k.x + k.w / 2, h - 5);
      }
    }
    for (const [m, k] of this.keys) {
      if (!k.black) continue;
      g.fillStyle = this.pressed.get(m) ?? this.lit.get(m) ?? "#22252b";
      g.fillRect(k.x, 0, k.w, h * 0.62);
      if (this.expected.has(m)) this.outline(g, k.x + 1.5, 1.5, k.w - 3, h * 0.62 - 3);
    }
  }

  private outline(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
    g.strokeStyle = PRESSED_RIGHT;
    g.lineWidth = 3;
    g.strokeRect(x, y, Math.max(1, w), Math.max(1, h));
  }
}
