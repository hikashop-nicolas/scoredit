import { ScoreDoc } from "../model/score";
import { detectFormat, type ScoreFormat } from "./detect";
import { readMscx, readMscz, readMsczExcerpts, type MscxOptions } from "./mscx";
import { readMxl } from "./mxl";

export interface LoadedScore {
  format: ScoreFormat;
  score: ScoreDoc;
}

export interface LoadOptions {
  /** Tab staff for fretted MuseScore parts: "auto" where MuseScore had one (default), "always", "never". */
  tab?: MscxOptions["tab"];
}

export function loadScore(bytes: Uint8Array, opts: LoadOptions = {}): LoadedScore {
  const format = detectFormat(bytes);
  switch (format) {
    case "musicxml":
      return { format, score: new ScoreDoc(new TextDecoder().decode(bytes)) };
    case "mxl":
      return { format, score: new ScoreDoc(readMxl(bytes)) };
    case "mscz":
    case "mscx": {
      const zip = format === "mscz";
      const { doc, sections } = readMscx(zip ? readMscz(bytes) : new TextDecoder().decode(bytes), { tab: opts.tab, excerpts: zip ? readMsczExcerpts(bytes) : [] });
      const score = new ScoreDoc(doc);
      score.sections = sections;
      return { format, score };
    }
    default:
      throw new Error("This file is not a score scoredit can read");
  }
}
