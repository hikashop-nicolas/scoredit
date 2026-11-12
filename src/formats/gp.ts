import { NOTE_VALUE_TICKS, TICKS_PER_QUARTER, parseGuitarPro } from "guitarpro-parser";
import type { Beat, Dynamic, FrettedNote, MasterBar, NoteValue, PercussionNote, PitchedNote, Rhythm, Song, Track } from "guitarpro-parser";
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
  const [step, alter] = (fifths < 0 ? FLATS : SHARPS)[((midi % 12) + 12) % 12];
  return { step, alter, octave: Math.floor(midi / 12) - 1 };
};
const divs = (ticks: number) => Math.round((ticks * DIV) / TICKS_PER_QUARTER);
const lengthOf = (r: Rhythm) => Math.max(1, divs(NOTE_VALUE_TICKS[r.value] * (r.dots === 2 ? 1.75 : r.dots === 1 ? 1.5 : 1) * (r.tuplet ? r.tuplet.den / r.tuplet.num : 1)));
const drumOf = (midi: number) => DRUM_KIT.find((d) => d.pitch === midi) ?? { pitch: midi, line: 3, head: "normal", name: `Drum ${midi}`, up: true };

/** A Guitar Pro file as MusicXML. */
export function readGuitarPro(bytes: Uint8Array, opts: GuitarProOptions = {}): { doc: Document; fretted: boolean; tab: boolean } {
  return songToMusicXml(parseGuitarPro(bytes), opts);
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

  const sameEndings = (a?: MasterBar, b?: MasterBar) => !!a && !!b && a.alternateEndings.join() === b.alternateEndings.join();

  parts.forEach((p, pi) => {
    const id = `P${pi + 1}`;
    const part = el(root, "part", null, { id });
    const many = p.staves.length > 1;
    const state = p.staves.map(() => ({ dynamic: null as Dynamic | null, pm: false, ring: false }));
    bars.forEach((mb, m) => {
      const pickup = m === 0 && mb.anacrusis;
      const meas = el(part, "measure", null, pickup ? { number: 0, implicit: "yes" } : { number: bars[0]?.anacrusis ? m : m + 1 });
      const len = divs(mb.durationTicks - (m === 0 ? shift : 0));
      const fifths = mb.keySignature.accidentals;
      const prev = bars[m - 1];

      // Left barline: a repeat's start, a volta's start.
      const voltaStart = mb.alternateEndings.length > 0 && !sameEndings(prev, mb);
      if (mb.repeatStart || voltaStart) {
        const bl = el(meas, "barline", null, { location: "left" });
        if (voltaStart) el(bl, "ending", `${mb.alternateEndings.join(", ")}.`, { number: mb.alternateEndings.join(","), type: "start" });
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
        }
      }

      const direction = (placement: "above" | "below", staff: number | null, types: ((dt: Element) => void)[], sound?: Record<string, string | number>, offset = 0) => {
        const dir = el(meas, "direction", null, { placement });
        for (const fill of types) fill(el(dir, "direction-type"));
        if (offset) el(dir, "offset", offset);
        if (staff !== null && many) el(dir, "staff", staff);
        if (sound) el(dir, "sound", null, sound);
        return dir;
      };

      // Bar directions on the first part: sections, tempo, segno and coda.
      if (pi === 0) {
        if (mb.section && (mb.section.letter || mb.section.text)) {
          const sec = mb.section;
          direction("above", 1, [...(sec.letter ? [(dt: Element) => el(dt, "rehearsal", sec.letter)] : []), ...(sec.text ? [(dt: Element) => el(dt, "words", sec.text)] : [])]);
        }
        for (const t of song.tempoChanges.filter((x) => x.masterBar === m)) {
          const bpm = Math.round(t.bpm * 100) / 100;
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
            divs(Math.max(0, t.offsetTick - (m === 0 ? shift : 0))),
          );
        }
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
      p.staves.forEach((s, k) => {
        const voices = ((s.track.bars[m]?.voices ?? []) as { beats: AnyBeat[] }[]).map((v, vi) => ({ beats: v.beats, vi })).filter((v) => v.beats.length);
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
          for (const beat of beats) {
            if (beat.grace && !beat.notes.length) continue;
            if (!beat.grace) {
              const at = divs(beat.startTick - (m === 0 ? shift : 0));
              if (Math.abs(at - cursor) > DIV / 32) goTo(at);
            }
            const dur = lengthOf(beat.rhythm);
            const wholeRest = !beat.notes.length && beats.length === 1;
            // Tuplet brackets: a group is `num` notes of the first note's value.
            let tupletMark: "start" | "stop" | "both" | null = null;
            const r = beat.rhythm;
            if (r.tuplet && !beat.grace) {
              const written = NOTE_VALUE_TICKS[r.value] * (r.dots === 2 ? 1.75 : r.dots === 1 ? 1.5 : 1);
              if (!tuplet) {
                tuplet = { left: NOTE_VALUE_TICKS[r.value] * r.tuplet.num };
                tupletMark = "start";
              }
              tuplet.left -= written;
              if (tuplet.left <= 0.5) {
                tupletMark = tupletMark === "start" ? "both" : "stop";
                tuplet = null;
              }
            } else if (!beat.grace) tuplet = null;

            if (s.role !== "tab") beatDirections(beat, s, k, st);
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
              cursor += wholeRest ? len : dur;
              continue;
            }
            notes.forEach((n, ni) => noteEl(n, ni, beat, s, k, vi, fifths, ni === 0 ? tupletMark : null, fermata && ni === 0, dur));
            if (!beat.grace) cursor += dur;
          }
        }
      });

      // Right barline: a repeat's end, a volta's end, a double or final bar.
      const next = bars[m + 1];
      const voltaEnd = mb.alternateEndings.length > 0 && !sameEndings(mb, next);
      if (mb.repeatEnd || voltaEnd || mb.doubleBar || !next) {
        const bl = el(meas, "barline", null, { location: "right" });
        el(bl, "bar-style", mb.repeatEnd || !next ? "light-heavy" : mb.doubleBar ? "light-light" : "regular");
        if (voltaEnd) el(bl, "ending", null, { number: mb.alternateEndings.join(","), type: mb.repeatEnd ? "stop" : "discontinue" });
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
          const sp = spell(n.midi, fifths);
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
        if (fn?.harmonic) el(el(group("technical"), "harmonic"), fn.harmonic.type === "natural" ? "natural" : "artificial");
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

function low(t: Track): boolean {
  const pitches = (t.bars as { voices: { beats: AnyBeat[] }[] }[]).flatMap((b) => b.voices.flatMap((v) => v.beats.flatMap((x) => x.notes.map((n) => n.midi))));
  return pitches.length > 0 && pitches.reduce((a, b) => a + b, 0) / pitches.length < 55;
}

function drumsUsed(t: Track): Set<number> {
  const used = new Set<number>();
  for (const b of t.bars as { voices: { beats: AnyBeat[] }[] }[]) for (const v of b.voices) for (const x of v.beats) for (const n of x.notes) used.add(n.midi);
  return used;
}
