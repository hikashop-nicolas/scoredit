import { strFromU8, unzipSync } from "fflate";
import { kid, kids, parseXml, text } from "../model/xml";

// MuseScore's .mscx (and the .mscz zip around it) read into MusicXML, versions 3 and 4.
// Learned from MuseScore files and MuseScore's own MusicXML export of the same scores; the
// format has no published spec.

/** Divisions per quarter note: divisible by 3, 5 and 7 tuplets down to 128ths. */
const DIV = 3360;

const DURATION: Record<string, number> = { long: 16, breve: 8, whole: 4, half: 2, quarter: 1, eighth: 0.5, "16th": 0.25, "32nd": 0.125, "64th": 1 / 16, "128th": 1 / 32, "256th": 1 / 64 };
const TYPE_NAME: Record<string, string> = { long: "long", breve: "breve", whole: "whole", half: "half", quarter: "quarter", eighth: "eighth", "16th": "16th", "32nd": "32nd", "64th": "64th", "128th": "128th", "256th": "256th" };
const ATTR_ORDER = ["divisions", "key", "time", "staves", "part-symbol", "instruments", "clef", "staff-details", "transpose"];
const SEMIS: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const ACCIDENTAL: Record<string, string> = {
  accidentalSharp: "sharp",
  accidentalFlat: "flat",
  accidentalNatural: "natural",
  accidentalDoubleSharp: "double-sharp",
  accidentalDoubleFlat: "flat-flat",
};
const ARTIC: Record<string, string> = {
  articStaccatoAbove: "staccato",
  articStaccatoBelow: "staccato",
  articStaccatissimoAbove: "staccatissimo",
  articStaccatissimoBelow: "staccatissimo",
  articAccentAbove: "accent",
  articAccentBelow: "accent",
  articTenutoAbove: "tenuto",
  articTenutoBelow: "tenuto",
  articMarcatoAbove: "strong-accent",
  articMarcatoBelow: "strong-accent",
};
const ORNAMENT: Record<string, string> = { ornamentTrill: "trill-mark", ornamentTurn: "turn", ornamentTurnInverted: "inverted-turn", ornamentMordent: "mordent", ornamentShortTrill: "inverted-mordent" };
// MuseScore clef names: [sign, line, octave change].
const CLEF: Record<string, [string, number, number]> = {
  G: ["G", 2, 0],
  G8va: ["G", 2, 1],
  G15ma: ["G", 2, 2],
  G8vb: ["G", 2, -1],
  G8vbo: ["G", 2, -1],
  F: ["F", 4, 0],
  F8vb: ["F", 4, -1],
  F15mb: ["F", 4, -2],
  F3: ["F", 3, 0],
  F5: ["F", 5, 0],
  C1: ["C", 1, 0],
  C2: ["C", 2, 0],
  C3: ["C", 3, 0],
  C4: ["C", 4, 0],
  C5: ["C", 5, 0],
  PERC: ["percussion", 3, 0],
  PERC2: ["percussion", 3, 0],
  TAB: ["TAB", 5, 0],
  TAB4: ["TAB", 5, 0],
};

/** The .mscx inside an .mscz (META-INF/container.xml names it; else the first .mscx). */
export function readMscz(bytes: Uint8Array): string {
  const files = unzipSync(bytes, { filter: (f) => f.name.endsWith(".mscx") || f.name === "META-INF/container.xml" });
  const container = files["META-INF/container.xml"];
  if (container) {
    const m = /<rootfile[^>]*full-path="([^"]+\.mscx)"/.exec(strFromU8(container));
    if (m && files[m[1]]) return strFromU8(files[m[1]]);
  }
  const name = Object.keys(files).find((n) => n.endsWith(".mscx"));
  if (!name) throw new Error("No MuseScore score inside the file");
  return strFromU8(files[name]);
}

const frac = (s: string | null | undefined): number => {
  if (!s) return 0;
  const [n, d] = s.split("/").map(Number);
  return d ? n / d : Number(n) || 0;
};

/** Spelling from MuseScore's tonal pitch class (line of fifths, C = 14). */
function spell(tpc: number, midi: number): { step: string; alter: number; octave: number } {
  const step = "FCGDAEB"[(((tpc - 13) % 7) + 7) % 7];
  const alter = Math.floor((tpc + 1) / 7) - 2;
  const octave = Math.round((midi - alter - SEMIS[step]) / 12) - 1;
  return { step, alter, octave };
}

const plain = (el: Element | null): string => (el?.textContent ?? "").replace(/\s+/g, " ").trim();

interface PartDef {
  id: string;
  staves: Element[]; // the <Staff> definitions inside <Part>
  name: string;
  abbreviation: string;
  program: number;
  drums: boolean;
  /** Written = sounding - chromatic (semitones); spelled diatonic steps away. */
  chromatic: number;
  diatonic: number;
  tab: boolean[];
  strings: number[];
}

/** MuseScore .mscx text to a MusicXML partwise document, plus where its sections start. */
export function mscxToMusicXml(source: string): Document {
  return readMscx(source).doc;
}

export function readMscx(source: string): { doc: Document; sections: number[] } {
  const src = parseXml(source);
  const ms = src.documentElement;
  if (ms.tagName !== "museScore") throw new Error("Not a MuseScore file");
  const score = kid(ms, "Score");
  if (!score) throw new Error("The MuseScore file holds no score");

  let pendingFermata = false;
  const out = parseXml(`<score-partwise version="4.0"/>`);
  const root = out.documentElement;
  const el = (parent: Element, tag: string, txt?: string | number | null, attrs?: Record<string, string | number>): Element => {
    const e = out.createElementNS(null, tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    if (txt !== undefined && txt !== null) e.textContent = String(txt);
    parent.appendChild(e);
    return e;
  };

  // ---- Header: title, composer, lyricist from the title frame or the meta tags.
  const staffEls = kids(score, "Staff");
  const meta = (name: string) => plain(kids(score, "metaTag").find((m) => m.getAttribute("name") === name) ?? null);
  const frameText = (style: string) => {
    const first = staffEls[0];
    if (!first) return "";
    for (const box of kids(first).filter((c) => /Box$/.test(c.tagName))) {
      for (const t of kids(box, "Text")) if (text(t, "style") === style) return plain(kid(t, "text"));
    }
    return "";
  };
  const title = frameText("title") || meta("workTitle");
  const subtitle = frameText("subtitle") || meta("subtitle");
  const composer = frameText("composer") || meta("composer");
  const lyricist = frameText("lyricist") || frameText("poet") || meta("lyricist");
  if (title) el(el(root, "work"), "work-title", title);
  if (subtitle) el(root, "movement-title", subtitle);
  const ident = el(root, "identification");
  if (composer) el(ident, "creator", composer, { type: "composer" });
  if (lyricist) el(ident, "creator", lyricist, { type: "lyricist" });
  const rights = meta("copyright");
  if (rights) el(ident, "rights", rights);
  el(el(ident, "encoding"), "software", "scoredit (from MuseScore)");

  // ---- Parts and their staves.
  const parts: PartDef[] = kids(score, "Part").map((p, i) => {
    const inst = kid(p, "Instrument");
    const staves = kids(p, "Staff");
    const program = Number(kid(kid(inst ?? p, "Channel") ?? p, "program")?.getAttribute("value") ?? 0) || 0;
    const types = staves.map((s) => kid(s, "StaffType")?.getAttribute("group") ?? "pitched");
    const stringData = inst ? kid(inst, "StringData") : null;
    const strings = stringData ? kids(stringData, "string").map((s) => Number(s.textContent)) : [];
    return {
      id: `P${i + 1}`,
      staves,
      name: text(p, "trackName") || text(inst, "longName"),
      abbreviation: text(inst, "shortName"),
      program,
      drums: types.includes("percussion"),
      chromatic: Number(text(inst, "transposeChromatic")) || 0,
      diatonic: Number(text(inst, "transposeDiatonic")) || 0,
      tab: types.map((t) => t === "tablature"),
      strings,
    };
  });
  const list = el(root, "part-list");
  for (const p of parts) {
    const sp = el(list, "score-part", null, { id: p.id });
    el(sp, "part-name", p.name);
    if (p.abbreviation) el(sp, "part-abbreviation", p.abbreviation);
    el(el(sp, "score-instrument", null, { id: `${p.id}-I1` }), "instrument-name", p.name || "Instrument");
    const mi = el(sp, "midi-instrument", null, { id: `${p.id}-I1` });
    if (p.drums) el(mi, "midi-channel", 10);
    el(mi, "midi-program", p.program + 1);
  }

  // Staff contents in order: <Staff id> elements after the parts, matched to parts in order.
  const measuresOf = staffEls.map((s) => kids(s, "Measure"));
  let staffCursor = 0;
  const partStaves = parts.map((p) => {
    const ids = p.staves.map((_, k) => staffCursor + k);
    staffCursor += p.staves.length;
    return ids;
  });
  const nMeasures = Math.max(0, ...measuresOf.map((m) => m.length));

  // Time signature in force per measure (from the first staff), for measure lengths.
  const lengths: number[] = [];
  {
    let sig = 1; // whole notes
    for (let m = 0; m < nMeasures; m++) {
      const meas = measuresOf[0]?.[m];
      const ts = meas ? Array.from(meas.getElementsByTagName("TimeSig"))[0] : undefined;
      if (ts) sig = Number(text(ts, "sigN")) / (Number(text(ts, "sigD")) || 4);
      lengths.push(meas?.getAttribute("len") ? frac(meas.getAttribute("len")) : sig);
    }
  }

  // Octave lines: MuseScore keeps the pitch as drawn and shifts it when playing; MusicXML
  // (as MuseScore exports it) holds the sounding pitch under an <octave-shift>. Ranges per
  // staff: [start measure, pos, end measure, pos, semitones].
  const OTTAVA: Record<string, [number, string, number]> = { "8va": [12, "down", 8], "8vb": [-12, "up", 8], "15ma": [24, "down", 15], "15mb": [-24, "up", 15], "22ma": [36, "down", 22], "22mb": [-36, "up", 22] };
  const ottavas = new Map<number, [number, number, number, number, number][]>();
  const ottavaAt = (staff: number, m: number, pos: number) => {
    for (const [m0, p0, m1, p1, semis] of ottavas.get(staff) ?? []) {
      const after = m > m0 || (m === m0 && pos >= p0 - 1e-9);
      const before = m < m1 || (m === m1 && pos < p1 - 1e-9);
      if (after && before) return semis;
    }
    return 0;
  };

  // Volta ends found while reading, keyed by measure index: ending numbers and whether it closes.
  const voltaStart = new Map<number, string>();
  const voltaStop = new Map<number, string>();

  parts.forEach((p, pi) => {
    const part = el(root, "part", null, { id: p.id });
    const shift = p.chromatic;
    const oct = Math.trunc(shift / 12);
    let number = 0;
    for (let m = 0; m < nMeasures; m++) {
      const first = measuresOf[partStaves[pi][0]]?.[m];
      const irregular = !!first && !!kid(first, "irregular");
      if (!irregular) number++;
      const meas = el(part, "measure", null, irregular && m === 0 ? { number: 0, implicit: "yes" } : irregular ? { number: `${number}X`, implicit: "yes" } : { number });
      // Left barline: forward repeat, volta start (filled in after the staves are read).
      const leftBar = el(meas, "barline", null, { location: "left" });
      if (first && kid(first, "startRepeat")) el(leftBar, "repeat", null, { direction: "forward" });
      const attrs = el(meas, "attributes");
      if (m === 0) {
        el(attrs, "divisions", DIV);
        if (p.staves.length > 1) el(attrs, "staves", p.staves.length);
        if (shift) {
          const tr = el(attrs, "transpose");
          el(tr, "diatonic", p.diatonic - 7 * oct);
          el(tr, "chromatic", shift - 12 * oct);
          if (oct) el(tr, "octave-change", oct);
        }
        p.staves.forEach((s, k) => {
          const def = text(s, "defaultClef");
          if (p.tab[k]) {
            const sd = el(attrs, "staff-details", null, p.staves.length > 1 ? { number: k + 1 } : undefined);
            el(sd, "staff-lines", p.strings.length || 6);
          } else if (def && m === 0 && !measuresOf[partStaves[pi][k]]?.[0]?.getElementsByTagName("Clef").length) {
            addClef(attrs, def, k + 1, p.staves.length > 1);
          }
        });
      }
      const len = lengths[m];
      // Each staff, each voice, in turn; <backup> between them.
      let emitted = 0; // whole notes from the measure start, where the output stream is
      const goTo = (pos: number) => {
        const d = Math.round((pos - emitted) * 4 * DIV);
        if (d > 0) el(el(meas, "forward"), "duration", d);
        else if (d < 0) el(el(meas, "backup"), "duration", -d);
        emitted = pos;
      };
      partStaves[pi].forEach((staffIdx, k) => {
        const smeas = measuresOf[staffIdx]?.[m];
        if (!smeas) return;
        kids(smeas, "voice").forEach((voice, v) => {
          let pos = 0;
          const tuplets: number[] = [];
          const tupletInfo: { actual: number; normal: number; base: string }[] = [];
          for (const c of kids(voice)) {
            switch (c.tagName) {
              case "location": {
                pos += frac(text(c, "fractions"));
                break;
              }
              case "TimeSig": {
                if (k === 0) {
                  goTo(pos);
                  const at = pos === 0 && m === 0 ? attrs : el(meas, "attributes");
                  const t = el(at, "time");
                  el(t, "beats", text(c, "sigN"));
                  el(t, "beat-type", text(c, "sigD"));
                }
                break;
              }
              case "KeySig": {
                if (k === 0) {
                  goTo(pos);
                  const at = pos === 0 && m === 0 ? attrs : el(meas, "attributes");
                  const fifths = Number(text(c, "concertKey") || text(c, "accidental") || text(c, "key")) || 0;
                  // The written key of a transposing part moves with it.
                  const written = shift ? fifths - (7 * shift - 12 * p.diatonic) : fifths;
                  const key = el(at, "key");
                  el(key, "fifths", written);
                }
                break;
              }
              case "Clef": {
                goTo(pos);
                const at = pos === 0 && m === 0 ? attrs : el(meas, "attributes");
                addClef(at, text(c, "concertClefType") || text(c, "transposingClefType") || "G", k + 1, p.staves.length > 1);
                break;
              }
              case "Tuplet": {
                const actual = Number(text(c, "actualNotes")) || 3;
                const normal = Number(text(c, "normalNotes")) || 2;
                tuplets.push(normal / actual);
                tupletInfo.push({ actual, normal, base: text(c, "baseNote") });
                break;
              }
              case "endTuplet": {
                tuplets.pop();
                tupletInfo.pop();
                break;
              }
              case "Dynamic": {
                goTo(pos);
                const sub = text(c, "subtype");
                if (text(c, "visible") === "0") {
                  const vel = Number(text(c, "velocity"));
                  if (vel > 0) el(meas, "sound", null, { dynamics: Math.round((vel / 90) * 100) });
                  break;
                }
                const dir = el(meas, "direction", null, { placement: "below" });
                const dt = el(dir, "direction-type");
                if (/^[pmfsrzn]+$/.test(sub)) el(el(dt, "dynamics"), sub);
                else el(dt, "words", plain(kid(c, "text")) || sub);
                const vel = Number(text(c, "velocity"));
                if (vel > 0) el(dir, "sound", null, { dynamics: Math.round((vel / 90) * 100) });
                if (p.staves.length > 1) el(dir, "staff", k + 1);
                break;
              }
              case "Tempo": {
                goTo(pos);
                const qps = Number(text(c, "tempo"));
                const bpm = Math.round(qps * 60 * 100) / 100;
                // An invisible tempo mark (a written-out ritardando) sounds but is not printed.
                if (text(c, "visible") === "0") {
                  if (qps > 0) el(meas, "sound", null, { tempo: bpm });
                  break;
                }
                const dir = el(meas, "direction", null, { placement: "above" });
                el(el(dir, "direction-type"), "words", plain(kid(c, "text")) || " ");
                if (qps > 0) el(dir, "sound", null, { tempo: bpm });
                break;
              }
              case "StaffText":
              case "SystemText":
              case "Expression":
              case "RehearsalMark": {
                const words = plain(kid(c, "text"));
                if (!words) break;
                goTo(pos);
                const dir = el(meas, "direction", null, { placement: c.tagName === "Expression" ? "below" : "above" });
                el(el(dir, "direction-type"), c.tagName === "RehearsalMark" ? "rehearsal" : "words", words);
                if (p.staves.length > 1) el(dir, "staff", k + 1);
                break;
              }
              case "Spanner": {
                const type = c.getAttribute("type");
                const starts = !!kid(c, "next");
                if (type === "HairPin") {
                  goTo(pos);
                  const dir = el(meas, "direction", null, { placement: "below" });
                  const hp = kid(c, "HairPin");
                  const sub = Number(text(hp, "subtype"));
                  el(el(dir, "direction-type"), "wedge", null, { type: starts ? (sub === 1 || sub === 3 ? "diminuendo" : "crescendo") : "stop" });
                  if (p.staves.length > 1) el(dir, "staff", k + 1);
                } else if (type === "Ottava") {
                  const list = ottavas.get(staffIdx) ?? [];
                  ottavas.set(staffIdx, list);
                  goTo(pos);
                  const dir = el(meas, "direction", null, { placement: "above" });
                  const dt = el(dir, "direction-type");
                  if (starts) {
                    const [semis, shiftType, size] = OTTAVA[text(kid(c, "Ottava"), "subtype")] ?? OTTAVA["8va"];
                    list.push([m, pos, Infinity, 0, semis]);
                    el(dt, "octave-shift", null, { type: shiftType, size });
                  } else {
                    const open = [...list].reverse().find((r) => r[2] === Infinity);
                    if (open) {
                      open[2] = m;
                      open[3] = pos;
                    }
                    el(dt, "octave-shift", null, { type: "stop", size: open ? (Math.abs(open[4]) / 12) * 7 + 1 : 8 });
                  }
                  if (p.staves.length > 1) el(dir, "staff", k + 1);
                } else if (type === "Volta" && pi === 0 && k === 0) {
                  const vt = kid(c, "Volta");
                  if (starts) voltaStart.set(m, text(vt, "endings") || "1");
                  else {
                    const at = pos <= 0 && m > 0 ? m - 1 : m;
                    const startM = [...voltaStart.keys()].filter((x) => x <= at).pop();
                    voltaStop.set(at, startM !== undefined ? voltaStart.get(startM)! : "1");
                  }
                }
                break;
              }
              case "Rest":
              case "Chord": {
                const dt = text(c, "durationType");
                const graceTag = ["acciaccatura", "appoggiatura", "grace4", "grace8after", "grace16", "grace16after", "grace32", "grace32after"].find((g) => kid(c, g));
                const ratio = tuplets.reduce((a, b) => a * b, 1);
                const dots = Number(text(c, "dots")) || 0;
                let whole: number;
                const override = text(c, "duration");
                if (dt === "measure") whole = override ? frac(override) : len;
                else if (override && c.tagName === "Chord") whole = frac(override);
                else whole = ((DURATION[dt] ?? 1) / 4) * (2 - 2 ** -dots) * ratio;
                if (graceTag) whole = 0;
                goTo(pos);
                const notes = c.tagName === "Chord" ? kids(c, "Note") : [null];
                notes.forEach((n, ni) => {
                  const note = el(meas, "note");
                  if (graceTag) el(note, "grace", null, graceTag === "acciaccatura" ? { slash: "yes" } : undefined);
                  if (ni > 0) el(note, "chord");
                  if (!n) {
                    el(note, "rest", null, dt === "measure" ? { measure: "yes" } : undefined);
                  } else {
                    const sounding = Number(text(n, "pitch"));
                    const tpc = Number(text(n, "tpc"));
                    const tpc2 = text(n, "tpc2");
                    const writtenTpc = shift ? (tpc2 ? Number(tpc2) : tpc - (7 * shift - 12 * p.diatonic)) : tpc;
                    const sp = spell(writtenTpc, sounding - shift + ottavaAt(staffIdx, m, pos));
                    const pitch = el(note, "pitch");
                    el(pitch, "step", sp.step);
                    if (sp.alter) el(pitch, "alter", sp.alter);
                    el(pitch, "octave", sp.octave);
                  }
                  if (!graceTag) el(note, "duration", Math.max(1, Math.round(whole * 4 * DIV)));
                  const ties = n ? kids(n, "Spanner").filter((s) => s.getAttribute("type") === "Tie") : [];
                  const tieStart = ties.some((s) => kid(s, "next"));
                  const tieStop = ties.some((s) => kid(s, "prev"));
                  if (tieStop) el(note, "tie", null, { type: "stop" });
                  if (tieStart) el(note, "tie", null, { type: "start" });
                  el(note, "voice", k * 4 + v + 1);
                  if (dt !== "measure" && TYPE_NAME[dt]) el(note, "type", TYPE_NAME[dt]);
                  for (let d = 0; d < dots; d++) el(note, "dot");
                  const acc = n ? kid(n, "Accidental") : null;
                  if (acc && ACCIDENTAL[text(acc, "subtype")]) el(note, "accidental", ACCIDENTAL[text(acc, "subtype")]);
                  if (tupletInfo.length && !graceTag) {
                    const ti = tupletInfo[tupletInfo.length - 1];
                    const tm = el(note, "time-modification");
                    el(tm, "actual-notes", ti.actual);
                    el(tm, "normal-notes", ti.normal);
                  }
                  const stem = text(c, "StemDirection");
                  if (stem === "up" || stem === "down") el(note, "stem", stem);
                  if (p.staves.length > 1) el(note, "staff", k + 1);
                  // Notations: ties, slurs, articulations, ornaments, fermata, tab string/fret.
                  const nots: Element[] = [];
                  const notations = () => (nots[0] ??= el(note, "notations"));
                  if (tieStop) el(notations(), "tied", null, { type: "stop" });
                  if (tieStart) el(notations(), "tied", null, { type: "start" });
                  if (ni === 0) {
                    for (const s of kids(c, "Spanner").filter((x) => x.getAttribute("type") === "Slur")) {
                      el(notations(), "slur", null, { type: kid(s, "next") ? "start" : "stop", number: 1 });
                    }
                    const arts = kids(c, "Articulation").map((a) => ARTIC[text(a, "subtype")]).filter(Boolean);
                    if (arts.length) {
                      const a = el(notations(), "articulations");
                      for (const x of arts) el(a, x);
                    }
                    const orns = [...kids(c, "Ornament"), ...kids(c, "Articulation")].map((a) => ORNAMENT[text(a, "subtype")]).filter(Boolean);
                    if (orns.length) {
                      const o = el(notations(), "ornaments");
                      for (const x of orns) el(o, x);
                    }
                    if (pendingFermata) {
                      el(notations(), "fermata", null, { type: "upright" });
                      pendingFermata = false;
                    }
                    if (kid(c, "Arpeggio")) el(notations(), "arpeggiate");
                  }
                  if (n && p.tab[k]) {
                    const fret = text(n, "fret");
                    const str = text(n, "string");
                    if (fret !== "" && str !== "") {
                      const tech = el(notations(), "technical");
                      el(tech, "string", Number(str) + 1);
                      el(tech, "fret", fret);
                    }
                  }
                  if (ni === 0) {
                    for (const ly of kids(c, "Lyrics")) {
                      const lyric = el(note, "lyric", null, { number: (Number(text(ly, "no")) || 0) + 1 });
                      el(lyric, "syllabic", text(ly, "syllabic") || "single");
                      el(lyric, "text", plain(kid(ly, "text")));
                    }
                  }
                });
                emitted = pos + whole;
                pos += whole;
                break;
              }
              case "Fermata": {
                pendingFermata = true;
                break;
              }
            }
          }
          goTo(0);
        });
      });
      // Right barline: end repeat, final or double bar from the first staff.
      const rightBar = el(meas, "barline", null, { location: "right" });
      const endRep = first ? kid(first, "endRepeat") : null;
      const bl = first ? Array.from(first.getElementsByTagName("BarLine")).pop() : undefined;
      const style = text(bl, "subtype");
      if (style === "double") el(rightBar, "bar-style", "light-light");
      else if (style === "end" || endRep) el(rightBar, "bar-style", "light-heavy");
      if (endRep) el(rightBar, "repeat", null, { direction: "backward", ...(Number(endRep.textContent) > 2 ? { times: Number(endRep.textContent) } : {}) });
      // Jumps and markers, as playback sounds.
      if (first) {
        for (const mk of kids(first, "Marker")) {
          const label = text(mk, "label") || text(mk, "subtype");
          const sub = (text(mk, "subtype") || label).toLowerCase();
          const dir = el(meas, "direction", null, { placement: "above" });
          el(el(dir, "direction-type"), "words", plain(kid(mk, "text")) || label);
          if (sub === "fine") el(dir, "sound", null, { fine: "yes" });
          else if (sub.startsWith("segno")) el(dir, "sound", null, { segno: label });
          else if (sub === "tocoda" || sub === "tocodasym") el(dir, "sound", null, { tocoda: label });
          else if (sub.startsWith("coda") || sub === "varcoda") el(dir, "sound", null, { coda: label });
        }
        for (const j of kids(first, "Jump")) {
          const to = text(j, "jumpTo");
          const dir = el(meas, "direction", null, { placement: "above" });
          el(el(dir, "direction-type"), "words", plain(kid(j, "text")) || (to === "start" ? "D.C." : "D.S."));
          if (to === "start") el(dir, "sound", null, { dacapo: "yes" });
          else el(dir, "sound", null, { dalsegno: to });
        }
      }
      // Drop empty helpers so OSMD and the timeline see only what is there.
      if (!attrs.firstChild) attrs.remove();
      if (!leftBar.firstChild) leftBar.remove();
      if (!rightBar.firstChild) rightBar.remove();
    }
  });

  // MusicXML wants the children of <attributes> in schema order.
  for (const at of Array.from(root.getElementsByTagName("attributes"))) {
    const sorted = kids(at).sort((a, b) => ATTR_ORDER.indexOf(a.tagName) - ATTR_ORDER.indexOf(b.tagName));
    for (const c of sorted) at.appendChild(c);
  }

  // Volta brackets on the barlines, in every part.
  for (const part of kids(root, "part")) {
    const meas = kids(part, "measure");
    for (const [m, nums] of voltaStart) addEnding(meas[m], "left", "start", nums);
    for (const [m, nums] of voltaStop) addEnding(meas[m], "right", meas[m] && hasBackward(meas[m]) ? "stop" : "discontinue", nums);
  }
  // Section breaks (between movements) end a section; the next measure starts one.
  const sections = [0];
  (measuresOf[0] ?? []).forEach((m, i) => {
    if (kids(m, "LayoutBreak").some((b) => text(b, "subtype") === "section") && i + 1 < nMeasures) sections.push(i + 1);
  });
  return { doc: out, sections };

  function addClef(at: Element, name: string, number: number, numbered: boolean): void {
    const [sign, line, octave] = CLEF[name] ?? CLEF.G;
    const clef = el(at, "clef", null, numbered ? { number } : undefined);
    el(clef, "sign", sign);
    el(clef, "line", line);
    if (octave) el(clef, "clef-octave-change", octave);
  }
  function addEnding(measure: Element | undefined, location: string, type: string, nums: string): void {
    if (!measure) return;
    let bar = kids(measure, "barline").find((b) => b.getAttribute("location") === location);
    if (!bar) {
      bar = out.createElementNS(null, "barline");
      bar.setAttribute("location", location);
      if (location === "left") measure.insertBefore(bar, measure.firstChild);
      else measure.appendChild(bar);
    }
    const e = out.createElementNS(null, "ending");
    e.setAttribute("number", nums.replace(/\s+/g, ""));
    e.setAttribute("type", type);
    // <ending> goes after bar-style and before repeat.
    bar.insertBefore(e, kid(bar, "repeat"));
  }
  function hasBackward(measure: Element): boolean {
    return kids(measure, "barline").some((b) => kid(b, "repeat")?.getAttribute("direction") === "backward");
  }
}

