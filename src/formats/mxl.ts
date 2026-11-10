import { strFromU8, unzipSync } from "fflate";

// Compressed MusicXML: META-INF/container.xml names the root file; without one, the
// first .xml/.musicxml outside META-INF is the score.
export function readMxl(bytes: Uint8Array): string {
  const files = unzipSync(bytes);
  const container = files["META-INF/container.xml"];
  if (container) {
    const m = /<rootfile[^>]*full-path="([^"]+)"/.exec(strFromU8(container));
    if (m && files[m[1]]) return strFromU8(files[m[1]]);
  }
  const name = Object.keys(files).find((n) => !n.startsWith("META-INF/") && /\.(xml|musicxml)$/i.test(n));
  if (!name) throw new Error("No MusicXML file inside the archive");
  return strFromU8(files[name]);
}
