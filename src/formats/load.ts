import { ScoreDoc } from "../model/score";
import { detectFormat, type ScoreFormat } from "./detect";
import { readMxl } from "./mxl";

export interface LoadedScore {
  format: ScoreFormat;
  score: ScoreDoc;
}

export function loadScore(bytes: Uint8Array): LoadedScore {
  const format = detectFormat(bytes);
  switch (format) {
    case "musicxml":
      return { format, score: new ScoreDoc(new TextDecoder().decode(bytes)) };
    case "mxl":
      return { format, score: new ScoreDoc(readMxl(bytes)) };
    case "mscz":
    case "mscx":
      throw new Error("MuseScore files are not supported yet");
    default:
      throw new Error("This file is not a score scoredit can read");
  }
}
