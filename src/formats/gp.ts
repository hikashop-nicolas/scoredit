import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { NOTE_VALUE_TICKS, TICKS_PER_QUARTER, parseGuitarPro } from "guitarpro-parser";
import type { Beat, Dynamic, FrettedNote, NoteValue, PercussionNote, PitchedNote, Rhythm, Song, Track } from "guitarpro-parser";
import { makeHarmony, parseChord } from "../edit/chords";
import { DRUM_KIT } from "../model/instruments";
import { parseXml } from "../model/xml";

// Guitar Pro files (.gp, .gpx, .gp3, .gp4, .gp5) read into MusicXML, read-only. The files are
// parsed by guitarpro-parser (Apache-2.0); this turns its song model into a score-partwise DOM.

export interface GuitarProOptions {
  /** Tab staff under each fretted part: shown unless "never". */
  tab?: "auto" | "always" | "never";
}

/** Divisions per quarter note: exact for tuplets of 3, 5, 7 and 9 down to 128ths. */
const DIV = 10080;

type AnyNote = FrettedNote | PercussionNote | PitchedNote;
type AnyBeat = Beat<AnyNote>;
type Role = "notation" | "tab" | "drums" | "pitched";
interface Staff {
  track: Track;
  role: Role;
  clef: [string, number, number];
}

const TYPE: Record<NoteValue, string> = { doubleWhole: "breve", whole: "whole", half: "half", quarter: "quarter", eighth: "eighth", "16th": "16th", "32nd": "32nd", "64th": "64th", "128th": "128th", "256th": "256th" };
const STROKES: Partial<Record<NoteValue, number>> = { eighth: 1, "16th": 2, "32nd": 3, "64th": 4 };
const SHARPS: [string, number][] = [["C", 0], ["C", 1], ["D", 0], ["D", 1], ["E", 0], ["F", 0], ["F", 1], ["G", 0], ["G", 1], ["A", 0], ["A", 1], ["B", 0]];
const FLATS: [string, number][] = [["C", 0], ["D", -1], ["D", 0], ["E", -1], ["E", 0], ["F", 0], ["G", -1], ["G", 0], ["A", -1], ["A", 0], ["B", -1], ["B", 0]];
const OUT_SLIDE: Record<string, string> = { outDown: "falloff", outUp: "doit", inFromBelow: "scoop", inFromAbove: "plop" };
// Guitar Pro's ottava: MusicXML's octave-shift type (the notes are drawn shifted down or up) and size.
const OTTAVA: Record<string, ["down" | "up", number]> = { "8va": ["down", 8], "8vb": ["up", 8], "15ma": ["down", 15], "15mb": ["up", 15] };
const HARMONICS: Record<string, string> = { artificial: "A.H.", pinch: "P.H.", tap: "T.H.", semi: "S.H.", feedback: "Fdbk." };
const HEADS: Record<string, string> = { cross: "x", diamond: "diamond", "circle-x": "circle-x", triangle: "triangle" };
const JUMPS: Record<string, [string, Record<string, string>]> = {
  daCapo: ["D.C.", { dacapo: "yes" }],
  daCapoAlCoda: ["D.C. al Coda", { dacapo: "yes" }],
  daCapoAlDoubleCoda: ["D.C. al Double Coda", { dacapo: "yes" }],
  daCapoAlFine: ["D.C. al Fine", { dacapo: "yes" }],
  daSegno: ["D.S.", { dalsegno: "segno" }],
  daSegnoAlCoda: ["D.S. al Coda", { dalsegno: "segno" }],
  daSegnoAlDoubleCoda: ["D.S. al Double Coda", { dalsegno: "segno" }],
  daSegnoAlFine: ["D.S. al Fine", { dalsegno: "segno" }],
  daSegnoSegno: ["D.S.S.", { dalsegno: "segno2" }],
  daSegnoSegnoAlCoda: ["D.S.S. al Coda", { dalsegno: "segno2" }],
  daSegnoSegnoAlDoubleCoda: ["D.S.S. al Double Coda", { dalsegno: "segno2" }],
  daSegnoSegnoAlFine: ["D.S.S. al Fine", { dalsegno: "segno2" }],
  daCoda: ["To Coda", { tocoda: "coda" }],
  daDoubleCoda: ["To Double Coda", { tocoda: "coda2" }],
};

const spell = (midi: number, fifths: number) => {
  midi = Math.max(0, Math.min(127, midi));
  const [step, alter] = (fifths < 0 ? FLATS : SHARPS)[((midi % 12) + 12) % 12];
  return { step, alter, octave: Math.floor(midi / 12) - 1 };
};
const divs = (ticks: number) => Math.round((ticks * DIV) / TICKS_PER_QUARTER);
const exactLength = (r: Rhythm) => (NOTE_VALUE_TICKS[r.value] * (r.dots === 2 ? 1.75 : r.dots === 1 ? 1.5 : 1) * (r.tuplet ? r.tuplet.den / r.tuplet.num : 1) * DIV) / TICKS_PER_QUARTER;
const lengthOf = (r: Rhythm) => Math.max(1, Math.round(exactLength(r)));
// General MIDI drums as MuseScore shows a Guitar Pro file's: key, place on the staff, notehead (x: cross), name.
const GM_DRUMS =
  "27 C5 - High Q|28 C5 - Slap|29 C5 - Scratch Push|30 C5 - Scratch Pull|31 C5 x Sticks|32 C5 - Square Click|33 C5 x Metronome Click|34 C5 - Metronome Bell|35 E4 - Acoustic Bass Drum|36 F4 - Bass Drum 1|37 C5 x Side Stick|38 C5 - Acoustic Snare|39 C5 - Hand Clap|40 C5 - Electric Snare|41 G4 - Low Floor Tom|42 G5 x Closed Hi-Hat|43 G4 - High Floor Tom|44 D4 x Pedal Hi-Hat|45 A4 - Low Tom|46 G5 circle-x Open Hi-Hat|47 B4 - Low-Mid Tom|48 D5 - Hi-Mid Tom|49 A5 x Crash Cymbal 1|50 E5 - High Tom|51 F5 x Ride Cymbal 1|52 B5 - Chinese Cymbal|53 F5 diamond Ride Bell|54 D5 x Tambourine|55 A5 x Splash Cymbal|56 F5 - Cowbell|57 B5 x Crash Cymbal 2|58 C5 - Vibraslap|59 D5 x Ride Cymbal 2|60 E4 - Hi Bongo|61 D4 - Low Bongo|62 A4 x Mute Hi Conga|63 B4 x Open Hi Conga|64 G4 x Low Conga|65 E4 x High Timbale|66 D4 x Low Timbale|67 C5 - High Agogo|68 C5 - Low Agogo|69 C5 - Cabasa|70 C5 - Maracas|71 C5 - Short Whistle|72 C5 - Long Whistle|73 C5 - Short Güiro|74 C5 - Long Güiro|75 C5 - Claves|76 C5 - Hi Wood Block|77 C5 - Low Wood Block|78 C5 - Mute Cuica|79 C5 - Open Cuica|80 C5 - Mute Triangle|81 C5 - Open Triangle|82 C5 - Shaker|83 C5 - Sleigh Bell|84 C5 - Mark Tree|85 C5 - Castanets|86 C5 - Mute Surdo|87 C5 - Open Surdo"
    .split("|")
    .map((d) => {
      const [key, at, head, ...name] = d.split(" ");
      // Lines count half spaces down from the top line, F5.
      const line = 5 * 7 + 3 - (Number(at[1]) * 7 + "CDEFGAB".indexOf(at[0]));
      return { pitch: Number(key), line, head: (head === "x" ? "cross" : head === "-" ? "normal" : head) as (typeof DRUM_KIT)[number]["head"], name: name.join(" "), up: line < 6 };
    });
const drumOf = (midi: number) => GM_DRUMS.find((d) => d.pitch === midi) ?? DRUM_KIT.find((d) => d.pitch === midi) ?? { pitch: midi, line: 3, head: "normal", name: `Drum ${midi}`, up: true };

/** A Guitar Pro file as MusicXML. */
export function readGuitarPro(bytes: Uint8Array, opts: GuitarProOptions = {}): { doc: Document; fretted: boolean; tab: boolean } {
  return songToMusicXml(parseSong(bytes), opts);
}

/** guitarpro-parser's song, after mending what it refuses in files Guitar Pro itself opens. */
export function parseSong(bytes: Uint8Array): Song {
  const gpif = gpifOf(bytes);
  let song: Song;
  try {
    song = parseGuitarPro(bytes);
  } catch (e) {
    // GP3 to GP5: zero padding after the last bar.
    const pad = /(\d+) bytes follow the last bar/.exec(e instanceof Error ? e.message : "");
    if (pad && bytes.subarray(bytes.length - Number(pad[1])).every((b) => b === 0)) song = parseGuitarPro(bytes.subarray(0, bytes.length - Number(pad[1])));
    else if (!gpif) throw e;
    // GP6 and GP7: the mended score.gpif, read from a plain zip.
    else song = parseGuitarPro(zipSync({ "Content/score.gpif": strToU8(mendGpif(gpif)) }));
  }
  if (gpif) readExtras(song, gpif);
  else {
    legacyHarmonics(song, /v5\./.test(strFromU8(bytes.subarray(1, 31))));
    legacyDrumKeys(song, bytes);
  }
  return song;
}

/** A GP3 to GP5 file read by guitarpro-parser, past zero padding after the last bar. */
function parseLegacy(bytes: Uint8Array): Song {
  try {
    return parseGuitarPro(bytes);
  } catch (e) {
    const pad = /(\d+) bytes follow the last bar/.exec(e instanceof Error ? e.message : "");
    if (pad && bytes.subarray(bytes.length - Number(pad[1])).every((b) => b === 0)) return parseGuitarPro(bytes.subarray(0, bytes.length - Number(pad[1])));
    throw e;
  }
}

/**
 * GP3 to GP5 drum notes on the keys the file gives (guitarpro-parser moves some to other General
 * MIDI keys): the file read again with its drum tracks marked fretted, where the fret is the key.
 */
function legacyDrumKeys(song: Song, bytes: Uint8Array): void {
  const drums = song.tracks.filter((t) => t.kind === "percussion");
  if (!drums.length) return;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const i32 = (at: number) => (at + 4 <= bytes.length ? view.getInt32(at, true) : -1);
  const latin1 = (from: number, n: number) => String.fromCharCode(...bytes.subarray(from, from + n));
  // A track header: flags, name (byte-size string in 40 bytes), strings, 7 tunings, port, channel...
  const header = (o: number, name: string) => {
    const len = bytes[o + 1];
    const strings = i32(o + 42);
    if (len > 40 || strings < 1 || strings > 7) return false;
    for (let s = 0; s < strings; s++) if (i32(o + 46 + 4 * s) < 0 || i32(o + 46 + 4 * s) > 127) return false;
    const channel = i32(o + 78);
    if (channel < 1 || channel > 64 || i32(o + 86) < 0 || i32(o + 86) > 100 || i32(o + 90) < 0 || i32(o + 90) > 100) return false;
    return !/^[\x20-\x7e]*$/.test(name) || latin1(o + 2, len) === name;
  };
  const patched = bytes.slice();
  let at = 0;
  for (const t of song.tracks) {
    while (at < bytes.length - 94 && !header(at, t.name)) at++;
    if (at >= bytes.length - 94) return;
    if (t.kind === "percussion") {
      patched[at] &= ~1;
      const channel = i32(at + 78);
      if ((channel - 1) % 16 === 9) new DataView(patched.buffer).setInt32(at + 78, channel - 1, true);
    }
    at += 94;
  }
  let fretted: Song;
  try {
    fretted = parseLegacy(patched);
  } catch {
    return;
  }
  song.tracks.forEach((t, ti) => {
    const f = fretted.tracks[ti];
    if (t.kind !== "percussion" || f?.kind !== "stringed") return;
    const keys: [PercussionNote, number][] = [];
    for (let b = 0; b < t.bars.length; b++)
      for (let v = 0; v < t.bars[b].voices.length; v++) {
        const ours = t.bars[b].voices[v].beats;
        const theirs = f.bars[b]?.voices[v]?.beats;
        if (!theirs || theirs.length !== ours.length) return;
        for (let i = 0; i < ours.length; i++) {
          if (ours[i].notes.length !== theirs[i].notes.length) return;
          ours[i].notes.forEach((n, k) => keys.push([n, theirs[i].notes[k].fret]));
        }
      }
    for (const [n, key] of keys) if (key >= 0 && key <= 127) n.midi = key;
  });
}

// Harmonic k sounds these semitones above its string; a fret touching the string at j/k of its length gives it.
const HARMONIC_SEMIS = [0, 0, 12, 19, 24, 28, 31, 34, 36];
// The touch fret Guitar Pro writes for harmonic k, counted from the fretted note.
const HARMONIC_FRETS = [0, 0, 12, 7, 5, 4, 3.2, 2.7, 2.4];

/** The harmonic a fret sounds (2 to 8), null when it touches no node. */
export function harmonicAt(fret: number): number | null {
  const x = 1 - 2 ** (-fret / 12);
  for (let k = 2; k <= 8; k++) if (Math.round(x * k) >= 1 && Math.abs(x - Math.round(x * k) / k) < 0.008) return k;
  return null;
}

/** Where a fretted note sounds: harmonics at their harmonic's pitch, from the touch fret as GP6 and GP7 store it. */
export function soundingMidi(n: FrettedNote): number {
  const h = n.harmonic;
  if (!h) return n.midi;
  const k = harmonicAt(h.fret);
  if (!k) return n.midi;
  // A natural harmonic counts from the open string; the others from the fretted note.
  return (h.type === "natural" ? n.midi - n.fret : n.midi) + HARMONIC_SEMIS[k];
}

/** GP3 to GP5 harmonics as GP7 stores them: artificial ones a distance in semitones, a GP5 tap its fret. */
function legacyHarmonics(song: Song, gp5: boolean): void {
  for (const t of song.tracks) {
    if (t.kind !== "stringed") continue;
    for (const b of t.bars)
      for (const v of b.voices)
        for (const beat of v.beats)
          for (const n of beat.notes) {
            const h = n.harmonic;
            if (!h || h.type === "natural") continue;
            let fret = 12;
            if (h.type === "artificial") {
              const k = HARMONIC_SEMIS.reduce((best, s, i) => (i >= 2 && Math.abs(s - h.fret) < Math.abs(HARMONIC_SEMIS[best] - h.fret) ? i : best), 2);
              fret = HARMONIC_FRETS[k];
            } else if (h.type === "tap" && gp5 && h.fret > n.fret) fret = h.fret - n.fret;
            n.harmonic = { ...h, fret };
          }
  }
}

/** The touch fret Guitar Pro stores for a harmonic sounding `semis` above its open string (natural) or note. */
export function harmonicFret(natural: boolean, semis: number, fret: number): number | null {
  const k = HARMONIC_SEMIS.indexOf(semis);
  if (k < 2) return null;
  if (!natural) return HARMONIC_FRETS[k];
  // The node of harmonic k nearest the fret played.
  let best: number | null = null;
  for (let j = 1; j < k; j++) {
    const f = -12 * Math.log2(1 - j / k);
    if (gcdOf(j, k) === 1 && (best === null || Math.abs(f - fret) < Math.abs(best - fret))) best = f;
  }
  if (best === null) return null;
  return Math.abs(best - Math.round(best)) < 0.15 ? Math.round(best) : Math.round(best * 10) / 10;
}
const gcdOf = (a: number, b: number): number => (b ? gcdOf(b, a % b) : a);

/** A GP6 or GP7 file's score.gpif, null for other files. */
export function gpifOf(bytes: Uint8Array): string | null {
  const magic = String.fromCharCode(...bytes.subarray(0, 4));
  try {
    if (magic === "BCFZ" || magic === "BCFS") return bcfsEntry(magic === "BCFZ" ? bcfz(bytes) : bytes.subarray(4), "score.gpif");
    if (magic === "PK\x03\x04") return strFromU8(unzipSync(bytes, { filter: (f) => f.name === "Content/score.gpif" })["Content/score.gpif"] ?? new Uint8Array()) || null;
  } catch {
    // Not a container this reads.
  }
  return null;
}

// What guitarpro-parser leaves out of GP6 and GP7 files, read from score.gpif: ottava lines
// on beats, and bars marked to repeat the one or two before (simile marks).
const OTTAVAS = new WeakMap<object, string>();
// Pitched tracks of a transposing instrument: sounding minus written, in semitones.
const TRANSPOSE = new WeakMap<object, number>();
// GP6 percussion kits other than the drum kit: General MIDI keys by element, then variation.
const GP6_KITS: Record<string, number[][]> = {
  cngKit: [[64], [63, 63, 62]],
  bngKit: [[61], [60]],
  tmblKit: [[66], [65]],
  agogoKit: [[67], [68]],
  whstlKit: [[71], [72]],
  cuicaKit: [[78], [79]],
  wdblckKit: [[76], [77]],
};
const SIMILES = new WeakMap<object, string>();

function readExtras(song: Song, gpif: string): void {
  const byId = (tag: string) => new Map([...gpif.matchAll(new RegExp(`<${tag} id="(\\d+)">([\\s\\S]*?)</${tag}>`, "g"))].map((m) => [m[1], m[2]]));
  const ids = (body: string | undefined, tag: string) => (new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(body ?? "")?.[1] ?? "").trim().split(/\s+/).filter(Boolean);
  const barEls = byId("Bar");
  const voiceEls = byId("Voice");
  const beatEls = byId("Beat");
  const noteEls = byId("Note");
  // Each staff's track (a GP6 grand staff track has two staves): its instrument, whether it plays
  // drums by its MIDI channel or table (guitarpro-parser goes by the instrument type), its transposition.
  const staves = [...gpif.matchAll(/<Track id="\d+">([\s\S]*?)<\/Track>/g)].flatMap((m) => {
    const ref = /<Instrument ref="([^"]*)"/.exec(m[1])?.[1] ?? "";
    const count = (m[1].match(/<Staff>/g) ?? []).length || (ref.endsWith("-gs") ? 2 : 1);
    const drums = !/name="Tuning"/.test(m[1]) && (/<GeneralMidi table="Percussion"/.test(m[1]) || /<PrimaryChannel>\s*9\s*</.test(m[1]));
    const chromatic = Number(/<Transpose>\s*<Chromatic>\s*(-?\d+)/.exec(m[1])?.[1] ?? 0);
    return Array.from({ length: count }, () => ({ ref, drums, chromatic }));
  });
  const refs = staves.map((s) => s.ref);
  const turned = song.tracks.map((t, i) => t.kind !== "percussion" && !!staves[i]?.drums && staves.length === song.tracks.length);
  const lists = [...gpif.matchAll(/<MasterBar>[\s\S]*?<Bars>([^<]*)<\/Bars>/g)].map((m) => m[1].trim().split(/\s+/));
  type AnyBar = { voices: { beats: object[] }[] };
  lists.forEach((barIds, i) =>
    barIds.forEach((barId, t) => {
      const bars = song.tracks[t]?.bars as AnyBar[] | undefined;
      const bar = bars?.[i];
      if (!bar) return;
      const body = barEls.get(barId);
      ids(body, "Voices").forEach((vid, v) => {
        const beats = ids(voiceEls.get(vid), "Beats");
        const ours = bar.voices[v]?.beats;
        if (!ours || ours.length !== beats.length) return;
        beats.forEach((bid, b) => {
          const ott = /<Ottavia>\s*(\w+)\s*<\/Ottavia>/.exec(beatEls.get(bid) ?? "");
          if (ott) OTTAVAS.set(ours[b], ott[1]);
          if (song.tracks[t].kind !== "percussion" && !turned[t]) return;
          // GP6 kits and notes on no drum of a GP7 kit: the note's own key.
          const nids = ids(beatEls.get(bid), "Notes");
          const notes = (ours[b] as AnyBeat).notes;
          if (nids.length !== notes.length) return;
          nids.forEach((nid, k) => {
            const body = noteEls.get(nid) ?? "";
            const art = /<InstrumentArticulation>\s*(-?\d+)/.exec(body)?.[1];
            const key = /name="Midi">\s*<Number>\s*(\d+)/.exec(body)?.[1];
            const element = Number(/<Element>\s*(\d+)/.exec(body)?.[1] ?? -1);
            const variation = Number(/<Variation>\s*(\d+)/.exec(body)?.[1] ?? 0);
            if (art !== undefined && Number(art) >= 0 && !turned[t]) return;
            if (key !== undefined) notes[k].midi = Number(key);
            else if (GP6_KITS[refs[t]]?.[element]) notes[k].midi = GP6_KITS[refs[t]][element][Math.min(variation, GP6_KITS[refs[t]][element].length - 1)];
          });
        });
      });
      const mark = /<SimileMark>\s*(\w+)\s*<\/SimileMark>/.exec(body ?? "")?.[1];
      const from = mark === "Simple" ? i - 1 : mark === "FirstOfDouble" || mark === "SecondOfDouble" ? i - 2 : -1;
      if (from < 0 || !bars![from] || bar.voices.some((v) => v.beats.length)) return;
      // Its notes, for playback; the sign itself is written as a measure repeat.
      bar.voices = structuredClone(bars![from].voices);
      SIMILES.set(bar, mark!);
    }),
  );
  song.tracks.forEach((t, i) => {
    if (turned[i]) (t as { kind: string }).kind = "percussion";
    // A transposing instrument (its notes keep their sounding pitch).
    const c = staves.length === song.tracks.length ? staves[i].chromatic : 0;
    if (t.kind === "pitched" && c) TRANSPOSE.set(t, c);
  });
}

/** A BCFZ container unpacked to its BCFS file system, reading past a stream cut short as zeros. */
function bcfz(data: Uint8Array): Uint8Array {
  const length = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(4, true);
  if (length > 64 << 20) throw new Error("BCFZ: too large");
  const out = new Uint8Array(length);
  const end = data.length * 8;
  let bit = 64;
  const read = (n: number, reversed = false) => {
    let v = 0;
    for (let i = 0; i < n; i++, bit++) {
      const b = bit < end ? (data[bit >>> 3] >>> (7 - (bit & 7))) & 1 : 0;
      v = reversed ? v | (b << i) : (v << 1) | b;
    }
    return v;
  };
  let pos = 0;
  while (pos < length && bit < end) {
    if (read(1)) {
      const word = read(4);
      const offset = read(word, true);
      const size = read(word, true);
      if (!offset || offset > pos) break;
      const n = Math.min(offset, size, length - pos);
      out.copyWithin(pos, pos - offset, pos - offset + n);
      pos += n;
    } else {
      const n = Math.min(read(2, true), length - pos);
      for (let i = 0; i < n; i++) out[pos++] = read(8);
    }
  }
  if (String.fromCharCode(...out.subarray(0, 4)) !== "BCFS") throw new Error("BCFZ: no BCFS inside");
  return out.subarray(4);
}

/** One file of a BCFS file system (4096-byte sectors; an entry lists its blocks). */
function bcfsEntry(fs: Uint8Array, name: string): string {
  const view = new DataView(fs.buffer, fs.byteOffset, fs.byteLength);
  for (let at = 0x1000; at + 0x1000 <= fs.length; at += 0x1000) {
    if (view.getUint32(at, true) !== 2) continue;
    const nameEnd = fs.indexOf(0, at + 4);
    if (strFromU8(fs.subarray(at + 4, nameEnd < 0 ? at + 131 : Math.min(nameEnd, at + 131))) !== name) continue;
    const size = view.getUint32(at + 0x8c, true);
    const content = new Uint8Array(size);
    let got = 0;
    for (let slot = at + 0x94; got < size && slot + 4 <= at + 0x1000; slot += 4) {
      const block = view.getUint32(slot, true);
      if (!block || block * 0x1000 >= fs.length) break;
      const chunk = fs.subarray(block * 0x1000, Math.min(block * 0x1000 + 0x1000, block * 0x1000 + size - got));
      content.set(chunk, got);
      got += chunk.length;
    }
    return strFromU8(content.subarray(0, got));
  }
  throw new Error(`BCFS: no ${name}`);
}

/** score.gpif with what guitarpro-parser refuses mended: GP6 grand staves, notes on no drum. */
function mendGpif(xml: string): string {
  // Text edits: GPIF is plain, and some DOM parsers choke on it.
  xml = xml.replace(/\0+$/, "");
  // A Guitar Pro 6 grand staff track ("...-gs" instrument) has two staves but no <Staves>.
  if (!xml.includes("<Staves>")) xml = xml.replace(/(<Instrument ref="[^"]*-gs"\s*\/>)/g, "$1<Staves><Staff><Properties></Properties></Staff><Staff><Properties></Properties></Staff></Staves>");
  // A note on no drum of the kit: on the first when it has a key of its own (set back after reading), else left out.
  const drop = new Set<string>();
  xml = xml.replace(/<Note id="(\d+)">(\s*<InstrumentArticulation>)\s*-\d+\s*(<[\s\S]*?<\/Note>)/g, (all, id: string, open: string, rest: string) => {
    if (/name="Midi">\s*<Number>/.test(rest)) return `<Note id="${id}">${open}0${rest}`;
    drop.add(id);
    return all;
  });
  if (drop.size)
    xml = xml.replace(/<Notes>([^<]*)<\/Notes>/g, (_, ids: string) => {
      const kept = ids.trim().split(/\s+/).filter((id) => id && !drop.has(id));
      return kept.length ? `<Notes>${kept.join(" ")}</Notes>` : "";
    });
  return xml;
}

/** guitarpro-parser's song as MusicXML. */
export function songToMusicXml(song: Song, opts: GuitarProOptions = {}): { doc: Document; fretted: boolean; tab: boolean } {
  const withTab = opts.tab !== "never";
  const out = parseXml(`<score-partwise version="4.0"/>`);
  const root = out.documentElement;
  const el = (parent: Element, tag: string, txt?: string | number | null, attrs?: Record<string, string | number>): Element => {
    const e = out.createElementNS(null, tag);
    if (attrs) for (const k in attrs) e.setAttribute(k, String(attrs[k]));
    if (txt !== undefined && txt !== null) e.appendChild(out.createTextNode(String(txt)));
    parent.appendChild(e);
    return e;
  };

  const info = song.info;
  if (info.title) el(el(root, "work"), "work-title", info.title);
  if (info.subtitle) el(root, "movement-title", info.subtitle);
  const ident = el(root, "identification");
  if (info.music || info.artist) el(ident, "creator", info.music || info.artist, { type: "composer" });
  if (info.words) el(ident, "creator", info.words, { type: "lyricist" });
  if (info.copyright) el(ident, "rights", info.copyright);

  // Parts: a fretted track is notation over tab; a piano's staves (tracks of one name) are one part.
  const parts: { track: Track; staves: Staff[] }[] = [];
  const tracks = song.tracks;
  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];
    if (t.kind === "stringed") {
      const bass = (t.program !== null && t.program >= 32 && t.program <= 39) || Math.min(...t.tuning) < 33;
      const staves: Staff[] = [{ track: t, role: "notation", clef: bass ? ["F", 4, -1] : ["G", 2, -1] }];
      if (withTab) staves.push({ track: t, role: "tab", clef: ["TAB", 5, 0] });
      parts.push({ track: t, staves });
    } else if (t.kind === "percussion") {
      parts.push({ track: t, staves: [{ track: t, role: "drums", clef: ["percussion", 2, 0] }] });
    } else {
      const group: Track[] = [t];
      while (tracks[i + 1]?.kind === "pitched" && tracks[i + 1].name === t.name) group.push(tracks[++i]);
      parts.push({ track: t, staves: group.map((g, k) => ({ track: g, role: "pitched", clef: group.length > 1 ? (k === 0 ? ["G", 2, 0] : ["F", 4, 0]) : low(g) ? ["F", 4, 0] : ["G", 2, 0] })) });
    }
  }

  const list = el(root, "part-list");
  parts.forEach((p, pi) => {
    const id = `P${pi + 1}`;
    const sp = el(list, "score-part", null, { id });
    el(sp, "part-name", p.track.name || `Track ${pi + 1}`);
    if (p.track.shortName) el(sp, "part-abbreviation", p.track.shortName);
    if (p.track.kind === "percussion") {
      const used = [...drumsUsed(p.track)].sort((a, b) => a - b);
      for (const d of used) el(el(sp, "score-instrument", null, { id: `${id}-I${d + 1}` }), "instrument-name", drumOf(d).name);
      for (const d of used) {
        const mi = el(sp, "midi-instrument", null, { id: `${id}-I${d + 1}` });
        el(mi, "midi-channel", 10);
        el(mi, "midi-unpitched", d + 1);
      }
      return;
    }
    el(el(sp, "score-instrument", null, { id: `${id}-I1` }), "instrument-name", p.track.name || "Instrument");
    el(el(sp, "midi-instrument", null, { id: `${id}-I1` }), "midi-program", (p.track.program ?? (p.track.kind === "stringed" ? 25 : 0)) + 1);
  });

  // Hammer-ons, pull-offs and slides end on the next note on the same string in the same voice.
  const ends = new Map<AnyNote, { kind: "hammer-on" | "pull-off" | "slide" }[]>();
  const starts = new Map<AnyNote, { kind: "hammer-on" | "pull-off" | "slide" }[]>();
  for (const t of tracks) {
    if (t.kind !== "stringed") continue;
    const voices = Math.max(0, ...t.bars.map((b) => b.voices.length));
    for (let v = 0; v < voices; v++) {
      const beats = t.bars.flatMap((b) => b.voices[v]?.beats ?? []);
      beats.forEach((b, i) => {
        for (const n of b.notes) {
          const kinds: ("hammer-on" | "pull-off" | "slide")[] = [];
          if (n.hopoToNext) kinds.push(n.hopoToNext === "hammerOn" ? "hammer-on" : "pull-off");
          if (n.slides.some((s) => s === "shift" || s === "legato")) kinds.push("slide");
          if (!kinds.length) continue;
          for (let j = i + 1; j < Math.min(beats.length, i + 9); j++) {
            const next = beats[j].notes.find((x) => x.string === n.string);
            if (!next) continue;
            for (const kind of kinds) {
              starts.set(n, [...(starts.get(n) ?? []), { kind }]);
              ends.set(next, [...(ends.get(next) ?? []), { kind }]);
            }
            break;
          }
        }
      });
    }
  }

  // Lyrics: each line's syllables on the struck beats of the first voice, from its bar on.
  const lyrics = new Map<AnyBeat, { number: number; text: string; syllabic: string }[]>();
  for (const t of tracks) {
    t.lyrics.forEach((line, li) => {
      const syllables = line.text
        .split(/\s+/)
        .filter(Boolean)
        .flatMap((word) => {
          const parts = word.split("-").filter(Boolean);
          return parts.map((s, k) => ({ text: s, syllabic: parts.length === 1 ? "single" : k === 0 ? "begin" : k === parts.length - 1 ? "end" : "middle" }));
        });
      const beats = (t.bars as { voices: { beats: AnyBeat[] }[] }[]).slice(line.masterBar).flatMap((b) => b.voices[0]?.beats ?? []);
      let s = 0;
      for (const b of beats) {
        if (s >= syllables.length) break;
        if (b.grace || !b.notes.length || b.notes.every((n) => n.tie.fromPrevious)) continue;
        lyrics.set(b, [...(lyrics.get(b) ?? []), { number: li + 1, ...syllables[s++] }]);
      }
    });
  }

  // A pickup bar: its beats sit at the end of the full bar.
  const bars = song.masterBars;
  let shift = 0;
  if (bars[0]?.anacrusis) {
    const firsts = tracks.flatMap((t) => (t.bars[0]?.voices ?? []).flatMap((v) => (v.beats as AnyBeat[]).filter((b) => !b.grace).map((b) => b.startTick)));
    shift = firsts.length ? Math.min(...firsts) : 0;
  }

  // Volta numbers: one already taken by an earlier volta of the same repeat is dropped (GP3 and
  // GP4 files can list it again, as MuseScore also reads them).
  const endings: number[][] = [];
  // A bar going on with the volta of the bar before.
  const goesOn = (m: number) => m > 0 && m < bars.length && bars[m].alternateEndings.length > 0 && !bars[m].repeatStart && !bars[m - 1].repeatEnd && bars[m].alternateEndings.join() === bars[m - 1].alternateEndings.join();
  // The numbers taken in this repeat: a bar without volta, or a repeat's start, begins anew.
  let used = new Set<number>();
  bars.forEach((mb, m) => {
    if (goesOn(m)) return endings.push(endings[m - 1]);
    const kept = mb.alternateEndings.filter((n) => !used.has(n));
    const e = kept.length ? kept : mb.alternateEndings;
    endings.push(e);
    if (mb.repeatStart || !e.length) used = new Set();
    else e.forEach((n) => used.add(n));
  });

  parts.forEach((p, pi) => {
    const id = `P${pi + 1}`;
    const part = el(root, "part", null, { id });
    const many = p.staves.length > 1;
    const state = p.staves.map(() => ({ dynamic: null as Dynamic | null, pm: false, ring: false, ottava: "" }));
    // A transposing instrument: written pitch and key, sounding `tr` semitones away.
    const tr = TRANSPOSE.get(p.track) ?? 0;
    const writtenKey = (f: number) => {
      let w = f - 7 * tr;
      while (w > 7) w -= 12;
      while (w < -7) w += 12;
      return w;
    };
    bars.forEach((mb, m) => {
      const pickup = m === 0 && mb.anacrusis;
      const meas = el(part, "measure", null, pickup ? { number: 0, implicit: "yes" } : { number: bars[0]?.anacrusis ? m : m + 1 });
      const len = divs(mb.durationTicks - (m === 0 ? shift : 0));
      const fifths = writtenKey(mb.keySignature.accidentals);
      const prev = bars[m - 1];

      // Left barline: a repeat's start, a volta's start.
      const voltaStart = endings[m].length > 0 && !goesOn(m);
      if (mb.repeatStart || voltaStart) {
        const bl = el(meas, "barline", null, { location: "left" });
        if (voltaStart) el(bl, "ending", `${endings[m].join(", ")}.`, { number: endings[m].join(","), type: "start" });
        if (mb.repeatStart) el(bl, "repeat", null, { direction: "forward" });
      }

      const keyChange = !prev || prev.keySignature.accidentals !== fifths || prev.keySignature.mode !== mb.keySignature.mode;
      const timeChange = !prev || prev.timeSignature.numerator !== mb.timeSignature.numerator || prev.timeSignature.denominator !== mb.timeSignature.denominator;
      if (m === 0 || keyChange || timeChange) {
        const attrs = el(meas, "attributes");
        if (m === 0) el(attrs, "divisions", DIV);
        if (keyChange) {
          const key = el(attrs, "key");
          el(key, "fifths", fifths);
          el(key, "mode", mb.keySignature.mode);
        }
        if (timeChange) {
          const time = el(attrs, "time");
          el(time, "beats", mb.timeSignature.numerator);
          el(time, "beat-type", mb.timeSignature.denominator);
        }
        if (m === 0) {
          if (many) el(attrs, "staves", p.staves.length);
          p.staves.forEach((s, k) => {
            const clef = el(attrs, "clef", null, many ? { number: k + 1 } : undefined);
            el(clef, "sign", s.clef[0]);
            el(clef, "line", s.clef[1]);
            if (s.clef[2]) el(clef, "clef-octave-change", s.clef[2]);
          });
          p.staves.forEach((s, k) => {
            if (s.role !== "tab" || s.track.kind !== "stringed") return;
            const sd = el(attrs, "staff-details", null, many ? { number: k + 1 } : undefined);
            const tuning = s.track.tuning;
            el(sd, "staff-lines", tuning.length);
            // Line 1 is the lowest string; Guitar Pro lists the highest first.
            [...tuning].reverse().forEach((midi, line) => {
              const sp = spell(midi, 0);
              const tu = el(sd, "staff-tuning", null, { line: line + 1 });
              el(tu, "tuning-step", sp.step);
              if (sp.alter) el(tu, "tuning-alter", sp.alter);
              el(tu, "tuning-octave", sp.octave);
            });
            if (s.track.capo) el(sd, "capo", s.track.capo);
          });
          if (tr) {
            const t = el(attrs, "transpose");
            const steps = [0, 1, 1, 2, 2, 3, 3, 4, 5, 5, 6, 6];
            el(t, "diatonic", Math.sign(tr) * (steps[Math.abs(tr) % 12] + 7 * Math.floor(Math.abs(tr) / 12)));
            el(t, "chromatic", tr);
          }
        }
      }

      const direction = (placement: "above" | "below", staff: number | null, types: ((dt: Element) => void)[], sound?: Record<string, string | number>) => {
        const dir = el(meas, "direction", null, { placement });
        for (const fill of types) fill(el(dir, "direction-type"));
        if (staff !== null && many) el(dir, "staff", staff);
        if (sound) el(dir, "sound", null, sound);
        return dir;
      };
      const tempos = pi === 0 ? song.tempoChanges.filter((x) => x.masterBar === m).map((t) => ({ bpm: Math.round(t.bpm * 100) / 100, at: divs(Math.max(0, t.offsetTick - (m === 0 ? shift : 0))) })) : [];
      const tempo = (bpm: number) =>
        direction(
          "above",
          1,
          [
            (dt) => {
              const mt = el(dt, "metronome");
              el(mt, "beat-unit", "quarter");
              el(mt, "per-minute", bpm);
            },
          ],
          { tempo: bpm },
        );

      // Bar directions on the first part: sections, tempo, segno and coda.
      if (pi === 0) {
        if (mb.section && (mb.section.letter || mb.section.text)) {
          const sec = mb.section;
          direction("above", 1, [...(sec.letter ? [(dt: Element) => el(dt, "rehearsal", sec.letter)] : []), ...(sec.text ? [(dt: Element) => el(dt, "words", sec.text)] : [])]);
        }
        for (const t of tempos.filter((x) => x.at === 0)) tempo(t.bpm);
        for (const target of mb.targets) {
          if (target === "fine") direction("above", 1, [(dt) => el(dt, "words", "Fine")], { fine: "yes" });
          else if (target.startsWith("segno")) direction("above", 1, [(dt) => el(dt, "segno")], { segno: target === "segno" ? "segno" : "segno2" });
          else direction("above", 1, [(dt) => el(dt, "coda")], { coda: target === "coda" ? "coda" : "coda2" });
        }
      }
      if (m === 0)
        p.staves.forEach((s, k) => {
          const capo = s.role === "notation" && s.track.kind === "stringed" ? s.track.capo : 0;
          if (capo) direction("above", k + 1, [(dt) => el(dt, "words", `Capo ${capo}`)]);
        });

      // Each staff, each voice, in turn; <backup> between them.
      let cursor = 0;
      const goTo = (pos: number) => {
        if (pos > cursor) el(el(meas, "forward"), "duration", pos - cursor);
        else if (pos < cursor) el(el(meas, "backup"), "duration", cursor - pos);
        cursor = pos;
      };
      // Bars repeating the one or two before: a measure repeat sign.
      p.staves.forEach((s, k) => {
        const mark = SIMILES.get(s.track.bars[m] ?? {});
        const before = SIMILES.get(s.track.bars[m - 1] ?? {});
        const goesOn = (before === "Simple" && mark === "Simple") || (before === "FirstOfDouble" && mark === "SecondOfDouble") || (before === "SecondOfDouble" && mark === "FirstOfDouble");
        if (goesOn || (!before && !mark)) return;
        const style = () => el(el(meas, "attributes"), "measure-style", null, many ? { number: k + 1 } : undefined);
        if (before) el(style(), "measure-repeat", null, { type: "stop" });
        if (mark) el(style(), "measure-repeat", mark === "Simple" ? 1 : 2, { type: "start" });
      });
      p.staves.forEach((s, k) => {
        // Beats past the end of an overfull bar are left out, as MuseScore does.
        const voices = ((s.track.bars[m]?.voices ?? []) as { beats: AnyBeat[] }[]).map((v, vi) => ({ beats: v.beats.filter((b) => b.startTick < mb.durationTicks), vi })).filter((v) => v.beats.length);
        const st = state[k];
        if (!voices.length) {
          goTo(0);
          const note = el(meas, "note");
          el(note, "rest", null, { measure: "yes" });
          el(note, "duration", len);
          el(note, "voice", k * 4 + 1);
          if (many) el(note, "staff", k + 1);
          cursor = len;
          return;
        }
        for (const { beats, vi } of voices) {
          goTo(0);
          let tuplet: { left: number } | null = null;
          // The exact position, so tuplets DIV cannot divide (13 in a bar) do not drift.
          let exact = 0;
          const run: Struck[] = [];
          let tuplets = 0;
          for (const beat of beats) {
            if (beat.grace && !beat.notes.length) continue;
            if (!beat.grace) {
              const at = divs(beat.startTick - (m === 0 ? shift : 0));
              if (Math.abs(at - cursor) > DIV / 32) {
                goTo(at);
                exact = at;
              }
            }
            const wholeRest = !beat.notes.length && beats.length === 1;
            // Tuplet brackets: a group is `num` notes of the first note's value.
            let tupletMark: "start" | "stop" | "both" | null = null;
            const r = beat.rhythm;
            if (r.tuplet && !beat.grace) {
              const written = NOTE_VALUE_TICKS[r.value] * (r.dots === 2 ? 1.75 : r.dots === 1 ? 1.5 : 1);
              if (!tuplet) {
                tuplet = { left: NOTE_VALUE_TICKS[r.value] * r.tuplet.num };
                tupletMark = "start";
                tuplets++;
              }
              tuplet.left -= written;
              if (tuplet.left <= 0.5) {
                tupletMark = tupletMark === "start" ? "both" : "stop";
                tuplet = null;
              }
            } else if (!beat.grace) tuplet = null;
            // The last note of a tuplet takes up its rounding.
            let dur = lengthOf(r);
            if (!beat.grace) {
              exact += exactLength(r);
              if (!r.tuplet || tupletMark === "stop" || tupletMark === "both" || beat === beats[beats.length - 1]) dur = Math.max(1, Math.round(exact) - cursor);
            }
            if (s.role !== "tab") beatDirections(beat, s, k, st);
            if (!beat.grace && vi === voices[0].vi && (s.role === "notation" || s.role === "pitched")) ottava(OTTAVAS.get(beat) ?? "", k, st);
            const fermata = !beat.grace && vi === 0 && s.role !== "tab" && mb.fermatas.some((f) => f.offsetTick === beat.startTick);
            const notes = s.role === "drums" ? beat.notes : [...beat.notes].sort((a, b) => a.midi - b.midi);
            if (!notes.length) {
              const note = el(meas, "note");
              el(note, "rest", null, wholeRest ? { measure: "yes" } : undefined);
              el(note, "duration", wholeRest ? len : dur);
              el(note, "voice", k * 4 + vi + 1);
              if (!wholeRest) {
                el(note, "type", TYPE[r.value]);
                for (let d = 0; d < r.dots; d++) el(note, "dot");
                if (r.tuplet) timeMod(note, r);
              }
              if (many) el(note, "staff", k + 1);
              if (tupletMark || fermata) {
                const nots = el(note, "notations");
                tupletEls(nots, tupletMark);
                if (fermata) el(nots, "fermata", null, { type: "upright" });
              }
              run.push({ note: null, pos: cursor, level: 0, tuplet: -1 });
              cursor += wholeRest ? len : dur;
              continue;
            }
            const first = meas.children.length;
            notes.forEach((n, ni) => noteEl(n, ni, beat, s, k, vi, fifths, ni === 0 ? tupletMark : null, fermata && ni === 0, dur));
            if (!beat.grace) {
              run.push({ note: meas.children[first], pos: cursor, level: BEAMS[r.value] ?? 0, tuplet: r.tuplet ? tuplets : -1 });
              cursor += dur;
            }
          }
          if (s.role !== "tab") beam(run, mb.timeSignature);
        }
      });

      // Tempo changes inside the bar, where they happen.
      for (const t of tempos.filter((x) => x.at > 0)) {
        goTo(Math.min(t.at, len));
        tempo(t.bpm);
      }
      if (!bars[m + 1])
        state.forEach((st, k) => {
          if (!st.ottava) return;
          goTo(len);
          ottava("", k, st);
        });
      if (cursor !== len && (tempos.some((x) => x.at > 0) || !bars[m + 1])) goTo(len);

      // Right barline: a repeat's end, a volta's end, a double or final bar.
      const next = bars[m + 1];
      const voltaEnd = endings[m].length > 0 && !goesOn(m + 1);
      if (mb.repeatEnd || voltaEnd || mb.doubleBar || !next) {
        const bl = el(meas, "barline", null, { location: "right" });
        el(bl, "bar-style", mb.repeatEnd || !next ? "light-heavy" : mb.doubleBar ? "light-light" : "regular");
        if (voltaEnd) el(bl, "ending", null, { number: endings[m].join(","), type: mb.repeatEnd ? "stop" : "discontinue" });
        if (mb.repeatEnd) el(bl, "repeat", null, { direction: "backward", ...(mb.repeatEnd.playCount > 2 ? { times: mb.repeatEnd.playCount } : {}) });
      }
      // Jumps at the bar's end, on the first part.
      if (pi === 0 && mb.jumps.length) {
        goTo(len);
        for (const j of mb.jumps) {
          const [words, sound] = JUMPS[j] ?? [j, undefined];
          const dir = direction("above", 1, [(dt) => el(dt, "words", words)], sound);
          // The barline stays last in the measure.
          const bl = [...meas.children].find((c) => c.tagName === "barline" && c.getAttribute("location") === "right");
          if (bl) meas.insertBefore(dir, bl);
        }
      }

      /** An ottava line starting or ending on staff k. The notes keep their sounding pitch. */
      function ottava(kind: string, k: number, st: (typeof state)[number]): void {
        if (kind === st.ottava || (kind && !OTTAVA[kind])) return;
        if (st.ottava) direction("above", k + 1, [(dt) => el(dt, "octave-shift", null, { type: "stop", size: OTTAVA[st.ottava][1] })]);
        if (kind) direction(OTTAVA[kind][0] === "down" ? "above" : "below", k + 1, [(dt) => el(dt, "octave-shift", null, { type: OTTAVA[kind][0], size: OTTAVA[kind][1] })]);
        st.ottava = kind;
      }

      function beatDirections(beat: AnyBeat, s: Staff, k: number, st: (typeof state)[number]): void {
        if (beat.chord) {
          const c = parseChord(beat.chord);
          if (c) meas.appendChild(makeHarmony(out, c, many ? k + 1 : undefined));
          else direction("above", k + 1, [(dt) => el(dt, "words", beat.chord)]);
        }
        if (beat.text) direction("above", k + 1, [(dt) => el(dt, "words", beat.text)]);
        if (beat.grace) return;
        const first = beat.notes[0];
        if (first && first.dynamic !== st.dynamic) {
          // Guitar Pro gives every note a dynamic: the usual starting one is left unwritten.
          if (st.dynamic !== null || (first.dynamic !== "f" && first.dynamic !== "mf")) direction("below", k + 1, [(dt) => el(el(dt, "dynamics"), first.dynamic)]);
          st.dynamic = first.dynamic;
        }
        if (s.track.kind !== "stringed") return;
        const fretted = beat.notes as FrettedNote[];
        const pm = fretted.some((n) => n.palmMute);
        const ring = fretted.some((n) => n.letRing);
        if (pm && !st.pm) direction("below", k + 1, [(dt) => el(dt, "words", "P.M.")]);
        if (ring && !st.ring) direction("below", k + 1, [(dt) => el(dt, "words", "let ring")]);
        st.pm = pm;
        st.ring = ring;
      }

      function noteEl(n: AnyNote, ni: number, beat: AnyBeat, s: Staff, k: number, vi: number, fifths: number, tupletMark: "start" | "stop" | "both" | null, fermata: boolean, dur: number): void {
        const r = beat.rhythm;
        const note = el(meas, "note");
        if (beat.grace) el(note, "grace", null, beat.grace === "beforeBeat" ? { slash: "yes" } : undefined);
        if (ni > 0) el(note, "chord");
        const drum = s.role === "drums" ? drumOf(n.midi) : null;
        if (drum) {
          // On its line of the drum staff, counting half spaces down from the top line (F5).
          const at = 5 * 7 + 3 - drum.line;
          const un = el(note, "unpitched");
          el(un, "display-step", "CDEFGAB"[((at % 7) + 7) % 7]);
          el(un, "display-octave", Math.floor(at / 7));
        } else {
          // A harmonic is written where it sounds; the tab keeps the fret played.
          const sp = spell(s.track.kind === "stringed" ? soundingMidi(n as FrettedNote) : n.midi - tr, fifths);
          const pitch = el(note, "pitch");
          el(pitch, "step", sp.step);
          if (sp.alter) el(pitch, "alter", sp.alter);
          el(pitch, "octave", sp.octave);
        }
        if (!beat.grace) el(note, "duration", dur);
        if (n.tie.fromPrevious) el(note, "tie", null, { type: "stop" });
        if (n.tie.toNext) el(note, "tie", null, { type: "start" });
        if (drum) el(note, "instrument", null, { id: `${id}-I${n.midi + 1}` });
        el(note, "voice", k * 4 + vi + 1);
        el(note, "type", TYPE[r.value]);
        for (let d = 0; d < r.dots; d++) el(note, "dot");
        if (r.tuplet) timeMod(note, r);
        const fn = s.track.kind === "stringed" ? (n as FrettedNote) : null;
        if (drum && HEADS[drum.head]) el(note, "notehead", HEADS[drum.head]);
        else if (fn?.dead) el(note, "notehead", "x");
        else if (n.ghost) el(note, "notehead", "normal", { parentheses: "yes" });
        else if (fn?.harmonic && s.role === "notation") el(note, "notehead", "diamond");
        if (many) el(note, "staff", k + 1);

        const nots: Element[] = [];
        const notations = () => (nots[0] ??= el(note, "notations"));
        const groups = new Map<string, Element>();
        const group = (tag: string) => groups.get(tag) ?? groups.set(tag, el(notations(), tag)).get(tag)!;
        if (n.tie.fromPrevious) el(notations(), "tied", null, { type: "stop" });
        if (n.tie.toNext) el(notations(), "tied", null, { type: "start" });
        if (tupletMark) tupletEls(notations(), tupletMark);
        const stop = ends.get(n) ?? [];
        const start = starts.get(n) ?? [];
        for (const e of stop) if (e.kind === "slide") el(notations(), "slide", null, { type: "stop", number: 1 });
        for (const e of start) if (e.kind === "slide") el(notations(), "slide", null, { type: "start", number: 1, "line-type": "solid" });
        // Ornaments: vibrato, trill, tremolo picking.
        if (fn?.vibrato) {
          el(group("ornaments"), "wavy-line", null, { type: "start", number: 2 });
          el(group("ornaments"), "wavy-line", null, { type: "stop", number: 2 });
        }
        if (fn?.trill) el(group("ornaments"), "trill-mark");
        if (beat.tremoloPicking && STROKES[beat.tremoloPicking]) el(group("ornaments"), "tremolo", STROKES[beat.tremoloPicking]!, { type: "single" });
        // Technical: string and fret (tab), hammer-ons and pull-offs, bends, harmonics, taps, picking.
        const tabbed = s.role === "tab" || (s.role === "notation" && !withTab);
        if (fn && tabbed) {
          el(group("technical"), "string", fn.string + 1);
          el(group("technical"), "fret", fn.fret);
        }
        for (const e of stop) if (e.kind !== "slide") el(group("technical"), e.kind, null, { type: "stop", number: 1 });
        for (const e of start) if (e.kind !== "slide") el(group("technical"), e.kind, e.kind === "hammer-on" ? "H" : "P", { type: "start", number: 1 });
        if (fn?.bend && tabbed) {
          const pts = fn.bend.map((x) => x.semitones);
          const top = Math.max(...pts);
          if (top > 0) {
            const bend = el(group("technical"), "bend");
            el(bend, "bend-alter", top);
            if (pts[0] >= top) el(bend, "pre-bend");
            if (pts[pts.length - 1] < top) {
              const back = el(group("technical"), "bend");
              el(back, "bend-alter", top);
              el(back, "release");
            }
          }
        }
        if (fn?.harmonic) {
          el(el(group("technical"), "harmonic"), fn.harmonic.type === "natural" ? "natural" : "artificial");
          // The kind of artificial harmonic, as Guitar Pro labels it on the tab.
          const label = HARMONICS[fn.harmonic.type];
          if (label && tabbed) el(group("technical"), "other-technical", label);
        }
        if (fn && (fn.tapped || fn.leftHandTapped)) el(group("technical"), "tap", null, fn.leftHandTapped ? { hand: "left" } : undefined);
        if (ni === 0 && s.role !== "tab" && beat.pickStroke) el(group("technical"), beat.pickStroke === "down" ? "down-bow" : "up-bow");
        // Articulations: accents, staccato, slides into and out of the note.
        const arts: string[] = [];
        if (n.accent) arts.push(n.accent === "heavyAccent" ? "strong-accent" : "accent");
        if (n.staccato) arts.push("staccato");
        if (fn) for (const sl of fn.slides) if (OUT_SLIDE[sl]) arts.push(OUT_SLIDE[sl]);
        if (arts.length) {
          const a = group("articulations");
          for (const x of arts) el(a, x);
        }
        if (fermata) el(notations(), "fermata", null, { type: "upright" });
        // A strum: Guitar Pro's "down" runs from the lowest string up.
        if (beat.stroke) el(notations(), "arpeggiate", null, { direction: beat.stroke.direction === "down" ? "up" : "down" });
        if (ni === 0 && s.role !== "tab") {
          for (const ly of lyrics.get(beat) ?? []) {
            const lyric = el(note, "lyric", null, { number: ly.number });
            el(lyric, "syllabic", ly.syllabic);
            el(lyric, "text", ly.text);
          }
        }
      }
    });
  });

  const fretted = tracks.some((t) => t.kind === "stringed");
  return { doc: out, fretted, tab: fretted && withTab };

  function timeMod(note: Element, r: Rhythm): void {
    const tm = el(note, "time-modification");
    el(tm, "actual-notes", r.tuplet!.num);
    el(tm, "normal-notes", r.tuplet!.den);
  }
  function tupletEls(nots: Element, mark: "start" | "stop" | "both" | null): void {
    if (mark === "start" || mark === "both") el(nots, "tuplet", null, { type: "start" });
    if (mark === "stop" || mark === "both") el(nots, "tuplet", null, { type: "stop" });
  }
}

const BEAMS: Partial<Record<NoteValue, number>> = { eighth: 1, "16th": 2, "32nd": 3, "64th": 4, "128th": 5, "256th": 6 };
interface Struck {
  note: Element | null;
  pos: number;
  level: number;
  /** The tuplet the note is in, -1 for none. */
  tuplet: number;
}

/** Beams eighths and shorter within each beat (a dotted quarter in 6/8, 9/8, 12/8) or tuplet; a rest breaks a group. */
function beam(run: Struck[], time: { numerator: number; denominator: number }): void {
  const compound = time.denominator === 8 && time.numerator % 3 === 0;
  const beat = compound ? DIV * 1.5 : time.denominator >= 4 ? DIV : (DIV * 4) / time.denominator;
  const groupOf = (s: Struck) => (s.tuplet >= 0 ? `t${s.tuplet}` : `b${Math.floor(s.pos / beat + 1e-6)}`);
  for (let i = 0; i < run.length; ) {
    const g = groupOf(run[i]);
    let j = i;
    while (run[i].level > 0 && j + 1 < run.length && run[j + 1].level > 0 && groupOf(run[j + 1]) === g) j++;
    if (j > i) {
      const group = run.slice(i, j + 1);
      group.forEach(({ note, level }, k) => {
        for (let L = 1; L <= level; L++) {
          const before = k > 0 && group[k - 1].level >= L;
          const after = k < group.length - 1 && group[k + 1].level >= L;
          const kind = before && after ? "continue" : before ? "end" : after ? "begin" : k > 0 ? "backward hook" : "forward hook";
          const b = note!.ownerDocument.createElementNS(null, "beam");
          b.setAttribute("number", String(L));
          b.textContent = kind;
          note!.insertBefore(b, [...note!.children].find((c) => c.tagName === "notations" || c.tagName === "lyric") ?? null);
        }
      });
    }
    i = j + 1;
  }
}

function low(t: Track): boolean {
  const pitches = (t.bars as { voices: { beats: AnyBeat[] }[] }[]).flatMap((b) => b.voices.flatMap((v) => v.beats.flatMap((x) => x.notes.map((n) => n.midi))));
  return pitches.length > 0 && pitches.reduce((a, b) => a + b, 0) / pitches.length < 55;
}

function drumsUsed(t: Track): Set<number> {
  const used = new Set<number>();
  for (const b of t.bars as { voices: { beats: AnyBeat[] }[] }[]) for (const v of b.voices) for (const x of v.beats) for (const n of x.notes) used.add(n.midi);
  return used;
}
