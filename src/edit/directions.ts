import { kid, kids, text } from "../model/xml";
import { readMeasure } from "./measure";

// Marks at a beat that belong to no note: dynamics, hairpins, text, tempo, rehearsal marks.
// They are MusicXML <direction>s placed among a measure's notes.

/** The dynamics edit mode offers, with the loudness each plays at (MIDI velocity). */
export const DYNAMICS: Record<string, number> = { ppp: 16, pp: 33, p: 49, mp: 64, mf: 80, f: 96, ff: 112, fff: 126, sf: 112, sfz: 112, sfp: 112, fp: 96, rfz: 112 };

const BEAT: Record<string, string> = { half: "𝅗𝅥", quarter: "♩", eighth: "♪" };

/** Kinds of text: staff text above, expression below, a rehearsal mark in a box. */
export type TextKind = "staff" | "expression" | "rehearsal";

export type Direction =
  | { kind: "dynamic"; value: string }
  | { kind: "wedge"; type: "crescendo" | "diminuendo" | "stop"; number: number }
  | { kind: "text"; text: TextKind; words: string }
  /** Its text as drawn ("Allegro ♩ = 132"), and quarters per minute. */
  | { kind: "tempo"; bpm: number; words: string };

/** What a <direction> holds, if it is one edit mode knows. */
export function directionOf(d: Element): Direction | null {
  const dt = kid(d, "direction-type");
  if (!dt) return null;
  const dyn = kid(dt, "dynamics");
  if (dyn) return { kind: "dynamic", value: dyn.firstElementChild?.tagName ?? text(dyn, "other-dynamics") };
  const wedge = kid(dt, "wedge");
  if (wedge) return { kind: "wedge", type: (wedge.getAttribute("type") as "crescendo") ?? "stop", number: Number(wedge.getAttribute("number")) || 1 };
  const sound = kid(d, "sound");
  // Repeat navigation (Fine, D.C., segno, coda): not text edit mode changes.
  if (sound && ["fine", "dacapo", "dalsegno", "segno", "coda", "tocoda"].some((a) => sound.hasAttribute(a))) return null;
  const tempo = sound?.getAttribute("tempo");
  const metro = kid(dt, "metronome");
  if (tempo || metro) {
    const words = kids(d, "direction-type").map((x) => text(x, "words")).join("");
    const shown = metro ? `${BEAT[text(metro, "beat-unit")] ?? "♩"}${kid(metro, "beat-unit-dot") ? "." : ""} = ${text(metro, "per-minute")}` : "";
    return { kind: "tempo", bpm: Number(tempo) || Number(text(metro, "per-minute")) || 0, words: [words, shown].filter(Boolean).join(" ") };
  }
  const reh = kid(dt, "rehearsal");
  if (reh) return { kind: "text", text: "rehearsal", words: reh.textContent ?? "" };
  const words = kid(dt, "words");
  if (words) return { kind: "text", text: d.getAttribute("placement") === "below" ? "expression" : "staff", words: kids(d, "direction-type").map((x) => text(x, "words")).join("") };
  return null;
}

/** A new <direction>: on a staff of a part with several, at the given beat by where it is inserted. */
export function makeDirection(doc: Document, dir: Direction, staff?: number): Element {
  const d = doc.createElementNS(null, "direction");
  const add = (parent: Element, tag: string, value?: string | number, attrs: Record<string, string | number> = {}) => {
    const e = doc.createElementNS(null, tag);
    if (value !== undefined) e.textContent = String(value);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    parent.appendChild(e);
    return e;
  };
  const dt = add(d, "direction-type");
  let sound: Record<string, number> | null = null;
  switch (dir.kind) {
    case "dynamic": {
      d.setAttribute("placement", "below");
      add(add(dt, "dynamics"), dir.value);
      const vel = DYNAMICS[dir.value];
      if (vel) sound = { dynamics: Math.round((vel / 90) * 10000) / 100 };
      break;
    }
    case "wedge":
      d.setAttribute("placement", "below");
      add(dt, "wedge", undefined, { type: dir.type, number: dir.number });
      break;
    case "text":
      d.setAttribute("placement", dir.text === "expression" ? "below" : "above");
      add(dt, dir.text === "rehearsal" ? "rehearsal" : "words", dir.words);
      break;
    case "tempo":
      d.setAttribute("placement", "above");
      add(dt, "words", dir.words || `♩ = ${dir.bpm}`);
      sound = { tempo: dir.bpm };
      break;
  }
  if (staff) add(d, "staff", staff);
  if (sound) add(d, "sound", undefined, sound);
  return d;
}

/** The <direction>s of a measure on one staff at a position (in divisions). */
export function directionsAt(measure: Element, pos: number, staff: number): Element[] {
  return readMeasure(measure)
    .others.filter((o) => o.el.tagName === "direction" && Math.abs(o.pos - pos) < 1e-9 && (Number(text(o.el, "staff")) || 1) === staff)
    .map((o) => o.el);
}

/** Usual speeds of tempo words, for a mark typed without a number. */
const WORDS: [RegExp, number][] = [[/grave|largo/i, 50], [/lento|adagio/i, 70], [/andante/i, 90], [/moderato/i, 110], [/allegretto/i, 116], [/allegro/i, 132], [/vivace/i, 160], [/presto/i, 180]];

/** Quarters per minute of a typed tempo mark: a number, "Allegro ♩ = 132", or a known word (else 120). */
export function tempoOf(words: string): number {
  const n = /(?:=\s*)?(\d+(?:\.\d+)?)\s*$/.exec(words.trim());
  if (n) return Number(n[1]);
  return WORDS.find(([re]) => re.test(words))?.[1] ?? 120;
}
