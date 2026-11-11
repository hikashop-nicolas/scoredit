import { kid, kids, text } from "../model/xml";
import { noteDuration } from "./notes";

// A measure read as voices of events (a rest or chord at a beat, with its grace notes) plus
// everything else at its beat, and written back the same way: each voice in turn, other
// elements at their beat in the first, <backup>/<forward> in between.

export interface Event {
  pos: number;
  dur: number;
  /** The rest, or the chord's notes (first without <chord/>). */
  notes: Element[];
  graces: Element[];
  rest: boolean;
}

export interface Placed {
  pos: number;
  el: Element;
}

export interface ReadMeasure {
  voices: Map<string, Event[]>;
  others: Placed[];
}

/** Voice key: staff and voice. */
export const voiceKey = (staff: number, voice: string) => `${staff}|${voice}`;
const keyOf = (note: Element) => voiceKey(Number(text(note, "staff")) || 1, text(note, "voice") || "1");

const LEFT = -1;
const RIGHT = Number.MAX_SAFE_INTEGER;

export function readMeasure(m: Element): ReadMeasure {
  const voices = new Map<string, Event[]>();
  const others: Placed[] = [];
  const graces = new Map<string, Element[]>();
  let pos = 0;
  let last: Event | null = null;
  for (const c of kids(m)) {
    switch (c.tagName) {
      case "backup":
        pos -= Number(text(c, "duration")) || 0;
        break;
      case "forward":
        pos += Number(text(c, "duration")) || 0;
        break;
      case "note": {
        const key = keyOf(c);
        if (kid(c, "grace")) {
          graces.set(key, [...(graces.get(key) ?? []), c]);
          break;
        }
        if (kid(c, "chord") && last) {
          last.notes.push(c);
          break;
        }
        const ev: Event = { pos, dur: noteDuration(c), notes: [c], graces: graces.get(key) ?? [], rest: !!kid(c, "rest") };
        graces.delete(key);
        const list = voices.get(key) ?? [];
        list.push(ev);
        voices.set(key, list);
        last = ev;
        pos += ev.dur;
        break;
      }
      case "barline": {
        const at = c.getAttribute("location");
        others.push({ pos: at === "left" ? LEFT : at === "middle" ? pos : RIGHT, el: c });
        break;
      }
      default:
        others.push({ pos, el: c });
    }
  }
  // Grace notes with nothing after them stay where they were.
  for (const gs of graces.values()) for (const g of gs) others.push({ pos, el: g });
  return { voices, others };
}

const RANK: Record<string, number> = { print: 0, attributes: 1, harmony: 3, "figured-bass": 3 };

const sortKeys = (keys: string[]) =>
  keys.sort((a, b) => {
    const [sa, va] = a.split("|");
    const [sb, vb] = b.split("|");
    return Number(sa) - Number(sb) || (Number(va) || 0) - (Number(vb) || 0) || va.localeCompare(vb);
  });

export function writeMeasure(m: Element, r: ReadMeasure): void {
  const doc = m.ownerDocument;
  while (m.firstChild) m.removeChild(m.firstChild);
  const others = [...r.others].sort((a, b) => a.pos - b.pos || (RANK[a.el.tagName] ?? 2) - (RANK[b.el.tagName] ?? 2));
  let cursor = 0;
  const move = (to: number) => {
    if (to === cursor) return;
    const e = doc.createElementNS(null, to < cursor ? "backup" : "forward");
    const d = doc.createElementNS(null, "duration");
    d.textContent = String(Math.abs(to - cursor));
    e.appendChild(d);
    m.appendChild(e);
    cursor = to;
  };
  let oi = 0;
  const flush = (upTo: number) => {
    while (oi < others.length && others[oi].pos <= upTo) {
      const o = others[oi++];
      if (o.pos !== LEFT && o.pos !== RIGHT) move(o.pos);
      m.appendChild(o.el);
    }
  };
  flush(LEFT);
  sortKeys([...r.voices.keys()]).forEach((key, k) => {
    for (const ev of r.voices.get(key)!) {
      if (k === 0) flush(ev.pos);
      move(ev.pos);
      for (const g of ev.graces) m.appendChild(g);
      ev.notes.forEach((n, i) => {
        const chord = kid(n, "chord");
        if (i === 0 && chord) chord.remove();
        if (i > 0 && !chord) n.insertBefore(doc.createElementNS(null, "chord"), kids(n).find((c) => c.tagName !== "grace" && c.tagName !== "cue") ?? null);
        m.appendChild(n);
      });
      cursor += ev.dur;
    }
    if (k === 0) flush(RIGHT - 1);
  });
  flush(RIGHT - 1);
  flush(RIGHT);
}
