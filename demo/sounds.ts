// A listening test for scoredit's instrument sounds: the same tune on each sound option,
// rendered offline and set to the same loudness, played on demand, compared blind.
import { PLUCKED, Pluck } from "../src/play/pluck";
import { DRUMS, Sampler } from "../src/play/sampler";
import WebAudioTinySynth from "../src/vendor/tinysynth.js";
import sizes from "./sound-sizes.json";

type Kind = "melody" | "keys" | "guitar" | "bass" | "drums";
interface Inst {
  name: string;
  family: string;
  program: number;
  kind: Kind;
  /** Semitones the tune moves to sit well on the instrument. */
  shift: number;
}
type Option = "fm" | "recorded" | "string";
const OPTION_NAME: Record<Option, string> = {
  fm: "Built-in synthesizer (no download)",
  recorded: "Recorded instrument",
  string: "String model (no download)",
};

const INSTRUMENTS: Inst[] = [
  { name: "Grand piano", family: "Keyboard", program: 0, kind: "keys", shift: 0 },
  { name: "Electric piano", family: "Keyboard", program: 4, kind: "keys", shift: 0 },
  { name: "Harpsichord", family: "Keyboard", program: 6, kind: "keys", shift: 0 },
  { name: "Church organ", family: "Keyboard", program: 19, kind: "keys", shift: 0 },
  { name: "Marimba", family: "Percussion", program: 12, kind: "keys", shift: 0 },
  { name: "Nylon guitar", family: "Guitar", program: 24, kind: "guitar", shift: 0 },
  { name: "Steel guitar", family: "Guitar", program: 25, kind: "guitar", shift: 0 },
  { name: "Electric guitar (clean)", family: "Guitar", program: 27, kind: "guitar", shift: 0 },
  { name: "Acoustic bass", family: "Bass", program: 32, kind: "bass", shift: 0 },
  { name: "Electric bass", family: "Bass", program: 33, kind: "bass", shift: 0 },
  { name: "Harp", family: "Plucked", program: 46, kind: "keys", shift: 0 },
  { name: "Violin", family: "Strings", program: 40, kind: "melody", shift: 12 },
  { name: "Cello", family: "Strings", program: 42, kind: "melody", shift: -12 },
  { name: "String orchestra", family: "Strings", program: 48, kind: "melody", shift: 0 },
  { name: "Choir", family: "Voices", program: 52, kind: "melody", shift: 0 },
  { name: "Flute", family: "Woodwind", program: 73, kind: "melody", shift: 12 },
  { name: "Oboe", family: "Woodwind", program: 68, kind: "melody", shift: 0 },
  { name: "Clarinet", family: "Woodwind", program: 71, kind: "melody", shift: 0 },
  { name: "Alto saxophone", family: "Woodwind", program: 65, kind: "melody", shift: 0 },
  { name: "Trumpet", family: "Brass", program: 56, kind: "melody", shift: 0 },
  { name: "French horn", family: "Brass", program: 60, kind: "melody", shift: -5 },
  { name: "Trombone", family: "Brass", program: 57, kind: "melody", shift: -12 },
  { name: "Drum kit", family: "Drums", program: DRUMS, kind: "drums", shift: 0 },
];

interface Note {
  midi: number;
  t: number;
  d: number;
  v: number;
}
const BEAT = 0.6; // seconds, about 100 beats per minute

// Ode to Joy (Beethoven), the first phrase: E E F G | G F E D | C C D E | E. D D
const ODE: [number, number][] = [
  [64, 1], [64, 1], [65, 1], [67, 1], [67, 1], [65, 1], [64, 1], [62, 1],
  [60, 1], [60, 1], [62, 1], [64, 1], [64, 1.5], [62, 0.5], [62, 2],
];

function phrase(inst: Inst): Note[] {
  const out: Note[] = [];
  const melody = (shift: number, v = 90) => {
    let t = 0;
    for (const [m, b] of ODE) {
      out.push({ midi: m + shift, t: t * BEAT, d: b * BEAT * 0.95, v });
      t += b;
    }
  };
  switch (inst.kind) {
    case "melody":
      melody(inst.shift);
      break;
    case "keys": {
      melody(inst.shift + 12, 88);
      // Left hand: one chord a bar, C G C G.
      const chords = [[48, 55, 64], [43, 50, 59], [48, 55, 64], [43, 50, 55]];
      chords.forEach((c, i) => c.forEach((m) => out.push({ midi: m + inst.shift, t: i * 4 * BEAT, d: 3.8 * BEAT, v: 62 })));
      break;
    }
    case "guitar": {
      // A picked pattern over C, G, Am, F: bass then three strings.
      const shapes = [[48, 55, 60, 64], [43, 50, 55, 59], [45, 52, 57, 60], [41, 48, 53, 57]];
      shapes.forEach((s, bar) =>
        [0, 1, 2, 3, 2, 1, 2, 3].forEach((k, i) => out.push({ midi: s[k], t: (bar * 4 + i * 0.5) * BEAT, d: (k === 0 ? 3.9 : 1.4) * BEAT, v: k === 0 ? 92 : 80 })),
      );
      break;
    }
    case "bass": {
      const line = [36, 40, 43, 45, 43, 38, 41, 43, 45, 43, 40, 36, 41, 43, 36, 36];
      line.forEach((m, i) => out.push({ midi: m, t: i * BEAT, d: 0.9 * BEAT, v: 95 }));
      break;
    }
    case "drums": {
      for (let i = 0; i < 16; i++) {
        out.push({ midi: 42, t: i * 0.5 * BEAT, d: 0.2, v: 70 }); // hi-hat
        if (i % 4 === 0) out.push({ midi: 36, t: i * 0.5 * BEAT, d: 0.3, v: 110 }); // kick
        if (i % 4 === 2) out.push({ midi: 38, t: i * 0.5 * BEAT, d: 0.3, v: 100 }); // snare
      }
      for (let i = 0; i < 16; i++) {
        out.push({ midi: 42, t: (8 + i * 0.5) * BEAT, d: 0.2, v: 70 });
        if (i % 4 === 0 || i === 7) out.push({ midi: 36, t: (8 + i * 0.5) * BEAT, d: 0.3, v: 110 });
        if (i % 4 === 2) out.push({ midi: 38, t: (8 + i * 0.5) * BEAT, d: 0.3, v: 100 });
      }
      out.push({ midi: 49, t: 15 * BEAT, d: 1, v: 100 }); // crash
      break;
    }
  }
  return out;
}

const SR = 44100;
const ctx = new AudioContext();
let sampler: Sampler | null = null;
const fm = new WebAudioTinySynth({ quality: 1, useReverb: 0 });

function optionsFor(inst: Inst): Option[] {
  const o: Option[] = ["fm", "recorded"];
  if (PLUCKED.has(inst.program)) o.push("string");
  return o;
}

async function render(inst: Inst, option: Option): Promise<AudioBuffer> {
  const notes = phrase(inst);
  const length = Math.max(...notes.map((n) => n.t + n.d)) + 1.5;
  const off = new OfflineAudioContext(2, Math.ceil(length * SR), SR);
  const ch = inst.program === DRUMS ? 9 : 0;
  if (option === "fm") {
    fm.setAudioContext(off as unknown as AudioContext);
    if (ch === 0) fm.send([0xc0, inst.program], 0.001);
    for (const n of notes) {
      fm.send([0x90 | ch, n.midi, n.v], 0.01 + n.t);
      fm.send([0x80 | ch, n.midi, 0], 0.01 + n.t + n.d);
    }
  } else if (option === "string") {
    const p = new Pluck(off as unknown as AudioContext);
    for (const n of notes) p.play(inst.program, n.midi, 0.01 + n.t, n.d, n.v);
  } else {
    if (!sampler) throw new Error("not loaded");
    await sampler.prepare(notes.map((n) => [inst.program, n.midi]));
    for (const n of notes) {
      const buf = sampler.buffer(inst.program, n.midi);
      if (!buf) continue;
      const src = off.createBufferSource();
      src.buffer = buf;
      const g = off.createGain();
      const t = 0.01 + n.t;
      g.gain.setValueAtTime(n.v / 100, t);
      g.gain.setTargetAtTime(0, t + n.d, 0.06);
      src.connect(g).connect(off.destination);
      src.start(t);
      src.stop(Math.min(t + buf.duration, t + n.d + 0.6));
    }
  }
  const out = await off.startRendering();
  out.rawPeak = peakOf(out);
  normalize(out);
  return out;
}

declare global {
  interface AudioBuffer {
    rawPeak?: number;
  }
}
const peakOf = (b: AudioBuffer) => Math.max(...[0, 1].map((c) => b.getChannelData(c).reduce((m, v) => Math.max(m, Math.abs(v)), 0)));

// Same loudness for every option (RMS), without clipping.
function normalize(buf: AudioBuffer): void {
  let sum = 0;
  let peak = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) {
      sum += d[i] * d[i];
      peak = Math.max(peak, Math.abs(d[i]));
    }
  }
  const rms = Math.sqrt(sum / (buf.length * buf.numberOfChannels)) || 1e-9;
  const k = Math.min(0.1 / rms, 0.95 / (peak || 1));
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) d[i] *= k;
  }
}

// ---- Page

const STORE = "scoredit-sound-check";
interface Saved {
  order: Record<string, Option[]>;
  choice: Record<string, Option | "same">;
}
const saved: Saved = (() => {
  try {
    return JSON.parse(localStorage.getItem(STORE) ?? "") as Saved;
  } catch {
    return { order: {}, choice: {} };
  }
})();
const save = () => {
  try {
    localStorage.setItem(STORE, JSON.stringify(saved));
  } catch {
    /* private mode */
  }
};
let blind = true;
const cache = new Map<string, Promise<AudioBuffer>>();
let playing: { src: AudioBufferSourceNode; btn: HTMLButtonElement } | null = null;

const shuffle = <T>(a: T[]) => {
  const b = [...a];
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
};
const sizeOf = (inst: Inst) => (sizes as Record<string, { mb: number }>)[inst.program === DRUMS ? "drums" : String(inst.program)]?.mb ?? 0;

async function play(inst: Inst, option: Option, btn: HTMLButtonElement): Promise<void> {
  if (ctx.state === "suspended") await ctx.resume();
  const was = playing?.btn;
  stop();
  if (was === btn) return;
  const key = `${inst.program}:${option}`;
  if (!cache.has(key)) cache.set(key, render(inst, option));
  btn.textContent = "…";
  const buf = await cache.get(key)!;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start();
  btn.classList.add("on");
  btn.textContent = "■ Stop";
  playing = { src, btn };
  src.onended = () => playing?.src === src && stop();
}
function stop(): void {
  if (!playing) return;
  try {
    playing.src.stop();
  } catch {
    /* already ended */
  }
  playing.btn.classList.remove("on");
  playing.btn.textContent = playing.btn.dataset.label ?? "";
  playing = null;
}

function draw(): void {
  const rows = document.getElementById("rows")!;
  rows.textContent = "";
  for (const inst of INSTRUMENTS) {
    const id = String(inst.program);
    saved.order[id] ??= shuffle(optionsFor(inst));
    const order = blind ? saved.order[id] : optionsFor(inst);
    const row = document.createElement("section");
    row.className = "row";
    const head = document.createElement("div");
    head.className = "head";
    head.innerHTML = `<span class="name"></span><span class="family"></span>`;
    head.querySelector(".name")!.textContent = inst.name;
    head.querySelector(".family")!.textContent = inst.family;
    const opts = document.createElement("div");
    opts.className = "opts";
    order.forEach((option, i) => {
      const box = document.createElement("span");
      box.className = "opt";
      const label = blind ? `▶ Sound ${i + 1}` : `▶ ${OPTION_NAME[option]}`;
      const playBtn = document.createElement("button");
      playBtn.type = "button";
      playBtn.className = "play";
      playBtn.textContent = label;
      playBtn.dataset.label = label;
      playBtn.addEventListener("click", () => void play(inst, option, playBtn));
      const pick = document.createElement("button");
      pick.type = "button";
      pick.className = "pick";
      pick.textContent = "I prefer this";
      pick.setAttribute("aria-pressed", String(saved.choice[id] === option));
      pick.addEventListener("click", () => {
        saved.choice[id] = option;
        save();
        draw();
      });
      box.append(playBtn, pick);
      opts.append(box);
    });
    const same = document.createElement("span");
    same.className = "opt";
    const sameBtn = document.createElement("button");
    sameBtn.type = "button";
    sameBtn.className = "pick";
    sameBtn.textContent = "They sound the same to me";
    sameBtn.setAttribute("aria-pressed", String(saved.choice[id] === "same"));
    sameBtn.addEventListener("click", () => {
      saved.choice[id] = "same";
      save();
      draw();
    });
    same.append(sameBtn);
    opts.append(same);
    row.append(head, opts);
    const choice = saved.choice[id];
    if (choice) {
      const reveal = document.createElement("div");
      reveal.className = "reveal";
      const names = order.map((o, i) => `${blind ? `Sound ${i + 1}` : ""}${blind ? " = " : ""}${OPTION_NAME[o]}`).join(" · ");
      reveal.innerHTML = choice === "same" ? `You heard no difference. ` : `You chose: <b></b>. `;
      if (choice !== "same") reveal.querySelector("b")!.textContent = OPTION_NAME[choice];
      reveal.append(document.createTextNode(blind ? names : ""));
      row.append(reveal);
    }
    rows.append(row);
  }
  const body = document.getElementById("summary")!;
  body.textContent = "";
  for (const inst of INSTRUMENTS) {
    const c = saved.choice[String(inst.program)];
    const tr = document.createElement("tr");
    tr.innerHTML = `<td></td><td></td><td class="num"></td>`;
    tr.children[0].textContent = inst.name;
    tr.children[1].textContent = c ? (c === "same" ? "No difference" : OPTION_NAME[c]) : "–";
    tr.children[2].textContent = `${sizeOf(inst).toFixed(1)} MB`;
    body.append(tr);
  }
  save();
}

document.getElementById("blind")!.addEventListener("click", () => {
  blind = true;
  document.getElementById("blind")!.setAttribute("aria-pressed", "true");
  document.getElementById("named")!.setAttribute("aria-pressed", "false");
  draw();
});
document.getElementById("named")!.addEventListener("click", () => {
  blind = false;
  document.getElementById("blind")!.setAttribute("aria-pressed", "false");
  document.getElementById("named")!.setAttribute("aria-pressed", "true");
  draw();
});
document.getElementById("reset")!.addEventListener("click", () => {
  saved.order = {};
  saved.choice = {};
  draw();
});

draw();
// For checking from the console: each option's raw (before levelling) peak.
(window as unknown as { soundCheck: unknown }).soundCheck = { render, INSTRUMENTS };
// The full MuseScore General bank, from the local corpus (npm run corpus, or copy it to corpus/sounds/).
fetch("corpus/sounds/MuseScore_General.sf3")
  .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
  .then((b) => Sampler.create(ctx, b))
  .then((s) => {
    sampler = s;
    document.getElementById("status")!.textContent = s ? "Ready. Press a ▶ to listen." : "The recorded sounds could not be loaded.";
  })
  .catch(() => (document.getElementById("status")!.textContent = "Put MuseScore_General.sf3 in corpus/sounds/ to hear the recorded sounds."));
