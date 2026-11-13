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

  it("trills the main note of a trill line, not the grace notes after it", () => {
    const m = TS + span("Trill", true) + chord("32nd", [[65, 13]], "<grace32after/>") + chord("32nd", [[64, 18]], "<grace32after/>") + chord("whole", [[65, 13]]);
    const tl = buildTimeline(loadScore(strToU8(mscx([m, span("Trill", false) + chord("whole", [[65, 13]])]))).score);
    expect(tl.events.filter((e) => e.measure === 0 && !e.grace).length).toBeGreaterThan(8);
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

  it("reads MuseScore 2 lines: the line's element with an id, closed by an endSpanner", () => {
    const flat = `<?xml version="1.0"?><museScore version="2.06"><Score><Division>480</Division><Part><Staff id="1"><StaffType group="pitched"/></Staff><trackName>Violin</trackName><Instrument><Channel><program value="40"/></Channel></Instrument></Part><Staff id="1"><Measure number="1">${TS}<Ottava id="7"><subtype>8va</subtype></Ottava>${chord("half", [[72, 14]])}<endSpanner id="7"/>${chord("half", [[72, 14]])}</Measure></Staff></Score></museScore>`;
    const tl = buildTimeline(loadScore(strToU8(flat)).score);
    expect(tl.events.map((e) => e.midi)).toEqual([84, 72]);
  });

  it("plays a drum kit by its drum map and draws it on its staff line", () => {
    const kit = `<Part><Staff id="1"><StaffType group="percussion"><lines>1</lines></StaffType></Staff><trackName>Snare</trackName><Instrument><Drum pitch="38"><head>0</head><line>0</line><name>Acoustic Snare</name></Drum><Drum pitch="37"><head>1</head><line>0</line><name>Side Stick</name></Drum></Instrument></Part>`;
    const s = loadScore(strToU8(mscx([TS + chord("half", [[38, 16]]) + chord("half", [[37, 21]])], kit))).score;
    const un = s.doc.getElementsByTagName("unpitched")[0];
    expect(kids(un).map((e) => e.textContent)).toEqual(["E", "4"]);
    expect(s.doc.getElementsByTagName("notehead")[0].textContent).toBe("x");
    const tl = buildTimeline(s);
    expect(tl.events.map((e) => [e.midi, e.channel, e.program])).toEqual([
      [38, 9, 128],
      [37, 9, 128],
    ]);
  });
});

describe("Sound effects on a percussion staff", () => {
  it("play the pitch the file stores, on the beat (as in the 1812 Overture's cannon)", () => {
    // A one-line percussion staff with no drum kit: a General MIDI sound played at a pitch.
    const part = `<Part><Staff id="1"><StaffType group="percussion"><lines>1</lines></StaffType></Staff><trackName>Canon</trackName><Instrument><instrumentId>effect.thunder</instrumentId><clef>PERC</clef><Channel><program value="127"/></Channel></Instrument></Part>`;
    const rest = `<Rest><durationType>quarter</durationType></Rest>`;
    const { score } = loadScore(strToU8(mscx([TS + rest + rest + rest + chord("quarter", [[49, 21]]), chord("whole", [[49, 21]])], part)));
    const ev = buildTimeline(score).events.map((e) => [e.measure, e.onset, e.midi, e.program]);
    // MuseScore's own MusicXML export writes these C sharps without their <alter>, a semitone low.
    expect(ev).toEqual([
      [0, 3, 49, 127],
      [1, 0, 49, 127],
    ]);
  });
});

describe("Fermata lengths and pauses the file sets", () => {
  const m1 = `<Measure><LayoutBreak><subtype>section</subtype><pause>1.5</pause></LayoutBreak><voice>${TS}<Fermata><subtype>fermataLongAbove</subtype><timeStretch>3</timeStretch></Fermata>${chord("quarter", [[60, 14]])}${chord("quarter", [[62, 16]])}<Breath><symbol>breathMarkComma</symbol><pause>0.5</pause></Breath>${chord("half", [[64, 18]])}</voice></Measure>`;
  const m2 = `<Measure><voice>${chord("whole", [[65, 13]])}</voice></Measure>`;
  const file = mscx([]).replace(`<Staff id="1"></Staff></Score>`, `<Staff id="1">${m1}${m2}</Staff></Score>`);

  it("play as MuseScore does, and stay out of the MusicXML", () => {
    const { score } = loadScore(strToU8(file));
    expect(score.doc.getElementsByTagName("fermata")[0].textContent).toBe("square");
    const tl = buildTimeline(score);
    // A quarter is 0.6 s: the fermata holds 3 times, the breath and the section end pause.
    expect(tl.events.map((e) => [+e.time.toFixed(3), +e.dur.toFixed(3)])).toEqual([
      [0, 1.8],
      [1.8, 0.6],
      [2.9, 1.2],
      [5.6, 2.4],
    ]);
    const xml = score.serialize();
    expect(xml).not.toContain("scoredit-");
    expect(xml).toContain(">square</fermata>");
    // The live score keeps them.
    expect(buildTimeline(score).events[3].time).toBeCloseTo(5.6, 5);
  });
});
