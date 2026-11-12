import { ScoreDoc } from "../model/score";
import { detectFormat, type ScoreFormat } from "./detect";
import { readMscx, readMscz, readMsczExcerpts, type MscxOptions } from "./mscx";
import { readMxl } from "./mxl";
import { rememberMeasure, writeMuseScore, type Dropped } from "./mscx-write";

export interface LoadedScore {
  format: ScoreFormat;
  score: ScoreDoc;
  /** Some part is a fretted instrument whose notes carry fret and string (a tab staff can be shown). */
  fretted: boolean;
  /** A tab staff is shown. */
  tab: boolean;
  /**
   * MuseScore files: the file with the edits made since it was read, written back into the
   * measures they changed (everything else as it was), and what could not be carried over.
   */
  save?: (opts?: { fresh?: boolean }) => { bytes: Uint8Array; dropped: Dropped };
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
      const { doc, sections, fretted, tab, link } = readMscx(zip ? readMscz(bytes) : new TextDecoder().decode(bytes), { tab: opts.tab, excerpts: zip ? readMsczExcerpts(bytes) : [] });
      const score = new ScoreDoc(doc);
      score.sections = sections;
      // Before an edit first changes a measure, its notes are remembered, so a save can tell
      // which chords stayed as they were.
      const prints = new WeakMap<Element, string>();
      score.beforeChange = (p, m) => rememberMeasure(score, link, p, m, prints);
      const original = bytes.slice();
      // MuseScore 3 and 4 files can be written back; MuseScore 2 ones not yet.
      const writable = link.version >= 3 && !/<Tuplet id=/.test(link.source);
      return { format, score, fretted, tab, save: writable ? (o) => writeMuseScore(original, score, link, score.dirty, prints, o) : undefined };
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
