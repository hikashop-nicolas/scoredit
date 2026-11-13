// Reads a PDF made by notation software (MuseScore and other SMuFL engravers, and the font
// families normalize.ts maps) into a MusicXML score-partwise document. Read-only.
import { parseXml } from "../../model/xml";
import { extractPdf } from "./extract";
import { normalizePage, type TextRun } from "./normalize";
import { length, readPage, type Clef, type PAttr, type PEvent, type PMeasure, type PSystem } from "./notation";

const DIV = 10080;
const STEPS = ["C", "D", "E", "F", "G", "A", "B"];
const SHARP_ORDER = [3, 0, 4, 1, 5, 2, 6];
const TYPES: [number, string][] = [
  [16, "long"],
  [8, "breve"],
  [4, "whole"],
  [2, "half"],
  [1, "quarter"],
  [0.5, "eighth"],
  [0.25, "16th"],
  [0.125, "32nd"],
  [0.0625, "64th"],
  [0.03125, "128th"],
];
const ACC_NAMES: Record<number, string> = { [-3]: "triple-flat", [-2]: "flat-flat", [-1]: "flat", 0: "natural", 1: "sharp", 2: "double-sharp", 3: "triple-sharp" };
const DYN = new Set("p pp ppp pppp ppppp pppppp f ff fff ffff fffff ffffff mp mf sf sfp sfpp fp rf rfz sfz sffz fz n pf sfzp".split(" "));
const TREBLE: Clef = { sign: "G", line: 2, octave: 0, top: 38 };

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Reads a score PDF into MusicXML. Throws when no music is found (a scan, or not a score). */
export async function readPdfScore(bytes: Uint8Array): Promise<Document> {
  const pdf = await extractPdf(bytes);
  const pages = pdf.pages.map((p) => normalizePage(p, pdf.fonts));
  const read = pages.map((p) => readPage(p));
  const systems = read.flatMap((r) => r.systems).filter((s) => s.measures.length);
  if (!systems.length) {
    const scanned = pages.some((p) => p.images > 0) && pages.every((p) => p.symbols.length === 0);
    const unknown = [...new Set(pages.flatMap((p) => p.unknownFonts))];
    throw new Error(scanned ? "This PDF holds scanned pages, not engraved music" : unknown.length ? `This PDF uses music fonts scoredit cannot read yet: ${unknown.join(", ")}` : "No music found in this PDF");
  }
  return parseXml(writeScore(systems, read[0]?.header ?? [], pages[0]?.width ?? 595, pdf.info.title));
}

interface Part {
  name: string;
  staves: number;
  first: number;
}

function partsOf(sys: PSystem): Part[] {
  const parts: Part[] = [];
  for (let k = 0; k < sys.staves.length; ) {
    const g = sys.groups.find(([a]) => a === k);
    const n = g ? g[1] - g[0] + 1 : 1;
    parts.push({ name: sys.names[k] ?? "", staves: n, first: k });
    k += n;
  }
  return parts;
}

/** Title, subtitle, composer and lyricist from the text above the first system. */
function credits(header: TextRun[], width: number) {
  const lines: { str: string; x: number; x1: number; y: number; size: number }[] = [];
  for (const t of [...header].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const x1 = t.words.length ? t.words[t.words.length - 1].x1 : t.x + t.size * 0.5 * t.str.length;
    const l = lines.find((q) => Math.abs(q.y - t.y) < 1 && Math.abs(q.size - t.size) < 1 && t.x - q.x1 < t.size * 2);
    if (l) {
      l.str += " " + t.str;
      l.x1 = x1;
    } else lines.push({ str: t.str, x: t.x, x1, y: t.y, size: t.size });
  }
  const big = [...lines].sort((a, b) => b.size - a.size)[0];
  const right = lines.filter((l) => l !== big && l.x > width * 0.55 && l.x1 > width * 0.75);
  const left = lines.filter((l) => l !== big && l.x1 < width * 0.45);
  return { title: big?.str, composer: right.map((l) => l.str).join(" "), lyricist: left.map((l) => l.str).join(" ") };
}

function writeScore(systems: PSystem[], header: TextRun[], width: number, docTitle?: string): string {
  const parts = partsOf(systems[0]);
  const total = systems[0].staves.length;
  const cred = credits(header, width);
  const out: string[] = [`<?xml version="1.0" encoding="UTF-8"?>`, `<score-partwise version="4.0">`];
  const title = cred.title || docTitle;
  if (title) out.push(`<work><work-title>${esc(title)}</work-title></work>`);
  if (cred.composer || cred.lyricist) {
    out.push("<identification>");
    if (cred.composer) out.push(`<creator type="composer">${esc(cred.composer)}</creator>`);
    if (cred.lyricist) out.push(`<creator type="lyricist">${esc(cred.lyricist)}</creator>`);
    out.push("</identification>");
  }
  out.push("<part-list>");
  parts.forEach((p, i) => out.push(`<score-part id="P${i + 1}"><part-name>${esc(p.name)}</part-name></score-part>`));
  out.push("</part-list>");

  // Every measure of every system, with where each staff of the score is in it.
  const measures: { m: PMeasure; sys: PSystem; staffMap: (number | null)[] }[] = [];
  for (const sys of systems) {
    const map = sys.staves.length === total ? sys.staves.map((_, k) => k) : matchStaves(systems[0], sys);
    for (const m of sys.measures) measures.push({ m, sys, staffMap: map });
  }
  // Time first: measure lengths need the time signature, voices their onsets.
  let time = { beats: 4, type: 4 } as NonNullable<PAttr["time"]>;
  const times: (typeof time)[] = [];
  for (const { m, sys, staffMap } of measures) {
    const t = staffMap.flatMap((k) => (k === null ? [] : m.attrs[k])).find((a) => a.time && leading(a, m, staffMap))?.time;
    if (t) time = t;
    times.push(time);
    timeMeasure(m, (time.beats * 4) / time.type, sys.staves[0].space);
  }

  parts.forEach((part, pi) => {
    out.push(`<part id="P${pi + 1}">`);
    const clefs: Clef[] = Array.from({ length: part.staves }, () => TREBLE);
    let fifths: number | null = null;
    let lastTime: (typeof time) | null = null;
    measures.forEach(({ m, staffMap }, mi) => {
      const ks = Array.from({ length: part.staves }, (_, k) => staffMap.indexOf(part.first + k));
      out.push(`<measure number="${mi + 1}">`);
      if (m.leftRepeat) out.push(`<barline location="left"><bar-style>heavy-light</bar-style><repeat direction="forward"/></barline>`);
      const lead = ks.map((k) => (k < 0 ? [] : m.attrs[k].filter((a) => leading(a, m, staffMap))));
      const attrs: string[] = [];
      if (mi === 0) attrs.push(`<divisions>${DIV}</divisions>`);
      const key = lead.flat().find((a) => a.key !== undefined)?.key ?? (mi === 0 ? 0 : null);
      if (key !== null && key !== fifths) {
        attrs.push(`<key><fifths>${key}</fifths></key>`);
        fifths = key;
      }
      const t = times[mi];
      if (!lastTime || t.beats !== lastTime.beats || t.type !== lastTime.type) {
        attrs.push(`<time${t.symbol ? ` symbol="${t.symbol}"` : ""}><beats>${t.beats}</beats><beat-type>${t.type}</beat-type></time>`);
        lastTime = t;
      }
      if (mi === 0 && part.staves > 1) attrs.push(`<staves>${part.staves}</staves>`);
      lead.forEach((as, k) => {
        const c = as.filter((a) => a.clef).pop()?.clef;
        if (mi === 0 || (c && !sameClef(c, clefs[k]))) {
          clefs[k] = c ?? clefs[k];
          attrs.push(clefXml(clefs[k], part.staves > 1 ? k + 1 : 0));
        }
      });
      if (attrs.length) out.push(`<attributes>${attrs.join("")}</attributes>`);

      const mlen = (t.beats * 4) / t.type;
      let pos = 0;
      ks.forEach((k, sk) => {
        if (k < 0) return;
        const staffNo = part.staves > 1 ? sk + 1 : 0;
        const evs = m.events[k];
        const mid = m.attrs[k].filter((a) => a.clef && !leading(a, m, staffMap)).sort((a, b) => a.x - b.x);
        const dirs = m.dirs.filter((d) => d.staff === k);
        const voices = [...new Set(evs.map((e) => e.voice))].sort((a, b) => a - b);
        if (!voices.length) voices.push(1);
        // Pitches: the clef and accidentals in force at each chord, left to right.
        const alters = new Map<number, number>();
        let clef = clefs[sk];
        const byX = [...evs].sort((a, b) => a.x - b.x);
        let ci = 0;
        for (const e of byX) {
          while (ci < mid.length && mid[ci].x < e.x) clef = mid[ci++].clef!;
          e.notes = e.heads.map((h) => {
            const d = clef.top - h.pos;
            let alter = 0;
            if (h.acc !== undefined && !e.grace) alters.set(d, h.acc);
            if (h.acc !== undefined) alter = h.acc;
            else if (alters.has(d)) alter = alters.get(d)!;
            else alter = keyAlter(fifths ?? 0, ((d % 7) + 7) % 7);
            return { step: STEPS[((d % 7) + 7) % 7], octave: Math.floor(d / 7), alter, shown: h.acc, pos: h.pos };
          });
        }
        while (ci < mid.length) clef = mid[ci++].clef!;
        voices.forEach((v) => {
          if (pos > 0) out.push(`<backup><duration>${Math.round(pos * DIV)}</duration></backup>`);
          pos = 0;
          let midClef = 0;
          const pending = v === voices[0] ? [...dirs] : [];
          const line = evs.filter((e) => e.voice === v).sort((a, b) => a.x - b.x);
          line.forEach((e, i) => {
            if (v === voices[0])
              while (midClef < mid.length && mid[midClef].x < e.x) out.push(`<attributes>${clefXml(mid[midClef++].clef!, staffNo)}</attributes>`);
            while (pending.length && pending[0].x < e.x1) out.push(directionXml(pending.shift()!, staffNo));
            if (!e.grace && e.onset > pos + 1e-6) {
              out.push(`<forward><duration>${Math.round((e.onset - pos) * DIV)}</duration><voice>${voiceNo(v, sk)}</voice>${staffNo ? `<staff>${staffNo}</staff>` : ""}</forward>`);
              pos = e.onset;
            }
            const dur = e.grace ? 0 : e.measureRest ? mlen : length(e);
            out.push(noteXml(e, dur, voiceNo(v, sk), staffNo, tupletEdge(line, i)));
            pos += dur;
          });
          for (const d of pending) out.push(directionXml(d, staffNo));
          if (v === voices[0]) while (midClef < mid.length) out.push(`<attributes>${clefXml(mid[midClef++].clef!, staffNo)}</attributes>`);
        });
        clefs[sk] = clef;
      });
      if (m.right && (m.right.repeat || m.right.kinds.length > 1)) {
        const style = m.right.kinds.join("-").replace(/thin/g, "light").replace(/thick/g, "heavy");
        out.push(`<barline location="right"><bar-style>${style === "light-light" || style === "light-heavy" || style === "heavy-light" || style === "heavy-heavy" ? style : "light-heavy"}</bar-style>${m.right.repeat ? `<repeat direction="backward"/>` : ""}</barline>`);
      }
      out.push("</measure>");
    });
    out.push("</part>");
  });
  out.push("</score-partwise>");
  return out.join("\n");
}

const voiceNo = (v: number, staff: number) => staff * 4 + v;

function keyAlter(fifths: number, letter: number): number {
  if (fifths > 0) return SHARP_ORDER.slice(0, fifths).includes(letter) ? 1 : 0;
  if (fifths < 0) return [...SHARP_ORDER].reverse().slice(0, -fifths).includes(letter) ? -1 : 0;
  return 0;
}

const sameClef = (a: Clef, b: Clef) => a.sign === b.sign && a.line === b.line && a.octave === b.octave;

function clefXml(c: Clef, staff: number): string {
  return `<clef${staff ? ` number="${staff}"` : ""}><sign>${c.sign}</sign>${c.sign === "percussion" ? "" : `<line>${c.line}</line>`}${c.octave ? `<clef-octave-change>${c.octave}</clef-octave-change>` : ""}</clef>`;
}

/** An attribute stands before the measure's first chord or rest (on its staff). */
function leading(a: PAttr, m: PMeasure, staffMap: (number | null)[]): boolean {
  const k = staffMap.find((s) => s !== null && m.attrs[s].includes(a));
  const evs = k === undefined || k === null ? [] : m.events[k].filter((e) => !e.grace);
  return !evs.length || a.x < Math.min(...evs.map((e) => e.x));
}

/** Staves of a system with fewer staves than the first (empty ones hidden): matched by name, else from the top. */
function matchStaves(first: PSystem, sys: PSystem): (number | null)[] {
  const out: (number | null)[] = sys.staves.map((_, k) => (k < first.staves.length ? k : null));
  return out;
}

/** Onsets: voices one after the other; a voice starting late lines up with the column it stands in. */
function timeMeasure(m: PMeasure, mlen: number, space: number): void {
  const cols: { x: number; at: number }[] = [];
  for (const pass of [1, 2]) {
    m.events.forEach((evs) => {
      const voices = [...new Set(evs.map((e) => e.voice))];
      for (const v of voices) {
        if ((pass === 1) !== (v === Math.min(...voices))) continue;
        let pos = 0;
        const line = evs.filter((e) => e.voice === v && !e.grace).sort((a, b) => a.x - b.x);
        for (const e of line) {
          e.measureRest = e.rest && e.base === 4 && line.length === 1 && e.dots === 0;
          if (pass === 2) {
            const c = cols.find((q) => Math.abs(q.x - e.x) < space * 0.6 && q.at >= pos - 1e-6);
            if (c) pos = c.at;
          }
          e.onset = pos;
          if (pass === 1) cols.push({ x: e.x, at: pos });
          pos += e.measureRest ? mlen : length(e);
        }
      }
    });
  }
  for (const evs of m.events)
    for (const e of evs) if (e.grace) e.onset = evs.find((n) => !n.grace && n.voice === e.voice && n.x > e.x)?.onset ?? 0;
}

/** Whether a chord starts or ends its tuplet group. */
function tupletEdge(line: PEvent[], i: number): "start" | "stop" | "both" | null {
  const e = line[i];
  if (!e.tuplet) return null;
  const startHere = line[i - 1]?.tuplet !== e.tuplet;
  const stopHere = line[i + 1]?.tuplet !== e.tuplet;
  return startHere && stopHere ? "both" : startHere ? "start" : stopHere ? "stop" : null;
}

function typeOf(base: number): string {
  return TYPES.find(([q]) => Math.abs(q - base) < 1e-6)?.[1] ?? "quarter";
}

function noteXml(e: PEvent, dur: number, voice: number, staff: number, tup: ReturnType<typeof tupletEdge>): string {
  const common = (chord: boolean, inner: string, extra: string, lyric: string) => {
    const s: string[] = ["<note>"];
    if (e.grace) s.push("<grace/>");
    if (chord) s.push("<chord/>");
    s.push(inner);
    if (!e.grace) s.push(`<duration>${Math.round(dur * DIV)}</duration>`);
    s.push(`<voice>${voice}</voice>`);
    if (!e.measureRest) s.push(`<type>${typeOf(e.base)}</type>`);
    for (let d = 0; d < e.dots; d++) s.push("<dot/>");
    s.push(extra);
    if (e.tuplet) s.push(`<time-modification><actual-notes>${e.tuplet.actual}</actual-notes><normal-notes>${e.tuplet.normal}</normal-notes></time-modification>`);
    if (!e.rest && e.up !== undefined) s.push(`<stem>${e.up ? "up" : "down"}</stem>`);
    if (staff) s.push(`<staff>${staff}</staff>`);
    if (!chord && tup) s.push(`<notations>${tup === "start" || tup === "both" ? `<tuplet type="start"/>` : ""}${tup === "stop" || tup === "both" ? `<tuplet type="stop"/>` : ""}</notations>`);
    s.push(lyric);
    s.push("</note>");
    return s.join("");
  };
  const lyrics = e.lyrics.map((l) => `<lyric number="${l.verse}"><syllabic>${l.syllabic}</syllabic><text>${esc(l.text)}</text></lyric>`).join("");
  if (e.rest) return common(false, e.measureRest ? `<rest measure="yes"/>` : "<rest/>", "", "");
  return e.notes
    .map((n, i) => {
      const pitch = `<pitch><step>${n.step}</step>${n.alter ? `<alter>${n.alter}</alter>` : ""}<octave>${n.octave}</octave></pitch>`;
      const acc = n.shown !== undefined ? `<accidental>${ACC_NAMES[n.shown] ?? "natural"}</accidental>` : "";
      return common(i > 0, pitch, acc, i === 0 ? lyrics : "");
    })
    .join("");
}

function directionXml(d: PMeasure["dirs"][number], staff: number): string {
  const inner = d.dynamics ? `<dynamics>${DYN.has(d.dynamics) ? `<${d.dynamics}/>` : `<other-dynamics>${esc(d.dynamics)}</other-dynamics>`}</dynamics>` : `<words>${esc(d.words ?? "")}</words>`;
  return `<direction placement="${d.above ? "above" : "below"}"><direction-type>${inner}</direction-type>${staff ? `<staff>${staff}</staff>` : ""}</direction>`;
}
