import { ScoreEditor, type Caret, type Change, type Clip } from "../edit/editor";
import { tempoOf, type TextKind } from "../edit/directions";
import { INTERVALS, intervalToKey } from "../edit/transpose";
import { INSTRUMENTS, instrument } from "../model/instruments";
import { readMeasure, voiceKey, type Event } from "../edit/measure";
import { ornamentAccidental, techValue, bendsOf, fingeringOf, type Bend, keyAlter, lyricsOf, marksOf, midiOf, readPitch, spellMidi, tremoloOf, type Pitch } from "../edit/notes";
import type { ScoreDoc } from "../model/score";
import { kid, kids, text } from "../model/xml";
import type { PageView, Pick } from "../render/page-view";
import { t } from "./i18n";
import { partFamily, type PartFamily } from "../model/score";
import { BASS, Fretboard, GUITAR } from "./fretboard";
import { Keyboard } from "./keyboard";

export interface EditingHost {
  /** The whole score (edits go there) and the parts shown, null for all. */
  score(): ScoreDoc;
  shown(): number[] | null;
  /** The page view, where editing happens. */
  view(): PageView | null;
  /** An edit landed: draw it, rebuild playback, tell the host. */
  changed(change: Change): void;
  /** The Done button. */
  done(): void;
}

export interface Editing {
  /** The palette that takes the bar's place, with the pitch strip above it. */
  readonly el: HTMLElement;
  start(): void;
  stop(): void;
  /** The view was built again (layout, parts): editing follows it. */
  attach(view: PageView | null): void;
  /** A key pressed while editing; true when it was used. */
  key(e: KeyboardEvent): boolean;
  /** The score was replaced (read again): a fresh undo history. */
  reset(): void;
}

const svg = (inner: string, view = "0 0 24 24") => `<svg width="20" height="20" viewBox="${view}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
// Note values drawn as notes: head (hollow or filled), stem, flags.
const noteIcon = (hollow: boolean, stem: boolean, flags: number) =>
  svg(
    `<ellipse cx="9" cy="17" rx="4.2" ry="3" transform="rotate(-20 9 17)" ${hollow ? "" : 'fill="currentColor"'}/>` +
      (stem ? '<line x1="13" x2="13" y1="16" y2="3"/>' : "") +
      Array.from({ length: flags }, (_, i) => `<path d="M13 ${3 + i * 4} q5 3 4 8"/>`).join(""),
  );
const ICONS = {
  input: svg('<path d="M4 20h4L19 9l-4-4L4 16z"/><line x1="13.5" x2="17.5" y1="6.5" y2="10.5"/>'),
  insert: svg('<line x1="12" x2="12" y1="4" y2="20"/><line x1="4" x2="9" y1="12" y2="12"/><line x1="6.5" x2="6.5" y1="9.5" y2="14.5"/><polyline points="15 9 18 12 15 15"/>'),
  rest: svg('<path d="M10 3l4 5-4 4 4 5c-3-1-5 0-4 4"/>'),
  dot: svg('<circle cx="12" cy="12" r="3" fill="currentColor"/>'),
  tie: svg('<path d="M4 11c4 6 12 6 16 0"/>'),
  marks: svg('<polyline points="5 5 12 9 5 13"/><circle cx="16" cy="18" r="2" fill="currentColor"/>'),
  textMarks: svg('<polyline points="5 7 5 5 15 5 15 7"/><line x1="10" x2="10" y1="5" y2="16"/><path d="M14 19 L20 16.5 L14 14"/>'),
  crescendo: svg('<polyline points="20 7 4 12 20 17"/>'),
  diminuendo: svg('<polyline points="4 7 20 12 4 17"/>'),
  staffText: svg('<polyline points="6 8 6 5 18 5 18 8"/><line x1="12" x2="12" y1="5" y2="19"/><line x1="9" x2="15" y1="19" y2="19"/>'),
  expression: svg('<path d="M9 19 L13 5 L17 5"/><line x1="8" x2="15" y1="11" y2="11"/>'),
  tempoMark: svg('<ellipse cx="7" cy="17" rx="3" ry="2.2" fill="currentColor"/><line x1="10" x2="10" y1="17" y2="5"/><line x1="13" x2="20" y1="10" y2="10"/><line x1="13" x2="20" y1="14" y2="14"/>'),
  chordSym: svg('<text x="3" y="17" font-size="13" font-family="serif" font-weight="700" fill="currentColor" stroke="none">C7</text>'),
  scoreTools: svg('<rect x="4" y="4" width="16" height="16" rx="2"/><line x1="4" x2="20" y1="9" y2="9"/><line x1="4" x2="20" y1="13" y2="13"/><line x1="4" x2="20" y1="17" y2="17"/>'),
  rehearsal: svg('<rect x="5" y="5" width="14" height="14" rx="1.5"/><path d="M9 16 L12 8 L15 16 M10.2 13 H13.8"/>'),
  accent: svg('<polyline points="5 7 19 12 5 17"/>'),
  staccato: svg('<circle cx="12" cy="12" r="3" fill="currentColor"/>'),
  tenuto: svg('<line x1="5" x2="19" y1="12" y2="12" stroke-width="3"/>'),
  marcato: svg('<polyline points="6 18 12 6 18 18"/>'),
  fermata: svg('<path d="M4 16a8 8 0 0 1 16 0"/><circle cx="12" cy="15" r="1.8" fill="currentColor"/>'),
  trill: svg('<text x="12" y="17" text-anchor="middle" font-size="13" font-style="italic" font-weight="700" fill="currentColor" stroke="none">tr</text>'),
  mordent: svg('<polyline points="3 14 7 9 10 14 14 9 17 14 21 9"/><line x1="12" x2="12" y1="5" y2="19"/>'),
  slur: svg('<path d="M3 15c5-9 13-9 18 0"/>'),
  grace: svg('<ellipse cx="9" cy="17" rx="3.2" ry="2.3" transform="rotate(-20 9 17)" fill="currentColor"/><line x1="12" x2="12" y1="16" y2="5"/><path d="M12 5q4 2 3 6"/><line x1="7" x2="17" y1="12" y2="7"/>'),
  arpeggio: svg('<path d="M12 3c3 1.5-3 3 0 4.5s-3 3 0 4.5-3 3 0 4.5 -3 3 0 4.5"/>'),
  tremolo: svg('<line x1="12" x2="12" y1="3" y2="21"/><line x1="7" x2="17" y1="9" y2="6"/><line x1="7" x2="17" y1="13" y2="10"/><line x1="7" x2="17" y1="17" y2="14"/>'),
  glissando: svg('<circle cx="5" cy="17" r="2.2" fill="currentColor"/><circle cx="19" cy="7" r="2.2" fill="currentColor"/><path d="M7 15l2-1-1-2 2-1-1-2 2-1-1-2 2-1"/>'),
  trillLine: svg('<text x="6" y="11" text-anchor="middle" font-size="9" font-style="italic" font-weight="700" fill="currentColor" stroke="none">tr</text><path d="M3 16q1.5-3 3 0t3 0 3 0 3 0 3 0 3 0"/>'),
  fingering: svg('<text x="12" y="17" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor" stroke="none">1 3</text>'),
  upBow: svg('<polyline points="6 6 12 18 18 6"/>'),
  downBow: svg('<polyline points="6 18 6 6 18 6 18 18"/>'),
  hammerOn: svg('<path d="M4 16c4-6 12-6 16 0"/><text x="12" y="21" text-anchor="middle" font-size="8" font-weight="700" fill="currentColor" stroke="none">H</text>'),
  pullOff: svg('<path d="M4 16c4-6 12-6 16 0"/><text x="12" y="21" text-anchor="middle" font-size="8" font-weight="700" fill="currentColor" stroke="none">P</text>'),
  bend: svg('<path d="M5 20c6 0 9-4 9-13"/><polyline points="11 9 14 5 17 9"/>'),
  tap: svg('<text x="12" y="17" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor" stroke="none">T</text>'),
  shake: svg('<path d="M3 13q2-4 4 0t4 0 4 0 4 0"/><line x1="20" x2="20" y1="8" y2="17"/>'),
  schleifer: svg('<polyline points="4 17 9 9 14 14 20 6"/>'),
  pluck: svg('<text x="12" y="17" text-anchor="middle" font-size="13" font-style="italic" font-weight="700" fill="currentColor" stroke="none">p i</text>'),
  hole: svg('<circle cx="12" cy="12" r="7"/><path d="M12 5a7 7 0 0 0 0 14z" fill="currentColor"/>'),
  arrow: svg('<line x1="12" x2="12" y1="20" y2="5"/><polyline points="7 10 12 5 17 10"/>'),
  turn: svg('<path d="M3 14c0-5 5-5 7-1s2 5 4 5 7-2 7-6-5-4-7-1-4 6-7 6-4-1-4-3z"/>'),
  invertedTurn: svg('<path d="M3 14c0-5 5-5 7-1s2 5 4 5 7-2 7-6-5-4-7-1-4 6-7 6-4-1-4-3z"/><line x1="12" x2="12" y1="5" y2="20"/>'),
  delayedTurn: svg('<path d="M9 14c0-4 4-4 5-1s2 4 3 4 5-2 5-5-4-3-5-1-3 5-5 5-3-1-3-2z"/><circle cx="4" cy="16" r="2" fill="currentColor"/>'),
  invertedMordent: svg('<polyline points="3 14 7 9 10 14 14 9 17 14 21 9"/>'),
  ornamentAccidental: svg('<text x="12" y="10" text-anchor="middle" font-size="10" fill="currentColor" stroke="none">♯</text><path d="M4 18q2-3 4 0t4 0 4 0 4 0"/>'),
  more: svg('<circle cx="6" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="18" cy="12" r="1.6" fill="currentColor"/>'),
  lyrics: svg('<text x="12" y="17" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor" stroke="none">Aa</text>'),
  triplet: svg('<polyline points="4 9 4 5 20 5 20 9"/><text x="12" y="19" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor" stroke="none">3</text>'),
  del: svg('<polyline points="4 7 20 7"/><path d="M6 7l1 13h10l1-13"/><path d="M9 7V4h6v3"/>'),
  undo: svg('<polyline points="9 14 4 9 9 4"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>'),
  redo: svg('<polyline points="15 14 20 9 15 4"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/>'),
  keys: svg('<rect x="2" y="6" width="20" height="12" rx="1"/><line x1="7" x2="7" y1="6" y2="18"/><line x1="12" x2="12" y1="6" y2="18"/><line x1="17" x2="17" y1="6" y2="18"/>'),
  done: svg('<polyline points="5 12 10 17 19 7"/>'),
  left: svg('<polyline points="15 6 9 12 15 18"/>'),
  right: svg('<polyline points="9 6 15 12 9 18"/>'),
};
const DURATIONS: [quarters: number, icon: string, label: string][] = [
  [0.25, noteIcon(false, true, 2), "sixteenth"],
  [0.5, noteIcon(false, true, 1), "eighth"],
  [1, noteIcon(false, true, 0), "quarter"],
  [2, noteIcon(true, true, 0), "half"],
  [4, noteIcon(true, false, 0), "whole"],
];
// MuseScore's number keys: 1 = 64th ... 5 = quarter, 6 = half, 7 = whole, 8 = breve.
const KEY_QUARTERS: Record<string, number> = { "1": 1 / 16, "2": 1 / 8, "3": 1 / 4, "4": 1 / 2, "5": 1, "6": 2, "7": 4, "8": 8 };
const STEPS = "CDEFGAB";

function button(html: string, label: string, onClick: () => void, cls = ""): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `sv-bb-btn sv-bb-icon ${cls}`.trim();
  b.innerHTML = html;
  b.title = label;
  b.setAttribute("aria-label", label);
  b.addEventListener("click", onClick);
  return b;
}

/** Clef in force on a staff at a measure: sign, line, octave change. */
function clefAt(score: ScoreDoc, part: number, m: number, staff: number): { sign: string; line: number; octave: number } {
  const meas = score.measures[part]?.[m];
  const all = [...score.attributesAt(part, m), ...(meas ? kids(meas, "attributes").flatMap((a) => kids(a)) : [])];
  let clef = { sign: "G", line: 2, octave: 0 };
  for (const c of all) {
    if (c.tagName !== "clef") continue;
    const n = Number(c.getAttribute("number") ?? 1);
    if (n !== staff) continue;
    clef = { sign: text(c, "sign") || "G", line: Number(text(c, "line")) || 2, octave: Number(text(c, "clef-octave-change")) || 0 };
  }
  return clef;
}

/** The pitch on a staff `step` half spaces below its top line. */
function pitchOnStaff(clef: { sign: string; line: number; octave: number }, lines: number, step: number, fifths: number): Pitch | null {
  // Diatonic number (octave * 7 + C=0..B=6) of the clef's line.
  const base = clef.sign === "F" ? 3 * 7 + 3 : clef.sign === "C" ? 4 * 7 : clef.sign === "TAB" ? NaN : 4 * 7 + 4;
  // One-line drum staves put their line at E4 (as scoredit reads them).
  if (clef.sign === "percussion" && lines === 1) {
    const d = 4 * 7 + 2 - step;
    return { step: STEPS[((d % 7) + 7) % 7], alter: 0, octave: Math.floor(d / 7) };
  }
  const line = clef.sign === "percussion" ? 2 : clef.line;
  if (Number.isNaN(base)) return null;
  const top = base + (lines - line) * 2 + clef.octave * 7;
  const d = top - step;
  const s = STEPS[((d % 7) + 7) % 7];
  return { step: s, alter: keyAlter(s, fifths), octave: Math.floor(d / 7) };
}

const NAMES: Record<number, string> = { [-2]: "𝄫", [-1]: "♭", 0: "", 1: "♯", 2: "𝄪" };
const nameOf = (p: Pitch) => `${p.step}${NAMES[p.alter] ?? ""}${p.octave}`;

export function createEditing(host: EditingHost): Editing {
  let editor = new ScoreEditor(host.score());
  let caret: Caret | null = null;
  // The selected event (or one note of it), and the last note entered counts as selected.
  let sel: { at: Caret; note: Element | null; end?: Caret } | null = null;
  let clip: Clip[] = [];
  // In note input, S opens a slur at the last note and S again closes it at the latest one.
  let slurFrom: Caret | null = null;
  let quarters = 1;
  let dots = 0;
  let input = false;
  let insert = false;
  let voiceN = 1;
  let lastPitch: Pitch | null = null;
  let view: PageView | null = null;
  let active = false;

  const el = document.createElement("div");
  el.className = "sv-edit";
  el.hidden = true;
  const strip = document.createElement("div");
  strip.className = "sv-pitch-strip";
  strip.hidden = true;
  const kb = new Keyboard("sv-strip-keys");
  let stripLo = 55;
  const shift = (by: number) => {
    stripLo = Math.min(96, Math.max(21, stripLo + by));
    kb.setRange(stripLo, stripLo + 19);
  };
  const navL = button(ICONS.left, t("lower"), () => shift(-12), "sv-strip-nav");
  const navR = button(ICONS.right, t("higher"), () => shift(12), "sv-strip-nav");
  strip.append(navL, kb.canvas, navR);
  // For a fretted part the strip is its fretboard instead.
  let frets: Fretboard | null = null;
  let fretPart = -1;
  function stripFor(part: number | null): void {
    // Without a tuning in the file, a guitar or bass part gets the standard one.
    const fam = part === null ? null : partFamily(editor.score.parts[part]);
    const f = part === null ? null : (editor.fretted(part) ?? (fam === "guitar" ? { tuning: GUITAR } : fam === "bass" ? { tuning: BASS } : null));
    if (!f) {
      if (frets) {
        frets.canvas.remove();
        frets = null;
        fretPart = -1;
        kb.canvas.hidden = navL.hidden = navR.hidden = false;
      }
      return;
    }
    if (frets && fretPart === part) return;
    frets?.canvas.remove();
    frets = new Fretboard(f.tuning);
    frets.canvas.classList.add("sv-strip-keys");
    frets.canvas.classList.remove("sv-keys");
    fretPart = part!;
    kb.canvas.hidden = navL.hidden = navR.hidden = true;
    strip.append(frets.canvas);
    const fb = frets;
    fb.canvas.addEventListener("pointerdown", (e) => {
      const r = fb.canvas.getBoundingClientRect();
      const at = fb.at(e.clientX - r.left, e.clientY - r.top);
      if (!at) return;
      const midi = f.tuning[f.tuning.length - at.string] + at.fret;
      const where = caret ?? sel?.at;
      const pitch = { ...spellMidi(midi, where ? fifthsAt(where) : 0), position: at };
      fb.set("tap", { ...at, color: "#e8710a" });
      fb.draw();
      setTimeout(() => (fb.set("tap", null), fb.draw()), 250);
      if (input && caret) enter([pitch], { chord: e.shiftKey });
      else if (selectedNotes().length === 1) each((n) => editor.setNotePitch(n, pitch));
      lastPitch = pitch;
    });
    requestAnimationFrame(() => fb.draw());
  }
  const row1 = document.createElement("div");
  row1.className = "sv-pal-row";
  const row2 = document.createElement("div");
  row2.className = "sv-pal-row";
  // The two groups share a line when there is room (desktop), else stack (phone).
  const rows = document.createElement("div");
  rows.className = "sv-pal";
  const row3 = document.createElement("div");
  row3.className = "sv-pal-row sv-pal-marks";
  row3.hidden = true;
  const dynRow = document.createElement("div");
  dynRow.className = "sv-pal-row sv-pal-marks";
  dynRow.hidden = true;
  const textRow = document.createElement("div");
  textRow.className = "sv-pal-row sv-pal-marks";
  textRow.hidden = true;
  const row5 = document.createElement("div");
  row5.className = "sv-pal-row sv-pal-marks sv-pal-score";
  row5.hidden = true;
  rows.append(row1, row2, row5);
  // What changes the selected notes floats over them (as pdfcraft's selection bar): accidentals,
  // marks, dynamics, text, delete; a group opens on a second line.
  const floatBar = document.createElement("div");
  floatBar.className = "sv-float";
  floatBar.hidden = true;
  const floatMain = document.createElement("div");
  floatMain.className = "sv-float-main";
  floatBar.append(floatMain, row3, dynRow, textRow);
  floatBar.addEventListener("pointerdown", (e) => e.stopPropagation());
  // Lyrics are typed in a field that moves along the notes.
  const lyricBar = document.createElement("div");
  lyricBar.className = "sv-lyric-bar";
  lyricBar.hidden = true;
  const lyricInput = document.createElement("input");
  lyricInput.type = "text";
  lyricInput.className = "sv-lyric";
  lyricInput.placeholder = t("lyricsHint");
  lyricInput.setAttribute("aria-label", t("lyrics"));
  lyricInput.autocomplete = "off";
  lyricInput.setAttribute("autocapitalize", "off");
  lyricBar.append(lyricInput);
  el.append(strip, lyricBar, rows);

  const inputBtn = button(ICONS.input, t("noteInput"), () => setInput(!input));
  const durBtns = DURATIONS.map(([q, icon, label]) => button(icon, t(label), () => setDuration(q)));
  const dotBtn = button(ICONS.dot, t("dot"), () => toggleDot());
  const restBtn = button(ICONS.rest, t("rest"), () => rest());
  const tieBtn = button(ICONS.tie, t("tie"), () => tie());
  const tripletBtn = button(ICONS.triplet, t("triplet"), () => triplet());
  row1.append(inputBtn, ...durBtns, dotBtn, restBtn, tieBtn, tripletBtn);
  const accBtns = ([[1, "♯", "sharp"], [-1, "♭", "flat"], [0, "♮", "natural"]] as const).map(([alter, glyph, label]) => button(`<span class="sv-glyph">${glyph}</span>`, t(label), () => accidental(alter)));
  const voiceBtn = button("", t("voice"), () => {
    voiceN = (voiceN % 4) + 1;
    if (caret) caret = { ...caret, voice: editor.voiceId(caret.part, caret.staff, voiceN) };
    sync();
  });
  const insertBtn = button(ICONS.insert, t("insertMode"), () => {
    insert = !insert;
    sync();
  });
  const delBtn = button(ICONS.del, t("deleteNote"), () => remove());
  const undoBtn = button(ICONS.undo, t("undo"), () => undo());
  const redoBtn = button(ICONS.redo, t("redo"), () => redo());
  const keysBtn = button(ICONS.keys, t("keyboard"), () => {
    strip.hidden = !strip.hidden;
    if (!strip.hidden) {
      if (lastPitch) stripLo = Math.max(21, midiOf(lastPitch) - 9);
      requestAnimationFrame(() => kb.setRange(stripLo, stripLo + 19));
    }
    sync();
  });
  const doneBtn = button(ICONS.done, t("done"), () => host.done(), "sv-pal-done");
  // One of the extra rows at a time: marks, dynamics and text, or the score's own tools.
  // One group of the floating bar open at a time.
  const openGroup = (row: HTMLElement) => {
    const show = row.hidden;
    for (const r of [row3, dynRow, textRow]) r.hidden = true;
    row.hidden = !show;
    sync();
  };
  const marksBtn = button(ICONS.marks, t("marks"), () => openGroup(row3));
  const dynGroupBtn = button('<span class="sv-dyn">mf</span>', t("dynamics"), () => openGroup(dynRow));
  const textBtn = button(ICONS.textMarks, t("text"), () => openGroup(textRow));
  const scoreBtn = button(ICONS.scoreTools, t("scoreTools"), () => {
    row5.hidden = !row5.hidden;
    sync();
  });
  row2.append(voiceBtn, insertBtn, undoBtn, redoBtn, keysBtn, scoreBtn, doneBtn);
  floatMain.append(...accBtns, marksBtn, dynGroupBtn, textBtn, delBtn);
  // Transpose: by an interval or to a key, up, down or the nearer way; the selection, else the whole score.
  const pick = (label: string, options: [string, string][]) => {
    const box = document.createElement("select");
    box.className = "sv-pick";
    box.setAttribute("aria-label", label);
    for (const [v, text] of options) box.add(new Option(text, v));
    return box;
  };
  const modePick = pick(t("transposeBy"), [["interval", t("byInterval")], ["key", t("toKey")]]);
  const intervalPick = pick(t("interval"), Object.keys(INTERVALS).map((k) => [k, t(`int_${k}`)]));
  intervalPick.value = "M2";
  const keyPick = pick(t("toKey"), Array.from({ length: 15 }, (_, i) => i - 7).map((f) => [String(f), keyName(f)]));
  keyPick.value = "0";
  const dirPick = pick(t("direction"), [["up", t("up")], ["down", t("down")], ["closest", t("closest")]]);
  const transposeBtn = document.createElement("button");
  transposeBtn.type = "button";
  transposeBtn.className = "sv-pal-text-btn";
  transposeBtn.textContent = t("transpose");
  transposeBtn.addEventListener("click", () => transposeNow());
  modePick.addEventListener("change", () => sync());
  // Key and clef from the selected bar on (the first bar when nothing is selected).
  const keyAtPick = pick(t("keyAt"), [["", t("keyAt")], ...Array.from({ length: 15 }, (_, i) => i - 7).map((f) => [String(f), keyName(f)] as [string, string])]);
  const CLEFS: [string, { sign: string; line: number; octave?: number }][] = [
    ["treble", { sign: "G", line: 2 }],
    ["treble8vb", { sign: "G", line: 2, octave: -1 }],
    ["treble8va", { sign: "G", line: 2, octave: 1 }],
    ["bass", { sign: "F", line: 4 }],
    ["bass8vb", { sign: "F", line: 4, octave: -1 }],
    ["alto", { sign: "C", line: 3 }],
    ["tenor", { sign: "C", line: 4 }],
  ];
  const TIMES = ["2/4", "3/4", "4/4", "5/4", "6/4", "2/2", "3/2", "3/8", "5/8", "6/8", "7/8", "9/8", "12/8"];
  const timeAtPick = pick(t("timeAt"), [["", t("timeAt")], ...TIMES.map((x) => [x, x] as [string, string])]);
  // Why a change was refused, until the next one.
  const scoreNote = document.createElement("span");
  scoreNote.className = "sv-pal-note";
  scoreNote.setAttribute("role", "status");
  timeAtPick.addEventListener("change", () => {
    const [n, d] = timeAtPick.value.split("/").map(Number);
    timeAtPick.value = "";
    if (!n || !d) return;
    const r = editor.setTime(sel?.at.measure ?? 0, n, d);
    scoreNote.textContent = r.refused ? t(r.refused.reason === "repeat" ? "timeRefusedRepeat" : "timeRefusedTuplet").replace("{0}", String(r.refused.measure + 1)) : "";
    if (!r.refused) {
      sel = null;
      caret = null;
    }
    landed(r.change);
  });
  const clefAtPick = pick(t("clefAt"), [["", t("clefAt")], ...CLEFS.map(([n]) => [n, t(`clef_${n}`)] as [string, string])]);
  keyAtPick.addEventListener("change", () => {
    if (keyAtPick.value === "") return;
    const at = sel?.at;
    landed(editor.setKey(at?.measure ?? 0, Number(keyAtPick.value), at?.part ?? toFull(0)));
    keyAtPick.value = "";
  });
  clefAtPick.addEventListener("change", () => {
    const c = CLEFS.find(([n]) => n === clefAtPick.value)?.[1];
    clefAtPick.value = "";
    if (!c) return;
    const at = sel?.at;
    landed(editor.setClef(at?.part ?? toFull(0), at?.staff ?? 1, at?.measure ?? 0, c));
  });
  const sep = document.createElement("span");
  sep.className = "sv-pal-sep";
  // Bars: before or after the selected one, one more at the end, the selected ones out.
  const barRange = () => {
    const a = sel?.at.measure ?? editor.score.measureCount - 1;
    const b = sel?.end?.measure ?? a;
    return [Math.min(a, b), Math.max(a, b)] as const;
  };
  const textBtnOf = (label: string, fn: () => void) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "sv-pal-text-btn sv-pal-plain";
    b.textContent = label;
    b.addEventListener("click", fn);
    return b;
  };
  const barBefore = textBtnOf(t("barBefore"), () => landed(editor.insertMeasures(barRange()[0])));
  const barAfter = textBtnOf(t("barAfter"), () => landed(editor.insertMeasures(barRange()[1] + 1)));
  const barEnd = textBtnOf(t("barAtEnd"), () => landed(editor.insertMeasures(editor.score.measureCount)));
  const barDelete = textBtnOf(t("deleteBars"), () => {
    const [a, b] = barRange();
    sel = null;
    caret = null;
    landed(editor.deleteMeasures(a, b + 1));
  });
  const sep2 = document.createElement("span");
  sep2.className = "sv-pal-sep";
  // Instruments: one more at the end, the selected note's one changed or taken out.
  const instrumentPick = (label: string) => {
    const box = document.createElement("select");
    box.className = "sv-pick";
    box.setAttribute("aria-label", label);
    box.add(new Option(label, ""));
    for (const fam of ["keys", "strings", "winds", "brass", "guitar", "bass", "voice", "other", "drums"] as const) {
      const g = document.createElement("optgroup");
      g.label = t(`fam_${fam}`);
      for (const d of INSTRUMENTS.filter((x) => x.family === fam)) g.appendChild(new Option(t(`inst_${d.key}`), d.key));
      if (g.children.length) box.appendChild(g);
    }
    return box;
  };
  const addInstPick = instrumentPick(t("newAdd"));
  addInstPick.addEventListener("change", () => {
    const def = instrument(addInstPick.value);
    addInstPick.value = "";
    if (def) landed(editor.addPart(def, t(`inst_${def.key}`)));
  });
  const changeInstPick = instrumentPick(t("changeInstrument"));
  changeInstPick.addEventListener("change", () => {
    const def = instrument(changeInstPick.value);
    changeInstPick.value = "";
    if (!def || !sel) return;
    const r = editor.changePart(sel.at.part, def, t(`inst_${def.key}`));
    scoreNote.textContent = r ? "" : t("instrumentRefused");
    if (r) landed(r);
  });
  const removeInstBtn = textBtnOf(t("removeInstrument"), () => {
    if (!sel) return;
    const p = sel.at.part;
    sel = null;
    caret = null;
    landed(editor.removePart(p));
  });
  const sep3 = document.createElement("span");
  sep3.className = "sv-pal-sep";
  row5.append(modePick, intervalPick, keyPick, dirPick, transposeBtn, sep, keyAtPick, timeAtPick, clefAtPick, sep2, barBefore, barAfter, barEnd, barDelete, sep3, addInstPick, changeInstPick, removeInstBtn, scoreNote);
  // Dynamics (the usual ones, "more" for the rest), hairpins, then the kinds of text.
  const dynBtn = (v: string) => button(`<span class="sv-dyn">${v}</span>`, v, () => dynamic(v));
  const DYN_MAIN = ["pp", "p", "mp", "mf", "f", "ff"];
  const DYN_MORE = ["ppp", "fff", "sf", "sfz", "sfp", "fp", "rfz"];
  const dynBtns = [...DYN_MAIN, ...DYN_MORE].map((v) => [v, dynBtn(v)] as const);
  let moreDyn = false;
  const moreDynBtn = button(ICONS.more, t("moreDynamics"), () => {
    moreDyn = !moreDyn;
    sync();
  });
  const crescBtn = button(ICONS.crescendo, t("crescendo"), () => hairpin("crescendo"));
  const dimBtn = button(ICONS.diminuendo, t("diminuendo"), () => hairpin("diminuendo"));
  const staffTextBtn = button(ICONS.staffText, t("staffText"), () => openField("staff", lyricBar.hidden !== false || fieldMode !== "staff"));
  const exprBtn = button(ICONS.expression, t("expressionText"), () => openField("expression", lyricBar.hidden !== false || fieldMode !== "expression"));
  const tempoBtn = button(ICONS.tempoMark, t("tempoMark"), () => openField("tempo", lyricBar.hidden !== false || fieldMode !== "tempo"));
  const rehearsalBtn = button(ICONS.rehearsal, t("rehearsalMark"), () => openField("rehearsal", lyricBar.hidden !== false || fieldMode !== "rehearsal"));
  const chordBtn = button(ICONS.chordSym, t("chordSymbol"), () => openField("chord", lyricBar.hidden !== false || fieldMode !== "chord"));
  dynRow.append(...dynBtns.map(([, b]) => b), moreDynBtn, crescBtn, dimBtn);
  const MARKS: [mark: string, icon: string, label: string][] = [
    ["accent", ICONS.accent, "accent"],
    ["staccato", ICONS.staccato, "staccato"],
    ["tenuto", ICONS.tenuto, "tenuto"],
    ["strong-accent", ICONS.marcato, "marcato"],
    ["fermata", ICONS.fermata, "fermata"],
    ["trill-mark", ICONS.trill, "trill"],
    ["mordent", ICONS.mordent, "mordent"],
    ["inverted-mordent", ICONS.invertedMordent, "invertedMordent"],
    ["turn", ICONS.turn, "turn"],
    ["inverted-turn", ICONS.invertedTurn, "invertedTurn"],
    ["delayed-turn", ICONS.delayedTurn, "delayedTurn"],
    ["shake", ICONS.shake, "shake"],
    ["schleifer", ICONS.schleifer, "schleifer"],
    ["tap", ICONS.tap, "tap"],
  ];
  const markBtns = MARKS.map(([m, icon, label]) => button(icon, t(label), () => mark(m)));
  const slurBtn = button(ICONS.slur, t("slur"), () => slur());
  const graceBtn = button(ICONS.grace, t("graceNote"), () => grace(true));
  const lyricsBtn = button(ICONS.lyrics, t("lyrics"), () => openField("lyrics", lyricBar.hidden !== false || fieldMode !== "lyrics"));
  const arpBtn = button(ICONS.arpeggio, t("arpeggio"), () => mark("arpeggiate"));
  const tremBtn = button(ICONS.tremolo, t("tremolo"), () => tremolo());
  const glissBtn = button(ICONS.glissando, t("glissando"), () => span("glissando", "wavy"));
  const trillLineBtn = button(ICONS.trillLine, t("trillLine"), () => span("trill line"));
  const fingerBtn = button(ICONS.fingering, t("fingering"), () => openField("fingering", lyricBar.hidden !== false || fieldMode !== "fingering"));
  const upBowBtn = button(ICONS.upBow, t("upBow"), () => mark("up-bow"));
  const downBowBtn = button(ICONS.downBow, t("downBow"), () => mark("down-bow"));
  const hammerBtn = button(ICONS.hammerOn, t("hammerOn"), () => span("hammer-on"));
  const pullBtn = button(ICONS.pullOff, t("pullOff"), () => span("pull-off"));
  const bendBtn = button(ICONS.bend, t("bend"), () => bend());
  // Plucks, holes and arrows: each press moves to the next value, then off.
  const cycleBtn = (tag: "pluck" | "hole" | "arrow", icon: string, label: string, values: string[]) =>
    button(icon, t(label), () => {
      const n = selectedNotes()[0];
      if (!n) return;
      const now = techValue(n, tag);
      const next = values[(values.indexOf(now) + 1) % (values.length + 1)] ?? "";
      landed(editor.techValue(n, tag, next));
    });
  // The small accidental over an ornament: sharp, flat, natural, off.
  const ornAccBtn = button(ICONS.ornamentAccidental, t("ornamentAccidental"), () => {
    if (!sel) return;
    const ev = editor.eventAt(sel.at);
    if (!ev || ev.rest) return;
    const order = ["sharp", "flat", "natural"];
    const now = ornamentAccidental(ev.notes[0]);
    landed(editor.ornamentAccidental(sel.at, order[(order.indexOf(now) + 1) % (order.length + 1)] ?? ""));
  });
  const pluckBtn = cycleBtn("pluck", ICONS.pluck, "pluck", ["p", "i", "m", "a"]);
  const holeBtn = cycleBtn("hole", ICONS.hole, "hole", ["yes", "half", "no"]);
  const arrowBtn = cycleBtn("arrow", ICONS.arrow, "arrow", ["up", "down"]);
  // The marks that suit the instrument being edited; "All marks" shows the others too.
  let allMarks = false;
  const allBtn = button(ICONS.more, t("allMarks"), () => {
    allMarks = !allMarks;
    sync();
  });
  row3.append(...markBtns, slurBtn, graceBtn, arpBtn, tremBtn, glissBtn, trillLineBtn, upBowBtn, downBowBtn, hammerBtn, pullBtn, bendBtn, pluckBtn, holeBtn, arrowBtn, ornAccBtn, allBtn);
  textRow.append(chordBtn, staffTextBtn, exprBtn, tempoBtn, rehearsalBtn, lyricsBtn, fingerBtn);
  const MELODIC: PartFamily[] = ["keys", "guitar", "bass", "strings", "winds", "brass", "voice", "other"];
  const ORNATE: PartFamily[] = ["keys", "guitar", "strings", "winds", "brass", "voice", "other"];
  const FRETTED: PartFamily[] = ["guitar", "bass", "other"];
  const markFamilies: Record<string, PartFamily[] | "all"> = {
    accent: "all",
    staccato: "all",
    tenuto: MELODIC,
    "strong-accent": "all",
    fermata: "all",
    "trill-mark": ORNATE,
    mordent: ORNATE,
    "inverted-mordent": ORNATE,
    turn: ORNATE,
    "inverted-turn": ORNATE,
    "delayed-turn": ORNATE,
    shake: ["winds", "brass", "voice", "other"],
    schleifer: ["keys", "strings", "winds", "voice", "other"],
    tap: FRETTED,
  };
  const fits: [HTMLButtonElement, PartFamily[] | "all"][] = [
    ...MARKS.map(([m], i) => [markBtns[i], markFamilies[m] ?? "all"] as [HTMLButtonElement, PartFamily[] | "all"]),
    [slurBtn, MELODIC],
    [graceBtn, "all"],
    [lyricsBtn, ["voice", "other"]],
    [arpBtn, ["keys", "guitar", "strings", "other"]],
    [tremBtn, "all"],
    [glissBtn, MELODIC],
    [trillLineBtn, ORNATE],
    [fingerBtn, ["keys", "guitar", "bass", "strings", "winds", "brass", "other"]],
    [upBowBtn, ["strings", "other"]],
    [downBowBtn, ["strings", "other"]],
    [hammerBtn, FRETTED],
    [pullBtn, FRETTED],
    [bendBtn, FRETTED],
    [pluckBtn, FRETTED],
    [holeBtn, ["winds", "other"]],
    [arrowBtn, FRETTED],
    [ornAccBtn, ORNATE],
  ];

  const toShown = (p: number) => host.shown()?.indexOf(p) ?? p;
  const toFull = (rp: number) => host.shown()?.[rp] ?? rp;
  const fifthsAt = (c: Caret) => editor.info(c.part, Math.min(c.measure, editor.score.measureCount - 1)).fifths;
  const durQ = () => quarters * (2 - 2 ** -dots);

  function sorted(ev: Event): Element[] {
    return [...ev.notes].sort((a, b) => midiOf(readPitch(a) ?? { step: "C", alter: 0, octave: 4 }) - midiOf(readPitch(b) ?? { step: "C", alter: 0, octave: 4 }));
  }

  /** The floating bar over the selected notes (above, else below), inside the score's area. */
  let floatQueued = false;
  function placeFloat(): void {
    floatQueued = false;
    // While text is typed (lyrics below, chord symbols above), the field is the tool: no bar over it.
    const typing = !lyricBar.hidden;
    const notes = view && active && sel && !typing ? Array.from(view.root.querySelectorAll(".sv-sel")) : [];
    const rects = notes.map((n) => n.getBoundingClientRect()).filter((r) => r.width || r.height);
    const area = view?.root.getBoundingClientRect();
    if (!rects.length || !area) return void (floatBar.hidden = true);
    const box = { left: Math.min(...rects.map((r) => r.left)), right: Math.max(...rects.map((r) => r.right)), top: Math.min(...rects.map((r) => r.top)), bottom: Math.max(...rects.map((r) => r.bottom)) };
    // Scrolled out of sight: no bar.
    if (box.bottom < area.top || box.top > area.bottom) return void (floatBar.hidden = true);
    floatBar.hidden = false;
    const w = floatBar.offsetWidth;
    const h = floatBar.offsetHeight;
    const gap = 10;
    let top = box.top - h - gap;
    if (top < area.top + 4) top = box.bottom + gap;
    top = Math.max(area.top + 4, Math.min(top, area.bottom - h - 4));
    const left = Math.max(area.left + 4, Math.min((box.left + box.right) / 2 - w / 2, area.right - w - 4));
    floatBar.style.left = `${left}px`;
    floatBar.style.top = `${top}px`;
  }
  const queueFloat = () => {
    if (floatQueued) return;
    floatQueued = true;
    requestAnimationFrame(placeFloat);
  };

  function sync(): void {
    queueFloat();
    const pressed = (b: HTMLButtonElement, on: boolean) => {
      b.classList.toggle("is-on", on);
      b.setAttribute("aria-pressed", String(on));
    };
    pressed(inputBtn, input);
    pressed(insertBtn, insert);
    pressed(keysBtn, !strip.hidden);
    pressed(marksBtn, !row3.hidden);
    pressed(dynGroupBtn, !dynRow.hidden);
    pressed(textBtn, !textRow.hidden);
    pressed(scoreBtn, !row5.hidden);
    intervalPick.hidden = modePick.value !== "interval";
    keyPick.hidden = modePick.value !== "key";
    const closest = dirPick.querySelector<HTMLOptionElement>('option[value="closest"]')!;
    closest.hidden = closest.disabled = modePick.value !== "key";
    if (modePick.value === "interval" && dirPick.value === "closest") dirPick.value = "up";
    transposeBtn.title = t(sel?.end ? "transposeSelection" : "transposeScore");
    barBefore.disabled = barAfter.disabled = barDelete.disabled = !sel;
    barDelete.disabled ||= editor.score.measureCount < 2;
    changeInstPick.disabled = !sel;
    removeInstBtn.disabled = !sel || editor.score.measures.length < 2;
    pressed(moreDynBtn, moreDyn);
    const dirs = sel ? editor.directions(sel.at) : [];
    for (const [v, b] of dynBtns) {
      b.hidden = !moreDyn && !DYN_MAIN.includes(v);
      pressed(b, dirs.some((d) => d.kind === "dynamic" && d.value === v));
    }
    pressed(crescBtn, dirs.some((d) => d.kind === "wedge" && d.type === "crescendo"));
    pressed(dimBtn, dirs.some((d) => d.kind === "wedge" && d.type === "diminuendo"));
    for (const [b, mode] of [[chordBtn, "chord"], [staffTextBtn, "staff"], [exprBtn, "expression"], [tempoBtn, "tempo"], [rehearsalBtn, "rehearsal"]] as const) pressed(b, !lyricBar.hidden && fieldMode === mode);
    pressed(allBtn, allMarks);
    const part = (sel?.at ?? caret)?.part ?? toFull(0);
    const family = partFamily(editor.score.parts[part] ?? { id: "", name: "", abbreviation: "", program: null });
    for (const [b, families] of fits) b.hidden = !allMarks && families !== "all" && !families.includes(family);
    // Drums have no sharps or flats, and no keyboard to pick a pitch from.
    for (const b of [...accBtns, keysBtn]) b.hidden = family === "drums";
    pressed(slurBtn, !!slurFrom);
    pressed(lyricsBtn, !lyricBar.hidden && fieldMode === "lyrics");
    pressed(fingerBtn, !lyricBar.hidden && fieldMode === "fingering");
    const selMarks = selectedEvents().flatMap(({ ev }) => ev.notes.flatMap(marksOf));
    MARKS.forEach(([m], i) => pressed(markBtns[i], selMarks.includes(m)));
    pressed(arpBtn, selMarks.includes("arpeggiate"));
    pressed(bendBtn, selectedNotes().some((n) => bendsOf(n).length > 0));
    pressed(upBowBtn, selMarks.includes("up-bow"));
    pressed(downBowBtn, selMarks.includes("down-bow"));
    pressed(dotBtn, dots > 0);
    DURATIONS.forEach(([q], i) => pressed(durBtns[i], q === quarters));
    view?.root.classList.toggle("sv-inputting", active && input);
    if (!strip.hidden) stripFor((caret ?? sel?.at)?.part ?? null);
    voiceBtn.innerHTML = `<span class="sv-voice sv-voice-${voiceN}">${voiceN}</span>`;
    undoBtn.disabled = !editor.canUndo;
    redoBtn.disabled = !editor.canRedo;
    if (!view) return;
    view.showCaret(input && caret ? { measure: caret.measure, quarter: caret.pos, part: toShown(caret.part), staff: caret.staff } : null);
    const keys = [];
    const ev = sel ? editor.eventAt(sel.at) : null;
    if (sel?.end) {
      for (const { at, ev: e } of editor.eventsBetween(sel.at, sel.end))
        keys.push({ measure: at.measure, onset: e.pos / editor.info(at.part, at.measure).perQuarter, part: toShown(at.part), staff: at.staff, voice: at.voice });
    } else if (sel && ev) {
      const per = editor.info(sel.at.part, sel.at.measure).perQuarter;
      const base = { measure: sel.at.measure, onset: ev.pos / per, part: toShown(sel.at.part), staff: sel.at.staff, voice: sel.at.voice };
      if (sel.note && ev.notes.includes(sel.note)) keys.push({ ...base, rank: sorted(ev).indexOf(sel.note) });
      else keys.push(base);
    }
    view.select(keys);
  }

  function landed(change: Change): void {
    host.changed(change);
    sync();
  }

  function setInput(on: boolean): void {
    input = on;
    if (input && !caret) {
      const part = toFull(0);
      caret = sel ? { ...sel.at } : { part, measure: 0, staff: 1, voice: editor.voiceId(part, 1, voiceN), pos: 0 };
    }
    sync();
  }

  /** Enters a note, chord or rest at the caret, which moves on; the entered note is selected. */
  function enter(pitches: Pitch[] | null, o: { chord?: boolean; insert?: boolean } = {}): void {
    if (!caret) return;
    if (o.chord && pitches && sel) {
      const change = editor.addToChord(sel.at, pitches[0]);
      // The added note is selected, so arrows move it alone.
      const ev = editor.eventAt(sel.at);
      const added = ev?.notes.find((n) => { const p = readPitch(n); return !!p && midiOf(p) === midiOf(pitches[0]); }) ?? null;
      sel = { at: sel.at, note: added };
      lastPitch = pitches[0];
      landed(change);
      return;
    }
    const at = { ...caret };
    // Inside a tuplet the chosen (written) value lasts its share of the tuplet.
    const ev = editor.eventAt(at);
    const ratio = ev ? ev.notes[0].getElementsByTagName("time-modification")[0] : undefined;
    const scale = ratio ? (Number(ratio.getElementsByTagName("normal-notes")[0]?.textContent) || 2) / (Number(ratio.getElementsByTagName("actual-notes")[0]?.textContent) || 3) : 1;
    const r = editor.enter(at, { pitches, quarters: durQ() * scale }, { insert: insert || o.insert });
    sel = { at, note: null };
    caret = r.caret;
    if (pitches?.length) lastPitch = pitches[0];
    landed(r.change);
  }

  function selectedNotes(): Element[] {
    if (!sel) return [];
    // A grace note on its own.
    if (sel.note && kid(sel.note, "grace") && sel.note.parentElement) return [sel.note];
    const ev = editor.eventAt(sel.at);
    if (!ev || ev.rest) return [];
    return sel.note && ev.notes.includes(sel.note) ? [sel.note] : ev.notes;
  }

  function each(fn: (n: Element) => Change): void {
    const changes = selectedNotes().map(fn);
    if (!changes.length) return;
    landed({ from: Math.min(...changes.map((c) => c.from)), to: Math.max(...changes.map((c) => c.to)), appended: 0 });
  }

  function transpose(semis: number): void {
    each((n) => editor.transpose(n, semis));
    const p = selectedNotes()[0] ? readPitch(selectedNotes()[0]) : null;
    if (p) lastPitch = p;
  }

  function accidental(alter: number): void {
    each((n) => {
      const p = readPitch(n)!;
      return editor.setNotePitch(n, { ...p, alter });
    });
  }

  function setDuration(q: number): void {
    quarters = q;
    dots = 0;
    if (!input && sel) {
      const r = editor.setLength(sel.at, durQ());
      landed(r.change);
    }
    sync();
  }

  function toggleDot(): void {
    dots = dots ? 0 : 1;
    if (!input && sel) landed(editor.setLength(sel.at, durQ()).change);
    sync();
  }

  function rest(): void {
    if (input && caret) enter(null);
    else if (sel) landed(editor.remove(sel.at));
  }

  function tie(): void {
    if (!sel) return;
    const r = editor.tie(sel.at);
    if (input) caret = r.caret;
    landed(r.change);
  }

  function copy(cut: boolean): void {
    if (!sel) return;
    clip = editor.copy(sel.at, sel.end ?? sel.at);
    if (!cut) return;
    const items = editor.eventsBetween(sel.at, sel.end ?? sel.at);
    if (!items.length) return;
    const change = editor.group(() => {
      for (const { at } of [...items].reverse()) editor.remove(at);
      return { from: items[0].at.measure, to: items[items.length - 1].at.measure + 1, appended: 0 };
    });
    sel = { at: items[0].at, note: null };
    landed(change);
  }

  function paste(): void {
    const at = caret ?? sel?.at;
    if (!at || !clip.length) return;
    const r = editor.paste(at, clip);
    sel = { at, note: null, end: undefined };
    caret = r.caret;
    landed(r.change);
  }

  /** A triplet the length of the chosen value at the caret; its slots fill as notes come. */
  function triplet(): void {
    const at = caret ?? sel?.at;
    if (!at) return;
    if (!input) setInput(true);
    caret = { ...at };
    const total = durQ();
    landed(editor.tuplet(caret, total));
    // Then notes of the tuplet's own value, as in MuseScore (eighths in a quarter triplet).
    quarters = total / 2;
    dots = 0;
    sync();
  }

  /** The selected events: the range, or the one selected (the last entered in note input). */
  function selectedEvents(): { at: Caret; ev: Event }[] {
    if (!sel) return [];
    if (sel.end) return editor.eventsBetween(sel.at, sel.end);
    const ev = editor.eventAt(sel.at);
    return ev ? [{ at: sel.at, ev }] : [];
  }

  /** Puts a mark on the selected notes, or takes it off when they all have it. */
  function mark(m: string): void {
    const items = selectedEvents().filter(({ ev }) => !ev.rest || m === "fermata");
    if (!items.length) return;
    const on = !items.every(({ ev }) => ev.notes.some((n) => marksOf(n).includes(m)));
    const change = editor.group(() => {
      for (const { at } of items) editor.mark(at, m, on);
      return { from: items[0].at.measure, to: items[items.length - 1].at.measure + 1, appended: 0 };
    });
    landed(change);
  }

  /**
   * A slur: over the selected range; from the selected note to the next; or, in note input,
   * from the note where S was pressed to the note where it is pressed again.
   */
  function slur(): void {
    if (!sel) return;
    if (sel.end) return landed(editor.slur(sel.at, sel.end));
    if (input) {
      if (!slurFrom) {
        slurFrom = { ...sel.at };
        return sync();
      }
      const from = slurFrom;
      slurFrom = null;
      return landed(editor.slur(from, sel.at, { add: true }));
    }
    landed(editor.slur(sel.at, null));
  }

  /** A grace note before the selected note, at its pitch; it is selected so arrows move it. */
  function grace(slash: boolean): void {
    if (!sel) return;
    const r = editor.addGrace(sel.at, undefined, slash);
    if (!r.grace) return;
    sel = { at: sel.at, note: r.grace };
    const p = readPitch(r.grace);
    if (p) lastPitch = p;
    landed(r.change);
  }

  // ---- The text field, for lyrics or fingerings. Lyrics: the selected note's syllable;
  // space or "-" moves to the next note (a hyphen joins a word's syllables). Fingerings: one
  // note at a time, a chord from its lowest note up. Enter moves on too, Escape closes.
  type FieldMode = "lyrics" | "fingering" | "chord" | TextKind | "tempo";
  let fieldMode: FieldMode = "lyrics";
  let hyphenBefore = false;
  let fingerIndex = 0;
  const HINT: Record<FieldMode, [string, string]> = { chord: ["chordHint", "chordSymbol"], lyrics: ["lyricsHint", "lyrics"], fingering: ["fingeringHint", "fingering"], staff: ["textHint", "staffText"], expression: ["textHint", "expressionText"], rehearsal: ["textHint", "rehearsalMark"], tempo: ["tempoHint", "tempoMark"] };
  /** Text marks: one per beat, Enter sets it (empty takes it off) and closes. */
  const oneShot = (m: FieldMode) => m !== "lyrics" && m !== "fingering" && m !== "chord";
  function openField(mode: FieldMode, open: boolean): void {
    if (!open) {
      lyricBar.hidden = true;
      sync();
      el.closest<HTMLElement>(".sv-shell")?.focus({ preventScroll: true });
      return;
    }
    if (!sel) return;
    if (input) setInput(false);
    fieldMode = mode;
    lyricInput.placeholder = t(HINT[mode][0]);
    lyricInput.setAttribute("aria-label", t(HINT[mode][1]));
    lyricInput.inputMode = mode === "fingering" ? "numeric" : "text";
    lyricBar.hidden = false;
    hyphenBefore = false;
    fingerIndex = 0;
    showField();
    lyricInput.focus();
    sync();
  }
  const openLyrics = (open: boolean) => openField("lyrics", open);
  function fingerNote(): Element | null {
    const ev = sel ? editor.eventAt(sel.at) : null;
    return ev && !ev.rest ? (sorted(ev)[fingerIndex] ?? null) : null;
  }
  function showField(): void {
    const ev = sel ? editor.eventAt(sel.at) : null;
    if (oneShot(fieldMode)) {
      const d = sel ? editor.directions(sel.at).find((x) => (fieldMode === "tempo" ? x.kind === "tempo" : x.kind === "text" && x.text === fieldMode)) : undefined;
      lyricInput.value = d && (d.kind === "text" || d.kind === "tempo") ? d.words.trim() : "";
    } else if (fieldMode === "chord") {
      lyricInput.value = sel ? editor.chordSymbolAt(sel.at) : "";
    } else if (fieldMode === "fingering") {
      const n = fingerNote();
      lyricInput.value = n ? fingeringOf(n) : "";
      if (sel) sel = { ...sel, note: n };
    } else lyricInput.value = ev && !ev.rest ? (lyricsOf(ev.notes[0])[0]?.text ?? "") : "";
  }
  function commitField(hyphen: boolean): void {
    if (!sel) return;
    const words = lyricInput.value.trim();
    if (fieldMode === "tempo") {
      const bpm = tempoOf(words);
      // "Allegro 132" or "Allegro = 132" is drawn as "Allegro ♩ = 132".
      const m = /^(.*?)\s*=?\s*(\d+(?:\.\d+)?)$/.exec(words);
      const drawn = m && !/[♩♪𝅗𝅥]/.test(words) ? `${m[1]} ♩ = ${m[2]}`.trim() : words;
      landed(editor.tempo(sel.at, words ? bpm : null, drawn));
      return openField(fieldMode, false);
    }
    if (oneShot(fieldMode)) {
      landed(editor.text(sel.at, fieldMode as TextKind, words || null));
      return openField(fieldMode, false);
    }
    if (fieldMode === "chord") {
      // A chord symbol, then the next note; what does not read as a chord stays to be fixed.
      if (words !== editor.chordSymbolAt(sel.at)) {
        const r = editor.chordSymbol(sel.at, words || null);
        if (!r.ok) {
          lyricInput.select();
          lyricInput.setAttribute("aria-invalid", "true");
          return;
        }
        landed(r.change);
      }
      lyricInput.removeAttribute("aria-invalid");
      const next = editor.nextEvent(sel.at, true);
      if (next) sel = { at: next, note: null };
      showField();
      sync();
      return;
    }
    if (fieldMode === "fingering") {
      const n = fingerNote();
      if (n && words !== fingeringOf(n)) landed(editor.fingering(n, words));
      const ev = editor.eventAt(sel.at);
      if (ev && fingerIndex + 1 < ev.notes.length) fingerIndex++;
      else {
        fingerIndex = 0;
        const next = editor.nextEvent(sel.at);
        if (next) sel = { at: next, note: null };
      }
    } else {
      if (words) {
        const syllabic = hyphenBefore ? (hyphen ? "middle" : "end") : hyphen ? "begin" : "single";
        landed(editor.lyric(sel.at, words, syllabic));
      }
      hyphenBefore = hyphen && !!words;
      const next = editor.nextEvent(sel.at);
      if (next) sel = { at: next, note: null };
    }
    showField();
    sync();
  }
  lyricInput.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (oneShot(fieldMode)) {
      if (e.key === "Enter") {
        e.preventDefault();
        commitField(false);
      } else if (e.key === "Escape") {
        e.preventDefault();
        openField(fieldMode, false);
      }
      return;
    }
    if (e.key === " " || e.key === "Enter" || (e.key === "-" && fieldMode === "lyrics")) {
      e.preventDefault();
      commitField(e.key === "-");
    } else if (e.key === "Escape") {
      e.preventDefault();
      openField(fieldMode, false);
    }
  });

  /** Transposes the selected bars and parts, or the whole score. */
  function transposeNow(): void {
    const range = sel?.end ? [sel.at, sel.end].sort((a, b) => a.measure - b.measure) : null;
    const from = range ? range[0].measure : 0;
    const to = range ? range[1].measure + 1 : editor.score.measureCount;
    const shown = host.shown();
    let parts: number[] | null = null;
    if (range) {
      const lo = Math.min(range[0].part, range[1].part);
      const hi = Math.max(range[0].part, range[1].part);
      parts = editor.score.parts.map((_, p) => p).filter((p) => p >= lo && p <= hi && (!shown || shown.includes(p)));
    } else if (shown) parts = shown;
    const dir = dirPick.value as "up" | "down" | "closest";
    let [steps, semis] = INTERVALS[intervalPick.value];
    if (modePick.value === "key") [steps, semis] = intervalToKey(editor.info(parts?.[0] ?? 0, from).fifths, Number(keyPick.value), dir);
    else if (dir === "down") [steps, semis] = [-steps, -semis];
    landed(editor.transposeRange(parts, from, to, steps, semis));
  }

  /** A dynamic at the selected note (pressing the one already there takes it off). */
  function dynamic(value: string): void {
    if (!sel) return;
    const now = editor.directions(sel.at).some((d) => d.kind === "dynamic" && d.value === value);
    landed(editor.dynamic(sel.at, now ? null : value));
  }

  /** A hairpin over the selected range, else from the selected note to the next (again: off). */
  function hairpin(type: "crescendo" | "diminuendo"): void {
    if (!sel) return;
    const now = editor.directions(sel.at).some((d) => d.kind === "wedge" && d.type === type);
    landed(editor.hairpin(sel.at, sel.end ?? null, now ? null : type));
  }

  /** A glissando, trill line or two-note tremolo over the selected range, else from the selected note to the next. */
  function span(kind: string, value?: string): void {
    if (!sel) return;
    const end = sel.end ?? (kind === "trill line" ? sel.at : null);
    landed(editor.span(kind, sel.at, end, { value }));
  }

  /** A bend on the selected note, one press after another: full, full and released, half, none. */
  function bend(): void {
    const n = selectedNotes()[0];
    if (!n) return;
    const now = bendsOf(n);
    const state = !now.length ? 0 : now.some((b) => b.release) ? 2 : now[0].alter >= 2 ? 1 : 3;
    const next: Bend[][] = [[{ alter: 2 }], [{ alter: 2 }, { alter: 2, release: true }], [{ alter: 1 }], []];
    landed(editor.bends(n, next[state]));
  }

  /** A tremolo: between the two selected notes, else on the selected one (on or off). */
  function tremolo(): void {
    if (!sel) return;
    const items = selectedEvents();
    if (items.length === 2) return landed(editor.span("tremolo", items[0].at, items[1].at, { value: "3" }));
    const ev = editor.eventAt(sel.at);
    if (!ev || ev.rest) return;
    landed(editor.tremolo(sel.at, tremoloOf(ev.notes[0]) ? 0 : 3));
  }

  function remove(): void {
    if (!sel) return;
    if (sel.note && kid(sel.note, "grace")) {
      landed(editor.removeGrace(sel.note));
      sel = { at: sel.at, note: null };
      return sync();
    }
    if (sel.end) {
      const items = editor.eventsBetween(sel.at, sel.end);
      const change = editor.group(() => {
        for (const { at } of [...items].reverse()) editor.remove(at);
        return { from: items[0]?.at.measure ?? sel!.at.measure, to: (items[items.length - 1]?.at.measure ?? sel!.at.measure) + 1, appended: 0 };
      });
      sel = items[0] ? { at: items[0].at, note: null } : null;
      return landed(change);
    }
    landed(editor.remove(sel.at, sel.note ?? undefined));
    sel = editor.eventAt(sel.at) ? { at: sel.at, note: null } : null;
    sync();
  }

  function undo(): void {
    const c = editor.undo();
    if (c) {
      sel = null;
      landed({ ...c, to: Math.max(c.to, c.from + 1) });
    }
  }
  function redo(): void {
    const c = editor.redo();
    if (c) {
      sel = null;
      landed({ ...c, to: Math.max(c.to, c.from + 1) });
    }
  }

  /** The event before or after the selection (or caret) in its voice. */
  function step(dir: 1 | -1, extend = false): void {
    const from = (extend ? sel?.end : null) ?? sel?.at ?? caret;
    if (!from) return;
    const s = editor.score;
    const key = voiceKey(from.staff, from.voice);
    const per = (m: number) => editor.info(from.part, m).perQuarter;
    const evs = (m: number) => (s.measures[from.part][m] ? readMeasure(s.measures[from.part][m]).voices.get(key) ?? [] : []);
    let m = from.measure;
    const here = evs(m);
    const pos = Math.round(from.pos * per(m));
    let i = here.findIndex((e) => e.pos <= pos && pos < e.pos + e.dur);
    i = i < 0 ? (dir > 0 ? -1 : here.length) : i;
    let list = here;
    i += dir;
    while (i < 0 || i >= list.length) {
      m += dir;
      if (m < 0 || m >= s.measureCount) return;
      list = evs(m);
      i = dir > 0 ? 0 : list.length - 1;
    }
    const at = { ...from, measure: m, pos: list[i].pos / per(m) };
    if (extend && sel) sel = { ...sel, note: null, end: at };
    else {
      sel = { at, note: null };
      caret = { ...at };
    }
    sync();
  }

  // ---- Taps on the score: select, or in note input, enter a note where the staff is touched.
  // A long press shows the pitch in a bubble and lets the finger slide to another line.
  const bubble = document.createElement("div");
  bubble.className = "sv-loupe";
  bubble.hidden = true;
  let press: { x: number; y: number; t: number; id: number; held: boolean; timer: number; shift: boolean; pan?: { x: number; y: number; vx: number; vy: number; t: number } } | null = null;
  // In note input the page does not pan by itself (a held finger slides to pick a pitch),
  // so a moving finger scrolls it here, with a fling when it lets go.
  let touches = 0;
  let fling = 0;
  function glide(vx: number, vy: number): void {
    cancelAnimationFrame(fling);
    let last = performance.now();
    const stepF = (now: number) => {
      const dt = now - last;
      last = now;
      if (!view || Math.hypot(vx, vy) < 0.02) return;
      view.root.scrollBy(-vx * dt, -vy * dt);
      const k = Math.exp(-dt / 325);
      vx *= k;
      vy *= k;
      fling = requestAnimationFrame(stepF);
    };
    fling = requestAnimationFrame(stepF);
  }

  function pitchFor(p: Pick): { caret: Caret; pitch: Pitch | null } {
    const part = toFull(p.part);
    const voice = editor.voiceId(part, p.staff, voiceN);
    // A tab staff drawn from a notation staff is written through that staff.
    const link = editor.fretted(part);
    const staff = link?.tab === p.staff && link.notation !== null ? link.notation : p.staff;
    const at: Caret = { part, measure: p.measure, staff, voice: staff === p.staff ? voice : editor.voiceId(part, staff, voiceN), pos: p.quarter };
    const clef = clefAt(editor.score, part, p.measure, p.staff);
    const pitch = pitchOnStaff(clef, p.lines, p.step, editor.info(part, p.measure).fifths);
    // A drum staff: the drum the part already draws on that line.
    if (pitch && (clef.sign === "percussion" || editor.isDrums(part))) return { caret: at, pitch: editor.drumAt(part, pitch.step, pitch.octave, p.lines === 1 ? 99 : 1) };
    return { caret: at, pitch };
  }

  function showBubble(p: Pick | null, x: number): void {
    const pitch = p ? pitchFor(p).pitch : null;
    if (!p || !pitch) return void (bubble.hidden = true);
    bubble.textContent = pitch.unpitched ? editor.drumName(pitch.instrument) || nameOf(pitch) : nameOf(pitch);
    bubble.hidden = false;
    bubble.style.left = `${x}px`;
    bubble.style.top = `${p.snapY}px`;
  }

  function tap(p: Pick, shiftKey: boolean): void {
    const part = toFull(p.part);
    if (input) {
      const { caret: at, pitch } = pitchFor(p);
      if (shiftKey && pitch && sel) return enter([pitch], { chord: true });
      caret = at;
      if (pitch) enter([pitch]);
      else sync();
      return;
    }
    if (shiftKey && sel && part === sel.at.part) {
      const staff = p.note?.staff ?? p.staff;
      if (staff === sel.at.staff) {
        sel = { ...sel, note: null, end: { ...sel.at, measure: p.note?.measure ?? p.measure, pos: p.note?.onset ?? p.quarter } };
        return sync();
      }
    }
    if (p.note) {
      const at: Caret = { part, measure: p.note.measure, staff: p.note.staff, voice: p.note.voice, pos: p.note.onset };
      const ev = editor.eventAt(at);
      const note = ev && !ev.rest && p.note.rank >= 0 ? sorted(ev)[p.note.rank] ?? null : null;
      sel = { at, note };
      const pp = note ? readPitch(note) : null;
      if (pp) lastPitch = pp;
    } else {
      const at: Caret = { part, measure: p.measure, staff: p.staff, voice: editor.voiceId(part, p.staff, voiceN), pos: p.quarter };
      sel = editor.eventAt(at) ? { at, note: null } : null;
    }
    caret = sel ? { ...sel.at } : caret;
    sync();
  }

  const onDown = (e: PointerEvent) => {
    if (!active || !e.isPrimary || e.button > 0) return;
    cancelAnimationFrame(fling);
    press = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId, held: false, shift: e.shiftKey, timer: 0 };
    if (input && e.pointerType !== "mouse") {
      const p = press;
      p.timer = window.setTimeout(() => {
        p.held = true;
        showBubble(view?.pick(p.x, p.y) ?? null, p.x);
      }, 280);
    }
  };
  const onMove = (e: PointerEvent) => {
    if (!press || e.pointerId !== press.id) return;
    if (press.held) showBubble(view?.pick(press.x, e.clientY) ?? null, press.x);
    else if (press.pan) {
      const now = performance.now();
      const dx = e.clientX - press.pan.x;
      const dy = e.clientY - press.pan.y;
      if (touches < 2) view?.root.scrollBy(-dx, -dy);
      const dt = Math.max(1, now - press.pan.t);
      press.pan = { x: e.clientX, y: e.clientY, vx: dx / dt, vy: dy / dt, t: now };
    } else if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > 8) {
      clearTimeout(press.timer);
      if (input && e.pointerType !== "mouse") press.pan = { x: e.clientX, y: e.clientY, vx: 0, vy: 0, t: performance.now() };
      else press = null;
    }
  };
  const onUp = (e: PointerEvent) => {
    const p = press;
    press = null;
    bubble.hidden = true;
    if (!p || e.pointerId !== p.id || !view) return;
    clearTimeout(p.timer);
    if (p.pan) {
      if (performance.now() - p.pan.t < 80 && touches < 2) glide(p.pan.vx, p.pan.vy);
      return;
    }
    const pk = view.pick(p.x, p.held ? e.clientY : p.y);
    if (pk) tap(pk, p.shift || e.shiftKey);
    el.closest<HTMLElement>(".sv-shell")?.focus({ preventScroll: true });
  };
  // Sliding a held finger picks a pitch, so the page must not scroll meanwhile.
  const onTouchMove = (e: TouchEvent) => {
    touches = e.touches.length;
    if (press?.held) e.preventDefault();
  };
  const onTouchStart = (e: TouchEvent) => {
    touches = e.touches.length;
    // A second finger is a pinch: no note, no pan.
    if (touches > 1 && press) {
      clearTimeout(press.timer);
      press = null;
      bubble.hidden = true;
    }
  };
  // Android's own long press (selection, menu) would take the finger away.
  const onMenu = (e: MouseEvent) => {
    if (active && input) e.preventDefault();
  };
  const onCancel = () => {
    if (press) clearTimeout(press.timer);
    press = null;
    bubble.hidden = true;
  };

  function attach(v: PageView | null): void {
    if (view) {
      view.root.removeEventListener("pointerdown", onDown);
      view.root.removeEventListener("pointermove", onMove);
      view.root.removeEventListener("pointerup", onUp);
      view.root.removeEventListener("pointercancel", onCancel);
      view.root.removeEventListener("touchmove", onTouchMove);
      view.root.removeEventListener("touchstart", onTouchStart);
      view.root.removeEventListener("contextmenu", onMenu);
      view.root.removeEventListener("scroll", queueFloat);
      view.root.classList.remove("sv-inputting");
    }
    view = v;
    if (!v) return;
    v.root.addEventListener("pointerdown", onDown);
    v.root.addEventListener("pointermove", onMove);
    v.root.addEventListener("pointerup", onUp);
    v.root.addEventListener("pointercancel", onCancel);
    v.root.addEventListener("touchmove", onTouchMove, { passive: false });
    v.root.addEventListener("touchstart", onTouchStart, { passive: true });
    v.root.addEventListener("contextmenu", onMenu);
    v.root.addEventListener("scroll", queueFloat, { passive: true });
    if (active) requestAnimationFrame(sync);
  }

  // The pitch strip: a key enters that pitch, or gives the selected note that pitch.
  kb.canvas.addEventListener("pointerdown", (e) => {
    const r = kb.canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    let hit: number | null = null;
    for (const [m, k] of kb.geometry) if (k.black && y < r.height * 0.62 && x >= k.x && x < k.x + k.w) hit = m;
    if (hit === null) for (const [m, k] of kb.geometry) if (!k.black && x >= k.x && x < k.x + k.w) hit = m;
    if (hit === null) return;
    const at = caret ?? sel?.at;
    const pitch = spellMidi(hit, at ? fifthsAt(at) : 0);
    if (input && caret) enter([pitch], { chord: e.shiftKey });
    else if (selectedNotes().length === 1) each((n) => editor.setNotePitch(n, pitch));
    lastPitch = pitch;
  });

  /** The octave of `step` nearest the last pitch (middle of the treble staff at first). */
  function nearest(step: string, at: Caret): Pitch {
    const ref = lastPitch ? midiOf(lastPitch) : 71;
    const alter = keyAlter(step, fifthsAt(at));
    let best: Pitch = { step, alter, octave: 4 };
    for (let o = 0; o <= 8; o++) {
      const p = { step, alter, octave: o };
      if (Math.abs(midiOf(p) - ref) < Math.abs(midiOf(best) - ref)) best = p;
    }
    return best;
  }

  function key(e: KeyboardEvent): boolean {
    if (!active || e.target instanceof HTMLInputElement) return false;
    const k = e.key;
    const mod = e.ctrlKey || e.metaKey;
    // MuseScore's keys for marks, slurs, grace notes and lyrics.
    if (!mod && !e.altKey && e.shiftKey) {
      const m = { S: "staccato", V: "accent", N: "tenuto", O: "strong-accent" }[k.toUpperCase()];
      if (m) return mark(m), true;
    }
    if (!mod && !e.altKey && !e.shiftKey && (k === "s" || k === "S")) return slur(), true;
    if (!mod && e.code === "Slash") return grace(!e.altKey), true;
    if (mod && !e.altKey && (k === "l" || k === "L")) return openLyrics(true), true;
    // MuseScore's: staff text, expression, tempo, rehearsal mark, hairpins.
    if (mod && !e.altKey && (k === "t" || k === "T")) return openField("staff", true), true;
    if (mod && !e.altKey && (k === "e" || k === "E")) return openField("expression", true), true;
    if (!mod && e.altKey && e.code === "KeyT") return openField("tempo", true), true;
    if (mod && !e.altKey && (k === "m" || k === "M")) return openField("rehearsal", true), true;
    if (mod && !e.altKey && (k === "k" || k === "K")) return openField("chord", true), true;
    if (!mod && !e.altKey && (k === "<" || k === ">")) return hairpin(k === "<" ? "crescendo" : "diminuendo"), true;
    if (mod && !e.altKey && (k === "z" || k === "Z")) {
      if (e.shiftKey) redo();
      else undo();
      return true;
    }
    if (mod && (k === "y" || k === "Y")) return redo(), true;
    if (mod && !e.altKey && e.code === "Digit3") return triplet(), true;
    if (mod && !e.altKey && (k === "c" || k === "C")) return copy(false), true;
    if (mod && !e.altKey && (k === "x" || k === "X")) return copy(true), true;
    if (mod && !e.altKey && (k === "v" || k === "V")) return paste(), true;
    if (mod && e.altKey && /^[1-4]$/.test(e.code.replace("Digit", ""))) {
      voiceN = Number(e.code.replace("Digit", ""));
      if (caret) caret = { ...caret, voice: editor.voiceId(caret.part, caret.staff, voiceN) };
      sync();
      return true;
    }
    if ((k === "n" || k === "N") && !e.shiftKey) {
      if (mod) return false;
      setInput(!input);
      return true;
    }
    if (k === "Escape") {
      if (input) setInput(false);
      else {
        sel = null;
        sync();
      }
      return true;
    }
    const letter = /^[a-gA-G]$/.test(k) ? k.toUpperCase() : null;
    if (letter && !e.altKey) {
      if (!input) setInput(true);
      const at = caret!;
      const p = nearest(letter, at);
      if (e.shiftKey && mod) enter([p], { insert: true });
      else if (e.shiftKey) enter([p], { chord: true });
      else if (!mod) enter([p]);
      else return false;
      return true;
    }
    if (!mod && KEY_QUARTERS[k] !== undefined) return setDuration(KEY_QUARTERS[k]), true;
    if (k === "0" && !mod) return rest(), true;
    if (k === ".") return toggleDot(), true;
    if (k === "+") return tie(), true;
    if (k === "Delete" || k === "Backspace") return remove(), true;
    if (k === "ArrowUp" || k === "ArrowDown") {
      transpose((k === "ArrowUp" ? 1 : -1) * (mod ? 12 : 1));
      return true;
    }
    if (k === "ArrowLeft" || k === "ArrowRight") return step(k === "ArrowLeft" ? -1 : 1, e.shiftKey), true;
    return false;
  }

  return {
    el,
    start() {
      active = true;
      el.hidden = false;
      document.body.append(bubble);
      (el.closest(".sv-shell") ?? document.body).append(floatBar);
      window.addEventListener("resize", queueFloat);
      sync();
    },
    stop() {
      active = false;
      el.hidden = true;
      input = false;
      slurFrom = null;
      lyricBar.hidden = true;
      view?.root.classList.remove("sv-inputting");
      bubble.remove();
      floatBar.remove();
      window.removeEventListener("resize", queueFloat);
      view?.showCaret(null);
      view?.select([]);
    },
    attach,
    key,
    reset() {
      editor = new ScoreEditor(host.score());
      caret = null;
      sel = null;
      sync();
    },
  };
}

/** A key's name, major and minor: "D major / B minor". */
export function keyName(fifths: number): string {
  const names = t("noteNames").split(" ");
  const MAJOR = ["C♭", "G♭", "D♭", "A♭", "E♭", "B♭", "F", "C", "G", "D", "A", "E", "B", "F♯", "C♯"];
  const MINOR = ["A♭", "E♭", "B♭", "F", "C", "G", "D", "A", "E", "B", "F♯", "C♯", "G♯", "D♯", "A♯"];
  const local = (n: string) => (names[("CDEFGAB".indexOf(n[0]))] ?? n[0]) + n.slice(1);
  return t("keyName").replace("{0}", local(MAJOR[fifths + 7])).replace("{1}", local(MINOR[fifths + 7]));
}
