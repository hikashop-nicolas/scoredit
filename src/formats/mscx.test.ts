// @vitest-environment happy-dom
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { kids } from "../model/xml";
import { buildTimeline } from "../play/timeline";
import { loadScore } from "./load";
import { readMscx } from "./mscx";

const chord = (dur: string, notes: [number, number][], extra = "", noteExtra = "") =>
  `<Chord><durationType>${dur}</durationType>${extra}${notes.map(([p, t]) => `<Note><pitch>${p}</pitch><tpc>${t}</tpc>${noteExtra}</Note>`).join("")}</Chord>`;
const span = (type: string, start: boolean, inner = "") =>
  `<Spanner type="${type}">${start ? `<${type}>${inner}</${type}><next><location><measures>1</measures></location></next>` : `<prev><location><measures>-1</measures></location></prev>`}</Spanner>`;

const mscx = (measures: string[], part = `<Part><Staff id="1"><StaffType group="pitched"/></Staff><trackName>Flute</trackName><Instrument><instrumentId>wind.flutes.flute</instrumentId><Channel><program value="73"/></Channel></Instrument></Part>`) =>
  `<?xml version="1.0"?><museScore version="4.50"><Score><Division>480</Division>${part}<Staff id="1">${measures.map((m) => `<Measure><voice>${m}</voice></Measure>`).join("")}</Staff></Score></museScore>`;
const TS = `<TimeSig><sigN>4</sigN><sigD>4</sigD></TimeSig>`;

describe("MuseScore reader", () => {
  it("spells pitches from the tonal pitch class", () => {
    const { doc } = readMscx(mscx([TS + chord("whole", [[61, 21]])]));
    const pitch = doc.getElementsByTagName("pitch")[0];
    expect(kids(pitch).map((e) => e.textContent)).toEqual(["C", "1", "4"]);
    const flat = readMscx(mscx([TS + chord("whole", [[61, 9]])])).doc.getElementsByTagName("pitch")[0];
    expect(kids(flat).map((e) => e.textContent)).toEqual(["D", "-1", "4"]);
  });

  it("reads tuplets, ties, rests and the instrument's program", () => {
    const m1 = TS + `<Tuplet><normalNotes>2</normalNotes><actualNotes>3</actualNotes><baseNote>eighth</baseNote></Tuplet>` + chord("eighth", [[60, 14]]) + chord("eighth", [[62, 16]]) + chord("eighth", [[64, 18]]) + "<endTuplet/>" + `<Rest><durationType>quarter</durationType></Rest>` + chord("half", [[67, 15]], "", span("Tie", true));
    const m2 = chord("half", [[67, 15]], "", span("Tie", false)) + `<Rest><durationType>half</durationType></Rest>`;
    const tl = buildTimeline(loadScore(strToU8(mscx([m1, m2]))).score);
    expect(tl.events.map((e) => [e.midi, Math.round(e.onset * 100) / 100, e.measure])).toEqual([
      [60, 0, 0],
      [62, 0.33, 0],
      [64, 0.67, 0],
      [67, 2, 0],
    ]);
    expect(tl.events[3].dur).toBeCloseTo(4 * 0.6, 5); // tied over the barline
    expect([...tl.programs.values()]).toEqual([73]);
  });

  it("sounds notes under an 8va an octave up, and pedals and trills", () => {
    const m = TS + span("Pedal", true, "<lineVisible>0</lineVisible>") + span("Ottava", true, "<subtype>8va</subtype>") + chord("quarter", [[72, 14]]) + span("Ottava", false) + span("Trill", true) + chord("quarter", [[64, 18]]) + span("Trill", false) + chord("half", [[60, 14]], `<TremoloSingleChord><subtype>r16</subtype></TremoloSingleChord>`) + span("Pedal", false);
    const tl = buildTimeline(loadScore(strToU8(mscx([m]))).score);
    expect(tl.events[0].midi).toBe(84); // drawn C5 under 8va sounds C6
    expect(new Set(tl.events.filter((e) => e.onset === 1).map((e) => e.midi))).toEqual(new Set([64, 65])); // E trilled with F
    expect(tl.events.filter((e) => e.onset === 2)).toHaveLength(8); // a half note in 16ths
    expect(tl.controls.map((c) => c.value)).toEqual([127, 0]);
  });

  it("adds a tab staff when MuseScore had one in an instrument part", () => {
    const guitar = `<Part><Staff id="1"><StaffType group="pitched"/><defaultClef>G8vb</defaultClef></Staff><trackName>Guitar</trackName><Instrument><instrumentId>pluck.guitar.nylon-string</instrumentId><StringData><frets>19</frets><string>40</string><string>45</string><string>50</string><string>55</string><string>59</string><string>64</string></StringData></Instrument></Part>`;
    const body = mscx([TS + chord("whole", [[52, 18]], "", "<fret>2</fret><string>4</string>")], guitar);
    const excerpt = `<museScore version="4.50"><Score><Part><Staff id="1"><StaffType group="tablature"/></Staff><trackName>Guitar</trackName><Instrument><instrumentId>pluck.guitar.nylon-string</instrumentId></Instrument></Part></Score></museScore>`;
    const plain = loadScore(zipSync({ "score.mscx": strToU8(body) })).score;
    expect(plain.doc.getElementsByTagName("staves")).toHaveLength(0);
    const withTab = loadScore(zipSync({ "score.mscx": strToU8(body), "Excerpts/Guitar/Guitar.mscx": strToU8(excerpt) })).score;
    expect(withTab.doc.getElementsByTagName("staves")[0].textContent).toBe("2");
    const tech = withTab.doc.getElementsByTagName("technical")[0];
    expect(kids(tech).map((e) => e.textContent)).toEqual(["5", "2"]);
    expect(buildTimeline(withTab).events).toHaveLength(1); // drawn twice, sounds once
  });
});
