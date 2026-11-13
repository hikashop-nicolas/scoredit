// MusicXML from the recognised symbols (oemer's build_system.py).
import type { NoteGroup } from "./group";
import { NoteType, type NoteHead, type SfnType } from "./notehead";
import { pyMod, pyRound, sortedBy } from "./py";
import { RestType, xCenter, type Barline, type Clef, type ClefType, type Rest, type Sfn, type Symbols } from "./symbols";

const DIV = 16;
const G_PITCH = ["D", "E", "F", "G", "A", "B", "C"];
const F_PITCH = ["F", "G", "A", "B", "C", "D", "E"];
const SHARP_ORDER = ["F", "C", "G", "D", "A", "E"];
const FLAT_ORDER = ["B", "E", "A", "D", "G", "C"];

const RHYTHM: Record<number, { name: string; duration: number }> = {
  [NoteType.WHOLE]: { name: "whole", duration: DIV * 4 },
  [NoteType.HALF]: { name: "half", duration: DIV * 2 },
  [NoteType.HALF_OR_WHOLE]: { name: "half", duration: DIV * 2 },
  [NoteType.QUARTER]: { name: "quarter", duration: DIV },
  [NoteType.EIGHTH]: { name: "eighth", duration: DIV / 2 },
  [NoteType.SIXTEENTH]: { name: "16th", duration: DIV / 4 },
  [NoteType.THIRTY_SECOND]: { name: "32nd", duration: DIV / 8 },
  [NoteType.SIXTY_FOURTH]: { name: "64th", duration: DIV / 16 },
};
const REST_DURA: [RestType, number][] = [
  [RestType.QUARTER, DIV],
  [RestType.EIGHTH, DIV / 2],
  [RestType.SIXTEENTH, DIV / 4],
  [RestType.THIRTY_SECOND, DIV / 8],
  [RestType.SIXTY_FOURTH, DIV / 16],
  [RestType.WHOLE_HALF, DIV * 2],
  [RestType.WHOLE, DIV * 4],
  [RestType.HALF, DIV * 2],
];
const restDura = (t: RestType) => REST_DURA.find(([k]) => k === t)![1];
const NOTE_DURA: [NoteType, number][] = [
  [NoteType.WHOLE, DIV * 4],
  [NoteType.HALF, DIV * 2],
  [NoteType.HALF_OR_WHOLE, DIV * 2],
  [NoteType.QUARTER, DIV],
  [NoteType.EIGHTH, DIV / 2],
  [NoteType.SIXTEENTH, DIV / 4],
  [NoteType.THIRTY_SECOND, DIV / 8],
  [NoteType.SIXTY_FOURTH, DIV / 16],
];

class Voice {
  kind = "voice" as const;
  id = 0;
  noteIds: number[] = [];
  stemUp: boolean | null = null;
  groupId = 0;
  x = 0;
  label: NoteType = NoteType.QUARTER;
  hasDot = false;
  group = 0;
  track = 0;
  duration = 0;
  init(notes: NoteHead[]) {
    const counts = new Map<NoteType | null, number>();
    for (const n of this.noteIds) counts.set(notes[n].label, (counts.get(notes[n].label) ?? 0) + 1);
    this.label = [...counts].sort((a, b) => b[1] - a[1])[0][0] ?? NoteType.QUARTER;
    const t = this.noteIds.filter((n) => notes[n].hasDot).length;
    this.hasDot = t > this.noteIds.length - t;
    for (const n of this.noteIds) {
      if (notes[n].label !== this.label) notes[n].forceLabel(this.label);
      notes[n].hasDot = this.hasDot;
    }
    this.duration = RHYTHM[this.label].duration;
    if (this.hasDot) this.duration = pyRound(this.duration * 1.5);
  }
}

type Sym = Voice | Clef | Sfn | Rest;
const symX = (s: Sym | Barline) => (s.kind === "voice" ? s.x : xCenter(s));

function labelByDura<T>(d: number, mapping: [T, number][]): [T, boolean] {
  let min = 9999999;
  let tar = mapping[0][0];
  for (const [l, v] of mapping) {
    const diff = d - v;
    if (diff >= 0 && diff < min) {
      min = diff;
      tar = l;
    }
  }
  return [tar, min > 0];
}

function duration(s: Voice | Rest): number {
  if (s.kind === "voice") return s.duration;
  const d = restDura(s.label);
  return s.hasDot ? pyRound(d * 1.5) : d;
}

class Ctx {
  constructor(
    public notes: NoteHead[],
    public tracks: number,
    public unit: number,
  ) {}
}

class Measure {
  symbols: Sym[] = [];
  doubleBarline = false;
  clefs: Clef[] = [];
  voices: Voice[] = [];
  sfns: Sfn[] = [];
  rests: Rest[] = [];
  number = 0;
  atBeginning = false;
  group = 0;
  slots: Sym[][] = [];
  slotDuras: number[][] = [];
  constructor(private c: Ctx) {}
  add(syms: Sym[]) {
    this.symbols = sortedBy([...this.symbols, ...syms], symX);
    for (const s of syms) {
      if (s.kind === "voice") this.voices.push(s);
      else if (s.kind === "clef") this.clefs.push(s);
      else if (s.kind === "sfn") this.sfns.push(s);
      else this.rests.push(s);
    }
    this.voices = sortedBy(this.voices, symX);
    this.clefs = sortedBy(this.clefs, symX);
    this.sfns = sortedBy(this.sfns, symX);
    this.rests = sortedBy(this.rests, symX);
  }
  hasKey(): boolean {
    const t = this.c.tracks;
    const start = this.atBeginning ? t : 0;
    return this.symbols.slice(start, start + t).every((s) => s.kind === "sfn");
  }
  getKey(): number {
    if (!this.sfns.length) return 0;
    const t = this.c.tracks;
    if (!this.hasKey()) return 0;
    const start = this.atBeginning ? t : 0;
    const end = Math.min(t * 7 + 4, this.symbols.length);
    const cands: Sfn[] = [];
    for (let i = start; i < end; i++) {
      const s = this.symbols[i];
      if (s.kind !== "sfn") break;
      cands.push(s);
    }
    const counts = new Array<number>(t).fill(0);
    for (const s of cands) counts[s.track]++;
    let label = cands[0]?.label;
    if (!cands.length) return 0;
    if (!cands.every((s) => s.label === cands[0].label)) {
      let c: [SfnType, number][] = (["flat", "sharp", "natural"] as SfnType[]).map((k) => [k, cands.filter((s) => s.label === k).length]);
      c = sortedBy(c, (x) => x[1], true);
      if (c[0][0] === "natural") [c[0], c[1]] = [c[1], c[0]];
      if (c[0][0] === "flat") label = "flat";
      else if (c[0][0] === "sharp") label = "sharp";
    }
    let n = pyRound(counts.reduce((a, b) => a + b, 0) / t);
    if (label === "flat") n = -n;
    for (const s of cands) s.isKey = true;
    return Math.max(-6, Math.min(6, n));
  }
  trackClefs(): (Clef | null)[] {
    const t = this.c.tracks;
    if (this.atBeginning || this.doubleBarline) {
      const out: Clef[] = [];
      for (let k = 0; k < t; k++) {
        const c = this.clefs.find((x) => x.track === k);
        out.push(c ?? { kind: "clef", bbox: [0, 0, 0, 0], track: k, group: this.group, label: k % 2 ? "F" : "G" });
      }
      return out;
    }
    return new Array(t).fill(null);
  }
  align() {
    const t = this.c.tracks;
    const unit = this.c.unit;
    const slots: Sym[][] = [];
    const corr: number[] = [];
    let lastX: number | null = null;
    this.symbols.forEach((s, idx) => {
      if (s.kind === "clef" || s.kind === "sfn") return;
      if (lastX === null || !(Math.abs(symX(s) - lastX) < unit)) {
        slots.push([s]);
        corr.push(idx);
        lastX = symX(s);
      } else slots[slots.length - 1].push(s);
    });
    const duras = slots.map((slot) => {
      const per: number[][] = Array.from({ length: t }, () => []);
      for (const s of slot) per[s.track].push(duration(s as Voice | Rest));
      return per.map((d) => (d.length ? Math.min(...d) & 0xffff : 0));
    });
    // oemer aligns two staffs only (it stops on more); more are left unaligned here.
    if (t !== 2) {
      this.slots = slots;
      this.slotDuras = duras;
      return;
    }
    let diff = 0;
    let lead: number | null = null;
    let addIdx = 0;
    let added = 0;
    let solved = true;
    const fresh = duras.map((d) => [...d, 0, 0]);
    let idx = 0;
    const modify = (ai: number, df: number, ld: number) => {
      const pos = duras[ai][1 - ld];
      if (pos !== 0) {
        for (const s of slots[ai]) if (s.track === 1 - ld) extend(s as Voice | Rest, df + pos, this.c.notes);
        fresh[ai][1 - ld] = df + pos;
      } else {
        const [label, dot] = labelByDura(df, REST_DURA);
        const x = symX(slots[ai][0]);
        const rest: Rest = { kind: "rest", bbox: [x, 0, x, 0], label, hasDot: dot, track: 1 - ld, group: this.group };
        // oemer inserts at the slot of the loop's current index (a late-bound variable).
        this.symbols.splice(corr[idx] + added, 0, rest);
        slots[ai].unshift(rest);
        added++;
        fresh[ai][1 - ld] = df;
      }
    };
    for (idx = 0; idx < duras.length; idx++) {
      const [t1, t2] = duras[idx];
      if (t1 > 0 && t2 > 0) {
        if (diff > 0) modify(addIdx, diff, lead!);
        if (t1 > t2) {
          diff = t1 - t2;
          lead = 0;
        } else {
          diff = t2 - t1;
          lead = 1;
        }
        addIdx = idx;
        solved = true;
      } else if (t1 > 0) {
        if (lead === 0) diff += t1;
        else if (diff >= t1) diff -= t1;
        else {
          diff = diff > 0 && diff < t1 ? t1 - diff : t1;
          addIdx = idx;
          lead = 0;
        }
        solved = false;
      } else if (t2 > 0) {
        if (lead === 1) diff += t2;
        else if (diff >= t2) diff -= t2;
        else {
          diff = diff > 0 && diff < t2 ? t2 - diff : t2;
          addIdx = idx;
          lead = 1;
        }
        solved = false;
      }
    }
    idx = duras.length - 1;
    if (!solved && diff > 0) modify(addIdx, diff, lead!);
    this.slots = slots;
    this.slotDuras = fresh.map((r) => r.slice(0, 2));
  }
  slotAt(x: number): [number, number[]] {
    for (let i = 0; i < this.slots.length - 1; i++) if (symX(this.slots[i][0]) <= x && x < symX(this.slots[i + 1][0])) return [i, this.slotDuras[i]];
    return [this.slots.length - 1, this.slotDuras[this.slotDuras.length - 1]];
  }
}

function extend(s: Voice | Rest, d: number, notes: NoteHead[]) {
  if (s.kind === "voice") {
    const [label, dot] = labelByDura(d, NOTE_DURA);
    s.label = label;
    s.hasDot = dot;
    s.duration = d;
    for (const n of s.noteIds) {
      notes[n].forceLabel(label);
      notes[n].hasDot = dot;
    }
  } else {
    const [label, dot] = labelByDura(d, REST_DURA);
    s.label = label;
    s.hasDot = dot;
  }
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

function clefXml(c: Clef): string {
  return `<clef number="${c.track + 1}"><sign>${c.label}</sign><line>${c.label === "G" ? 2 : 4}</line></clef>`;
}

function chroma(pos: number, clef: ClefType) {
  const order = clef === "G" ? G_PITCH : F_PITCH;
  return order[pos >= 0 ? pos % 7 : (pyMod(pos, -7) + 7) % 7];
}

function noteXml(n: NoteHead, clef: ClefType, chord: boolean, voice: number): string | null {
  if (n.invalid) return null;
  const pos = Math.trunc(n.staffLinePos);
  const [order, octOff, pOff] = clef === "G" ? [G_PITCH, 4, 1] : [F_PITCH, 2, 3];
  const step = order[pos >= 0 ? pos % 7 : (pyMod(pos, -7) + 7) % 7];
  const octave = pos - pOff >= 0 ? Math.floor((pos + pOff) / 7) + octOff : -Math.ceil((pos + pOff) / -7) + octOff;
  const alter = n.sfn === "sharp" ? 1 : n.sfn === "flat" ? -1 : 0;
  if (octave < 0 || octave > 8 || (octave === 0 && step !== "A") || (octave === 8 && step !== "C")) return null;
  const r = RHYTHM[n.label ?? NoteType.QUARTER];
  const dura = n.hasDot ? pyRound(r.duration * 1.5) : r.duration;
  return (
    `<note>${chord ? "<chord/>" : ""}<pitch><step>${step}</step><alter>${alter}</alter><octave>${octave}</octave></pitch>` +
    `<duration>${dura}</duration><type>${r.name}</type>${n.hasDot ? "<dot/>" : ""}<stem>${n.stemUp ? "up" : "down"}</stem>` +
    `<staff>${n.track + 1}</staff><voice>${voice}</voice></note>`
  );
}

function restXml(r: Rest): string {
  const d = restDura(r.label);
  const dura = r.hasDot ? pyRound(d * 1.5) : d;
  // oemer marks every rest as a whole-measure rest.
  return `<note><rest measure="yes"/><duration>${dura}</duration>${r.hasDot ? "<dot/>" : ""}<staff>${r.track + 1}</staff></note>`;
}

/** Builds the MusicXML text (oemer's MusicXMLBuilder). */
export function buildMusicXml(notes: NoteHead[], groups: NoteGroup[], sym: Symbols, unit: number, tracks: number, title = "Scan"): string {
  const c = new Ctx(notes, tracks, unit);
  const voices: Voice[] = [];
  const addVoice = (g: NoteGroup, ids: number[], up: boolean | null) => {
    ids = ids.filter((n) => !notes[n].invalid);
    if (!ids.length) return;
    const v = new Voice();
    v.group = g.group;
    v.groupId = g.id;
    v.track = g.track;
    v.noteIds = ids;
    v.stemUp = up;
    v.x = g.xCenter;
    v.init(notes);
    voices.push(v);
  };
  for (const g of groups) {
    if (g.stemUp === null && g.hasStem) {
      addVoice(g, g.topNoteIds, true);
      addVoice(g, g.bottomNoteIds, false);
    } else addVoice(g, g.noteIds, g.stemUp);
  }
  voices.forEach((v, i) => (v.id = i));
  // Symbols per system, left to right.
  const byGroup = new Map<number, (Sym | Barline)[]>();
  const put = (xs: (Sym | Barline)[]) => {
    for (const s of xs) {
      if (!byGroup.has(s.group)) byGroup.set(s.group, []);
      byGroup.get(s.group)!.push(s);
    }
  };
  put(voices);
  put(sym.barlines);
  put(sym.rests);
  put(sym.clefs);
  put(sym.sfns.filter((s) => s.noteId === null));
  const systems = [...byGroup.keys()].sort((a, b) => a - b).map((k) => [k, sortedBy(byGroup.get(k)!, symX)] as const);
  if (!systems.length) throw new Error("nothing recognised");
  const measures = new Map<number, Measure[]>();
  let num = 1;
  const gen = (buf: Sym[], grp: number, n: number, begin: boolean, dbl: boolean) => {
    const m = new Measure(c);
    m.add(buf);
    m.doubleBarline = dbl;
    m.number = n;
    m.atBeginning = begin;
    m.group = grp;
    m.getKey();
    m.align();
    return m;
  };
  for (const [grp, insts] of systems) {
    measures.set(grp, []);
    let buf: Sym[] = [];
    let begin = true;
    let dbl = false;
    for (const inst of insts) {
      if (inst.kind === "barline") {
        if (!buf.length) dbl = true;
        else {
          measures.get(grp)!.push(gen(buf, grp, num, begin, dbl));
          num++;
          buf = [];
          begin = false;
          dbl = false;
        }
        continue;
      }
      buf.push(inst);
    }
    if (buf.length) measures.get(grp)!.push(gen(buf, grp, num, begin, dbl));
  }
  const first = [...measures.values()].find((ms) => ms.length)?.[0];
  if (!first) throw new Error("no measure recognised");
  // Actions, performed in order with the clef, key and accidental state oemer keeps.
  let key = first.getKey();
  let clefs = first.trackClefs() as Clef[];
  let curKey = key;
  const curClefs = [...clefs];
  let sfnState: Record<string, SfnType | null> = {};
  const initSfn = () => {
    sfnState = Object.fromEntries("ABCDEFG".split("").map((k) => [k, null]));
    if (key > 0) for (const s of SHARP_ORDER.slice(0, key)) sfnState[s] = "sharp";
    else if (key < 0) for (const s of FLAT_ORDER.slice(0, -key)) sfnState[s] = "flat";
  };
  initSfn();
  const measuresXml: { number: number; newSystem: boolean; body: string[] }[] = [];
  measuresXml.push({
    number: first.number,
    newSystem: false,
    body: [`<attributes><divisions>${DIV}</divisions><key><fifths>${first.getKey()}</fifths></key><staves>${tracks}</staves>${clefs.map(clefXml).join("")}</attributes>`],
  });
  let cur = measuresXml[0];
  const addNote = (n: NoteHead, chord = false, voice = 1) => {
    const clef = clefs[n.track].label;
    const ch = chroma(Math.trunc(n.staffLinePos), clef);
    const st = sfnState[ch];
    if (n.sfn !== null && st !== n.sfn) sfnState[ch] = n.sfn;
    else n.sfn = st;
    const x = noteXml(n, clef, chord, voice);
    if (x) cur.body.push(x);
  };
  const backup = (d: number) => d && cur.body.push(`<backup><duration>${d}</duration></backup>`);
  const forward = (d: number) => d && cur.body.push(`<forward><duration>${d}</duration></forward>`);
  for (const [, ms] of systems.map(([g]) => [g, measures.get(g)!] as const)) {
    let brk = true;
    for (const m of ms) {
      // AddMeasure resets the accidentals to the key.
      cur = { number: m.number, newSystem: brk, body: [] };
      measuresXml.push(cur);
      initSfn();
      brk = false;
      let lastT = 0;
      let lastD = 0;
      let lastPos = 0;
      const total = new Array<number>(tracks).fill(0);
      let minAdded = new Array<boolean>(tracks).fill(false);
      for (const s of m.symbols) {
        const tr = s.track;
        if (s.kind === "clef") {
          if (curClefs[tr].label !== s.label) {
            clefs = [...clefs];
            clefs[tr] = s;
            cur.body.push(`<attributes>${clefXml(s)}</attributes>`);
            curClefs[tr] = s;
          }
          continue;
        }
        if (s.kind === "sfn") {
          if (m.hasKey()) {
            const k = m.getKey();
            if (k !== curKey) {
              key = k;
              initSfn();
              cur.body.push(`<attributes><key><fifths>${k}</fifths></key></attributes>`);
              curKey = k;
            }
          }
          continue;
        }
        const [tidx, mins] = m.slotAt(symX(s));
        const minD = mins[tr];
        const d = duration(s);
        if (tidx === lastT && lastD > 0) backup(Math.trunc(lastD));
        else {
          minAdded = new Array<boolean>(tracks).fill(false);
          const df = lastPos - total[tr];
          if (df > 0 && df !== lastD) backup(Math.trunc(df));
        }
        let one = false;
        if (d === minD && !minAdded[tr]) {
          total[tr] += minD;
          minAdded[tr] = true;
          one = true;
        }
        if (s.kind === "rest") {
          cur.body.push(restXml(s));
          lastPos = total[tr];
          lastD = d;
          lastT = tidx;
        } else if (s.duration === minD && one) {
          addNote(notes[s.noteIds[0]]);
          for (const n of s.noteIds.slice(1)) addNote(notes[n], true);
          lastPos = total[tr];
          lastD = d;
          lastT = tidx;
        } else {
          addNote(notes[s.noteIds[0]], false, 2);
          for (const n of s.noteIds.slice(1)) addNote(notes[n], true, 2);
          let pos = total[tr] + s.duration;
          if (minAdded[tr]) pos -= minD;
          const df = lastPos - pos;
          if (df > 0) forward(Math.trunc(df));
          else if (df < 0) backup(Math.trunc(-df));
        }
      }
    }
  }
  // oemer drops the break between the opening attributes and the first measure.
  if (measuresXml.length > 1 && measuresXml[1].number === measuresXml[0].number && measuresXml[1].newSystem) {
    measuresXml[0].body.push(...measuresXml[1].body);
    measuresXml.splice(1, 1);
  }
  const parts = measuresXml.map(
    (m) => `<measure number="${m.number}">${m.newSystem ? '<print new-system="yes"/>' : ""}${m.body.join("")}</measure>`,
  );
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">\n` +
    `<score-partwise version="4.0"><work><work-title>${esc(title)}</work-title></work>` +
    `<identification><creator type="composer">Transcribed by Oemer</creator></identification>` +
    `<part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>` +
    `<part id="P1">${parts.join("")}</part></score-partwise>\n`
  );
}
