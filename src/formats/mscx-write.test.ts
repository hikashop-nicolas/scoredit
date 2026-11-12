// @vitest-environment happy-dom
import { strFromU8, strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { ScoreEditor } from "../edit/editor";
import { noteList } from "../edit/rebuild";
import { loadScore } from "./load";
import { measureOffsets } from "./mscx-write";

const chord = (dur: string, pitch: number, tpc: number, extra = "") => `<Chord><durationType>${dur}</durationType>${extra}<Note><pitch>${pitch}</pitch><tpc>${tpc}</tpc></Note></Chord>`;
const file = (measures: string[]) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<museScore version="4.50">\n  <Score>\n    <Division>480</Division>\n    <Part id="1">\n      <Staff id="1">\n        <StaffType group="pitched"/>\n        </Staff>\n      <trackName>Flute</trackName>\n      <Instrument><instrumentId>wind.flutes.flute</instrumentId><Channel><program value="73"/></Channel></Instrument>\n      </Part>\n    <Staff id="1">\n${measures.map((m) => `      <Measure>\n        <voice>\n          ${m}\n          </voice>\n        </Measure>\n`).join("")}      </Staff>\n    </Score>\n  </museScore>\n`;
const TS = `<KeySig><concertKey>0</concertKey></KeySig><TimeSig><sigN>4</sigN><sigD>4</sigD></TimeSig>`;

describe("Saving back into MuseScore files", () => {
  const source = file([TS + chord("quarter", 60, 14) + chord("quarter", 62, 16) + chord("quarter", 64, 18) + chord("quarter", 65, 13), `<Dynamic><subtype>p</subtype></Dynamic><Rest><durationType>measure</durationType><duration>4/4</duration></Rest>`, chord("whole", 67, 15)]);

  it("finds the measures of each staff in the text", () => {
    const { staves } = measureOffsets(source);
    expect(staves).toHaveLength(1);
    expect(staves[0]).toHaveLength(3);
    expect(source.slice(...staves[0][2])).toMatch(/^<Measure>[\s\S]*<\/Measure>$/);
  });

  it("writes the edited measure again and leaves the others as they were", () => {
    const loaded = loadScore(strToU8(source));
    const ed = new ScoreEditor(loaded.score);
    ed.enter({ part: 0, measure: 1, staff: 1, voice: "1", pos: 1 }, { pitches: [{ step: "F", alter: 1, octave: 4 }], quarters: 1 });
    const saved = strFromU8(loaded.save!().bytes);
    const before = measureOffsets(source).staves[0];
    const after = measureOffsets(saved).staves[0];
    expect(saved.slice(...after[0])).toBe(source.slice(...before[0]));
    expect(saved.slice(...after[2])).toBe(source.slice(...before[2]));
    const edited = saved.slice(...after[1]);
    expect(edited).toContain("<Dynamic>");
    expect(edited).toContain("<subtype>accidentalSharp</subtype>");
    // Read again, the file holds what the editor shows.
    expect(noteList(loadScore(strToU8(saved)).score)).toEqual(noteList(loaded.score));
  });

  it("keeps a tie across the barline and a triplet, and adds bars at the end", () => {
    const loaded = loadScore(strToU8(source));
    const ed = new ScoreEditor(loaded.score);
    ed.enter({ part: 0, measure: 0, staff: 1, voice: "1", pos: 3 }, { pitches: [{ step: "B", alter: -1, octave: 4 }], quarters: 2 });
    ed.tuplet({ part: 0, measure: 2, staff: 1, voice: "1", pos: 0 }, 1);
    for (let i = 0; i < 3; i++) ed.enter({ part: 0, measure: 2, staff: 1, voice: "1", pos: i / 3 }, { pitches: [{ step: "C", alter: 0, octave: 5 }], quarters: 1 / 3 });
    ed.enter({ part: 0, measure: 2, staff: 1, voice: "1", pos: 3 }, { pitches: [{ step: "D", alter: 0, octave: 5 }], quarters: 2 });
    const saved = strFromU8(loaded.save!().bytes);
    expect(saved).toContain('<Spanner type="Tie">');
    expect(saved).toContain("<endTuplet/>");
    const back = loadScore(strToU8(saved)).score;
    expect(back.measureCount).toBe(4);
    expect(noteList(back)).toEqual(noteList(loaded.score));
  });

  it("writes every mark the editor puts on a note", async () => {
    const { ARTICULATIONS, ORNAMENTS, TECHNICAL_MARKS } = await import("../edit/notes");
    const marks = [...ARTICULATIONS, ...TECHNICAL_MARKS, ...ORNAMENTS].filter((x) => x !== "delayed-inverted-turn");
    const loaded = loadScore(strToU8(file(marks.map((_, i) => (i ? "" : TS) + chord("whole", 72, 14)))));
    const ed = new ScoreEditor(loaded.score);
    marks.forEach((mk, m) => ed.mark({ part: 0, measure: m, staff: 1, voice: "1", pos: 0 }, mk, true));
    const { bytes, dropped } = loaded.save!();
    expect(dropped).toEqual({});
    const back = noteList(loadScore(bytes).score);
    // MuseScore draws a few as the same sign: those come back as it.
    const same: Record<string, string> = { "detached-legato": "staccato tenuto", "open-string": "open", "delayed-turn": "turn" };
    const want = noteList(loaded.score).map((k) => k.replace(/\|marks (.*)$/, (all, mk: string) => `|marks ${same[mk] ?? mk}`));
    expect(back).toEqual(want);
  });

  it("writes bends as curves in a MuseScore 4.5 file", () => {
    const loaded = loadScore(strToU8(source));
    const ed = new ScoreEditor(loaded.score);
    const note = ed.eventAt({ part: 0, measure: 0, staff: 1, voice: "1", pos: 0 })!.notes[0];
    ed.bends(note, [{ alter: 1 }, { alter: 1, release: true }]);
    const { bytes, dropped } = loaded.save!();
    expect(dropped).toEqual({});
    expect(strFromU8(bytes)).toContain('<Bend><point time="0" pitch="0" vibrato="0"/><point time="10" pitch="50" vibrato="0"/>');
  });

  it("writes dynamics, hairpins, text and tempo marks", () => {
    const loaded = loadScore(strToU8(source));
    const ed = new ScoreEditor(loaded.score);
    const c = (measure: number, pos: number) => ({ part: 0, measure, staff: 1, voice: "1", pos });
    ed.dynamic(c(0, 1), "mf");
    ed.hairpin(c(0, 1), c(0, 3), "crescendo");
    ed.text(c(0, 2), "expression", "dolce");
    ed.text(c(0, 3), "staff", "pizz.");
    ed.tempo(c(0, 0), 72, "Adagio ♩ = 72");
    // The file's own p in bar 2 goes.
    ed.dynamic(c(1, 0), null);
    const saved = strFromU8(loaded.save!().bytes);
    const [m1, m2, m3] = measureOffsets(saved).staves[0].map((r) => saved.slice(...r));
    expect(m1).toContain("<Dynamic><subtype>mf</subtype><velocity>80</velocity></Dynamic>");
    expect(m1).toContain('<Spanner type="HairPin"><HairPin><subtype>0</subtype></HairPin><next><location><measures>1</measures><fractions>-1/4</fractions></location></next></Spanner>');
    expect(m1).toContain("<Expression><text>dolce</text></Expression>");
    expect(m1).toContain("<StaffText><text>pizz.</text></StaffText>");
    expect(m1).toContain("<Tempo><tempo>1.2</tempo><followText>1</followText><text>Adagio <sym>metNoteQuarterUp</sym> = 72</text></Tempo>");
    // The hairpin ends at the next bar's start; the p is gone from there.
    expect(m2).toContain('<Spanner type="HairPin"><prev><location><measures>-1</measures><fractions>1/4</fractions></location></prev></Spanner>');
    expect(m2).not.toContain("<Dynamic>");
    expect(m3).toBe(source.slice(...measureOffsets(source).staves[0][2]));
    expect(noteList(loadScore(strToU8(saved)).score)).toEqual(noteList(loaded.score));
  });

  it("keeps each kind of breath mark and caesura", () => {
    const symbols = ["breathMarkComma", "breathMarkTick", "breathMarkUpbow", "breathMarkSalzedo", "caesura", "caesuraThick", "caesuraShort", "caesuraCurved", "caesuraSingleStroke"];
    const src = file(symbols.map((sym, i) => (i ? "" : TS) + chord("whole", 72, 14) + `<Breath><symbol>${sym}</symbol></Breath>`));
    const loaded = loadScore(strToU8(src));
    loaded.score.measures[0].forEach((_, m) => loaded.score.changing(0, m));
    const saved = strFromU8(loaded.save!({ fresh: true }).bytes);
    expect([...saved.matchAll(/<symbol>(\w+)<\/symbol>/g)].map((x) => x[1])).toEqual(symbols);
  });

  it("keeps grace notes after a trill, and a courtesy natural", () => {
    // MuseScore files hold the grace notes after a chord before it, last first.
    const slur = `<Spanner type="Slur"><Slur/><next><location><grace>0</grace></location></next></Spanner>`;
    const back = `<Spanner type="Slur"><prev><location/></prev></Spanner>`;
    const trill = chord("16th", 74, 16, back + "<grace16after/>") + chord("16th", 72, 14, "<grace16after/>") + chord("half", 74, 16, slur + "<Ornament><subtype>ornamentTrill</subtype></Ornament>").replace("<pitch>74", "<Accidental><role>1</role><subtype>accidentalNatural</subtype></Accidental><pitch>74");
    const src = file([TS + chord("half", 72, 14) + trill, chord("whole", 67, 15)]);
    const loaded = loadScore(strToU8(src));
    // Read: after the trill note, in the order they sound.
    const notes = Array.from(loaded.score.measures[0][0].getElementsByTagName("note")).map((n) => (n.getElementsByTagName("grace").length ? "g" : "") + n.getElementsByTagName("step")[0].textContent);
    expect(notes).toEqual(["C", "D", "gC", "gD"]);
    for (const fresh of [false, true]) {
      loaded.score.changing(0, 0);
      const saved = strFromU8(loaded.save!({ fresh }).bytes);
      const m = saved.slice(...measureOffsets(saved).staves[0][0]);
      expect(m.match(/grace16after|<durationType>half/g)).toEqual(["<durationType>half", "grace16after", "grace16after", "<durationType>half"]);
      expect(m.indexOf("<pitch>74")).toBeLessThan(m.indexOf("<pitch>72</pitch><tpc>14</tpc></Note></Chord><Chord><durationType>half"));
      expect(m).toContain("<grace>0</grace>");
      expect(m).toContain("accidentalNatural");
      expect(noteList(loadScore(strToU8(saved)).score)).toEqual(noteList(loaded.score));
    }
  });
});

// A corpus file (SCOREDIT_SAVE=path, run by scripts/save-corpus.mjs, one per process): every
// measure written back, keeping chords (keep) or writing all of them (fresh), then read again.
const target = process.env.SCOREDIT_SAVE;
describe.skipIf(!target)("Saving a corpus score", () => {
  it("writes it back", async () => {
    const { readFileSync, writeFileSync } = await import("node:fs");
    const { compareNotes, describeNote } = await import("../edit/rebuild");
    const out: Record<string, unknown> = {};
    const bytes = new Uint8Array(readFileSync(target!));
    // SCOREDIT_SAVE_MODE runs one of them (a big score needs a process per mode).
    for (const mode of (["keep", "fresh"] as const).filter((x) => !process.env.SCOREDIT_SAVE_MODE || process.env.SCOREDIT_SAVE_MODE === x)) {
      const t0 = performance.now();
      try {
        // One load per mode: a big quartet's document costs gigabytes.
        const loaded = loadScore(bytes);
        if (!loaded.save) {
          writeFileSync(process.env.SCOREDIT_SAVE_JSON ?? "/dev/stdout", JSON.stringify({ unwritable: true }));
          return;
        }
        loaded.score.measures.forEach((ms, p) => ms.forEach((_, m) => loaded.score.changing(p, m)));
        const { bytes: saved, dropped } = loaded.save!({ fresh: mode === "fresh" });
        // MuseScore checks the way a real save writes: unchanged chords kept.
        if (mode === "keep" && process.env.SCOREDIT_SAVE_OUT) writeFileSync(process.env.SCOREDIT_SAVE_OUT, saved);
        if (mode === "fresh" && process.env.SCOREDIT_SAVE_FRESH_OUT) writeFileSync(process.env.SCOREDIT_SAVE_FRESH_OUT, saved);
        const r = compareNotes(loaded.score, loadScore(saved).score);
        out[mode] = { total: r.total, missing: r.missing.length, extra: r.extra.length, dropped, examples: [...r.missing.slice(0, 4).map((k) => "missing: " + describeNote(k, loaded.score)), ...r.extra.slice(0, 4).map((k) => "extra: " + describeNote(k, loaded.score))], ms: Math.round(performance.now() - t0) };
      } catch (e) {
        out[mode] = { error: e instanceof Error ? e.message : String(e) };
      }
    }
    writeFileSync(process.env.SCOREDIT_SAVE_JSON ?? "/dev/stdout", JSON.stringify(out));
  }, 3_600_000);
});

// Two MusicXML files (MuseScore's conversions of an original and of its saved copy), compared.
describe.skipIf(!process.env.SCOREDIT_COMPARE_A)("MuseScore reads", () => {
  it("the saved file as the original", async () => {
    const { readFileSync, writeFileSync } = await import("node:fs");
    const { compareNotes, describeNote } = await import("../edit/rebuild");
    const a = loadScore(new Uint8Array(readFileSync(process.env.SCOREDIT_COMPARE_A!))).score;
    const b = loadScore(new Uint8Array(readFileSync(process.env.SCOREDIT_COMPARE_B!))).score;
    const r = compareNotes(a, b);
    writeFileSync(process.env.SCOREDIT_COMPARE_OUT!, JSON.stringify({ total: r.total, missing: r.missing.length, extra: r.extra.length, examples: [...r.missing.slice(0, 4).map((k) => "missing: " + describeNote(k, a)), ...r.extra.slice(0, 4).map((k) => "extra: " + describeNote(k, b))] }));
  }, 600000);
});
