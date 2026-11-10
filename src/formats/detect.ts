import { unzipSync } from "fflate";

export type ScoreFormat = "musicxml" | "mxl" | "mscz" | "mscx";

const isZip = (b: Uint8Array) => b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;

// Sniffs the bytes, not the name: a zip holding an .mscx is MuseScore, any other zip is
// compressed MusicXML; XML is told apart by its root element.
export function detectFormat(bytes: Uint8Array): ScoreFormat | null {
  if (isZip(bytes)) {
    try {
      const names = Object.keys(unzipSync(bytes, { filter: (f) => !f.name.endsWith(".png") }));
      return names.some((n) => n.endsWith(".mscx")) ? "mscz" : "mxl";
    } catch {
      return null;
    }
  }
  const head = new TextDecoder().decode(bytes.subarray(0, 4096));
  if (/<museScore[\s>]/.test(head)) return "mscx";
  if (/<score-(partwise|timewise)[\s>]/.test(head)) return "musicxml";
  return null;
}
