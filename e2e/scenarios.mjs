// The edit-mode scenarios. Each one says, for someone who does not read music, what it does
// (`why`), what to look for in the screenshot (`look`), and checks the result through what
// the score now holds and what playback would sound.

// Page-side helpers: read the score back as words, find points on the page.
export const HELPERS = `(() => {
  const NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
  const ALTER = { "-2": "𝄫", "-1": "♭", "0": "", "1": "♯", "2": "𝄪" };
  const DRUMS = { 35: "Bass Drum", 36: "Bass Drum", 38: "Snare", 40: "Snare", 42: "Hi-Hat", 46: "Open Hi-Hat", 49: "Crash" };
  const kidsOf = (el, tag) => [...el.children].filter((c) => c.tagName === tag);
  const txt = (el, tag) => (el && tag ? kidsOf(el, tag)[0] : el)?.textContent?.trim() ?? "";
  const deep = (el, tag) => el.getElementsByTagName(tag)[0]?.textContent?.trim() ?? "";
  const midiName = (m) => NAMES[m % 12] + (Math.floor(m / 12) - 1);
  const frac = (x) => {
    const w = Math.floor(x + 1e-6);
    const f = Math.round((x - w) * 12);
    const F = { 0: "", 3: "¼", 4: "⅓", 6: "½", 8: "⅔", 9: "¾" }[f] ?? "+" + (x - w).toFixed(2);
    return w === 0 && F ? F : w + F;
  };
  const noteName = (score, n) => {
    const u = kidsOf(n, "unpitched")[0];
    if (u) {
      const id = kidsOf(n, "instrument")[0]?.getAttribute("id");
      const si = [...score.root.getElementsByTagName("score-instrument")].find((s) => s.getAttribute("id") === id);
      return si ? txt(si, "instrument-name") : txt(u, "display-step") + txt(u, "display-octave");
    }
    const p = kidsOf(n, "pitch")[0];
    if (!p) return "rest";
    return txt(p, "step") + (ALTER[txt(p, "alter") || "0"] ?? "?") + txt(p, "octave");
  };
  const value = (n) => {
    if (kidsOf(n, "rest")[0]?.getAttribute("measure") === "yes") return "whole bar";
    const dots = kidsOf(n, "dot").length;
    return (dots === 1 ? "dotted " : dots === 2 ? "double-dotted " : "") + (txt(n, "type") || "?") + (kidsOf(n, "time-modification").length ? " (triplet)" : "");
  };
  const STEPS = "CDEFGAB";
  const diatonic = (name) => {
    const m = /^([A-G])[^0-9-]*(-?\\d)$/.exec(name);
    return Number(m[2]) * 7 + STEPS.indexOf(m[1]);
  };
  const center = (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  };
  window.e2e = {
    bars(part, staff, score = viewer.score) {
      return score.measures[part].map((m) => {
        const notes = kidsOf(m, "note").filter((n) => (Number(txt(n, "staff")) || 1) === staff && !kidsOf(n, "grace").length);
        const voices = [...new Set(notes.map((n) => txt(n, "voice") || "1"))].sort((a, b) => a - b);
        const out = [];
        for (const n of notes.filter((n) => (txt(n, "voice") || "1") === voices[0])) {
          const name = noteName(score, n);
          if (kidsOf(n, "chord").length && out.length) {
            out[out.length - 1].names.push(name);
            continue;
          }
          const tie = kidsOf(n, "tie").some((t) => t.getAttribute("type") === "start") ? " (tied to the next)" : "";
          const tech = n.getElementsByTagName("fret")[0] ? " (string " + deep(n, "string") + ", fret " + deep(n, "fret") + ")" : "";
          out.push({ names: [name], v: value(n), tie, tech });
        }
        return out.map((e) => (e.names[0] === "rest" ? (e.v === "whole bar" ? "whole-bar rest" : e.v + " rest") : e.names.join("+") + " " + e.v + e.tie + e.tech)).join(", ");
      });
    },
    sounds() {
      const tl = scoreditLib.buildTimeline(viewer.score);
      const perBeat = 60 / 100;
      return [...tl.events]
        .sort((a, b) => a.time - b.time || a.midi - b.midi)
        .map((e) => {
          const name = e.program === 128 ? DRUMS[e.midi] ?? "drum " + e.midi : midiName(e.midi);
          const beats = e.dur / perBeat;
          return name + " at bar " + (e.measure + 1) + " beat " + frac(e.onset + 1) + (e.program === 128 ? "" : " for " + frac(beats) + (Math.abs(beats - 1) < 1e-3 || beats < 1 ? " beat" : " beats"));
        });
    },
    staffPoint(bar, beat, staff, pitch, part = 0) {
      const m0 = viewer.score.measures[part][0];
      const clef = [...m0.getElementsByTagName("clef")].find((c) => Number(c.getAttribute("number") ?? 1) === staff);
      const sign = clef ? txt(clef, "sign") : "G";
      const line = clef ? Number(txt(clef, "line")) || 2 : 2;
      const oct = clef ? Number(txt(clef, "clef-octave-change")) || 0 : 0;
      const base = sign === "F" ? 3 * 7 + 3 : sign === "C" ? 4 * 7 : 4 * 7 + 4;
      const top = base + (5 - (sign === "percussion" ? 2 : line)) * 2 + oct * 7;
      return viewer.pointFor(bar - 1, beat - 1, part, staff, top - diatonic(pitch));
    },
    buttonPoint(label) {
      const b = [...document.querySelectorAll("button")].find((x) => x.getAttribute("aria-label") === label && x.offsetParent);
      return b ? center(b) : null;
    },
    stripPoint(name) {
      const c = [...document.querySelectorAll(".sv-pitch-strip canvas")].find((x) => !x.hidden && x.offsetParent);
      if (!c) return null;
      const m = /^([A-G])(♯|#)?(-?\\d)$/.exec(name);
      const midi = (Number(m[3]) + 1) * 12 + [0, 2, 4, 5, 7, 9, 11][STEPS.indexOf(m[1])] + (m[2] ? 1 : 0);
      const [lo, hi] = scoreditKeys.keyRange(55, 74);
      const k = scoreditKeys.layoutKeys(lo, hi, c.clientWidth).get(midi);
      if (!k) return null;
      const r = c.getBoundingClientRect();
      return { x: r.left + k.x + k.w / 2, y: r.top + (k.black ? r.height * 0.3 : r.height * 0.85) };
    },
    fretPoint(string, fret) {
      const c = [...document.querySelectorAll(".sv-pitch-strip canvas.sv-frets")].find((x) => x.offsetParent);
      if (!c) return null;
      const r = c.getBoundingClientRect();
      const w = c.clientWidth;
      const open = Math.max(22, w * 0.05);
      const gap = (c.clientHeight - 8 - 14) / 6;
      const x = (f) => open + ((w - open - 4) * f) / 12;
      return { x: r.left + (fret === 0 ? open / 2 : (x(fret - 1) + x(fret)) / 2), y: r.top + 8 + gap * (string - 0.5) };
    },
    // Rebuilding a score by typing: the plan, in typing order, on an emptied copy.
    prepareRebuild() {
      const orig = viewer.score;
      const ed = new scoreditLib.ScoreEditor(orig, { history: false });
      const lengths = orig.measures.map((ms, p) => ms.map((_, m) => { const i = ed.info(p, m); return i.length / i.perQuarter; }));
      const starts = lengths.map((ls) => ls.reduce((a, l, i) => (a.push(i ? a[i - 1] + ls[i - 1] : 0), a), []));
      const { entries, skipped } = scoreditRebuild.plan(orig);
      const midi = (p) => (p.octave + 1) * 12 + [0, 2, 4, 5, 7, 9, 11]["CDEFGAB".indexOf(p.step)] + p.alter;
      const plan = entries.map((e) => ({
        part: e.at.part, measure: e.at.measure, staff: e.at.staff, voice: e.at.voice, pos: e.at.pos,
        abs: starts[e.at.part][e.at.measure] + e.at.pos, quarters: e.quarters, tuplet: e.tuplet ?? null, ties: e.ties,
        notes: e.pitches.map((p) => ({ step: p.step, midi: midi(p), drum: !!p.unpitched })),
      }));
      window.__orig = orig;
      viewer.setScore(scoreditRebuild.emptyCopy(orig));
      return { plan, skipped, measures: lengths[0].length };
    },
    midisAt(part, measure, staff, voice, pos) {
      const ed = new scoreditLib.ScoreEditor(viewer.score, { history: false });
      const ev = ed.eventAt({ part, measure, staff, voice, pos });
      if (!ev || ev.rest) return [];
      const STEPS7 = [0, 2, 4, 5, 7, 9, 11];
      return ev.notes.map((n) => { const p = n.getElementsByTagName("pitch")[0]; if (!p) return null; return (Number(txt(p, "octave")) + 1) * 12 + STEPS7["CDEFGAB".indexOf(txt(p, "step"))] + (Number(txt(p, "alter")) || 0); }).filter((x) => x !== null);
    },
    finishRebuild() {
      const r = scoreditRebuild.compareNotes(window.__orig, viewer.score);
      return { total: r.total, missing: r.missing.length, extra: r.extra.length, examplesMissing: r.missing.slice(0, 6).map((k) => scoreditRebuild.describeNote(k, window.__orig)), examplesExtra: r.extra.slice(0, 6).map((k) => scoreditRebuild.describeNote(k, viewer.score)) };
    },
    staffMiddle(bar, staff, part = 0) {
      return viewer.pointFor(bar - 1, 0, part, staff, 4);
    },
    paletteLines() {
      const tops = [...document.querySelectorAll(".sv-pal button")].filter((b) => b.offsetParent).map((b) => Math.round(b.getBoundingClientRect().top / 8));
      return new Set(tops).size;
    },
    paletteOverflows() {
      return [...document.querySelectorAll(".sv-edit button")].filter((b) => b.offsetParent && b.getBoundingClientRect().right > innerWidth + 1).length;
    },
  };
})()`;

const EMPTY = "whole-bar rest";

export const scenarios = [
  {
    id: "palette-desktop",
    title: "On a computer, the edit toolbar fits on one line",
    device: "desktop",
    fixture: "piano.musicxml",
    why: "A computer screen is wide enough for every edit button side by side, so the toolbar should take a single line and leave more room for the score.",
    look: "One dark toolbar line at the bottom, with the usual player bar gone.",
    async run(d) {
      d.check("The toolbar is a single line", (await d.eval("e2e.paletteLines()")) === 1, `It takes ${await d.eval("e2e.paletteLines()")} lines`);
      d.check("The player bar is hidden while editing", await d.eval("document.querySelector('.sv-bar').hidden"));
    },
  },
  {
    id: "palette-phone",
    title: "On a phone, the edit toolbar wraps onto two lines without spilling",
    device: "phone",
    fixture: "piano.musicxml",
    why: "A phone is too narrow for one line, so the buttons go on two lines, and none may stick out past the right edge of the screen.",
    look: "Two lines of buttons at the bottom, all fully visible.",
    async run(d) {
      const lines = await d.eval("e2e.paletteLines()");
      d.check("The toolbar takes two lines", lines === 2, `It takes ${lines} lines`);
      d.check("No button sticks out of the screen", (await d.eval("e2e.paletteOverflows()")) === 0);
    },
  },
  {
    id: "type-notes",
    title: "Typing letters enters notes one after another",
    device: "desktop",
    fixture: "piano.musicxml",
    why: "As in MuseScore: N starts note input, 5 picks a quarter note (one beat), and each letter A to G enters that note. Four quarter notes fill a 4-beat bar.",
    look: "Four notes climbing like stairs in the first bar of the upper staff.",
    async run(d) {
      await d.key("n");
      await d.key("5");
      await d.keys("cdef");
      await d.bars({ 1: "C5 quarter, D5 quarter, E5 quarter, F5 quarter", 2: EMPTY });
      await d.sounds(["C5 at bar 1 beat 1 for 1 beat", "D5 at bar 1 beat 2 for 1 beat", "E5 at bar 1 beat 3 for 1 beat", "F5 at bar 1 beat 4 for 1 beat"]);
    },
  },
  {
    id: "durations",
    title: "Number keys choose how long the next notes last",
    device: "desktop",
    fixture: "piano.musicxml",
    why: "6 is a half note (2 beats), 4 an eighth note (half a beat), 5 a quarter note (1 beat). Together they make exactly one 4-beat bar.",
    look: "A note with a hollow head, two notes joined by a beam, then one plain note.",
    async run(d) {
      await d.key("n");
      await d.key("6");
      await d.key("c");
      await d.key("4");
      await d.keys("dd");
      await d.key("5");
      await d.key("e");
      await d.bars({ 1: "C5 half, D5 eighth, D5 eighth, E5 quarter" });
      await d.sounds(["C5 at bar 1 beat 1 for 2 beats", "D5 at bar 1 beat 3 for ½ beat", "D5 at bar 1 beat 3½ for ½ beat", "E5 at bar 1 beat 4 for 1 beat"]);
    },
  },
  {
    id: "dot-and-rest",
    title: "A dot makes a note half as long again, and 0 enters a silence",
    device: "desktop",
    fixture: "piano.musicxml",
    why: "A dotted quarter lasts 1½ beats. 0 enters a rest (a beat of silence) instead of a note.",
    look: "A note with a dot after it, a short note, a rest sign (a squiggle), then a note.",
    async run(d) {
      await d.key("n");
      await d.key("5");
      await d.key(".");
      await d.key("c");
      await d.key("4");
      await d.key("d");
      await d.key("5");
      await d.key("0");
      await d.key("e");
      await d.bars({ 1: "C5 dotted quarter, D5 eighth, quarter rest, E5 quarter" });
      await d.sounds(["C5 at bar 1 beat 1 for 1½ beats", "D5 at bar 1 beat 2½ for ½ beat", "E5 at bar 1 beat 4 for 1 beat"]);
    },
  },
  {
    id: "chord",
    title: "Shift with a letter stacks notes into a chord",
    device: "desktop",
    fixture: "piano.musicxml",
    why: "Shift+letter adds a note on top of the last one, so they sound together (a chord). The rest of the bar fills with rests.",
    look: "Three note heads stacked on one stem in the first beat, then rests.",
    async run(d) {
      await d.key("n");
      await d.key("5");
      await d.key("c");
      await d.key("e", { shift: true });
      await d.key("g", { shift: true });
      await d.bars({ 1: "C5+E5+G5 quarter, quarter rest, half rest" });
      await d.sounds(["C5 at bar 1 beat 1 for 1 beat", "E5 at bar 1 beat 1 for 1 beat", "G5 at bar 1 beat 1 for 1 beat"]);
    },
  },
  {
    id: "tie-over-barline",
    title: "A note too long for the bar continues into the next one",
    device: "desktop",
    fixture: "piano.musicxml",
    why: "A 2-beat note entered on the last beat does not fit: it is split at the barline and the two halves are tied (a curved line), so it still sounds as one 2-beat note.",
    look: "The last note of bar 1 joined by a curve to the first note of bar 2.",
    async run(d) {
      await d.key("n");
      await d.key("5");
      await d.keys("cde");
      await d.key("6");
      await d.key("f");
      await d.bars({ 1: "C5 quarter, D5 quarter, E5 quarter, F5 quarter (tied to the next)", 2: "F5 quarter, quarter rest, half rest" });
      await d.sounds(["C5 at bar 1 beat 1 for 1 beat", "D5 at bar 1 beat 2 for 1 beat", "E5 at bar 1 beat 3 for 1 beat", "F5 at bar 1 beat 4 for 2 beats"]);
    },
  },
  {
    id: "arrows",
    title: "Up and down arrows raise or lower the note just entered",
    device: "desktop",
    fixture: "piano.musicxml",
    why: "Up moves the note one step (semitone) higher, which turns C into C sharp (♯). Ctrl+Down moves it a whole octave lower.",
    look: "One note with a ♯ sign before it, low in the upper staff.",
    async run(d) {
      await d.key("n");
      await d.key("5");
      await d.key("c");
      await d.key("ArrowUp");
      await d.key("ArrowDown", { ctrl: true });
      await d.bars({ 1: "C♯4 quarter, quarter rest, half rest" });
    },
  },
  {
    id: "overwrite-and-insert",
    title: "Typing over a note replaces it; Ctrl+Shift inserts and pushes the rest along",
    device: "desktop",
    fixture: "melody.musicxml",
    why: "The tune starts C D E F | G A | B. Clicking D and typing G replaces D. Then Ctrl+Shift+A inserts an A without removing anything: every later note moves one beat later, spilling over the barlines (cut notes are tied), and the empty last bar absorbs the push.",
    look: "Bar 1 now reads C G A E; the following bars are shifted by one beat, with ties across the barlines.",
    async run(d) {
      await d.tapStaff(1, 2, 1, "D4");
      await d.key("n");
      await d.key("g");
      await d.bars({ 1: "C4 quarter, G4 quarter, E4 quarter, F4 quarter" });
      await d.key("a", { ctrl: true, shift: true });
      await d.bars({
        1: "C4 quarter, G4 quarter, A4 quarter, E4 quarter",
        2: "F4 quarter, G4 half, A4 quarter (tied to the next)",
        3: "A4 quarter, B4 dotted half (tied to the next)",
        4: "B4 quarter, quarter rest, half rest",
      });
      await d.sounds([
        "C4 at bar 1 beat 1 for 1 beat",
        "G4 at bar 1 beat 2 for 1 beat",
        "A4 at bar 1 beat 3 for 1 beat",
        "E4 at bar 1 beat 4 for 1 beat",
        "F4 at bar 2 beat 1 for 1 beat",
        "G4 at bar 2 beat 2 for 2 beats",
        "A4 at bar 2 beat 4 for 2 beats",
        "B4 at bar 3 beat 2 for 4 beats",
      ]);
    },
  },
  {
    id: "delete-undo-redo",
    title: "Delete turns a note into silence; undo and redo work",
    device: "desktop",
    fixture: "melody.musicxml",
    why: "Clicking the third note (E) selects it; Delete replaces it with a rest. Ctrl+Z brings it back, Ctrl+Y removes it again.",
    look: "A rest in place of the third note of bar 1.",
    async run(d) {
      await d.tapStaff(1, 3, 1, "E4");
      await d.key("Delete");
      await d.bars({ 1: "C4 quarter, D4 quarter, quarter rest, F4 quarter" }, { label: "After Delete, bar 1" });
      await d.key("z", { ctrl: true });
      await d.bars({ 1: "C4 quarter, D4 quarter, E4 quarter, F4 quarter" }, { label: "After undo, bar 1" });
      await d.key("y", { ctrl: true });
      await d.bars({ 1: "C4 quarter, D4 quarter, quarter rest, F4 quarter" }, { label: "After redo, bar 1" });
    },
  },
  {
    id: "click-entry",
    title: "With the mouse, clicking a line of the staff enters that note",
    device: "desktop",
    fixture: "piano.musicxml",
    why: "In note input, a click on the staff puts a note where you clicked: each line and space is a different note. The upper staff here gets a G, the lower staff a C.",
    look: "One note in each staff of bar 1, the lower one selected (orange).",
    async run(d) {
      await d.button("Note input");
      await d.button("Quarter note");
      await d.tapStaff(1, 1, 1, "G4", { staffName: "upper staff" });
      await d.tapStaff(1, 1, 2, "C3", { staffName: "lower staff" });
      await d.bars({ 1: "G4 quarter, quarter rest, half rest" }, { label: "Upper staff, bar 1" });
      await d.bars({ 1: "C3 quarter, quarter rest, half rest" }, { staff: 2, label: "Lower staff, bar 1" });
      await d.sounds(["C3 at bar 1 beat 1 for 1 beat", "G4 at bar 1 beat 1 for 1 beat"]);
    },
  },
  {
    id: "phone-tap-and-hold",
    title: "On a phone, tap a line to enter a note, or hold and slide to pick one",
    device: "phone",
    fixture: "piano.musicxml",
    why: "A tap enters the note under the finger. Holding the finger down shows a bubble with the note's name; sliding changes it, and letting go enters it. Here the finger starts on B and slides two steps down to G.",
    look: "Two notes in bar 1 of the upper staff: a high one, then a lower one (selected, orange).",
    async run(d) {
      await d.button("Note input");
      await d.tapStaff(1, 1, 1, "E5");
      const bubble = await d.hold(1, 2, 1, "B4", "G4");
      d.check('The bubble showed "G4" while sliding', bubble === "G4", `It showed "${bubble}"`);
      await d.bars({ 1: "E5 quarter, G4 quarter, half rest" });
    },
  },
  {
    id: "phone-scroll",
    title: "On a phone, swiping still scrolls in note input and enters nothing",
    device: "phone",
    fixture: "piano.musicxml",
    why: "In note input a tap enters a note, but a swipe must scroll the page instead, without adding any note.",
    look: "The score scrolled down; no notes anywhere.",
    async run(d) {
      await d.run("Zoom in so the score is taller than the screen", "viewer.setZoom(1.6), new Promise((r) => setTimeout(r, 1500))");
      await d.button("Note input");
      const before = await d.eval("document.querySelector('.sv-root').scrollTop");
      await d.swipe(350);
      const after = await d.eval("document.querySelector('.sv-root').scrollTop");
      const room = await d.eval("(() => { const r = document.querySelector('.sv-root'); return r.scrollHeight - r.clientHeight; })()");
      d.check("The page scrolled down", after > before + 100, `It moved from ${before} to ${after} (it can scroll ${room})`);
      const bars = await d.eval("e2e.bars(0, 1)");
      d.check("No note was entered", bars.every((b) => b === EMPTY), bars.find((b) => b !== EMPTY) ?? "");
    },
  },
  {
    id: "keyboard-strip",
    title: "The keyboard strip enters the key you tap",
    device: "phone",
    fixture: "piano.musicxml",
    why: "The keyboard button shows a small piano above the toolbar. Tapping C, E and G (the notes of a C major chord, played one after another) enters them in order.",
    look: "A small piano above the toolbar; three rising notes in bar 1.",
    async run(d) {
      await d.button("Note input");
      await d.button("Keyboard");
      for (const k of ["C4", "E4", "G4"]) await d.stripKey(k);
      await d.bars({ 1: "C4 quarter, E4 quarter, G4 quarter, quarter rest" });
      await d.sounds(["C4 at bar 1 beat 1 for 1 beat", "E4 at bar 1 beat 2 for 1 beat", "G4 at bar 1 beat 3 for 1 beat"]);
    },
  },
  {
    id: "accidentals",
    title: "Sharp, flat and natural buttons change the selected note",
    device: "phone",
    fixture: "piano.musicxml",
    why: "A sharp (♯) raises a note a little, a flat (♭) lowers it, a natural (♮) takes either away. They apply to the note just entered.",
    look: "One note in bar 1 with no sign before it (the natural was last).",
    async run(d) {
      await d.button("Note input");
      await d.tapStaff(1, 1, 1, "F4");
      await d.bars({ 1: "F4 quarter, quarter rest, half rest" }, { label: "Entered, bar 1" });
      await d.button("Sharp");
      await d.bars({ 1: "F♯4 quarter, quarter rest, half rest" }, { label: "After sharp, bar 1" });
      await d.button("Flat");
      await d.bars({ 1: "F♭4 quarter, quarter rest, half rest" }, { label: "After flat, bar 1" });
      await d.button("Natural");
      await d.bars({ 1: "F4 quarter, quarter rest, half rest" }, { label: "After natural, bar 1" });
    },
  },
  {
    id: "triplet",
    title: "A triplet fits three notes into the time of two",
    device: "desktop",
    fixture: "piano.musicxml",
    why: "With a quarter note chosen, Ctrl+3 makes a triplet: three short notes sharing one beat equally, marked with a 3.",
    look: "Three beamed notes under a bracket with a 3, then rests.",
    async run(d) {
      await d.key("n");
      await d.key("5");
      await d.key("3", { ctrl: true });
      await d.keys("cde");
      await d.bars({ 1: "C5 eighth (triplet), D5 eighth (triplet), E5 eighth (triplet), quarter rest, half rest" });
      await d.sounds(["C5 at bar 1 beat 1 for ⅓ beat", "D5 at bar 1 beat 1⅓ for ⅓ beat", "E5 at bar 1 beat 1⅔ for ⅓ beat"]);
    },
  },
  {
    id: "copy-paste",
    title: "Copy a run of notes and paste it into another bar",
    device: "desktop",
    fixture: "melody.musicxml",
    why: "Click the first note, Shift+Right three times to select four notes, Ctrl+C to copy, click the empty last bar and Ctrl+V to paste: the last bar gets the same four notes.",
    look: "Bars 1 and 4 hold the same four rising notes; the pasted ones are selected.",
    async run(d) {
      await d.tapStaff(1, 1, 1, "C4");
      for (let i = 0; i < 3; i++) await d.key("ArrowRight", { shift: true });
      await d.key("c", { ctrl: true });
      await d.tapStaff(4, 1, 1, "B4");
      await d.key("v", { ctrl: true });
      await d.bars({ 1: "C4 quarter, D4 quarter, E4 quarter, F4 quarter", 4: "C4 quarter, D4 quarter, E4 quarter, F4 quarter" });
    },
  },
  {
    id: "drums",
    title: "On a drum staff, each line is a drum",
    device: "phone",
    fixture: "drums.musicxml",
    why: "Drum parts do not have notes, but drums: each line of the staff is one drum. Holding a finger on the snare drum's line shows its name, and letting go enters a snare hit.",
    look: "A drum hit at the start of bar 3, after the beat already in bars 1 and 2.",
    async run(d) {
      await d.button("Note input");
      const bubble = await d.hold(3, 1, 1, "C5", "C5");
      d.check('The bubble named the drum "Snare"', bubble === "Snare", `It showed "${bubble}"`);
      await d.bars({ 3: "Snare quarter, quarter rest, half rest" });
      await d.sounds([
        "Bass Drum at bar 1 beat 1",
        "Snare at bar 1 beat 2",
        "Bass Drum at bar 1 beat 3",
        "Snare at bar 1 beat 4",
        "Hi-Hat at bar 2 beat 1",
        "Hi-Hat at bar 2 beat 2",
        "Hi-Hat at bar 2 beat 3",
        "Hi-Hat at bar 2 beat 4",
        "Snare at bar 3 beat 1",
      ]);
    },
  },
  {
    id: "guitar-fretboard",
    title: "On a guitar, the fretboard enters notes and the tab follows",
    device: "phone",
    fixture: "guitar.musicxml",
    why: "For a guitar the keyboard button shows a guitar neck. Tapping the second string at the third fret enters that note (a D) in the notes staff, and the tab staff under it (which shows strings and frets as numbers) gets a 3 on the second line.",
    look: "A note in bar 1 of the upper staff, and the number 3 on the second line of the TAB staff below.",
    async run(d) {
      await d.button("Note input");
      await d.button("Keyboard");
      await d.fret(2, 3);
      await d.bars({ 1: "D4 quarter (string 2, fret 3), quarter rest, half rest" }, { label: "Notes staff, bar 1" });
      await d.bars({ 1: "D4 quarter (string 2, fret 3), quarter rest, half rest" }, { staff: 2, label: "Tab staff, bar 1" });
      await d.sounds(["D4 at bar 1 beat 1 for 1 beat"], "Playback (once, not twice)");
    },
  },
  {
    id: "save-and-reopen",
    title: "What you entered is saved and comes back when the file is opened again",
    device: "desktop",
    fixture: "piano.musicxml",
    why: "The edited score is written out as a MusicXML file (plain and compressed .mxl) and read back: the notes must be the same.",
    look: "Four notes in bar 1.",
    async run(d) {
      await d.key("n");
      await d.key("5");
      await d.keys("cdef");
      const now = await d.eval("e2e.bars(0, 1)");
      const xml = await d.eval("e2e.bars(0, 1, new scoreditLib.ScoreDoc(viewer.score.serialize()))");
      const mxl = await d.eval("e2e.bars(0, 1, new scoreditLib.ScoreDoc(scoreditLib.readMxl(scoreditLib.writeMxl(viewer.score.serialize()))))");
      d.check("Saved as MusicXML and reopened, the notes are the same", JSON.stringify(xml) === JSON.stringify(now), xml[0]);
      d.check("Saved as compressed .mxl and reopened, the notes are the same", JSON.stringify(mxl) === JSON.stringify(now), mxl[0]);
    },
  },
  {
    id: "done",
    title: "Done leaves edit mode",
    device: "desktop",
    fixture: "piano.musicxml",
    why: "The tick button closes the edit toolbar and brings back the player bar.",
    look: "The normal player bar at the bottom.",
    async run(d) {
      await d.button("Done");
      d.check("The edit toolbar is gone", await d.eval("document.querySelector('.sv-edit').hidden"));
      d.check("The player bar is back", await d.eval("!document.querySelector('.sv-bar').hidden"));
    },
  },
  {
    id: "open-fur-elise",
    title: "Für Elise opens and scrolls without errors",
    device: "desktop",
    corpus: "musescore-com/fur-elise-ms4.musicxml",
    edit: false,
    why: "Before typing it back in: the original opens, and every line draws as the page is scrolled to the end, with no error.",
    look: "The end of Für Elise.",
    async run(d) {
      await d.run("Scroll to the end, a screen at a time", "(async () => { const r = document.querySelector('.sv-root'); for (let i = 0; i < 40; i++) { r.scrollTop += r.clientHeight; await new Promise((x) => setTimeout(x, 250)); } })()");
    },
  },
  {
    id: "type-fur-elise",
    title: "Typing all of Für Elise back in gives the same piece",
    device: "desktop",
    corpus: "musescore-com/fur-elise-ms4.musicxml",
    edit: false,
    why: "Every note of Für Elise is removed, then the whole piece is typed back in with the keyboard as a person would in note input: a number key for each note's length, a letter for its name, arrow keys to correct the octave or add a sharp, Shift+letter for chords, Ctrl+3 for triplets, rests where a hand is silent, and ArrowLeft then + to tie notes. At the end every note must be the same as in the original. Grace notes and slurs are left out (edit mode does not enter them yet).",
    look: "The beginning of Für Elise, typed back in (slurs and the few grace notes missing).",
    async run(d) {
      const prep = await d.eval("e2e.prepareRebuild()");
      d.note(`Empty the score (${prep.measures} bars) and press Edit`);
      await d.run("Wait for the empty score", "new Promise((r) => setTimeout(r, 1500))");
      await d.button("Edit");
      const streams = new Map();
      for (const e of prep.plan) {
        const k = `${e.part}|${e.staff}|${e.voice}`;
        if (!streams.has(k)) streams.set(k, []);
        streams.get(k).push(e);
      }
      const order = [...streams.keys()].sort((a, b) => {
        const [pa, sa, va] = a.split("|").map(Number);
        const [pb, sb, vb] = b.split("|").map(Number);
        return pa - pb || sa - sb || va - vb;
      });
      const VALUES = [["8", 8], ["7", 4], ["6", 2], ["5", 1], ["4", 0.5], ["3", 0.25], ["2", 0.125], ["1", 0.0625]];
      const written = (q) => {
        for (const [k, base] of VALUES) for (const dots of [0, 1]) if (Math.abs(base * (2 - 2 ** -dots) - q) < 1e-6) return { k, dots };
        return null;
      };
      let cur = { k: null, dots: 0 };
      let keys = 0;
      const key = async (k, mods) => {
        keys++;
        await d.fastKey(k, mods);
      };
      const setLength = async (q) => {
        const w = written(q);
        if (!w) return false;
        if (w.k !== cur.k || w.dots !== cur.dots) {
          await key(w.k);
          if (w.dots) await key(".");
          cur = w;
        }
        return true;
      };
      let notes = 0;
      let fixes = 0;
      let ties = 0;
      const problems = [];
      for (const k of order) {
        const list = streams.get(k).sort((a, b) => a.abs - b.abs);
        const [part, staff, voice] = k.split("|");
        const voices = [...new Set(prep.plan.filter((e) => e.part === Number(part) && e.staff === Number(staff)).map((e) => Number(e.voice)))].sort((a, b) => a - b);
        d.note(`${staff === "1" ? "Upper" : "Lower"} staff, voice ${voices.indexOf(Number(voice)) + 1}: click its first bar, press N${voices.length > 1 ? ` and Ctrl+Alt+${voices.indexOf(Number(voice)) + 1}` : ""}, then type ${list.length} notes and chords`);
        await key("Escape");
        await d.click(await d.eval(`e2e.staffMiddle(1, ${staff}, ${part})`));
        await key("n");
        await key(String(voices.indexOf(Number(voice)) + 1), { ctrl: true, alt: true });
        cur = { k: null, dots: 0 };
        let at = 0;
        let prev = null;
        let tup = null;
        for (const e of list) {
          // Silence before the note: rests, longest first.
          let gap = e.abs - at;
          for (const [, v] of VALUES) {
            while (gap >= v - 1e-6) {
              await setLength(v);
              await key("0");
              gap -= v;
            }
          }
          if (gap > 1e-6) problems.push(`a silence of ${gap.toFixed(3)} beat before bar ${e.measure + 1} cannot be typed`);
          if (e.tuplet) {
            if (e.tuplet.actual === 3 && e.tuplet.normal === 2 && (await setLength(e.tuplet.quarters))) {
              await key("3", { ctrl: true });
              // The editor switches to the tuplet's note value.
              cur = written(e.tuplet.quarters / 2) ?? { k: null, dots: 0 };
              tup = { ...e.tuplet, end: e.abs + e.tuplet.quarters };
            } else problems.push(`bar ${e.measure + 1}: a ${e.tuplet.actual}:${e.tuplet.normal} tuplet cannot be typed`);
          }
          // Inside a tuplet a note is typed with its written value.
          const inside = tup && e.abs < tup.end - 1e-6;
          const wq = inside ? (e.quarters * tup.actual) / tup.normal : e.quarters;
          if (written(wq)) await setLength(wq);
          else problems.push(`bar ${e.measure + 1}: a note ${e.quarters.toFixed(3)} beat long cannot be typed`);
          if (!e.notes.length) {
            // A tuplet starting with a rest: the rest fills its first slot.
            await key("0");
            at = e.abs + e.quarters;
            continue;
          }
          const where = `${e.part}, ${e.measure}, ${e.staff}, ${JSON.stringify(e.voice)}, ${e.pos}`;
          const placed = [];
          for (const [i, n] of e.notes.entries()) {
            await key(n.step.toLowerCase(), i ? { shift: true } : undefined);
            const now = await d.eval(`e2e.midisAt(${where})`);
            const rest = [...now];
            for (const p of placed) rest.splice(rest.indexOf(p), 1);
            let diff = n.midi - (rest[0] ?? n.midi);
            while (diff >= 12) (await key("ArrowUp", { ctrl: true }), (diff -= 12), fixes++);
            while (diff <= -12) (await key("ArrowDown", { ctrl: true }), (diff += 12), fixes++);
            while (diff > 0) (await key("ArrowUp"), diff--, fixes++);
            while (diff < 0) (await key("ArrowDown"), diff++, fixes++);
            placed.push(n.midi);
          }
          notes++;
          if (prev?.ties.length) {
            const same = prev.notes.map((n) => n.midi).sort().join() === e.notes.map((n) => n.midi).sort().join();
            if (same && prev.ties.length === prev.notes.length && Math.abs(prev.abs + prev.quarters - e.abs) < 1e-6) {
              await key("ArrowLeft");
              await key("+");
              ties++;
            } else problems.push(`bar ${prev.measure + 1}: a tie on part of a chord cannot be typed`);
          }
          at = e.abs + e.quarters;
          prev = e;
        }
      }
      d.note(`In all: ${notes} notes and chords, ${keys} key presses (${fixes} arrow corrections, ${ties} ties)`);
      const during = d.takeErrors();
      await d.run("Scroll through the whole piece", "(async () => { const r = document.querySelector('.sv-root'); r.scrollTop = 0; for (let i = 0; i < 40; i++) { r.scrollTop += r.clientHeight; await new Promise((x) => setTimeout(x, 250)); } })()");
      const after = d.takeErrors();
      d.check("The finished piece draws without errors", !after.length, after[0]?.split("\n")[0] ?? "");
      if (during.length) d.note(`(While typing, the drawing library reported ${during.length} errors on lines drawn in the middle of an edit.)`);
      const r = await d.eval("e2e.finishRebuild()");
      d.check(`All ${r.total} notes of the original are back, in the same place, with the same length`, !r.missing && !r.extra, [r.missing ? `${r.missing} missing, e.g. ${r.examplesMissing.join("; ")}` : "", r.extra ? `${r.extra} not in the original, e.g. ${r.examplesExtra.join("; ")}` : ""].filter(Boolean).join(". "));
      d.check("Everything could be typed", !problems.length, problems.slice(0, 5).join("; "));
      const not = Object.entries(prep.skipped).map(([k, n]) => `${n} ${k}`).join(", ");
      if (not) d.note(`Left out on purpose (not in edit mode yet): ${not}`);
    },
  },
];
