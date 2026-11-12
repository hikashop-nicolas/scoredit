// A small Guitar Pro 7 file written from scratch (no song, no copyrighted material): guitar and
// drums over four bars, using the effects scoredit reads. `node scripts/gp-fixture.mjs` writes
// it to demo/fixtures/riff.gp; tests build it in memory.
import { strToU8, zipSync } from "fflate";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const prop = (name, inner) => `<Property name="${name}">${inner}</Property>`;
const RHYTHMS = {
  w: `<NoteValue>Whole</NoteValue>`,
  h: `<NoteValue>Half</NoteValue>`,
  q: `<NoteValue>Quarter</NoteValue>`,
  "q.": `<NoteValue>Quarter</NoteValue><AugmentationDot count="1"/>`,
  e: `<NoteValue>Eighth</NoteValue>`,
  e3: `<NoteValue>Eighth</NoteValue><PrimaryTuplet num="3" den="2"/>`,
  s: `<NoteValue>16th</NoteValue>`,
};
const RHYTHM_IDS = Object.keys(RHYTHMS);

/**
 * A GPIF document from bars of voices of beats. A beat: { r, notes, dyn, chord, text, grace, props, brush }.
 * A note: { s (string, 0 = lowest), f (fret), drum (articulation index), xml (extra elements), props }.
 */
export function gpif() {
  const beats = [];
  const notes = [];
  const voices = [];
  const bars = [];
  const note = (n) => {
    const id = notes.length;
    const props = n.drum !== undefined ? "" : prop("String", `<String>${n.s}</String>`) + prop("Fret", `<Fret>${n.f}</Fret>`);
    const drum = n.drum !== undefined ? `<InstrumentArticulation>${n.drum}</InstrumentArticulation>` : "";
    notes.push(`<Note id="${id}">${n.xml ?? ""}${drum}<Properties>${props}${n.props ?? ""}</Properties></Note>`);
    return id;
  };
  const beat = (b) => {
    const id = beats.length;
    const ids = (b.notes ?? []).map(note);
    beats.push(
      `<Beat id="${id}">${b.grace ? `<GraceNotes>${b.grace}</GraceNotes>` : ""}${ids.length ? `<Dynamic>${b.dyn ?? "MF"}</Dynamic>` : ""}${b.chord !== undefined ? `<Chord>${b.chord}</Chord>` : ""}${b.text ? `<FreeText>${b.text}</FreeText>` : ""}<Rhythm ref="${RHYTHM_IDS.indexOf(b.r)}"/>${ids.length ? `<Notes>${ids.join(" ")}</Notes>` : ""}<Properties>${b.brush ? prop("Brush", `<Direction>${b.brush}</Direction>`) : ""}${b.props ?? ""}</Properties></Beat>`,
    );
    return id;
  };
  const bar = (vs) => {
    const ids = vs.map((v) => {
      const id = voices.length;
      voices.push(`<Voice id="${id}"><Beats>${v.map(beat).join(" ")}</Beats></Voice>`);
      return id;
    });
    while (ids.length < 4) ids.push(-1);
    bars.push(`<Bar id="${bars.length}"><Voices>${ids.join(" ")}</Voices></Bar>`);
    return bars.length - 1;
  };

  const on = (name) => prop(name, "<Enable/>");
  const g = (s, f, extra = {}) => ({ s, f, ...extra });
  const guitar = [
    [[
      { r: "q", chord: 0, notes: [g(0, 0), g(1, 2), g(2, 2)], text: "Intro riff" },
      { r: "e3", notes: [g(3, 0, { props: on("HopoOrigin") })] },
      { r: "e3", notes: [g(3, 2)] },
      { r: "e3", notes: [g(4, 0)] },
      { r: "q", notes: [g(4, 3, { props: prop("Slide", "<Flags>1</Flags>") })] },
      { r: "q", notes: [g(4, 5, { xml: "<Vibrato>Slight</Vibrato>" })] },
    ]],
    [[
      { r: "s", grace: "BeforeBeat", notes: [g(5, 3)] },
      { r: "q", notes: [g(5, 5, { props: on("Bended") + prop("BendOriginValue", "<Float>0</Float>") + prop("BendOriginOffset", "<Float>0</Float>") + prop("BendDestinationValue", "<Float>100</Float>") + prop("BendDestinationOffset", "<Float>100</Float>") })] },
      { r: "e", notes: [g(5, 0, { props: on("Muted") })] },
      { r: "e", notes: [g(4, 5, { xml: "<AntiAccent>Normal</AntiAccent>" })] },
      { r: "q", notes: [g(5, 12, { props: prop("HarmonicType", "<HType>Natural</HType>") + prop("HarmonicFret", "<HFret>12</HFret>") })] },
      { r: "e", notes: [g(1, 2, { xml: `<Tie origin="true" destination="false"/>` })] },
      { r: "e", notes: [g(1, 2, { xml: `<Tie origin="false" destination="true"/>` })] },
    ]],
    [[
      { r: "q" },
      { r: "q.", dyn: "FF", chord: 1, brush: "Down", notes: [g(0, 3), g(1, 2), g(2, 0), g(3, 0), g(4, 0), g(5, 3)].map((n) => ({ ...n, xml: "<LetRing/>" })) },
      { r: "e", dyn: "FF", notes: [g(3, 0, { xml: "<Accent>9</Accent>" })] },
      { r: "q", dyn: "FF", notes: [g(2, 2, { props: on("PalmMuted") }), g(0, 0, { props: on("PalmMuted") })] },
    ]],
    [
      [{ r: "w", dyn: "P", notes: [g(3, 2), g(4, 3), g(5, 2)] }],
      [{ r: "h", dyn: "P", notes: [g(0, 0)] }, { r: "h", dyn: "P", notes: [g(1, 2)] }],
    ],
  ];
  const kit = (a, b) => ({ r: "q", notes: [{ drum: a }, { drum: 2 }].concat(b === undefined ? [] : [{ drum: b }]) });
  const drums = [
    [[kit(0), kit(1), kit(0), kit(1)]],
    [[kit(0), kit(1), kit(0), kit(1)]],
    [[kit(0), kit(1), kit(0, 1), kit(1)]],
    [[{ r: "w" }]],
  ];
  const gBars = guitar.map(bar);
  const dBars = drums.map(bar);

  const master = (i, extra) => `<MasterBar><Key><AccidentalCount>1</AccidentalCount><Mode>Minor</Mode></Key><Time>4/4</Time><Bars>${gBars[i]} ${dBars[i]}</Bars>${extra}</MasterBar>`;
  const masterBars = [
    master(0, `<Repeat start="true" end="false" count="0"/><Section><Letter>A</Letter><Text>Intro</Text></Section>`),
    master(1, `<Repeat start="false" end="true" count="2"/><AlternateEndings>1</AlternateEndings>`),
    master(2, `<AlternateEndings>2</AlternateEndings>`),
    master(3, `<Fermatas><Fermata><Type>Medium</Type><Offset>0/1</Offset></Fermata></Fermatas>`),
  ];
  const tempo = (bar, bpm) => `<Automation><Type>Tempo</Type><Linear>false</Linear><Bar>${bar}</Bar><Position>0</Position><Value>${bpm} 2</Value></Automation>`;
  const element = (name, midi) => `<Element><Name>${name}</Name><Type>drum</Type><Articulations><Articulation><OutputMidiNumber>${midi}</OutputMidiNumber></Articulation></Articulations></Element>`;

  return `<?xml version="1.0" encoding="utf-8"?>
<GPIF>
<GPVersion>7</GPVersion>
<Score><Title>Riff study</Title><SubTitle>A test file</SubTitle><Artist>scoredit</Artist><Music>scoredit</Music><Copyright>Public domain</Copyright></Score>
<MasterTrack><Tracks>0 1</Tracks><Automations>${tempo(0, 96)}${tempo(3, 80)}</Automations></MasterTrack>
<Tracks>
<Track id="0"><Name>Guitar</Name><ShortName>Gtr.</ShortName><InstrumentSet><Type>electricGuitar</Type><Elements/></InstrumentSet><GeneralMidi><Program>29</Program></GeneralMidi>
<Staves><Staff><Properties>${prop("Tuning", "<Pitches>40 45 50 55 59 64</Pitches>")}${prop("DiagramCollection", `<Items><Item id="0" name="Em"/><Item id="1" name="G"/></Items>`)}</Properties></Staff></Staves>
<Lyrics><Line><Text>Hel-lo there</Text><Offset>0</Offset></Line></Lyrics></Track>
<Track id="1"><Name>Drums</Name><InstrumentSet><Type>drumKit</Type><Elements>${element("Kick", 36)}${element("Snare", 38)}${element("Hi-Hat", 42)}</Elements></InstrumentSet><GeneralMidi table="Percussion"><Program>0</Program></GeneralMidi></Track>
</Tracks>
<MasterBars>${masterBars.join("")}</MasterBars>
<Bars>${bars.join("")}</Bars>
<Voices>${voices.join("")}</Voices>
<Beats>${beats.join("")}</Beats>
<Notes>${notes.join("")}</Notes>
<Rhythms>${RHYTHM_IDS.map((k, i) => `<Rhythm id="${i}">${RHYTHMS[k]}</Rhythm>`).join("")}</Rhythms>
</GPIF>`;
}

/** The .gp file: a zip holding Content/score.gpif. */
export function gpFile(xml = gpif()) {
  return zipSync({ VERSION: strToU8("7.0"), "Content/score.gpif": strToU8(xml) });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(new URL("../demo/fixtures/riff.gp", import.meta.url), gpFile());
  console.log("wrote demo/fixtures/riff.gp");
}
