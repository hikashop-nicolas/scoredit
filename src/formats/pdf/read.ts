// Reads a PDF made by notation software (MuseScore and other SMuFL engravers, and the font
// families normalize.ts maps) into a MusicXML score-partwise document. Read-only.
import { parseXml } from "../../model/xml";
import { readEmbeddedScore } from "./embed";
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

/**
 * Reads a score PDF into MusicXML: the MusicXML file attached to it as it is, else what its
 * pages draw. Throws when no music is found (a scan, or not a score).
 */
export async function readPdfScore(bytes: Uint8Array): Promise<Document> {
  const embedded = await readEmbeddedScore(bytes);
  if (embedded) return embedded;
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

/** Title, subtitle, composer and lyricist from the text above the first system. */
function credits(header: TextRun[], width: number) {
  const lines: { str: string; x: number; x1: number; y: number; size: number }[] = [];
  for (const t of [...header].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const x1 = t.words.length ? t.words[t.words.length - 1].x1 : t.x + t.size * 0.5 * t.str.length;
    const l = lines.find((q) => Math.abs(q.y - t.y) < 1 && Math.abs(q.size - t.size) < 1 && t.x > q.x1 - 1 && t.x - q.x1 < t.size * 2);
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
  // The staves are those of the fullest system; others may hide empty ones.
  const full = systems.reduce((a, b) => (b.staves.length > a.staves.length ? b : a));
  const total = full.staves.length;
  // Staves with lyrics in any full system (a voice), to tell it from an instrument.
  const lyrics = (s: PSystem, k: number) => s.measures.reduce((n, m) => n + m.events[k].filter((e) => e.lyrics.length).length, 0) >= 3;
  const fulls = systems.filter((s) => s.staves.length === total);
  const sung = full.staves.map((_, k) => fulls.filter((s) => lyrics(s, k)).length > fulls.length * 0.3);
  // How often each clef starts each staff of the full systems.
  const clefShare = full.staves.map((_, k) => (sign: string) => fulls.filter((s) => clefSign(s, k) === sign).length / fulls.length);
  const maps = systems.map((sys) => alignStaves(sys, full, (i, j) => 2 * clefShare[j](clefSign(sys, i)) + (lyrics(sys, i) === sung[j] ? 1.5 : 0)));
  // Instruments (brace or named groups) as any system shows them.
  const groups: [number, number][] = [];
  systems.forEach((sys, i) => {
    for (const [a, b] of sys.groups) {
      const ga = maps[i].indexOf(a);
      const gb = maps[i].indexOf(b);
      if (ga >= 0 && gb - ga === b - a && !groups.some(([x, y]) => ga <= y && gb >= x)) groups.push([ga, gb]);
    }
  });
  const parts: Part[] = [];
  for (let k = 0; k < total; ) {
    const g = groups.find(([a]) => a === k);
    const n = g ? g[1] - g[0] + 1 : 1;
    parts.push({ name: "", staves: n, first: k });
    k += n;
  }
  // Names as the first system that shows the part has them.
  parts.forEach((p) => {
    for (let i = 0; i < systems.length; i++) {
      const k = maps[i][p.first];
      if (k >= 0 && systems[i].names[k]) {
        p.name = systems[i].names[k];
        break;
      }
    }
  });
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
  const measures: { m: PMeasure; sys: PSystem; staffMap: number[] }[] = [];
  systems.forEach((sys, i) => {
    for (const m of sys.measures) measures.push({ m, sys, staffMap: maps[i] });
  });
  // Time first: measure lengths need the time signature, voices their onsets.
  let time = { beats: 4, type: 4 } as NonNullable<PAttr["time"]>;
  const times: (typeof time)[] = [];
  for (const { m, sys, staffMap } of measures) {
    const t = staffMap.flatMap((k) => (k < 0 ? [] : m.attrs[k])).find((a) => a.time && leading(a, m))?.time;
    if (t) time = t;
    times.push(time);
    timeMeasure(m, (time.beats * 4) / time.type, sys.staves[0].space);
  }

  parts.forEach((part, pi) => {
    out.push(`<part id="P${pi + 1}">`);
    const lines = Array.from({ length: part.staves }, (_, k) => full.staves[part.first + k].lines);
    const clefs: Clef[] = lines.map((n) => (n === 5 ? TREBLE : TAB));
    // Alterations carried by ties, per staff and diatonic step.
    const tied = lines.map(() => new Map<number, number>());
    let fifths: number | null = null;
    let lastTime: (typeof time) | null = null;
    measures.forEach(({ m, staffMap }, mi) => {
      const ks = Array.from({ length: part.staves }, (_, k) => staffMap[part.first + k]);
      out.push(`<measure number="${mi + 1}">`);
      if (m.leftRepeat || m.ending?.start)
        out.push(`<barline location="left">${m.leftRepeat ? "<bar-style>heavy-light</bar-style>" : ""}${m.ending?.start ? `<ending number="${esc(m.ending.number)}" type="start"/>` : ""}${m.leftRepeat ? `<repeat direction="forward"/>` : ""}</barline>`);
      const lead = ks.map((k) => (k < 0 ? [] : m.attrs[k].filter((a) => leading(a, m))));
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
        if (lines[k] !== 5) {
          if (mi === 0) attrs.push(clefXml(TAB, part.staves > 1 ? k + 1 : 0));
          return;
        }
        if (mi === 0 || (c && !sameClef(c, clefs[k]))) {
          clefs[k] = c ?? clefs[k];
          attrs.push(clefXml(clefs[k], part.staves > 1 ? k + 1 : 0));
        }
      });
      if (mi === 0)
        lines.forEach((n, k) => {
          if (n !== 5) attrs.push(staffDetails(n, part.staves > 1 ? k + 1 : 0));
        });
      if (attrs.length) out.push(`<attributes>${attrs.join("")}</attributes>`);

      const mlen = (t.beats * 4) / t.type;
      let pos = 0;
      ks.forEach((k, sk) => {
        const staffNo = part.staves > 1 ? sk + 1 : 0;
        if (k < 0) {
          // A staff the system hides: a measure rest.
          if (pos > 0) out.push(`<backup><duration>${Math.round(pos * DIV)}</duration></backup>`);
          out.push(`<note><rest measure="yes"/><duration>${Math.round(mlen * DIV)}</duration><voice>${voiceNo(1, sk)}</voice>${staffNo ? `<staff>${staffNo}</staff>` : ""}</note>`);
          pos = mlen;
          return;
        }
        const evs = m.events[k];
        const mid = m.attrs[k].filter((a) => a.clef && !leading(a, m)).sort((a, b) => a.x - b.x);
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
          if (e.tab) {
            e.notes = e.tab.map((t) => ({ ...spell(tuning(lines[sk])[t.string - 1] + t.fret, fifths ?? 0), pos: 0, tab: t }));
            continue;
          }
          e.notes = e.heads.map((h) => {
            const d = clef.top - h.pos;
            let alter = 0;
            if (h.acc !== undefined && !e.grace) alters.set(d, h.acc);
            if (h.acc !== undefined) alter = h.acc;
            else if (h.tieStop && tied[sk].has(d)) alter = tied[sk].get(d)!;
            else if (alters.has(d)) alter = alters.get(d)!;
            else alter = keyAlter(fifths ?? 0, ((d % 7) + 7) % 7);
            if (h.tieStart) tied[sk].set(d, alter);
            else if (h.tieStop) tied[sk].delete(d);
            return { step: STEPS[((d % 7) + 7) % 7], octave: Math.floor(d / 7) + Math.round((h.shift ?? 0) / 12), alter, shown: h.acc, pos: h.pos, tieStart: h.tieStart, tieStop: h.tieStop };
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
      const end = m.ending?.end ? `<ending number="${esc(m.ending.number)}" type="${m.ending.end}"/>` : "";
      if (m.right && (m.right.repeat || m.right.kinds.length > 1 || end)) {
        const style = m.right.kinds.join("-").replace(/thin/g, "light").replace(/thick/g, "heavy");
        const bar = m.right.kinds.length > 1 || m.right.repeat ? `<bar-style>${style === "light-light" || style === "light-heavy" || style === "heavy-light" || style === "heavy-heavy" ? style : "light-heavy"}</bar-style>` : "";
        out.push(`<barline location="right">${bar}${end}${m.right.repeat ? `<repeat direction="backward"/>` : ""}</barline>`);
      } else if (end) out.push(`<barline location="right">${end}</barline>`);
      out.push("</measure>");
    });
    out.push("</part>");
  });
  out.push("</score-partwise>");
  return out.join("\n");
}

const TAB: Clef = { sign: "TAB", line: 5, octave: 0, top: 0 };
const TUNING: Record<number, number[]> = { 6: [64, 59, 55, 50, 45, 40], 4: [43, 38, 33, 28], 5: [43, 38, 33, 28, 23], 7: [64, 59, 55, 50, 45, 40, 35] };
// Standard tunings, top line first: a PDF does not say which tuning a tablature uses.
const tuning = (lines: number) => TUNING[lines] ?? TUNING[6];

function spell(midi: number, fifths: number): { step: string; octave: number; alter: number } {
  const pc = ((midi % 12) + 12) % 12;
  const natural = [0, 2, 4, 5, 7, 9, 11].indexOf(pc);
  const octave = Math.floor(midi / 12) - 1;
  if (natural >= 0) return { step: STEPS[natural], octave, alter: 0 };
  if (fifths >= 0) return { step: STEPS[[0, 2, 4, 5, 7, 9, 11].indexOf(pc - 1)], octave, alter: 1 };
  return { step: STEPS[[0, 2, 4, 5, 7, 9, 11].indexOf(pc + 1)], octave, alter: -1 };
}

function staffDetails(lines: number, staff: number): string {
  const tun = [...tuning(lines)].reverse();
  const tunes = tun.map((m, i) => {
    const p = spell(m, 0);
    return `<staff-tuning line="${i + 1}"><tuning-step>${p.step}</tuning-step>${p.alter ? `<tuning-alter>${p.alter}</tuning-alter>` : ""}<tuning-octave>${p.octave}</tuning-octave></staff-tuning>`;
  });
  return `<staff-details${staff ? ` number="${staff}"` : ""}><staff-lines>${lines}</staff-lines>${tunes.join("")}</staff-details>`;
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
function leading(a: PAttr, m: PMeasure): boolean {
  const k = m.attrs.findIndex((as) => as.includes(a));
  const evs = k < 0 ? [] : m.events[k].filter((e) => !e.grace);
  return !evs.length || a.x < Math.min(...evs.map((e) => e.x));
}

/** For each staff of the fullest system, the staff of this system showing it (or -1): clefs and sizes aligned in order. */
const clefSign = (s: PSystem, k: number) => s.measures[0]?.attrs[k].find((a) => a.clef)?.clef?.sign ?? "?";

function alignStaves(sys: PSystem, full: PSystem, fit: (i: number, j: number) => number): number[] {
  const n = full.staves.length;
  if (sys.staves.length === n) return full.staves.map((_, k) => k);
  const score = (i: number, j: number) => fit(i, j) + (Math.abs(sys.staves[i].space - full.staves[j].space) < 0.05 ? 1 : 0) + (nameFits(sys.names[i], full.names[j]) ? 0.5 : 0);
  const m = sys.staves.length;
  const gap = (s: PSystem, k: number) => s.staves[k + 1].top - s.staves[k].bottom;
  // Best order-keeping assignment of m staves among n; neighbours at the same distance score too.
  const dp: number[][] = Array.from({ length: m }, () => Array(n).fill(-Infinity));
  const from: number[][] = Array.from({ length: m }, () => Array(n).fill(-1));
  for (let j = 0; j < n; j++) dp[0][j] = score(0, j);
  for (let i = 1; i < m; i++)
    for (let j = i; j < n; j++)
      for (let p = i - 1; p < j; p++) {
        const near = p === j - 1 && Math.abs(gap(sys, i - 1) - gap(full, p)) < 0.15 * gap(full, p) ? 1.5 : 0;
        const v = dp[i - 1][p] + score(i, j) + near;
        if (v > dp[i][j]) {
          dp[i][j] = v;
          from[i][j] = p;
        }
      }
  const map: number[] = Array(n).fill(-1);
  let j = dp[m - 1].indexOf(Math.max(...dp[m - 1]));
  for (let i = m - 1; i >= 0 && j >= 0; i--) {
    map[j] = i;
    j = from[i][j];
  }
  return map;
}

/** A name or its abbreviation ("Pno." for "Piano"): letters in order, same first letter. */
function nameFits(a: string, b: string): boolean {
  if (!a || !b) return true;
  const x = a.toLowerCase().replace(/[^\p{L}\d]/gu, "");
  const y = b.toLowerCase().replace(/[^\p{L}\d]/gu, "");
  if (!x || !y || x[0] !== y[0]) return false;
  let i = 0;
  for (const c of y) if (c === x[i]) i++;
  return i === x.length;
}

/** Onsets: voices one after the other; a voice starting late lines up with the column it stands in. */
function timeMeasure(m: PMeasure, mlen: number, space: number): void {
  const cols: { x: number; at: number }[] = [];
  // Unnumbered tuplets.
  const lines = m.events.flatMap((evs) => [...new Set(evs.map((e) => e.voice))].map((v) => evs.filter((e) => e.voice === v && !e.grace)));
  for (const l of lines) hiddenTuplets(l, mlen);
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

/** A voice too long for its measure has tuplets without a number: its shortest notes, scaled to fit. */
function hiddenTuplets(line: PEvent[], mlen: number): void {
  const isRest = (e: PEvent) => e.rest && e.base === 4 && line.length === 1;
  const total = line.reduce((t, e) => t + (isRest(e) ? mlen : length(e)), 0);
  if (total <= mlen + 1e-6 || line.some((e) => e.guess)) return;
  // The shortest notes not in a numbered tuplet yet.
  const free = line.filter((e) => !e.tuplet);
  if (!free.length) return;
  const min = Math.min(...free.map((e) => e.base));
  const short = free.filter((e) => e.base === min);
  const sum = short.reduce((t, e) => t + length(e), 0);
  const r = (sum - (total - mlen)) / sum;
  for (const [actual, normal] of [[3, 2], [5, 4], [6, 4], [7, 4], [9, 8], [7, 8], [5, 2], [10, 8], [11, 8], [12, 8], [13, 8], [15, 8]]) {
    if (Math.abs(normal / actual - r) > 1e-3) continue;
    const tup = { actual, normal };
    for (const e of short) e.tuplet = tup;
    return;
  }
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
  const common = (chord: boolean, inner: string, extra: string, lyric: string, tech = "", tie: { start?: boolean; stop?: boolean } = {}) => {
    const s: string[] = ["<note>"];
    if (e.grace) s.push("<grace/>");
    if (chord) s.push("<chord/>");
    s.push(inner);
    if (!e.grace) s.push(`<duration>${Math.round(dur * DIV)}</duration>`);
    if (tie.stop) s.push(`<tie type="stop"/>`);
    if (tie.start) s.push(`<tie type="start"/>`);
    s.push(`<voice>${voice}</voice>`);
    if (!e.measureRest) s.push(`<type>${typeOf(e.base)}</type>`);
    for (let d = 0; d < e.dots; d++) s.push("<dot/>");
    s.push(extra);
    if (e.tuplet) s.push(`<time-modification><actual-notes>${e.tuplet.actual}</actual-notes><normal-notes>${e.tuplet.normal}</normal-notes></time-modification>`);
    if (!e.rest && e.up !== undefined) s.push(`<stem>${e.up ? "up" : "down"}</stem>`);
    if (staff) s.push(`<staff>${staff}</staff>`);
    const tupXml = !chord && tup ? `${tup === "start" || tup === "both" ? `<tuplet type="start"/>` : ""}${tup === "stop" || tup === "both" ? `<tuplet type="stop"/>` : ""}` : "";
    const tied = `${tie.stop ? `<tied type="stop"/>` : ""}${tie.start ? `<tied type="start"/>` : ""}`;
    if (tupXml || tech || tied) s.push(`<notations>${tied}${tupXml}${tech}</notations>`);
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
      const tech = n.tab ? `<technical><string>${n.tab.string}</string><fret>${n.tab.fret}</fret></technical>` : "";
      return common(i > 0, pitch, acc, i === 0 ? lyrics : "", tech, { start: n.tieStart, stop: n.tieStop });
    })
    .join("");
}

function directionXml(d: PMeasure["dirs"][number], staff: number): string {
  const inner = d.dynamics ? `<dynamics>${DYN.has(d.dynamics) ? `<${d.dynamics}/>` : `<other-dynamics>${esc(d.dynamics)}</other-dynamics>`}</dynamics>` : `<words>${esc(d.words ?? "")}</words>`;
  return `<direction placement="${d.above ? "above" : "below"}"><direction-type>${inner}</direction-type>${staff ? `<staff>${staff}</staff>` : ""}</direction>`;
}
