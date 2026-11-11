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
  // Each measure once: the notes as written. The order they play in is checked against
  // MuseScore's own playback (its MIDI), which its MusicXML export does not always follow.
  const tl = buildTimeline(loadScore(bytes).score, { straight: true });
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

// Guitar scores with tab (MuseScore 2, 4 and converted OSMD tests): same notes, and the same
// string and fret per measure, as MuseScore's own MusicXML export.
describe.skipIf(!have || !existsSync(join(root, "guitar")))("MuseScore guitar corpus", () => {
  const frets = (bytes: Uint8Array) => {
    const s = loadScore(bytes).score;
    const out: string[] = [];
    s.measures.forEach((ms) =>
      ms.forEach((meas, m) => {
        for (const t of Array.from(meas.getElementsByTagName("technical"))) {
          const str = t.getElementsByTagName("string")[0]?.textContent;
          const fret = t.getElementsByTagName("fret")[0]?.textContent;
          if (str && fret) out.push(`${m}|${str}|${fret}`);
        }
      }),
    );
    return out.sort();
  };
  const names = have && existsSync(join(root, "guitar")) ? readdirSync(join(root, "guitar")).filter((f) => f.endsWith(".mscz")).map((f) => f.replace(/\.mscz$/, "")) : [];
  for (const name of names) {
    it(`reads ${name} like MuseScore`, () => {
      const mscz = join(root, "guitar", `${name}.mscz`);
      const xml = join(root, "guitar", `${name}.musicxml`);
      const r = compare(name, mscz, xml);
      const a = frets(new Uint8Array(readFileSync(mscz)));
      const b = frets(new Uint8Array(readFileSync(xml)));
      const bs = new Set(b);
      const as = new Set(a);
      const fretDiff = [...a.filter((x) => !bs.has(x)), ...b.filter((x) => !as.has(x))];
      console.log(JSON.stringify({ ...r, frets: [a.length, b.length], fretDiff: fretDiff.length, fretSample: fretDiff.slice(0, 4) }));
      expect(r.missing + r.extra).toBe(0);
      // A little room: MuseScore 4 re-fingers a few notes when it loads a MuseScore 2 file.
      if (b.length) expect(fretDiff.length).toBeLessThanOrEqual(Math.ceil(b.length * 0.005));
    }, 120_000);
  }
});
