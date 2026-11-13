// Legacy "Sonata-compatible" music fonts (Sibelius Opus and its handwritten siblings, Finale
// Maestro, Petrucci, Engraver, Jazz...): one symbol per Mac keyboard character. The tables
// follow Finale's published Maestro character map, keyed by the Unicode of each character.
import type { PdfGlyph } from "./extract";
import type { FontMapper } from "./normalize";
import { DROP, smufl } from "./smufl";

/** Main music font: character to SMuFL glyph name. */
export const SONATA: Record<string, string> = {
  // Notes with stems (tempo marks, cue text) and noteheads.
  W: "noteheadDoubleWhole", "á": "noteheadDoubleWholeSquare", "›": "noteheadDoubleWholeSquare",
  w: "noteheadWhole", h: "noteHalfUp", H: "noteHalfDown", q: "noteQuarterUp", Q: "noteQuarterDown",
  e: "note8thUp", E: "note8thDown", x: "note16thUp", X: "note16thDown",
  ";": "graceNoteAppoggiaturaStemUp", ":": "graceNoteAppoggiaturaStemDown", "…": "graceNoteAcciaccaturaStemUp",
  "˙": "noteheadHalf", "œ": "noteheadBlack", ".": "augmentationDot", k: "augmentationDot",
  y: "noteheadTriangleUpWhite", "–": "noteheadSquareBlack", "≠": "noteheadSquareWhite",
  "·": "noteheadDiamondWhite", "‚": "noteheadDiamondBlack",
  "À": "noteheadSlashHorizontalEnds",
  // Flags; "second" flags stack under the first one for 32nds and shorter.
  j: "flag8thUp", J: "flag8thDown", r: "flag16thUp", R: "flag16thDown", "ê": "flag16thUp", "í": "flag16thDown",
  K: "flagInternalUp", "Ô": "flagInternalDown", "˚": "flagInternalUp", "": "flagInternalDown", "ë": "flagInternalUp", "ì": "flagInternalDown",
  // Accidentals: courtesy (bracketed) and small forms map to the plain sign.
  "#": "accidentalSharp", a: "accidentalSharp", I: "accidentalSharp", "[": "accidentalSharp",
  b: "accidentalFlat", A: "accidentalFlat", i: "accidentalFlat", "{": "accidentalFlat",
  n: "accidentalNatural", N: "accidentalNatural", "È": "accidentalNatural", "“": "accidentalNatural",
  "∫": "accidentalDoubleFlat", "å": "accidentalDoubleFlat", "”": "accidentalDoubleFlat",
  "‹": "accidentalDoubleSharp", "Å": "accidentalDoubleSharp", "]": "accidentalDoubleSharp",
  "ı": "accidentalQuarterToneFlatStein", $: "accidentalQuarterToneSharpStein",
  "(": "accidentalParensLeft", ")": "accidentalParensRight",
  // Rests.
  "„": "restDoubleWhole", "∑": "restWhole", "Ó": "restHalf", "Œ": "restQuarter", "‰": "rest8th",
  "≈": "rest16th", "®": "rest32nd", "Ù": "rest64th", "Â": "rest128th",
  // Dynamics.
  "Ø": "dynamicPPPP", "∏": "dynamicPPP", "π": "dynamicPP", P: "dynamicMP", p: "dynamicPiano",
  F: "dynamicMF", f: "dynamicForte", "ƒ": "dynamicFF", "Ï": "dynamicFFF", "Î": "dynamicFFFF",
  "Í": "dynamicFortePiano", Z: "dynamicForzando", "∂": "dynamicSforzandoPianissimo", "Ç": "dynamicSforzandoPiano",
  "ß": "dynamicSforzato", S: "dynamicSforzando1", "ç": "dynamicSforzando1",
  "Ω": "dynamicMezzo", "ñ": "dynamicNiente", "é": "dynamicRinforzando", s: "dynamicSforzando", z: "dynamicZ",
  // Articulations and ornaments.
  ">": "articAccentAbove", "˘": "articAccentStaccatoAbove", "ﬂ": "articAccentStaccatoBelow",
  "^": "articMarcatoAbove", v: "articMarcatoBelow", "´": "articMarcatoAbove", "ÿ": "articMarcatoBelow",
  "¨": "articMarcatoStaccatoAbove", "Ë": "articMarcatoStaccatoBelow",
  "-": "articTenutoAbove", "¯": "articTenutoStaccatoAbove", "<": "articTenutoStaccatoBelow",
  "ä": "articTenutoAccentAbove", "â": "articTenutoAccentBelow",
  U: "fermataAbove", u: "fermataBelow",
  "~": "wiggleTrill", M: "ornamentMordent", m: "ornamentShortTrill", "µ": "ornamentMordent", T: "ornamentTurn",
  "Ÿ": "ornamentTrill", g: "wiggleArpeggiatoUp",
  "≤": "stringsUpBow", "≥": "stringsDownBow", o: "stringsHarmonic",
  "°": "keyboardPedalPed", "*": "keyboardPedalUp",
  '"': "caesura", ",": "breathMarkComma", "Ö": "breathMarkComma",
  "!": "tremolo1", "@": "tremolo2",
  // Octave lines, repeats, segno and coda.
  "É": "ottavaAlta", "√": "ottavaAlta", "◊": "ottavaBassaVb", "Ü": "quindicesimaAlta", "€": "quindicesimaAlta", "¤": "quindicesimaAlta", "`": "quindicesimaBassaMb",
  "%": "segno", "ü": "segno", "ﬁ": "coda", "‘": "repeat1Bar", "«": "repeat2Bars",
  // Clefs.
  "&": "gClef", "†": "gClef8va", V: "gClef8vb", B: "cClef", "?": "fClef", "Ê": "fClef8va", t: "fClef8vb",
  "/": "unpitchedPercussionClef1", "ã": "unpitchedPercussionClef1", "÷": "unpitchedPercussionClef2",
  // Time signatures.
  c: "timeSigCommon", C: "timeSigCutCommon", "+": "timeSigPlus",
  ..."0123456789".split("").reduce<Record<string, string>>((o, d) => ((o[d] = `timeSig${d}`), o), {}),
  // Small digits (tuplets, fingering).
  "º": "tuplet0", "¡": "tuplet1", "™": "tuplet2", "£": "tuplet3", "¢": "tuplet4",
  "∞": "tuplet5", "§": "tuplet6", "¶": "tuplet7", "•": "tuplet8", "ª": "tuplet9",
  // Chord symbol signs, ledger and staff pieces.
  "Ñ": "csymAugmented", "˜": "csymDiminished", "ø": "csymHalfDiminished", "±": "csymMajorSeventh",
  _: "legerLine", "=": "staff5Lines", "\\": "barlineSingle", "Ò": "barlineDashed",
};

/** Sibelius's "Special" companion fonts: brackets, braces, clef octave numbers, string numbers. */
export const SONATA_SPECIAL: Record<string, string> = {
  "{": "brace", "°": "bracketTop", "¢": "bracketBottom",
  "<": "accidentalParensLeft", ">": "accidentalParensRight", "‹": "clef8",
  // Circled string numbers (read off Sibelius output: not in a published map).
  "·": "guitarString1", "‚": "guitarString2", "„": "guitarString3", "‰": "guitarString4", "Â": "guitarString5",
};

/** Sibelius's music-text fonts: dynamics letters, notes for tempo marks, tuplet digits. */
export const SONATA_TEXT: Record<string, string> = {
  p: "dynamicPiano", m: "dynamicMezzo", f: "dynamicForte", s: "dynamicSforzando", z: "dynamicZ", r: "dynamicRinforzando", n: "dynamicNiente",
  w: "noteWhole", h: "noteHalfUp", H: "noteHalfDown", q: "noteQuarterUp", Q: "noteQuarterDown",
  e: "note8thUp", E: "note8thDown", x: "note16thUp", X: "note16thDown", ".": "metAugmentationDot",
  ..."0123456789".split("").reduce<Record<string, string>>((o, d) => ((o[d] = `tuplet${d}`), o), {}),
};

const SIBELIUS = "Opus|Inkpen2|Reprise|Repris|Helsinki|Norfolk|Pori|Tamburo";
const FAMILY = new RegExp(`^(${SIBELIUS}|Maestro|Sonata|Petrucci|Engraver|Jazz|Broadway ?Copyist|November|Toccata|Anastasia)`, "i");

/** Which table a font uses, by its name; null when it is not a Sonata-style font. */
export function sonataKind(font: string): "main" | "special" | "text" | "plain" | "unknown" | null {
  const name = font.replace(/^[A-Z]{6}\+/, "");
  if (!FAMILY.test(name)) return null;
  if (/chord|times|lyric/i.test(name)) return "plain";
  if (/percussion|metronome|ornament|figured|extra|tab/i.test(name)) return "unknown";
  if (/special/i.test(name)) return "special";
  if (/text/i.test(name)) return new RegExp(`^(${SIBELIUS})`, "i").test(name) ? "text" : "plain";
  return "main";
}

function lookup(table: Record<string, string>, g: PdfGlyph): number | undefined {
  const name = table[g.unicode];
  return name === undefined ? undefined : smufl(name);
}

/** Maps a glyph of a Sonata-style font; unknown symbols of a music font are dropped. */
export const sonataMapper: FontMapper = (g) => {
  const kind = sonataKind(g.font);
  if (kind === "main") return lookup(SONATA, g) ?? DROP;
  if (kind === "special") return lookup(SONATA_SPECIAL, g) ?? DROP;
  if (kind === "text") return lookup(SONATA_TEXT, g) ?? null;
  return kind === "unknown" ? DROP : null;
};
