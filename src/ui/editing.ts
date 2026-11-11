import { ScoreEditor, type Caret, type Change, type Clip } from "../edit/editor";
import { readMeasure, voiceKey, type Event } from "../edit/measure";
import { keyAlter, lyricsOf, marksOf, midiOf, readPitch, spellMidi, type Pitch } from "../edit/notes";
import type { ScoreDoc } from "../model/score";
import { kid, kids, text } from "../model/xml";
import type { PageView, Pick } from "../render/page-view";
import { t } from "./i18n";
import { partFamily } from "../model/score";
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
  accent: svg('<polyline points="5 7 19 12 5 17"/>'),
  staccato: svg('<circle cx="12" cy="12" r="3" fill="currentColor"/>'),
  tenuto: svg('<line x1="5" x2="19" y1="12" y2="12" stroke-width="3"/>'),
  marcato: svg('<polyline points="6 18 12 6 18 18"/>'),
  fermata: svg('<path d="M4 16a8 8 0 0 1 16 0"/><circle cx="12" cy="15" r="1.8" fill="currentColor"/>'),
  trill: svg('<text x="12" y="17" text-anchor="middle" font-size="13" font-style="italic" font-weight="700" fill="currentColor" stroke="none">tr</text>'),
  mordent: svg('<polyline points="3 14 7 9 10 14 14 9 17 14 21 9"/><line x1="12" x2="12" y1="5" y2="19"/>'),
  slur: svg('<path d="M3 15c5-9 13-9 18 0"/>'),
  grace: svg('<ellipse cx="9" cy="17" rx="3.2" ry="2.3" transform="rotate(-20 9 17)" fill="currentColor"/><line x1="12" x2="12" y1="16" y2="5"/><path d="M12 5q4 2 3 6"/><line x1="7" x2="17" y1="12" y2="7"/>'),
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
  rows.append(row1, row2, row3);
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
  const marksBtn = button(ICONS.marks, t("marks"), () => {
    row3.hidden = !row3.hidden;
    sync();
  });
  row2.append(...accBtns, voiceBtn, insertBtn, delBtn, undoBtn, redoBtn, keysBtn, marksBtn, doneBtn);
  const MARKS: [mark: string, icon: string, label: string][] = [
    ["accent", ICONS.accent, "accent"],
    ["staccato", ICONS.staccato, "staccato"],
    ["tenuto", ICONS.tenuto, "tenuto"],
    ["strong-accent", ICONS.marcato, "marcato"],
    ["fermata", ICONS.fermata, "fermata"],
    ["trill-mark", ICONS.trill, "trill"],
    ["mordent", ICONS.mordent, "mordent"],
  ];
  const markBtns = MARKS.map(([m, icon, label]) => button(icon, t(label), () => mark(m)));
  const slurBtn = button(ICONS.slur, t("slur"), () => slur());
  const graceBtn = button(ICONS.grace, t("graceNote"), () => grace(true));
  const lyricsBtn = button(ICONS.lyrics, t("lyrics"), () => openLyrics(lyricBar.hidden !== false));
  row3.append(...markBtns, slurBtn, graceBtn, lyricsBtn);

  const toShown = (p: number) => host.shown()?.indexOf(p) ?? p;
  const toFull = (rp: number) => host.shown()?.[rp] ?? rp;
  const fifthsAt = (c: Caret) => editor.info(c.part, Math.min(c.measure, editor.score.measureCount - 1)).fifths;
  const durQ = () => quarters * (2 - 2 ** -dots);

  function sorted(ev: Event): Element[] {
    return [...ev.notes].sort((a, b) => midiOf(readPitch(a) ?? { step: "C", alter: 0, octave: 4 }) - midiOf(readPitch(b) ?? { step: "C", alter: 0, octave: 4 }));
  }

  function sync(): void {
    const pressed = (b: HTMLButtonElement, on: boolean) => {
      b.classList.toggle("is-on", on);
      b.setAttribute("aria-pressed", String(on));
    };
    pressed(inputBtn, input);
    pressed(insertBtn, insert);
    pressed(keysBtn, !strip.hidden);
    pressed(marksBtn, !row3.hidden);
    pressed(slurBtn, !!slurFrom);
    pressed(lyricsBtn, !lyricBar.hidden);
    const selMarks = selectedEvents().flatMap(({ ev }) => ev.notes.flatMap(marksOf));
    MARKS.forEach(([m], i) => pressed(markBtns[i], selMarks.includes(m)));
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

  // ---- Lyrics: the field takes the selected note's syllable; space or "-" moves to the next
  // note (a hyphen joins the syllables of a word), Enter too, Escape closes.
  let hyphenBefore = false;
  function openLyrics(open: boolean): void {
    if (!open) {
      lyricBar.hidden = true;
      sync();
      el.closest<HTMLElement>(".sv-shell")?.focus({ preventScroll: true });
      return;
    }
    if (!sel) return;
    if (input) setInput(false);
    lyricBar.hidden = false;
    hyphenBefore = false;
    showLyric();
    lyricInput.focus();
    sync();
  }
  function showLyric(): void {
    const ev = sel ? editor.eventAt(sel.at) : null;
    lyricInput.value = ev && !ev.rest ? (lyricsOf(ev.notes[0])[0]?.text ?? "") : "";
  }
  function commitLyric(hyphen: boolean): void {
    if (!sel) return;
    const words = lyricInput.value.trim();
    if (words) {
      const syllabic = hyphenBefore ? (hyphen ? "middle" : "end") : hyphen ? "begin" : "single";
      landed(editor.lyric(sel.at, words, syllabic));
    }
    hyphenBefore = hyphen && !!words;
    const next = editor.nextEvent(sel.at);
    if (next) sel = { at: next, note: null };
    showLyric();
    sync();
  }
  lyricInput.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === " " || e.key === "Enter" || e.key === "-") {
      e.preventDefault();
      commitLyric(e.key === "-");
    } else if (e.key === "Escape") {
      e.preventDefault();
      openLyrics(false);
    }
  });

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
