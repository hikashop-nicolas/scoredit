// Quick looks at a file's bytes, for a host choosing how to open it: is this PDF a score made
// by notation software, is this MIDI file notation or a played-in performance.
import { unzlibSync } from "fflate";
import { parseSmf } from "./midi";
import { MUSIC_FONT } from "./pdf/fonts";

const NOTATION_APPS = /musescore|sibelius|finale|lilypond|dorico|notion|guitar ?pro|noteworthy|capella|encore|scorecloud|noteflight|flat\.io|frescobaldi|abc2ps|abcm2ps|verovio|harmony assistant|overture|forte notation|staffpad/i;
const SCAN_MAX = 16 << 20;
const CHUNK = 1 << 20;
const OBJSTM_MAX = 40;

/**
 * Whether a PDF is a score engraved by notation software: it names a music font (Leland,
 * Opus, Maestro, Emmentaler...). A scan of a score is not one: it has no music font.
 */
export function isScorePdf(bytes: Uint8Array): boolean {
  if (String.fromCharCode(...bytes.subarray(0, 5)) !== "%PDF-") return false;
  // In chunks (overlapping by a font name's length), stopping at the first music font.
  const end = Math.min(bytes.length, SCAN_MAX);
  let packed = false;
  for (let at = 0; at < end; at += CHUNK) {
    const text = latin1(bytes.subarray(at, Math.min(end, at + CHUNK + 256)));
    if (namesMusicFont(text)) return true;
    packed ||= text.includes("/ObjStm");
  }
  if (!packed) return false;
  // Font dictionaries packed in object streams (PDF 1.5) only show once inflated.
  const text = latin1(bytes.subarray(0, end));
  let seen = 0;
  for (let i = text.indexOf("/ObjStm"); i >= 0 && seen < OBJSTM_MAX; i = text.indexOf("/ObjStm", i + 7)) {
    // The stream that follows this dictionary.
    const head = text.indexOf("stream", i);
    if (head < 0 || head - i > 2048) continue;
    let start = head + 6;
    if (text[start] === "\r") start++;
    if (text[start] === "\n") start++;
    const stop = text.indexOf("endstream", start);
    if (stop < 0) continue;
    seen++;
    try {
      if (namesMusicFont(latin1(unzlibSync(bytes.subarray(start, stop))))) return true;
    } catch {
      /* not deflated, or damaged: skip it */
    }
  }
  return false;
}

/** The notation program that made a PDF, from its Creator or Producer, if it says so. */
export function pdfNotationApp(bytes: Uint8Array): string | null {
  const text = latin1(bytes.subarray(0, Math.min(bytes.length, 1 << 20)));
  for (const m of text.matchAll(/\/(?:Creator|Producer)\s*\(([^)]*)\)|<xmp:CreatorTool>([^<]*)</g)) {
    const s = m[1] ?? m[2] ?? "";
    if (NOTATION_APPS.test(s)) return s.trim();
  }
  return null;
}

function namesMusicFont(text: string): boolean {
  for (const m of text.matchAll(/\/(?:BaseFont|FontName)\s*\/(?:[A-Z]{6}\+)?([^\s/<>[\]()]+)/g)) if (MUSIC_FONT.test(m[1])) return true;
  return false;
}

/**
 * Whether a MIDI file reads as notation (written or exported from a score: onsets on a beat
 * grid) rather than a played-in performance (onsets off the grid). No notes, or not MIDI: false.
 */
export function isNotationMidi(bytes: Uint8Array): boolean {
  if (bytes.length < 22) return false;
  let smf: ReturnType<typeof parseSmf>;
  try {
    smf = parseSmf(bytes);
  } catch {
    return false;
  }
  // SMPTE time is a recording's clock, not a beat.
  if (bytes.length >= 14 && bytes[12] & 0x80) return false;
  const onsets = [...new Set(smf.notes.map((n) => n.start))];
  if (!onsets.length) return false;
  // Notation exports put graces, rolls and trills off the grid; played-in timing is near 40%.
  return onGrid(onsets, smf.ppq) >= 0.75;
}

/** Share of onsets within a hair of a 32nd, triplet, quintuplet or septuplet grid. */
export function onGrid(onsets: number[], ppq: number): number {
  const steps = [ppq / 8, ppq / 6, ppq / 3, ppq / 5, ppq / 7, ppq / 10].filter((s) => s >= 1);
  const tol = Math.max(1, ppq / 96);
  let hit = 0;
  for (const t of onsets) {
    if (steps.some((s) => {
      const r = t % s;
      return Math.min(r, s - r) <= tol;
    }))
      hit++;
  }
  return hit / onsets.length;
}

// Native and fast; windows-1252 is close enough to Latin-1 for matching ASCII names.
const decoder = new TextDecoder("latin1");
function latin1(b: Uint8Array): string {
  return decoder.decode(b);
}
