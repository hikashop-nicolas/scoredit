import { ScoreDoc } from "../model/score";
import { detectFormat, type ScoreFormat } from "./detect";
import { readMscx, readMscz, readMsczExcerpts, type MscxOptions } from "./mscx";
import { readMxl } from "./mxl";

export interface LoadedScore {
  format: ScoreFormat;
  score: ScoreDoc;
  /** Some part is a fretted instrument whose notes carry fret and string (a tab staff can be shown). */
  fretted: boolean;
  /** A tab staff is shown. */
  tab: boolean;
}

export interface LoadOptions {
  /** Tab staff for fretted MuseScore parts: "auto" where MuseScore had one (default), "always", "never". */
  tab?: MscxOptions["tab"];
}

export function loadScore(bytes: Uint8Array, opts: LoadOptions = {}): LoadedScore {
  const format = detectFormat(bytes);
  switch (format) {
    case "musicxml":
      return withTab(format, new ScoreDoc(new TextDecoder().decode(bytes)));
    case "mxl":
      return withTab(format, new ScoreDoc(readMxl(bytes)));
    case "mscz":
    case "mscx": {
      const zip = format === "mscz";
      const { doc, sections, fretted, tab } = readMscx(zip ? readMscz(bytes) : new TextDecoder().decode(bytes), { tab: opts.tab, excerpts: zip ? readMsczExcerpts(bytes) : [] });
      const score = new ScoreDoc(doc);
      score.sections = sections;
      return { format, score, fretted, tab };
    }
    default:
      throw new Error("This file is not a score scoredit can read");
  }
}

// A MusicXML score shows the tab it has; scoredit adds none to it.
function withTab(format: ScoreFormat, score: ScoreDoc): LoadedScore {
  const tab = score.doc.getElementsByTagName("staff-tuning").length > 0;
  return { format, score, fretted: false, tab };
}
