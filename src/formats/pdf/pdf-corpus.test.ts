// @vitest-environment happy-dom
// Exports corpus scores to PDF with MuseScore 4 (and to MusicXML, the reference), reads the
// PDFs back with readPdfScore and compares per staff: measures, pitches, durations.
// Runs with SCOREDIT_CORPUS=1 when the corpus and MuseScore are there; the exports are cached
// in SCOREDIT_PDF_CACHE (default: the system temp folder). SCOREDIT_PDF_ONLY=regex narrows it.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { kids, parseXml, text } from "../../model/xml";
import { loadScore } from "../load";
import { readPdfScore } from "./read";

const root = join(__dirname, "../../../corpus");
const mscore = process.env.MSCORE ?? "/Applications/MuseScore 4.app/Contents/MacOS/mscore";
const have = process.env.SCOREDIT_CORPUS === "1" && existsSync(join(root, "ms4")) && existsSync(mscore);
const cache = process.env.SCOREDIT_PDF_CACHE ?? join(tmpdir(), "scoredit-pdf-corpus");
const only = process.env.SCOREDIT_PDF_ONLY ? new RegExp(process.env.SCOREDIT_PDF_ONLY) : null;

function sources(): string[] {
  const dir = (d: string) => (existsSync(join(root, d)) ? readdirSync(join(root, d)).filter((f) => f.endsWith(".mscz")).sort().map((f) => join(root, d, f)) : []);
  const all = [join(root, "musescore-com/fur-elise-ms4.mscz"), ...dir("ms4"), ...dir("guitar")].filter(existsSync);
  return all.filter((f) => !only || only.test(basename(f)));
}

// One MuseScore run for every missing export.
function exportAll(files: string[]): void {
  mkdirSync(cache, { recursive: true });
  const job = files.flatMap((f) => {
    const b = join(cache, basename(f, ".mscz"));
    return existsSync(`${b}.pdf`) && existsSync(`${b}.musicxml`) ? [] : [{ in: f, out: [`${b}.pdf`, `${b}.musicxml`] }];
  });
  if (!job.length) return;
  writeFileSync(join(cache, "job.json"), JSON.stringify(job));
  execFileSync(mscore, ["-j", join(cache, "job.json")], { stdio: "ignore", timeout: 1_800_000 });
}

interface StaffSummary {
  measures: number;
  pitches: string[];
  notes: string[];
  byMeasure: string[][];
}

const STEP: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

// Per staff, in part order: notes ordered by measure, onset and pitch (voices do not matter).
function summarize(doc: Document): StaffSummary[] {
  const out: StaffSummary[] = [];
  for (const part of kids(doc.documentElement, "part")) {
    const ev = new Map<number, { m: number; on: number; p: number; d: number }[]>();
    let div = 1;
    let staves = 1;
    const measures = kids(part, "measure");
    measures.forEach((meas, m) => {
      let pos = 0;
      let last = 0;
      for (const c of kids(meas)) {
        if (c.tagName === "attributes") {
          div = Number(text(c, "divisions")) || div;
          staves = Number(text(c, "staves")) || staves;
        } else if (c.tagName === "backup") pos -= Number(text(c, "duration"));
        else if (c.tagName === "forward") pos += Number(text(c, "duration"));
        else if (c.tagName === "note") {
          if (kids(c, "grace").length || kids(c, "cue").length) continue;
          const d = Number(text(c, "duration")) || 0;
          const chord = kids(c, "chord").length > 0;
          const on = chord ? last : pos;
          if (!chord) {
            last = pos;
            pos += d;
          }
          const pitch = kids(c, "pitch")[0] ?? kids(c, "unpitched")[0];
          if (!pitch) continue;
          const step = text(pitch, "step") || text(pitch, "display-step");
          const oct = Number(text(pitch, "octave") || text(pitch, "display-octave"));
          const p = (oct + 1) * 12 + (STEP[step] ?? 0) + (Number(text(pitch, "alter")) || 0);
          const s = Number(text(c, "staff")) || 1;
          const list = ev.get(s) ?? [];
          list.push({ m, on: on / div, p, d: d / div });
          ev.set(s, list);
        }
      }
    });
    for (let s = 1; s <= staves; s++) {
      const list = (ev.get(s) ?? []).sort((a, b) => a.m - b.m || a.on - b.on || a.p - b.p);
      const tok = (e: (typeof list)[number]) => `${e.p}:${Math.round(e.d * 1000) / 1000}`;
      const byMeasure = measures.map((_, m) => list.filter((e) => e.m === m).map(tok));
      out.push({ measures: measures.length, pitches: list.map((e) => String(e.p)), notes: list.map(tok), byMeasure });
    }
  }
  return out;
}

// Edit distance, two rows.
function lev(a: string[], b: string[]): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

const log = (...a: unknown[]) => process.stdout.write(a.join(" ") + "\n");
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

describe.skipIf(!have)("MuseScore PDFs", () => {
  const files = have ? sources() : [];
  const rows: string[] = [];
  const total = { notes: 0, pitchErr: 0, noteErr: 0, measuresOk: 0, staves: 0 };
  it("exports the corpus scores", () => exportAll(files), 1_800_000);
  for (const f of files) {
    const name = basename(f, ".mscz");
    it(`reads ${name}`, async () => {
      const ref = summarize(parseXml(readFileSync(join(cache, `${name}.musicxml`), "utf8")));
      let ours: StaffSummary[] = [];
      let err = "";
      try {
        const doc = await readPdfScore(new Uint8Array(readFileSync(join(cache, `${name}.pdf`))));
        ours = summarize(doc);
        if (process.env.SCOREDIT_PDF_SAVE) writeFileSync(join(cache, `${name}.ours.musicxml`), new XMLSerializer().serializeToString(doc));
        // And it opens as a score.
        loadScore(new TextEncoder().encode(new XMLSerializer().serializeToString(doc)));
      } catch (e) {
        err = String(e).slice(0, 80);
      }
      let notes = 0;
      let pe = 0;
      let ne = 0;
      const ms: string[] = [];
      ref.forEach((r, i) => {
        const o = ours[i] ?? { measures: 0, pitches: [], notes: [], byMeasure: [] };
        if (process.env.SCOREDIT_PDF_DIFF) {
          let shown = 0;
          r.byMeasure.forEach((t, m) => {
            const a = (o.byMeasure[m] ?? []).join(" ");
            if (a !== t.join(" ") && shown++ < Number(process.env.SCOREDIT_PDF_DIFF)) log(`${name} staff ${i + 1} m${m + 1}\n  ours ${a}\n  ref  ${t.join(" ")}`);
          });
        }
        notes += r.notes.length;
        pe += Math.min(r.pitches.length, lev(o.pitches, r.pitches));
        ne += Math.min(r.notes.length, lev(o.notes, r.notes));
        if (o.measures === r.measures) total.measuresOk++;
        ms.push(o.measures === r.measures ? `${r.measures}` : `${o.measures}/${r.measures}`);
      });
      total.notes += notes;
      total.pitchErr += pe;
      total.noteErr += ne;
      total.staves += ref.length;
      const row = `${name.padEnd(48)} staves ${String(ours.length).padStart(2)}/${String(ref.length).padEnd(2)} measures ${ms.join(",").padEnd(14)} notes ${String(notes).padStart(5)} pitch ${pct(1 - pe / Math.max(1, notes)).padStart(6)} pitch+dur ${pct(1 - ne / Math.max(1, notes)).padStart(6)} ${err}`;
      rows.push(row);
      log(row);
      expect(ref.length).toBeGreaterThan(0);
    }, 600_000);
  }
  it("reports the table", () => {
    const summary = `TOTAL staves ${total.staves} measure counts right ${total.measuresOk}, notes ${total.notes}, pitch ${pct(1 - total.pitchErr / Math.max(1, total.notes))}, pitch+dur ${pct(1 - total.noteErr / Math.max(1, total.notes))}`;
    log([...rows, summary].join("\n"));
    writeFileSync(join(cache, "report.txt"), [...rows, summary].join("\n") + "\n");
  });
});
