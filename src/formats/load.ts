import { ScoreDoc } from "../model/score";
import { readAbc } from "./abc";
import { detectFormat, type ScoreFormat } from "./detect";
import { readMscx, readMscz, readMsczExcerpts, type MscxOptions } from "./mscx";
import { readMxl } from "./mxl";
import { readGuitarPro } from "./gp";
import { writeGuitarPro } from "./gp-write";
import { readMidi } from "./midi";
import { midiSaver } from "./midi-save";
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
   * Guitar Pro files (any version): the score written whole as a Guitar Pro 7 .gp file.
   * MIDI files (types 0 and 1): the file with only the notes, tempos, time and key signatures
   * an edit changed written again; every other event as it was.
   */
  save?: (opts?: { fresh?: boolean }) => { bytes: Uint8Array; dropped: Dropped };
}

export interface LoadOptions {
  /** Tab staff for fretted MuseScore parts: "auto" where MuseScore had one (default), "always", "never". */
  tab?: MscxOptions["tab"];
  /** ABC files: the tune to open, by its X: number. */
  tune?: number;
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
    case "abc":
      return withTab(format, new ScoreDoc(readAbc(new TextDecoder().decode(bytes), { tune: opts.tune })));
    case "guitarpro": {
      const { doc, fretted, tab } = readGuitarPro(bytes, { tab: opts.tab });
      const score = new ScoreDoc(doc);
      // Saved as Guitar Pro 7 (.gp), whichever version was read.
      return { format, score, fretted, tab, save: () => writeGuitarPro(score) };
    }
    case "midi": {
      const { xml, link } = readMidi(bytes);
      const score = new ScoreDoc(xml);
      // Types 0 and 1 in ticks a quarter can be written back; type 2 (separate songs) and SMPTE time not.
      const writable = link.file.format !== 2 && !(link.file.division & 0x8000);
      return { format, score, fretted: false, tab: false, save: writable ? midiSaver(bytes, score, link) : undefined };
    }
    case "pdf":
      throw new Error("PDF scores are read with loadScoreAsync");
    default:
      throw new Error("This file is not a score scoredit can read");
  }
}

/** Like loadScore, for every format, PDF scores (read-only) included. */
export async function loadScoreAsync(bytes: Uint8Array, opts: LoadOptions = {}): Promise<LoadedScore> {
  if (detectFormat(bytes) !== "pdf") return loadScore(bytes, opts);
  const { readPdfScore } = await import("./pdf/read");
  return withTab("pdf", new ScoreDoc(await readPdfScore(bytes)));
}

// A MusicXML score shows the tab it has; scoredit adds none to it.
function withTab(format: ScoreFormat, score: ScoreDoc): LoadedScore {
  const tab = score.doc.getElementsByTagName("staff-tuning").length > 0;
  return { format, score, fretted: false, tab };
}
