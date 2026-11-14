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
  // The marks on a note, in words.
  const NAMES_OF = { "strong-accent": "marcato", "trill-mark": "trill", arpeggiate: "arpeggio", "inverted-mordent": "inverted mordent", "inverted-turn": "inverted turn", "delayed-turn": "delayed turn" };
  const notationWords = (n) => {
    const words = [];
    const ends = (e, what) => words.push(what + (e.getAttribute("type") === "stop" ? " ends" : " starts"));
    for (const nots of kidsOf(n, "notations")) {
      for (const g of kidsOf(nots, "articulations")) for (const a of g.children) words.push(NAMES_OF[a.tagName] ?? a.tagName);
      for (const g of kidsOf(nots, "ornaments"))
        for (const o of g.children) {
          if (o.tagName === "tremolo") (o.getAttribute("type") ?? "single") === "single" ? words.push("tremolo " + o.textContent.trim()) : ends(o, "tremolo");
          else if (o.tagName === "wavy-line") ends(o, "trill line");
          else if (o.tagName === "accidental-mark") words.push(o.textContent.trim() + " over it");
          else words.push(NAMES_OF[o.tagName] ?? o.tagName);
        }
      for (const g of kidsOf(nots, "technical"))
        for (const t of g.children) {
          if (t.tagName === "fingering") words.push("finger " + t.textContent.trim());
          else if (t.tagName === "hammer-on" || t.tagName === "pull-off") ends(t, t.tagName);
          else if (t.tagName === "pluck") words.push("pluck " + t.textContent.trim());
          else if (t.tagName === "hole") words.push("hole " + ({ yes: "closed", no: "open", half: "half closed" }[txt(t, "hole-closed")] ?? txt(t, "hole-closed")));
          else if (t.tagName === "arrow") words.push("arrow " + txt(t, "arrow-direction"));
          else if (t.tagName === "bend") words.push("bend " + txt(t, "bend-alter") + (kidsOf(t, "release").length ? " release" : "") + (kidsOf(t, "pre-bend").length ? " pre-bent" : ""));
          else if (t.tagName !== "string" && t.tagName !== "fret") words.push(t.tagName);
        }
      if (kidsOf(nots, "fermata").length) words.push("fermata");
      if (kidsOf(nots, "arpeggiate").length) words.push("arpeggio");
      for (const tag of ["glissando", "slide"]) for (const e of kidsOf(nots, tag)) ends(e, tag);
      for (const sl of kidsOf(nots, "slur")) ends(sl, "slur");
    }
    return words;
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
            for (const w of notationWords(n)) if (w.startsWith("finger")) out[out.length - 1].extras.push(w);
            continue;
          }
          const tie = kidsOf(n, "tie").some((t) => t.getAttribute("type") === "start") ? " (tied to the next)" : "";
          const extras = notationWords(n);
          for (const l of kidsOf(n, "lyric")) { const sy = txt(l, "syllabic"); extras.push('lyric "' + txt(l, "text") + (sy === "begin" || sy === "middle" ? "-" : "") + '"'); }
          let g = n.previousElementSibling;
          const graces = [];
          while (g && g.tagName === "note" && kidsOf(g, "grace").length) { graces.unshift(noteName(score, g)); g = g.previousElementSibling; }
          if (graces.length) extras.unshift("grace note " + graces.join(" "));
          const tech = n.getElementsByTagName("fret")[0] ? " (string " + deep(n, "string") + ", fret " + deep(n, "fret") + ")" : "";
          out.push({ names: [name], v: value(n), tie, tech, extras });
        }
        return out.map((e) => (e.names[0] === "rest" ? (e.v === "whole bar" ? "whole-bar rest" : e.v + " rest") : e.names.join("+") + " " + e.v + e.tie + e.tech + (e.extras.length ? " [" + e.extras.join("; ") + "]" : ""))).join(", ");
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
          if (e.grace) return name + " at bar " + (e.measure + 1) + " beat " + frac(e.onset + 1) + ", quick (grace note)";
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
        graces: e.graces.map((g) => ({ step: g.pitch.step, midi: midi(g.pitch), slash: g.slash, chord: g.chord, slurs: g.slurs.length })),
        slurStarts: e.slurs.filter((x) => x.type === "start").length,
        slurStops: e.slurs.filter((x) => x.type === "stop").length,
        marks: e.marks,
        lyrics: e.lyrics,
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
    graceMidisAt(part, measure, staff, voice, pos) {
      const ed = new scoreditLib.ScoreEditor(viewer.score, { history: false });
      const ev = ed.eventAt({ part, measure, staff, voice, pos });
      const STEPS7 = [0, 2, 4, 5, 7, 9, 11];
      return (ev?.graces ?? []).map((n) => { const p = n.getElementsByTagName("pitch")[0]; return (Number(txt(p, "octave")) + 1) * 12 + STEPS7["CDEFGAB".indexOf(txt(p, "step"))] + (Number(txt(p, "alter")) || 0); });
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

// Exports the open score to PDF, opens that PDF again and draws its first page with pdf.js.
async function pdfRoundTrip(d) {
  let r;
  await d.step("Export the score to PDF, then open that PDF again", async () => {
    r = await d.eval(`(async () => {
      const lib = scoreditLib;
      const strip = (x) => x.replace(/^<\\?xml[^>]*>\\s*/, "");
      const pdf = await lib.exportPdf(viewer.score);
      const plain = await lib.exportPdf(viewer.score, { embedScore: false });
      const back = await lib.loadScoreAsync(pdf);
      const pdfjs = await scoreditPdfjs();
      const task = pdfjs.getDocument({ data: pdf.slice() });
      const doc = await task.promise;
      const page = await doc.getPage(1);
      const vp = page.getViewport({ scale: 1 });
      const canvas = document.createElement("canvas");
      canvas.width = vp.width;
      canvas.height = vp.height;
      const ctx = canvas.getContext("2d");
      await page.render({ canvasContext: ctx, canvas, viewport: vp }).promise;
      const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let ink = 0;
      for (let i = 0; i < px.length; i += 4) if (px[i] < 128) ink++;
      const files = await doc.getAttachments();
      const pages = doc.numPages;
      await task.destroy();
      return { sniff: lib.isScorePdf(pdf), plainSniff: lib.isScorePdf(plain), format: back.format, same: strip(back.score.serialize()) === strip(viewer.score.serialize()), pages, ink, names: files ? [...files.values()].map((f) => f.filename) : [], extra: pdf.length - plain.length };
    })()`);
  });
  d.check("The PDF is recognised as a score", r.sniff && !r.plainSniff, JSON.stringify(r));
  d.check("It carries one attached .mxl file", r.names.length === 1 && r.names[0].endsWith(".mxl"), r.names.join(", "));
  d.check("Opening it gives back the same MusicXML", r.format === "pdf" && r.same);
  d.check("The pages still draw in a PDF reader", r.pages >= 1 && r.ink > 500, `${r.pages} pages, ${r.ink} dark pixels on page 1`);
}

const EMPTY = "whole-bar rest";


// Practice: a two-bar piano piece (right hand C, E+G, C, C | D; left hand C | G) and a
// simulated MIDI keyboard the scenario strikes keys on.
const PRACTICE_RH = (step, oct, dur, chord = false) => `<note>${chord ? "<chord/>" : ""}<pitch><step>${step}</step><octave>${oct}</octave></pitch><duration>${dur}</duration><voice>1</voice><type>${dur === 4 ? "whole" : "quarter"}</type><staff>1</staff></note>`;
const PRACTICE_LH = (step, oct) => `<backup><duration>4</duration></backup><note><pitch><step>${step}</step><octave>${oct}</octave></pitch><duration>4</duration><voice>5</voice><type>whole</type><staff>2</staff></note>`;
const PRACTICE_ATTR =`<attributes><divisions>1</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes>`;
const PRACTICE_XML =`<score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1"><measure number="1">${PRACTICE_ATTR}${PRACTICE_RH("C", 5, 1)}${PRACTICE_RH("E", 5, 1)}${PRACTICE_RH("G", 5, 1, true)}${PRACTICE_RH("C", 5, 1)}${PRACTICE_RH("C", 5, 1)}${PRACTICE_LH("C", 3)}</measure><measure number="2">${PRACTICE_RH("D", 5, 4)}${PRACTICE_LH("G", 2)}</measure></part></score-partwise>`;
async function practiceSetup(d) {
  await d.run("Open a two-bar piano piece", `(viewer.setScore(new scoreditLib.ScoreDoc(${JSON.stringify(PRACTICE_XML)})), new Promise((r) => setTimeout(r, 1200)))`);
  await d.run(
    "Connect a simulated MIDI keyboard",
    `(() => { const cbs = new Set(); window.fakeMidi = { subscribe(cb) { cbs.add(cb); return () => cbs.delete(cb); }, key(p, on = true) { for (const cb of cbs) cb({ data: new Uint8Array([on ? 0x90 : 0x80, p, on ? 100 : 0]), time: performance.now(), source: "fake" }); } }; viewer.setMidiInput(window.fakeMidi); })()`,
  );
}
const practiceKey = (d, p, on = true) => d.run(`${on ? "Strike" : "Release"} ${["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"][p % 12]}${Math.floor(p / 12) - 1}`, `fakeMidi.key(${p}, ${on})`);
// Wait mode's state, the play time and the cursor's place.
const practiceStatus = (d) =>
  d.eval(`(() => { const s = viewer.practiceStatus; const c = document.querySelector(".sv-cursor"); return s && { ...s, time: viewer.player.time, x: c && !c.hidden ? Number(/translateX\\(([-\\d.]+)px/.exec(c.style.transform)?.[1]) : null, lit: document.querySelectorAll(".sv-on").length }; })()`);
// Waits (up to 4 s) for playback to hold at group `index`, or for every group to be played.
async function practiceWaitFor(d, index) {
  for (let i = 0; i < 40; i++) {
    const s = await practiceStatus(d);
    if (s && s.index === index && (s.waiting || s.count === index)) return s;
    await new Promise((r) => setTimeout(r, 100));
  }
  return practiceStatus(d);
}
// The colour of a key of the falling-notes keyboard, as [r, g, b], low on white keys.
const practiceKeyColor = (d, midi, edge = false) =>
  d.eval(`(() => { const c = document.querySelector(".sv-keys-big"); const [lo, hi] = scoreditKeys.keyRange(43, 79); const k = scoreditKeys.layoutKeys(lo, hi, c.clientWidth).get(${midi}); const dpr = c.width / c.clientWidth; const x = ${edge} ? k.x + 2 : k.x + k.w / 2; const y = c.clientHeight * (k.black ? 0.3 : 0.8); return [...c.getContext("2d").getImageData(Math.round(x * dpr), Math.round(y * dpr), 1, 1).data].slice(0, 3); })()`);

// Step entry from a simulated MIDI keyboard: keys struck together arrive at the same time.
async function midiConnect(d) {
  await d.run(
    "Connect a simulated MIDI keyboard",
    `(() => { const cbs = new Set(); const send = (data) => { const time = performance.now(); for (const cb of cbs) cb({ data: new Uint8Array(data), time, source: "fake" }); }; window.fakeMidi = { subscribe(cb) { cbs.add(cb); return () => cbs.delete(cb); }, keys(ps) { const time = performance.now(); for (const cb of cbs) for (const p of ps) cb({ data: new Uint8Array([0x90, p, 100]), time, source: "fake" }); for (const cb of cbs) for (const p of ps) cb({ data: new Uint8Array([0x80, p, 0]), time: time + 30, source: "fake" }); }, cc(c, v) { send([0xb0, c, v]); } }; viewer.setMidiInput(window.fakeMidi); })()`,
  );
}
const KEY_NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
const midiKeys = (d, ps) => d.run(`Strike ${ps.map((p) => KEY_NAMES[p % 12] + (Math.floor(p / 12) - 1)).join(" and ")} on the MIDI keyboard`, `fakeMidi.keys(${JSON.stringify(ps)})`);
// One part, two empty bars, in a key (fifths), with extra attributes (a transposition).
const midiScore = (name, fifths, extra = "") =>
  `<score-partwise version="4.0"><part-list><score-part id="P1"><part-name>${name}</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions><key><fifths>${fifths}</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef>${extra}</attributes><note><rest measure="yes"/><duration>4</duration><voice>1</voice></note></measure><measure number="2"><note><rest measure="yes"/><duration>4</duration><voice>1</voice></note></measure></part></score-partwise>`;

export const scenarios = [
  {
    id: "open-pdf",
    title: "A score PDF opens as a score",
    device: "desktop",
    fixture: "melody.pdf",
    why: "A PDF printed by notation software holds the music as symbols and lines, so scoredit reads the notes back from it instead of showing a picture.",
    look: "The same short melody as the melody fixture: four quarter notes, two half notes, a whole note, then a resting bar.",
    async run(d) {
      await d.bars({ 1: "C4 quarter, D4 quarter, E4 quarter, F4 quarter", 2: "G4 half, A4 half", 3: "B4 whole", 4: EMPTY });
    },
  },
  {
    id: "pdf-roundtrip",
    title: "A PDF scoredit exports opens again as the same score",
    device: "desktop",
    fixture: "piano.musicxml",
    edit: false,
    why: "An exported PDF carries the score itself as an attached MusicXML file, so opening that PDF gives back the exact score rather than a guess read from the drawing.",
    look: "The piano fixture, as it was opened.",
    run: pdfRoundTrip,
  },
  {
    id: "pdf-roundtrip-elise",
    title: "Für Elise exported to PDF opens again as the same score",
    device: "desktop",
    corpus: "musescore-com/fur-elise-beethoven.mxl",
    edit: false,
    why: "The same round trip on a real piece several pages long: the PDF reopens as the exact score.",
    look: "Für Elise, as it was opened.",
    run: pdfRoundTrip,
  },
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
      d.check("No sharp button or keyboard for drums", !(await d.eval('!!e2e.buttonPoint("Sharp") || !!e2e.buttonPoint("Keyboard")')));
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
    id: "marks-keys",
    title: "Accent, staccato, tenuto and marcato from the keyboard",
    device: "desktop",
    fixture: "piano.musicxml",
    why: "Marks tell how a note is played: an accent (>) louder, staccato (a dot) short, tenuto (a line) held, marcato (^) strongly marked. MuseScore's keys put them on the note just entered: Shift+V, Shift+S, Shift+N, Shift+O.",
    look: "Four notes in bar 1, each with a different small sign above or below it.",
    async run(d) {
      await d.key("n");
      await d.key("5");
      for (const [note, k] of [["c", "v"], ["d", "s"], ["e", "n"], ["f", "o"]]) {
        await d.key(note);
        await d.key(k, { shift: true });
      }
      await d.bars({ 1: "C5 quarter [accent], D5 quarter [staccato], E5 quarter [tenuto], F5 quarter [marcato]" });
    },
  },
  {
    id: "slur-and-grace",
    title: "A slur from the keyboard, and a grace note before a note",
    device: "desktop",
    fixture: "piano.musicxml",
    why: "A slur (a curve over several notes) means play them smoothly: in note input, S on the first note and S again on the last one draw it. A grace note is a tiny quick note before a main note: / adds one at the main note's pitch, and the arrow keys move it.",
    look: "A curve over the first three notes of bar 1, and a small slashed note before the fourth.",
    async run(d) {
      await d.key("n");
      await d.key("5");
      await d.key("c");
      await d.key("s");
      await d.keys("de");
      await d.key("s");
      await d.key("f");
      await d.key("/");
      await d.key("ArrowUp");
      await d.key("ArrowUp");
      await d.bars({ 1: "C5 quarter [slur starts], D5 quarter, E5 quarter [slur ends], F5 quarter [grace note G5]" });
      await d.sounds(["C5 at bar 1 beat 1 for 1 beat", "D5 at bar 1 beat 2 for 1 beat", "E5 at bar 1 beat 3 for ½ beat", "G5 at bar 1 beat 4, quick (grace note)", "F5 at bar 1 beat 4 for 1 beat"], "Playback (the slashed grace note takes the second half of the note before, then the main note on the beat)");
    },
  },
  {
    id: "marks-palette",
    title: "On a phone, marks come from the Marks buttons",
    device: "phone",
    fixture: "piano.musicxml",
    why: "The Marks button shows a row of signs to put on the selected note: here a trill (tr, a fast wavering) and a fermata (an arc with a dot: hold the note longer).",
    look: "One note in bar 1 with tr and an arc with a dot above it.",
    async run(d) {
      await d.button("Note input");
      await d.tapStaff(1, 1, 1, "E5");
      await d.button("Marks");
      await d.button("Trill");
      await d.button("Fermata");
      await d.bars({ 1: "E5 quarter [trill; fermata], quarter rest, half rest" });
    },
  },
  {
    id: "lyrics",
    title: "Typing lyrics under the notes",
    device: "desktop",
    fixture: "melody.musicxml",
    why: "Ctrl+L opens a field for the words sung on the selected note. Space moves to the next note; a hyphen also moves on and joins the two syllables of a word (Hel-lo).",
    look: "The words Hel-lo world under the first three notes.",
    async run(d) {
      await d.tapStaff(1, 1, 1, "C4");
      await d.key("l", { ctrl: true });
      for (const c of "Hel") await d.key(c);
      await d.key("-");
      for (const c of "lo") await d.key(c);
      await d.key(" ");
      for (const c of "world") await d.key(c);
      await d.key(" ");
      await d.bars({ 1: 'C4 quarter [lyric "Hel-"], D4 quarter [lyric "lo"], E4 quarter [lyric "world"], F4 quarter' });
    },
  },
  {
    id: "tremolo-arpeggio",
    title: "A tremolo on a note, and an arpeggio on a chord",
    device: "desktop",
    fixture: "piano.musicxml",
    why: "A tremolo (slashes through the stem) repeats a note very fast. An arpeggio (a wavy line before a chord) rolls the chord's notes one after another, from the lowest. Both come from the Marks row.",
    look: "A chord with a wavy line before it in bar 1, then a note with three slashes on its stem.",
    async run(d) {
      await d.key("n");
      await d.key("5");
      await d.key("c");
      await d.key("e", { shift: true });
      await d.key("g", { shift: true });
      await d.button("Marks");
      await d.button("Arpeggio");
      await d.key("d");
      await d.button("Tremolo");
      await d.bars({ 1: "C5+E5+G5 quarter [arpeggio], D5 quarter [tremolo 3], half rest" });
    },
  },
  {
    id: "glissando-trill-line",
    title: "A glissando between two notes, and a trill line over two notes",
    device: "desktop",
    fixture: "melody.musicxml",
    why: "A glissando (a wavy line from one note to the next) slides between them. A trill line (tr followed by a wavy line) keeps the trill going over the notes it covers: select them with Shift+Right first.",
    look: "A wavy line from the first note to the second, and tr with a wavy line over the third and fourth.",
    async run(d) {
      await d.tapStaff(1, 1, 1, "C4");
      await d.button("Marks");
      await d.button("Glissando");
      await d.tapStaff(1, 3, 1, "E4");
      await d.key("ArrowRight", { shift: true });
      await d.button("Trill line");
      await d.bars({ 1: "C4 quarter [glissando starts], D4 quarter [glissando ends], E4 quarter [trill; trill line starts], F4 quarter [trill line ends]" });
    },
  },
  {
    id: "fingering-bowing",
    title: "Fingerings typed under the notes, and a bowing sign",
    device: "desktop",
    fixture: "melody.musicxml",
    why: "A fingering is the number of the finger that plays a note. The Fingering button (in the Text group of the bar over the selected note) opens a field: type a number, space moves to the next note. Up-bow (a V) tells a string player to push the bow.",
    look: "Small numbers 1, 2, 3 over the first three notes, and a V over the fourth.",
    async run(d) {
      await d.tapStaff(1, 1, 1, "C4");
      await d.button("Text");
      await d.button("Fingering");
      for (const k of ["1", " ", "2", " ", "3", " "]) await d.key(k);
      await d.key("Escape");
      await d.tapStaff(1, 4, 1, "F4");
      // A flute has no bow: its marks leave bowings out until All marks is pressed.
      await d.button("Marks");
      await d.button("All marks");
      await d.button("Up-bow");
      await d.bars({ 1: "C4 quarter [finger 1], D4 quarter [finger 2], E4 quarter [finger 3], F4 quarter [up-bow]" });
    },
  },
  {
    id: "hammer-on-bend",
    title: "Guitar: a hammer-on between two notes, and a bend",
    device: "desktop",
    fixture: "guitar.musicxml",
    why: "A hammer-on (a curve marked H) plays the second note by hammering a finger down, without picking again. A bend pushes the string so the note rises: one press of Bend is a full bend (2 semitones), the next adds a release back down. The tab staff below follows.",
    look: "A curve with H between the first two notes, and a bend arrow on the third in the tab.",
    async run(d) {
      await d.key("n");
      await d.key("5");
      await d.keys("abc");
      await d.button("Marks");
      await d.button("Bend");
      await d.button("Bend");
      await d.key("ArrowLeft");
      await d.key("ArrowLeft");
      await d.key("ArrowRight", { shift: true });
      await d.button("Hammer-on");
      await d.bars({ 1: "A4 quarter [hammer-on starts], B4 quarter [hammer-on ends], C5 quarter [bend 2; bend 2 release], quarter rest" }, { label: "Notes staff, bar 1" });
      const tab = await d.eval("e2e.bars(0, 2)[0]");
      d.check("The tab staff shows the same hammer-on and bends", tab.includes("hammer-on starts") && tab.includes("bend 2 release"), tab);
    },
  },
  {
    id: "tap-shake-schleifer",
    title: "A tap, a shake and a schleifer",
    device: "desktop",
    fixture: "melody.musicxml",
    why: "Three rarer signs from the Marks row (the tune is for flute, so All marks shows the guitar's tap too): a tap (T, a guitarist hitting the string on the fretboard), a shake (a wide fast wavering, as on a trumpet) and a schleifer (a quick slide of two notes up into the main note).",
    look: "A T over the first note, a short wavy sign over the second and a small slide sign before the third.",
    async run(d) {
      // The marks float over a selected note: select the first one.
      await d.tapStaff(1, 1, 1, "C4");
      await d.button("Marks");
      await d.button("All marks");
      for (const [beat, pitch, label] of [[1, "C4", "Tap"], [2, "D4", "Shake"], [3, "E4", "Schleifer"]]) {
        await d.tapStaff(1, beat, 1, pitch);
        await d.button(label);
      }
      await d.bars({ 1: "C4 quarter [tap], D4 quarter [shake], E4 quarter [schleifer], F4 quarter" });
    },
  },
  {
    id: "pluck-hole-arrow",
    title: "A plucking finger, a woodwind hole and an arrow",
    device: "desktop",
    fixture: "melody.musicxml",
    why: "Plucks name the right-hand finger of a guitarist (p thumb, i index, m middle, a ring): each press of the button moves to the next. A hole (a circle) shows a woodwind hole covered, half covered or open. An arrow points up or down (a strum direction, for instance).",
    look: "An i over the first note, a half-filled circle over the second, an up arrow over the third.",
    async run(d) {
      // The marks float over a selected note: select the first one.
      await d.tapStaff(1, 1, 1, "C4");
      await d.button("Marks");
      await d.button("All marks");
      await d.tapStaff(1, 1, 1, "C4");
      await d.button("Pluck (p i m a)");
      await d.button("Pluck (p i m a)");
      await d.tapStaff(1, 2, 1, "D4");
      await d.button("Hole");
      await d.button("Hole");
      await d.tapStaff(1, 3, 1, "E4");
      await d.button("Arrow");
      await d.bars({ 1: "C4 quarter [pluck i], D4 quarter [hole half closed], E4 quarter [arrow up], F4 quarter" });
    },
  },
  {
    id: "turns-and-accidentals",
    title: "Turns, an inverted mordent, and a sharp over a trill",
    device: "desktop",
    fixture: "melody.musicxml",
    why: "A turn (a sideways S) plays the notes around the main one; an inverted turn goes the other way; an inverted mordent is a quick note above and back. A small sharp, flat or natural over an ornament changes the note it decorates with: each press of its button moves to the next.",
    look: "A turn, an inverted turn and an inverted mordent over the first three notes, and tr with a small sharp over the fourth.",
    async run(d) {
      // The marks float over a selected note: select the first one.
      await d.tapStaff(1, 1, 1, "C4");
      await d.button("Marks");
      for (const [beat, pitch, label] of [[1, "C4", "Turn"], [2, "D4", "Inverted turn"], [3, "E4", "Inverted mordent"], [4, "F4", "Trill"]]) {
        await d.tapStaff(1, beat, 1, pitch);
        await d.button(label);
      }
      await d.button("Accidental over the ornament");
      await d.bars({ 1: "C4 quarter [turn], D4 quarter [inverted turn], E4 quarter [inverted mordent], F4 quarter [trill; sharp over it]" });
    },
  },
  {
    id: "marks-by-instrument",
    title: "The Marks row shows what suits the instrument",
    device: "desktop",
    fixture: "guitar.musicxml",
    why: "A guitar part gets the guitar's marks (bend, hammer-on, tap...) and not a violin's bowings or a flute's holes; a piano part gets arpeggios but no bends. All marks shows everything.",
    look: "The Marks row for a guitar: bend, hammer-on and the like, no bowing signs.",
    async run(d) {
      const shown = (label) => d.eval(`!!e2e.buttonPoint(${JSON.stringify(label)})`);
      await d.key("n");
      await d.key("5");
      await d.key("c");
      await d.button("Marks");
      d.check("For the guitar: Bend is there", await shown("Bend"));
      d.check("For the guitar: Hammer-on is there", await shown("Hammer-on"));
      d.check("For the guitar: Up-bow (a violin's) is not", !(await shown("Up-bow")));
      d.check("For the guitar: Hole (a flute's) is not", !(await shown("Hole")));
      await d.button("Text");
      d.check("For the guitar: Lyrics (a singer's) are not", !(await shown("Lyrics")));
      await d.button("Marks");
      await d.button("All marks");
      d.check("With All marks: Up-bow is there too", await shown("Up-bow"));
    },
  },
  {
    id: "marks-for-piano",
    title: "A piano part gets arpeggios and fingerings, not bends",
    device: "desktop",
    fixture: "piano.musicxml",
    why: "The same Marks row, for a piano: the arpeggio is there (and fingering in the Text group), the guitar's bend and hammer-on are not.",
    look: "The Marks row for a piano.",
    async run(d) {
      const shown = (label) => d.eval(`!!e2e.buttonPoint(${JSON.stringify(label)})`);
      await d.key("n");
      await d.key("5");
      await d.key("c");
      await d.button("Marks");
      d.check("For the piano: Arpeggio is there", await shown("Arpeggio"));
      await d.button("Text");
      d.check("For the piano: Fingering is there", await shown("Fingering"));
      await d.button("Marks");
      d.check("For the piano: Bend (a guitar's) is not", !(await shown("Bend")));
      d.check("For the piano: Hammer-on (a guitar's) is not", !(await shown("Hammer-on")));
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
    why: "Every note of Für Elise is removed, then the whole piece is typed back in with the keyboard as a person would in note input: a number key for each note's length, a letter for its name, arrow keys to correct the octave or add a sharp, Shift+letter for chords, Ctrl+3 for triplets, rests where a hand is silent, and ArrowLeft then + to tie notes. At the end every note must be the same as in the original. Grace notes are added with / and the arrows, and slurs with S on their first and last notes.",
    look: "The beginning of Für Elise, typed back in with its slurs.",
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
      let graces = 0;
      let slurs = 0;
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
          // Grace notes: "/" adds one at the note's pitch (Alt+/ unslashed), arrows move it.
          for (const g of e.graces) {
            if (g.chord) problems.push(`bar ${e.measure + 1}: a grace chord cannot be typed`);
            await key("/", g.slash ? undefined : { alt: true });
            const gs = await d.eval(`e2e.graceMidisAt(${where})`);
            let gd = g.midi - (gs[gs.length - 1] ?? g.midi);
            while (gd >= 12) (await key("ArrowUp", { ctrl: true }), (gd -= 12), fixes++);
            while (gd <= -12) (await key("ArrowDown", { ctrl: true }), (gd += 12), fixes++);
            while (gd > 0) (await key("ArrowUp"), gd--, fixes++);
            while (gd < 0) (await key("ArrowDown"), gd++, fixes++);
            graces++;
            if (g.slurs) problems.push(`bar ${e.measure + 1}: a slur from a grace note cannot be typed`);
          }
          // Marks by their MuseScore keys.
          const MARK_KEYS = { staccato: "S", accent: "V", tenuto: "N", "strong-accent": "O" };
          for (const m of e.marks) {
            if (MARK_KEYS[m]) await key(MARK_KEYS[m].toLowerCase(), { shift: true });
            else problems.push(`bar ${e.measure + 1}: the ${m} mark has no key`);
          }
          // Slurs: S closes the open one here, S opens one here.
          if (e.slurStops > 1 || e.slurStarts > 1) problems.push(`bar ${e.measure + 1}: overlapping slurs cannot be typed with S`);
          for (let s = 0; s < Math.min(1, e.slurStops); s++) (await key("s"), slurs++);
          for (let s = 0; s < Math.min(1, e.slurStarts); s++) await key("s");
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
      d.note(`In all: ${notes} notes and chords, ${graces} grace notes, ${slurs} slurs, ${keys} key presses (${fixes} arrow corrections, ${ties} ties)`);
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
  {
    id: "practice-wait",
    title: "Wait mode holds playback until the right keys are played on a MIDI keyboard",
    device: "desktop",
    fixture: "melody.musicxml",
    edit: false,
    why: "A piano piece is practised with the right hand on a (simulated) MIDI keyboard: C, then the chord E G, then C twice, then D. Playback must stop before each of them and go on only once its keys are struck; a wrong key changes nothing, and a C still held from before must be struck again. The left hand is played for you.",
    look: "The piece played through: the cursor at the end of the second bar.",
    async run(d) {
      await practiceSetup(d);
      await d.button("Practice");
      const label = (text) => `(() => { const l = [...document.querySelectorAll(".sv-pop-practice label")].find((x) => x.textContent === ${JSON.stringify(text)} && x.offsetParent); if (!l) return null; const r = l.getBoundingClientRect(); return { x: r.left + 12, y: r.top + r.height / 2 }; })()`;
      for (const text of ["Wait for me", "Right hand"]) {
        await d.step(`Choose "${text}"`, async () => {
          const p = await d.eval(label(text));
          if (!p) throw new Error(`no "${text}" choice`);
          await d.click(p);
        });
      }
      d.check("Wait mode is on, for the right hand", await d.eval(`viewer.practice.mode === "wait" && viewer.practice.hand === "right"`));
      await d.button("Practice");
      await d.button("Play");
      const status = () => practiceStatus(d);
      const waitFor = (index) => practiceWaitFor(d, index);
      const key = (p, on) => practiceKey(d, p, on);
      let s = await waitFor(0);
      d.check("Playback holds before the first C, waiting for it", s?.waiting && s.index === 0 && s.time < 0.05 && JSON.stringify(s.expected) === "[72]", JSON.stringify(s));
      d.check("The note waited for is lit in the score", s?.lit > 0, `lit: ${s?.lit}`);
      await key(61);
      await new Promise((r) => setTimeout(r, 500));
      const after = await status();
      d.check("A wrong key (C♯) changes nothing: still waiting at the start", after.index === 0 && after.waiting && after.time < 0.05, JSON.stringify(after));
      await key(72);
      s = await waitFor(1);
      d.check("C played: the cursor moves on to the chord and holds there", s?.waiting && s.index === 1 && Math.abs(s.time - 0.6) < 0.02 && s.x > after.x, JSON.stringify(s));
      const x1 = s.x;
      await key(76);
      await new Promise((r) => setTimeout(r, 500));
      s = await status();
      d.check("Half the chord (E only) is not enough", s.index === 1 && s.waiting && s.x === x1, JSON.stringify(s));
      await key(79);
      s = await waitFor(2);
      d.check("The whole chord played: on to the next C", s?.waiting && s.index === 2 && Math.abs(s.time - 1.2) < 0.02 && s.x > x1, JSON.stringify(s));
      await key(72);
      s = await waitFor(3);
      d.check("C struck: on to the repeated C", s?.waiting && s.index === 3 && Math.abs(s.time - 1.8) < 0.02, JSON.stringify(s));
      await new Promise((r) => setTimeout(r, 400));
      s = await status();
      d.check("The C still held does not count for the repeated C", s.index === 3 && s.waiting, JSON.stringify(s));
      await key(72, false);
      await key(72);
      s = await waitFor(4);
      d.check("C struck again: on to the D of bar 2", s?.waiting && s.index === 4 && Math.abs(s.time - 2.4) < 0.02, JSON.stringify(s));
      await key(74);
      s = await waitFor(5);
      d.check("Every note played: playback runs on to the end", s && s.index === 5 && !s.waiting, JSON.stringify(s));
    },
  },
  {
    id: "practice-keys",
    title: "In falling notes, wait mode outlines the keys to play and colours the keys pressed",
    device: "desktop",
    fixture: "melody.musicxml",
    edit: false,
    why: "The same piano piece in the falling-notes layout, both hands practised. While playback waits, the keys of the next notes are outlined on the keyboard; a key pressed that is not expected turns red, one that is expected turns green.",
    look: "Falling notes stopped above the keyboard: the chord's keys E and G outlined, C green (played), F red (wrong).",
    async run(d) {
      await practiceSetup(d);
      await d.button("Falling notes");
      await d.run("Turn wait mode on (both hands) from the host", `viewer.setPractice({ mode: "wait", hand: "both" })`);
      await d.button("Play");
      let s = await practiceWaitFor(d, 0);
      d.check("Playback holds for the first chord: C of both hands", s?.waiting && JSON.stringify(s.expected) === "[48,72]", JSON.stringify(s));
      const near = (c, rgb) => c && c.every((v, i) => Math.abs(v - rgb[i]) < 40);
      const GREEN = [34, 197, 94];
      const RED = [239, 68, 68];
      d.check("The key C5 is outlined", near(await practiceKeyColor(d, 72, true), GREEN), JSON.stringify(await practiceKeyColor(d, 72, true)));
      await practiceKey(d, 77);
      d.check("F5, not expected, shows red", near(await practiceKeyColor(d, 77), RED), JSON.stringify(await practiceKeyColor(d, 77)));
      await practiceKey(d, 48);
      await practiceKey(d, 72);
      s = await practiceWaitFor(d, 1);
      d.check("Both Cs played: playback moves on and holds for E G", s?.waiting && JSON.stringify(s.expected) === "[76,79]", JSON.stringify(s));
      d.check("C5, played when expected, stays green while held", near(await practiceKeyColor(d, 72), GREEN), JSON.stringify(await practiceKeyColor(d, 72)));
      d.check("E5, expected next, is outlined", near(await practiceKeyColor(d, 76, true), GREEN), JSON.stringify(await practiceKeyColor(d, 76, true)));
      await practiceKey(d, 77, false);
      d.check("F5 released: no longer red", !near(await practiceKeyColor(d, 77), RED), JSON.stringify(await practiceKeyColor(d, 77)));
    },
  },
  {
    id: "midi-entry",
    title: "Notes played on a MIDI keyboard are entered in note input",
    device: "desktop",
    fixture: "piano.musicxml",
    why: "As in MuseScore, a MIDI keyboard enters notes in note input: each key is written at its exact pitch with the chosen length, keys struck together make a chord, a black key is written with a sharp in C major, and the sustain pedal enters a rest. Lengths still come from the computer keyboard, and each note or chord is undone in one step.",
    look: "Bar 1: C, D, a two-note chord E G, C sharp. Bar 2: a half note F, a quarter rest, then G.",
    async run(d) {
      await midiConnect(d);
      await d.run("Turn practice wait mode on from the host: editing must still win", `viewer.setPractice({ mode: "wait", hand: "both" })`);
      await d.key("n");
      await d.key("5");
      await midiKeys(d, [60]);
      await midiKeys(d, [62]);
      await midiKeys(d, [67, 64]);
      await midiKeys(d, [61]);
      await d.bars({ 1: "C4 quarter, D4 quarter, E4+G4 quarter, C♯4 quarter", 2: EMPTY });
      await d.key("6");
      await midiKeys(d, [65]);
      await d.key("5");
      await d.run("Press the sustain pedal", "fakeMidi.cc(64, 127)");
      await d.run("Let the sustain pedal up", "fakeMidi.cc(64, 0)");
      await midiKeys(d, [67]);
      await d.bars({ 2: "F4 half, quarter rest, G4 quarter" });
      await d.sounds(["C4 at bar 1 beat 1 for 1 beat", "D4 at bar 1 beat 2 for 1 beat", "E4 at bar 1 beat 3 for 1 beat", "G4 at bar 1 beat 3 for 1 beat", "C♯4 at bar 1 beat 4 for 1 beat", "F4 at bar 2 beat 1 for 2 beats", "G4 at bar 2 beat 4 for 1 beat"]);
      for (let i = 0; i < 4; i++) await d.key("z", { ctrl: true });
      await d.bars({ 1: "C4 quarter, D4 quarter, E4+G4 quarter, quarter rest", 2: EMPTY }, { label: "After four undos, bar" });
      await d.key("z", { ctrl: true });
      await d.bars({ 1: "C4 quarter, D4 quarter, half rest" }, { label: "One more undo takes the whole chord away: bar" });
      d.check("Playback did not start: practice waits for nothing while editing", !(await d.eval("viewer.player?.isPlaying ?? false")));
      d.check("No errors", d.takeErrors().length === 0);
    },
  },
  {
    id: "midi-entry-flat-key",
    title: "Black keys are written with flats in a flat key",
    device: "desktop",
    fixture: "piano.musicxml",
    why: "In E flat major (three flats) the black keys are flat notes: the keyboard enters D flat, E flat (from the key signature), G flat and A flat.",
    look: "Four notes in bar 1, the first and third with a flat sign.",
    async run(d) {
      await d.run("Open a flute part in E flat major", `(viewer.setScore(new scoreditLib.ScoreDoc(${JSON.stringify(midiScore("Flute", -3))})), new Promise((r) => setTimeout(r, 1200)))`);
      await midiConnect(d);
      await d.key("n");
      await d.key("5");
      for (const k of [61, 63, 66, 68]) await midiKeys(d, [k]);
      await d.bars({ 1: "D♭4 quarter, E♭4 quarter, G♭4 quarter, A♭4 quarter" });
      d.check("Each written note keeps its pitch", JSON.stringify(await d.eval("e2e.midisAt(0, 0, 1, '1', 0).concat(e2e.midisAt(0, 0, 1, '1', 1), e2e.midisAt(0, 0, 1, '1', 2), e2e.midisAt(0, 0, 1, '1', 3))")) === "[61,63,66,68]");
    },
  },
  {
    id: "midi-entry-transposing",
    title: "A B flat clarinet gets its written notes from the keys played",
    device: "desktop",
    fixture: "piano.musicxml",
    why: "A B flat clarinet sounds a tone lower than written. Keys played sound concert pitch, so B flat on the keyboard is written C, E flat is written F, and A flat is written B flat.",
    look: "Bar 1: C, F, B flat, then a C chord of C and E.",
    async run(d) {
      await d.run("Open a clarinet part in B flat (written in C major)", `(viewer.setScore(new scoreditLib.ScoreDoc(${JSON.stringify(midiScore("Clarinet in B♭", 0, "<transpose><diatonic>-1</diatonic><chromatic>-2</chromatic></transpose>"))})), new Promise((r) => setTimeout(r, 1200)))`);
      await midiConnect(d);
      await d.key("n");
      await d.key("5");
      await midiKeys(d, [70]);
      await midiKeys(d, [63]);
      await midiKeys(d, [68]);
      await midiKeys(d, [70, 74]);
      await d.bars({ 1: "C5 quarter, F4 quarter, A♯4 quarter, C5+E5 quarter" });
      await d.sounds(["A♯4 at bar 1 beat 1 for 1 beat", "D♯4 at bar 1 beat 2 for 1 beat", "G♯4 at bar 1 beat 3 for 1 beat", "A♯4 at bar 1 beat 4 for 1 beat", "D5 at bar 1 beat 4 for 1 beat"]);
    },
  },
  {
    id: "midi-repitch",
    title: "Out of note input, a MIDI key gives the selected note its pitch",
    device: "desktop",
    fixture: "piano.musicxml",
    why: "With a note selected (not in note input), striking a key changes that note to the key's pitch; nothing new is entered. Leaving edit mode, keys no longer change the score.",
    look: "Bar 1: E, D, E, F, the first changed from C.",
    async run(d) {
      await midiConnect(d);
      await d.key("n");
      await d.key("5");
      await d.keys("cdef");
      await d.key("Escape");
      await d.tapStaff(1, 1, 1, "C5");
      await midiKeys(d, [76]);
      await d.bars({ 1: "E5 quarter, D5 quarter, E5 quarter, F5 quarter", 2: EMPTY });
      await d.button("Done");
      await midiKeys(d, [60]);
      await d.bars({ 1: "E5 quarter, D5 quarter, E5 quarter, F5 quarter", 2: EMPTY }, { label: "Out of edit mode, a key changes nothing: bar" });
    },
  },
  {
    id: "midi-drums",
    title: "On a drum staff, MIDI keys play the kit's drums",
    device: "desktop",
    fixture: "drums.musicxml",
    why: "A drum part maps keys to its drums as General MIDI does: key 38 is the snare and 42 the closed hi-hat; a key the part has no drum for enters nothing.",
    look: "Bar 1 starts with a snare and hi-hat struck together, then the beat as it was.",
    async run(d) {
      await midiConnect(d);
      await d.button("Note input");
      await midiKeys(d, [42, 38]);
      await midiKeys(d, [60]);
      await d.bars({ 1: "Snare+Hi-Hat quarter, Snare quarter, Bass Drum quarter, Snare quarter" });
    },
  },
];
