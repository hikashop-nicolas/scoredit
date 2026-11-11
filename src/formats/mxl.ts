import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from "fflate";

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

/**
 * Compressed MusicXML holding `xml`. Given the archive it was read from, only the score file
 * is replaced and everything else (images, other files) stays as it was.
 */
export function writeMxl(xml: string, original?: Uint8Array): Uint8Array {
  const files: Zippable = {};
  let root = "score.musicxml";
  if (original) {
    const old = unzipSync(original);
    const container = old["META-INF/container.xml"];
    const m = container ? /<rootfile[^>]*full-path="([^"]+)"/.exec(strFromU8(container)) : null;
    root = m?.[1] ?? Object.keys(old).find((n) => !n.startsWith("META-INF/") && /\.(xml|musicxml)$/i.test(n)) ?? root;
    // The mimetype entry first and stored, as the format asks.
    if (old.mimetype) files.mimetype = [old.mimetype, { level: 0 }];
    for (const [name, data] of Object.entries(old)) if (name !== "mimetype") files[name] = data;
  } else {
    files.mimetype = [strToU8("application/vnd.recordare.musicxml"), { level: 0 }];
    files["META-INF/container.xml"] = strToU8(`<?xml version="1.0" encoding="UTF-8"?>\n<container><rootfiles><rootfile full-path="${root}" media-type="application/vnd.recordare.musicxml+xml"/></rootfiles></container>\n`);
  }
  files[root] = strToU8(xml);
  return zipSync(files);
}
