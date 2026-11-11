// @vitest-environment happy-dom
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadScore } from "../formats/load";
import { compareNotes, describeNote, rebuild } from "./rebuild";

// Rebuilding scores note by note through the editor must give back the same notes.
const root = process.cwd();
const fixtures = join(root, "demo/fixtures");

describe("Rebuilding scores through the editor", () => {
  for (const f of readdirSync(fixtures).filter((n) => n.endsWith(".musicxml") && !n.startsWith("piano"))) {
    it(`rebuilds ${f}`, () => {
      const score = loadScore(new Uint8Array(readFileSync(join(fixtures, f)))).score;
      const { doc } = rebuild(score);
      const r = compareNotes(score, doc);
      expect(r.missing.map((k) => describeNote(k, score))).toEqual([]);
      expect(r.extra.map((k) => describeNote(k, doc))).toEqual([]);
    });
  }
});

// One corpus score (SCOREDIT_REBUILD=path), run by scripts/rebuild-corpus.mjs in its own
// process each: the result goes to SCOREDIT_REBUILD_OUT as JSON.
const target = process.env.SCOREDIT_REBUILD;
describe.skipIf(!target)("Rebuilding a corpus score", () => {
  it("rebuilds it", () => {
    const t0 = performance.now();
    let row: Record<string, unknown>;
    try {
      const score = loadScore(new Uint8Array(readFileSync(target!))).score;
      const { doc, skipped, entered } = rebuild(score);
      const r = compareNotes(score, doc);
      row = {
        total: r.total,
        missing: r.missing.length,
        extra: r.extra.length,
        entered,
        skipped,
        examplesMissing: r.missing.slice(0, 8).map((k) => describeNote(k, score)),
        examplesExtra: r.extra.slice(0, 8).map((k) => describeNote(k, doc)),
      };
    } catch (e) {
      row = { error: e instanceof Error ? e.message : String(e) };
    }
    row.ms = Math.round(performance.now() - t0);
    writeFileSync(process.env.SCOREDIT_REBUILD_OUT ?? "/dev/stdout", JSON.stringify(row));
  }, 3_600_000);
});
