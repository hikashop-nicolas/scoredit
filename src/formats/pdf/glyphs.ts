// The SMuFL code points the notation reader understands, by role.

export type HeadKind = "breve" | "whole" | "half" | "black";

const HEADS: Record<number, HeadKind> = {
  0xe0a0: "breve",
  0xe0a1: "breve",
  0xe0a2: "whole",
  0xe0a3: "half",
  0xe0a4: "black",
  0xe0a6: "breve",
  0xe0a7: "whole",
  0xe0a8: "half",
  0xe0a9: "black",
  0xe0d7: "whole",
  0xe0d8: "whole",
  0xe0d9: "half",
  0xe0db: "black",
  0xe0fa: "whole",
  0xe0fb: "half",
};

/** Notehead kind, or null when the code point is not a notehead. */
export function headKind(cp: number): HeadKind | null {
  if (HEADS[cp]) return HEADS[cp];
  // Other noteheads (shapes, slashes): filled.
  if ((cp >= 0xe0a0 && cp <= 0xe0ff && cp !== 0xe0a5 && !(cp >= 0xe0f5 && cp <= 0xe0f6)) || (cp >= 0xe100 && cp <= 0xe10f)) return "black";
  return null;
}

/** Quarter lengths of plain notes by notehead. */
export const HEAD_LENGTH: Record<HeadKind, number> = { breve: 8, whole: 4, half: 2, black: 1 };

export const ACCIDENTALS: Record<number, number> = { 0xe260: -1, 0xe261: 0, 0xe262: 1, 0xe263: 2, 0xe264: -2, 0xe265: 3, 0xe266: -3 };

/** Clefs: MusicXML sign, the note on the glyph's baseline (diatonic index, C4 = 28), octave change. */
export const CLEFS: Record<number, { sign: string; ref: number; octave: number }> = {
  0xe050: { sign: "G", ref: 32, octave: 0 },
  0xe051: { sign: "G", ref: 18, octave: -2 },
  0xe052: { sign: "G", ref: 25, octave: -1 },
  0xe053: { sign: "G", ref: 39, octave: 1 },
  0xe054: { sign: "G", ref: 46, octave: 2 },
  0xe05c: { sign: "C", ref: 28, octave: 0 },
  0xe05d: { sign: "C", ref: 21, octave: -1 },
  0xe062: { sign: "F", ref: 24, octave: 0 },
  0xe063: { sign: "F", ref: 10, octave: -2 },
  0xe064: { sign: "F", ref: 17, octave: -1 },
  0xe065: { sign: "F", ref: 31, octave: 1 },
  0xe066: { sign: "F", ref: 38, octave: 2 },
  0xe069: { sign: "percussion", ref: 34, octave: 0 },
  0xe06a: { sign: "percussion", ref: 34, octave: 0 },
};

/** Time signature digits 0-9, common and cut time. */
export const timeDigit = (cp: number) => (cp >= 0xe080 && cp <= 0xe089 ? cp - 0xe080 : -1);
export const TIME_COMMON = 0xe08a;
export const TIME_CUT = 0xe08b;

/** Rests: quarter lengths. */
export const RESTS: Record<number, number> = { 0xe4e1: 16, 0xe4e2: 8, 0xe4e3: 4, 0xe4e4: 2, 0xe4e5: 1, 0xe4e6: 0.5, 0xe4e7: 0.25, 0xe4e8: 0.125, 0xe4e9: 0.0625, 0xe4ea: 0.03125 };
export const REST_WHOLE = 0xe4e3;

/** Flags: number of beams they stand for, and whether the stem goes up. */
export function flag(cp: number): { n: number; up: boolean } | null {
  if (cp < 0xe240 || cp > 0xe24f) return null;
  const k = cp - 0xe240;
  return { n: Math.floor(k / 2) + 1, up: k % 2 === 0 };
}

export const AUGMENTATION_DOT = 0xe1e7;
export const REPEAT_DOT = 0xe044;
export const BRACE = 0xe000;

/** Tuplet number digits. */
export const tupletDigit = (cp: number) => (cp >= 0xe880 && cp <= 0xe889 ? cp - 0xe880 : -1);

/** Dynamics glyphs, by the letters they show. */
export const DYNAMICS: Record<number, string> = {
  0xe520: "p",
  0xe521: "m",
  0xe522: "f",
  0xe523: "r",
  0xe524: "s",
  0xe525: "z",
  0xe526: "n",
  0xe527: "pppppp",
  0xe528: "ppppp",
  0xe529: "pppp",
  0xe52a: "ppp",
  0xe52b: "pp",
  0xe52c: "mp",
  0xe52d: "mf",
  0xe52e: "pf",
  0xe52f: "ff",
  0xe530: "fff",
  0xe531: "ffff",
  0xe532: "fffff",
  0xe533: "ffffff",
  0xe534: "fp",
  0xe535: "fz",
  0xe536: "sf",
  0xe537: "sfp",
  0xe538: "sfpp",
  0xe539: "sfz",
  0xe53a: "sfzp",
  0xe53b: "sffz",
  0xe53c: "rf",
  0xe53d: "rfz",
};

/** Octave lines: semitones the notes under them sound away from where they are written. */
export const OTTAVAS: Record<number, number> = { 0xe510: 12, 0xe511: 12, 0xe512: -12, 0xe513: -12, 0xe514: 24, 0xe515: 24, 0xe516: -24, 0xe517: -24, 0xe51c: -12, 0xe51d: -24 };
