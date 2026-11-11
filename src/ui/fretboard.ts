import type { ScoreDoc } from "../model/score";
import { kids, text } from "../model/xml";
import type { NoteEvent } from "../play/timeline";

const STEP: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
export const GUITAR = [40, 45, 50, 55, 59, 64];
export const BASS = [28, 33, 38, 43];

/**
 * Open-string pitches, lowest first, of the score's fretted part: from its tab staff tuning,
 * else standard guitar or bass when the notes carry frets or the part is named so. Null when
 * nothing in the score is played on frets.
 */
export function fretTuning(score: ScoreDoc, events: NoteEvent[]): number[] | null {
  for (const sd of Array.from(score.doc.getElementsByTagName("staff-details"))) {
    const lines = kids(sd, "staff-tuning");
    if (!lines.length) continue;
    return lines
      .sort((a, b) => Number(a.getAttribute("line")) - Number(b.getAttribute("line")))
      .map((t) => (Number(text(t, "tuning-octave")) + 1) * 12 + (STEP[text(t, "tuning-step")] ?? 0) + (Number(text(t, "tuning-alter")) || 0));
  }
  const names = score.parts.map((p) => p.name).join(" ");
  if (/bass|basse|bajo|basso/i.test(names) && !/guitar|gitar|guitare|chitarra|guitarra/i.test(names)) return BASS;
  if (events.some((e) => e.string !== undefined) || /guitar|gitar|guitare|chitarra|guitarra|gitarre/i.test(names)) return GUITAR;
  return null;
}

/** Where a note is played: the score's string and fret, else the lowest fret that reaches it. */
export function position(e: NoteEvent, tuning: number[]): { string: number; fret: number } | null {
  if (e.string !== undefined && e.fret !== undefined && e.string <= tuning.length) return { string: e.string, fret: e.fret };
  let best: { string: number; fret: number } | null = null;
  tuning.forEach((open, i) => {
    const fret = e.midi - open;
    if (fret < 0 || fret > 24) return;
    if (!best || fret < best.fret) best = { string: tuning.length - i, fret };
  });
  return best;
}

export interface Dot {
  string: number;
  fret: number;
  color: string;
}

// A guitar neck seen from the player, highest string on top as in tab, with the positions
// sounding now lit and numbered.
export class Fretboard {
  readonly canvas: HTMLCanvasElement;
  private dots = new Map<string, Dot>();
  private frets = 12;

  constructor(private tuning: number[]) {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "sv-keys sv-frets";
  }

  /** Shows frets 0..n (at least 12) so every position in the piece fits. */
  setFrets(n: number): void {
    this.frets = Math.max(12, Math.min(24, n));
  }

  set(key: string, dot: Dot | null): void {
    if (dot) this.dots.set(key, dot);
    else this.dots.delete(key);
  }

  /** The string (1 = highest) and fret under a point of the canvas, in CSS px. */
  at(px: number, py: number): { string: number; fret: number } | null {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const strings = this.tuning.length;
    const open = Math.max(22, w * 0.05);
    const top = 8;
    const neck = h - top - 14;
    const string = Math.min(strings, Math.max(1, Math.floor((py - top) / (neck / strings)) + 1));
    if (px < open) return { string, fret: 0 };
    const fret = Math.min(this.frets, Math.max(1, Math.ceil(((px - open) * this.frets) / (w - open - 4))));
    return { string, fret };
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
    const strings = this.tuning.length;
    const open = Math.max(22, w * 0.05); // the open-string column, left of the nut
    const labels = 14; // fret numbers under the neck
    const top = 8;
    const neck = h - top - labels;
    const gap = neck / strings;
    const y = (s: number) => top + gap * (s - 0.5); // string 1 (highest) on top
    const x = (f: number) => open + ((w - open - 4) * f) / this.frets; // fret wire f
    const mid = (f: number) => (f === 0 ? open / 2 : (x(f - 1) + x(f)) / 2);
    g.fillStyle = "#1b1d22";
    g.fillRect(0, 0, w, h);
    g.fillStyle = "#3a2c22"; // rosewood
    g.fillRect(open, top, w - open - 4, neck);
    // Inlays.
    g.fillStyle = "#d9cfc0";
    const r = Math.min(gap * 0.22, 5);
    for (const f of [3, 5, 7, 9, 15, 17, 19, 21]) if (f <= this.frets) circle(g, mid(f), top + neck / 2, r);
    for (const f of [12, 24]) if (f <= this.frets) {
      circle(g, mid(f), top + neck * 0.3, r);
      circle(g, mid(f), top + neck * 0.7, r);
    }
    // Frets, then the nut.
    g.fillStyle = "#b9bcc2";
    for (let f = 1; f <= this.frets; f++) g.fillRect(x(f) - 1, top, 2, neck);
    g.fillStyle = "#efe9dc";
    g.fillRect(open - 3, top, 4, neck);
    // Strings: thicker as they go down.
    for (let s = 1; s <= strings; s++) {
      g.fillStyle = "#cfd2d6";
      const t = 0.8 + (s - 1) * 0.35;
      g.fillRect(open - 3, y(s) - t / 2, w - open, t);
    }
    // Fret numbers.
    g.fillStyle = "#8a8f98";
    g.font = "10px system-ui, sans-serif";
    g.textAlign = "center";
    for (let f = 1; f <= this.frets; f++) if ([1, 3, 5, 7, 9, 12, 15, 17, 19, 21, 24].includes(f)) g.fillText(String(f), mid(f), h - 3);
    // What sounds now: a dot on the string at its fret, with the fret number.
    const dr = Math.min(gap * 0.42, (x(1) - x(0)) * 0.4, 11);
    for (const d of this.dots.values()) {
      if (d.string < 1 || d.string > strings || d.fret > this.frets) continue;
      const cx = mid(d.fret);
      const cy = y(d.string);
      g.fillStyle = d.color;
      circle(g, cx, cy, dr);
      g.fillStyle = "#fff";
      g.font = `600 ${Math.max(8, dr * 1.1)}px system-ui, sans-serif`;
      g.textBaseline = "middle";
      g.fillText(String(d.fret), cx, cy + 0.5);
      g.textBaseline = "alphabetic";
    }
    // Open-string names at the left edge.
    g.fillStyle = "#8a8f98";
    g.font = `${Math.min(11, gap * 0.6)}px system-ui, sans-serif`;
    g.textBaseline = "middle";
    this.tuning.forEach((m, i) => {
      const s = strings - i;
      if (![...this.dots.values()].some((d) => d.string === s && d.fret === 0)) g.fillText(NAMES[m % 12], open / 2 - 2, y(s));
    });
    g.textBaseline = "alphabetic";
  }
}

const NAMES = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"];

function circle(g: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.fill();
}
