import type { PartFamily } from "./score";

// The instruments a new score or an added part can have. Facts only, gathered for scoredit:
// MuseScore's instrument id (MusicXML's standard sound name), the General MIDI program,
// clefs (MuseScore's clef types, one per staff), the transposition from written to sounding
// pitch, tunings for fretted instruments and a drum kit map from common drum notation.

export interface InstrumentDef {
  /** Our key; its name is the string `inst_<key>`. */
  key: string;
  family: PartFamily;
  /** MuseScore's instrumentId. */
  musescore: string;
  /** General MIDI program, from 0. */
  program: number;
  clefs: string[];
  /** Written to sounding: diatonic steps and semitones (B flat clarinet: -1, -2). */
  transpose?: [number, number];
  /** Open strings, lowest first, as MIDI pitches. */
  strings?: number[];
  drums?: true;
  /** A short name, as printed before later systems. */
  short: string;
}

const I = (key: string, family: PartFamily, musescore: string, program: number, short: string, clefs: string[] = ["G"], extra: Partial<InstrumentDef> = {}): InstrumentDef => ({ key, family, musescore, program, short, clefs, ...extra });

export const INSTRUMENTS: InstrumentDef[] = [
  I("piano", "keys", "keyboard.piano", 0, "Pno.", ["G", "F"]),
  I("epiano", "keys", "keyboard.piano.electric", 4, "E. Pno.", ["G", "F"]),
  I("harpsichord", "keys", "keyboard.harpsichord", 6, "Hpschd.", ["G", "F"]),
  I("organ", "keys", "keyboard.organ", 19, "Org.", ["G", "F"]),
  I("accordion", "keys", "keyboard.accordion", 21, "Acc.", ["G", "F"]),
  I("celesta", "keys", "keyboard.celesta", 8, "Cel.", ["G", "F"], { transpose: [7, 12] }),
  I("violin", "strings", "strings.violin", 40, "Vln."),
  I("viola", "strings", "strings.viola", 41, "Vla.", ["C3"]),
  I("cello", "strings", "strings.cello", 42, "Vc.", ["F"]),
  I("contrabass", "strings", "strings.contrabass", 43, "Cb.", ["F"], { transpose: [-7, -12] }),
  I("harp", "strings", "pluck.harp", 46, "Hp.", ["G", "F"]),
  I("piccolo", "winds", "wind.flutes.flute.piccolo", 72, "Picc.", ["G"], { transpose: [7, 12] }),
  I("flute", "winds", "wind.flutes.flute", 73, "Fl."),
  I("recorder", "winds", "wind.flutes.recorder", 74, "Rec.", ["G8va"]),
  I("oboe", "winds", "wind.reed.oboe", 68, "Ob."),
  I("englishhorn", "winds", "wind.reed.english-horn", 69, "E. H.", ["G"], { transpose: [-4, -7] }),
  I("clarinet", "winds", "wind.reed.clarinet.bflat", 71, "Cl.", ["G"], { transpose: [-1, -2] }),
  I("clarinetA", "winds", "wind.reed.clarinet.a", 71, "Cl.", ["G"], { transpose: [-2, -3] }),
  I("bassclarinet", "winds", "wind.reed.clarinet.bass", 71, "B. Cl.", ["G"], { transpose: [-8, -14] }),
  I("bassoon", "winds", "wind.reed.bassoon", 70, "Bsn.", ["F"]),
  I("sopranosax", "winds", "wind.reed.saxophone.soprano", 64, "S. Sax.", ["G"], { transpose: [-1, -2] }),
  I("altosax", "winds", "wind.reed.saxophone.alto", 65, "A. Sax.", ["G"], { transpose: [-5, -9] }),
  I("tenorsax", "winds", "wind.reed.saxophone.tenor", 66, "T. Sax.", ["G"], { transpose: [-8, -14] }),
  I("baritonesax", "winds", "wind.reed.saxophone.baritone", 67, "Bar. Sax.", ["G"], { transpose: [-12, -21] }),
  I("trumpet", "brass", "brass.trumpet.bflat", 56, "Tpt.", ["G"], { transpose: [-1, -2] }),
  I("cornet", "brass", "brass.cornet", 56, "Cor.", ["G"], { transpose: [-1, -2] }),
  I("horn", "brass", "brass.french-horn", 60, "Hn.", ["G"], { transpose: [-4, -7] }),
  I("trombone", "brass", "brass.trombone", 57, "Tbn.", ["F"]),
  I("basstrombone", "brass", "brass.trombone.bass", 57, "B. Tbn.", ["F"]),
  I("euphonium", "brass", "brass.euphonium", 58, "Euph.", ["F"]),
  I("tuba", "brass", "brass.tuba", 58, "Tba.", ["F"]),
  I("guitar", "guitar", "pluck.guitar.nylon-string", 24, "Guit.", ["G8vb"], { strings: [40, 45, 50, 55, 59, 64] }),
  I("acousticguitar", "guitar", "pluck.guitar.acoustic", 25, "Guit.", ["G8vb"], { strings: [40, 45, 50, 55, 59, 64] }),
  I("electricguitar", "guitar", "pluck.guitar.electric", 27, "El. Guit.", ["G8vb"], { strings: [40, 45, 50, 55, 59, 64] }),
  I("bassguitar", "bass", "pluck.bass", 33, "Bass", ["F8vb"], { strings: [28, 33, 38, 43] }),
  I("ukulele", "guitar", "pluck.ukulele", 24, "Uke.", ["G"], { strings: [67, 60, 64, 69] }),
  I("mandolin", "guitar", "pluck.mandolin", 25, "Mand.", ["G"], { strings: [55, 62, 69, 76] }),
  I("banjo", "guitar", "pluck.banjo", 105, "Bjo.", ["G8vb"], { strings: [67, 50, 55, 59, 62] }),
  I("soprano", "voice", "voice.soprano", 52, "S."),
  I("alto", "voice", "voice.alto", 52, "A."),
  I("tenor", "voice", "voice.tenor", 52, "T.", ["G8vb"]),
  I("baritone", "voice", "voice.baritone", 52, "Bar.", ["F"]),
  I("bass", "voice", "voice.bass", 52, "B.", ["F"]),
  I("voice", "voice", "voice.vocals", 53, "Vo."),
  I("timpani", "other", "drum.timpani", 47, "Timp.", ["F"]),
  I("xylophone", "other", "pitched-percussion.xylophone", 13, "Xyl.", ["G"], { transpose: [7, 12] }),
  I("marimba", "other", "pitched-percussion.marimba", 12, "Mar.", ["G", "F"]),
  I("vibraphone", "other", "pitched-percussion.vibraphone", 11, "Vib."),
  I("glockenspiel", "other", "pitched-percussion.glockenspiel", 9, "Glk.", ["G"], { transpose: [14, 24] }),
  I("drumset", "drums", "drum.group.set", 0, "D. Set", ["PERC"], { drums: true }),
];

export const instrument = (key: string) => INSTRUMENTS.find((x) => x.key === key);

/**
 * A drum kit: General MIDI pitch, staff line (half spaces down from the top line), notehead
 * and name, as common drum notation places them.
 */
export const DRUM_KIT: { pitch: number; line: number; head: "normal" | "cross" | "diamond" | "circle-x" | "triangle"; name: string; up: boolean }[] = [
  { pitch: 35, line: 8, head: "normal", name: "Acoustic Bass Drum", up: false },
  { pitch: 36, line: 7, head: "normal", name: "Bass Drum", up: false },
  { pitch: 37, line: 3, head: "cross", name: "Side Stick", up: true },
  { pitch: 38, line: 3, head: "normal", name: "Snare", up: true },
  { pitch: 40, line: 3, head: "normal", name: "Electric Snare", up: true },
  { pitch: 41, line: 6, head: "normal", name: "Low Floor Tom", up: true },
  { pitch: 42, line: -1, head: "cross", name: "Closed Hi-Hat", up: true },
  { pitch: 43, line: 5, head: "normal", name: "High Floor Tom", up: true },
  { pitch: 44, line: 9, head: "cross", name: "Pedal Hi-Hat", up: false },
  { pitch: 45, line: 4, head: "normal", name: "Low Tom", up: true },
  { pitch: 46, line: -1, head: "circle-x", name: "Open Hi-Hat", up: true },
  { pitch: 47, line: 2, head: "normal", name: "Low-Mid Tom", up: true },
  { pitch: 48, line: 1, head: "normal", name: "Hi-Mid Tom", up: true },
  { pitch: 49, line: -2, head: "cross", name: "Crash Cymbal", up: true },
  { pitch: 50, line: 0, head: "normal", name: "High Tom", up: true },
  { pitch: 51, line: 0, head: "cross", name: "Ride Cymbal", up: true },
  { pitch: 53, line: 0, head: "diamond", name: "Ride Bell", up: true },
  { pitch: 54, line: 2, head: "diamond", name: "Tambourine", up: true },
  { pitch: 56, line: 1, head: "triangle", name: "Cowbell", up: true },
  { pitch: 57, line: -3, head: "cross", name: "Crash Cymbal 2", up: true },
];
