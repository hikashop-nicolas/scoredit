import { unzipSync } from "fflate";
import { looksLikeAbc } from "./abc";

export type ScoreFormat = "musicxml" | "mxl" | "mscz" | "mscx" | "abc" | "guitarpro" | "midi" | "pdf";

const isZip = (b: Uint8Array) => b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;

// Sniffs the bytes, not the name: a zip holding an .mscx is MuseScore, any other zip is
// compressed MusicXML; XML is told apart by its root element.
export function detectFormat(bytes: Uint8Array): ScoreFormat | null {
  if (bytes.length > 13 && String.fromCharCode(...bytes.subarray(0, 4)) === "MThd") return "midi";
  if (bytes.length > 8 && String.fromCharCode(...bytes.subarray(0, 5)) === "%PDF-") return "pdf";
  if (isZip(bytes)) {
    try {
      const names = Object.keys(unzipSync(bytes, { filter: (f) => !f.name.endsWith(".png") }));
      if (names.includes("Content/score.gpif")) return "guitarpro";
      return names.some((n) => n.endsWith(".mscx")) ? "mscz" : "mxl";
    } catch {
      return null;
    }
  }
  if (isGuitarPro(bytes)) return "guitarpro";
  const head = new TextDecoder().decode(bytes.subarray(0, 4096));
  if (/<museScore[\s>]/.test(head)) return "mscx";
  if (/<score-(partwise|timewise)[\s>]/.test(head)) return "musicxml";
  if (looksLikeAbc(head)) return "abc";
  return null;
}

// Guitar Pro 6 (a "BCFZ" or "BCFS" container) and Guitar Pro 3 to 5 (a version string header).
function isGuitarPro(b: Uint8Array): boolean {
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  return ascii(0, 4) === "BCFZ" || ascii(0, 4) === "BCFS" || ascii(1, 21) === "FICHIER GUITAR PRO v";
}
