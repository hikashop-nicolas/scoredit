// @vitest-environment happy-dom
// Reads every MuseScore file of the local corpus (npm run corpus) with scoredit's reader, and
// MuseScore's own MusicXML export of the same score with the MusicXML path, and checks both
// play the same notes. Runs with `npm run test:corpus` (it needs a large heap), when the
// corpus is there.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildTimeline, type NoteEvent } from "../play/timeline";
import { loadScore } from "./load";

const root = join(__dirname, "../../corpus");
const have = process.env.SCOREDIT_CORPUS === "1" && existsSync(join(root, "musicxml"));
const big = process.env.SCOREDIT_BIG === "1";

// Measure, beat and pitch. Lengths in seconds are left out: MuseScore's export drops the
// invisible tempo marks scores use for a written-out ritardando, which the reader keeps.
const sig = (e: NoteEvent) => `${e.measure}|${Math.round(e.onset * 48)}|${e.midi}`;
const notes = (bytes: Uint8Array) => {
  const tl = buildTimeline(loadScore(bytes).score);
  // Distinct notes: MuseScore's MusicXML export unrolls D.C. across movements differently
  // from MuseScore's own playback, which the reader follows (checked against its MIDI).
  return { set: [...new Set(tl.events.filter((e) => !e.grace).map(sig))].sort(), measures: new Set(tl.spans.map((s) => s.measure)).size, spans: tl.spans.length };
};

function compare(name: string, mscz: string, xml: string) {
  const a = notes(new Uint8Array(readFileSync(mscz)));
  const b = notes(new Uint8Array(readFileSync(xml)));
  const as = new Set(a.set);
  const bs = new Set(b.set);
  const missing = b.set.filter((x) => !as.has(x));
  const extra = a.set.filter((x) => !bs.has(x));
  return { name, notes: b.set.length, spans: [a.spans, b.spans], missing: missing.length, extra: extra.length, sample: [...missing.slice(0, 3), "/", ...extra.slice(0, 3)] };
}

describe.skipIf(!have)("MuseScore corpus", () => {
  const names = have ? readdirSync(join(root, "musicxml")).filter((f) => f.endsWith(".musicxml")).map((f) => f.replace(/\.musicxml$/, "")) : [];
  for (const name of names) {
    if (name.startsWith("sq_") && !big) continue;
    it(`plays ${name} like MuseScore's own export (MS4 and MS3)`, () => {
      const xml = join(root, "musicxml", `${name}.musicxml`);
      const r4 = compare(name, join(root, "ms4", `${name}.mscz`), xml);
      const r3 = compare(name, join(root, "openscore", `${name}.mscx`), xml);
      console.log(JSON.stringify(r4), JSON.stringify(r3));
      expect(r4.missing + r4.extra).toBeLessThanOrEqual(Math.ceil(r4.notes * 0.005));
      expect(r3.missing + r3.extra).toBeLessThanOrEqual(Math.ceil(r3.notes * 0.005));
    }, 120_000);
  }
});
