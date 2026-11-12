import { midiOf, spellMidi, type Pitch } from "./notes";

// Transposing by an interval: diatonic steps and semitones (both negative going down).

const STEPS = "CDEFGAB";

/** An interval by name, going up: steps and semitones. */
export const INTERVALS: Record<string, [steps: number, semitones: number]> = {
  m2: [1, 1],
  M2: [1, 2],
  m3: [2, 3],
  M3: [2, 4],
  P4: [3, 5],
  A4: [3, 6],
  d5: [4, 6],
  P5: [4, 7],
  m6: [5, 8],
  M6: [5, 9],
  m7: [6, 10],
  M7: [6, 11],
  P8: [7, 12],
};

/** How far key signatures move for an interval, in fifths (a major 2nd up: two sharps more). */
export const fifthsOf = (steps: number, semitones: number) => 7 * semitones - 12 * steps;

/** A key past seven sharps or flats, as its enharmonic one (F♯ for G♭ and so on, the simpler side). */
export function plainKey(fifths: number): number {
  let f = fifths;
  while (f > 7) f -= 12;
  while (f < -7) f += 12;
  return f;
}

/** A pitch moved by an interval, spelled by it (C up a major 2nd is D); spelled for the key when that needs a triple accidental. */
export function transposePitch(p: Pitch, steps: number, semitones: number, fifths: number): Pitch {
  const target = midiOf(p) + semitones;
  const index = STEPS.indexOf(p.step) + steps;
  const step = STEPS[((index % 7) + 7) % 7];
  const octave = p.octave + Math.floor(index / 7);
  const alter = target - midiOf({ step, alter: 0, octave });
  if (Math.abs(alter) <= 2) return { step, alter, octave };
  return spellMidi(target, fifths);
}

/** The interval from one key to another: up, down or the nearer way. */
export function intervalToKey(from: number, to: number, direction: "up" | "down" | "closest"): [steps: number, semitones: number] {
  const d = to - from;
  let semitones = (((7 * d) % 12) + 12) % 12;
  let steps = (((4 * d) % 7) + 7) % 7;
  // The same pitch spelled anew (C♯ to D♭) moves no way.
  if (semitones && (direction === "down" || (direction === "closest" && semitones > 6))) {
    semitones -= 12;
    steps -= 7;
  }
  return [steps, semitones];
}
