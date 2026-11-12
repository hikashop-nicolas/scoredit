import { kid, kids, parseXml, text } from "./xml";

export interface PartInfo {
  id: string;
  name: string;
  abbreviation: string;
  /** General MIDI program (0-127) from the part list, 128 for a drum kit, null if not given. */
  program: number | null;
}

// The order MusicXML's schema wants inside <attributes>.
const ATTR_ORDER = ["divisions", "key", "time", "staves", "part-symbol", "instruments", "clef", "staff-details", "transpose", "for-part", "directive", "measure-style"];
// Attributes a new system needs to be read on its own. measure-style and directive are
// local to where they appear.
const CARRIED = new Set(["divisions", "key", "time", "staves", "part-symbol", "instruments", "clef", "staff-details", "transpose"]);

const attrKey = (e: Element) => e.tagName + "#" + (e.getAttribute("number") ?? "");

// A MusicXML score, partwise, kept as a DOM so that elements scoredit does not model
// survive a save untouched. The index on top answers what layout and editing ask.
export class ScoreDoc {
  readonly doc: Document;
  readonly root: Element;
  readonly parts: PartInfo[];
  /** measures[p][m]: the <measure> of part p at index m. */
  readonly measures: Element[][];
  /** First measures of the score's sections (movements); repeats and D.C. stay inside one. */
  sections: number[] = [0];
  /** "part:measure" of the measures edits changed, for saving only those. */
  readonly dirty = new Set<string>();
  /** Each measure's index in the file it was read from (-1: added since); null: unchanged. */
  origins: number[] | null = null;
  /** Called once per measure, just before an edit first changes it. */
  beforeChange?: (part: number, measure: number) => void;
  /** Attributes in force at the start of each measure, per part. */
  private attrsAt: Map<string, Element>[][] = [];

  constructor(xml: string | Document) {
    let doc = typeof xml === "string" ? parseXml(xml) : xml;
    if (doc.documentElement.tagName === "score-timewise") doc = timewiseToPartwise(doc);
    if (doc.documentElement.tagName !== "score-partwise") throw new Error("Not a MusicXML score");
    this.doc = doc;
    this.root = doc.documentElement;
    const list = kid(this.root, "part-list");
    const named = new Map<string, PartInfo>();
    for (const sp of list ? kids(list, "score-part") : []) {
      const id = sp.getAttribute("id") ?? "";
      const mi = kid(sp, "midi-instrument");
      const prog = mi ? Number(text(mi, "midi-program")) : 0;
      const program = mi && (kid(mi, "midi-unpitched") || text(mi, "midi-channel") === "10") ? 128 : prog ? prog - 1 : null;
      named.set(id, { id, name: text(sp, "part-name"), abbreviation: text(sp, "part-abbreviation"), program });
    }
    const partEls = kids(this.root, "part");
    this.parts = partEls.map((p) => named.get(p.getAttribute("id") ?? "") ?? { id: p.getAttribute("id") ?? "", name: "", abbreviation: "", program: null });
    this.measures = partEls.map((p) => kids(p, "measure"));
    this.reindex();
  }

  get measureCount(): number {
    return this.measures.length ? Math.max(...this.measures.map((m) => m.length)) : 0;
  }

  get title(): string {
    const work = kid(this.root, "work");
    return text(work, "work-title") || text(this.root, "movement-title");
  }

  get composer(): string {
    const id = kid(this.root, "identification");
    const c = id ? kids(id, "creator").find((e) => e.getAttribute("type") === "composer") : null;
    return text(c);
  }

  /** Reads the measures again after measures were added, removed or replaced. */
  refresh(): void {
    kids(this.root, "part").forEach((p, i) => {
      const ms = kids(p, "measure");
      if (this.measures[i]) this.measures[i].splice(0, this.measures[i].length, ...ms);
      else this.measures[i] = ms;
    });
    this.reindex();
  }

  /** Edits call this before changing a measure. */
  changing(part: number, measure: number): void {
    const key = `${part}:${measure}`;
    if (this.dirty.has(key)) return;
    this.beforeChange?.(part, measure);
    this.dirty.add(key);
  }

  /** Recomputes the carried attributes; call after an edit that touches <attributes>. */
  reindex(): void {
    this.attrsAt = this.measures.map((ms) => {
      const state = new Map<string, Element>();
      return ms.map((m) => {
        const at = new Map(state);
        for (const a of kids(m, "attributes")) for (const c of kids(a)) if (CARRIED.has(c.tagName)) state.set(attrKey(c), c);
        return at;
      });
    });
  }

  /** Attributes in force when measure m of part p starts, before its own. */
  attributesAt(p: number, m: number): Element[] {
    return [...(this.attrsAt[p]?.[m]?.values() ?? [])];
  }

  /** Musical width weight of a measure: distinct onsets across all parts. */
  measureWeight(m: number): number {
    const onsets = new Set<number>();
    let extras = 0;
    this.measures.forEach((ms, p) => {
      const meas = ms[m];
      if (!meas) return;
      let div = Number(text(this.attributesAt(p, m).find((e) => e.tagName === "divisions"))) || 1;
      let pos = 0;
      for (const c of kids(meas)) {
        if (c.tagName === "attributes") {
          const d = Number(text(c, "divisions"));
          if (d) { pos = (pos / div) * d; div = d; }
        }
        const dur = Number(text(c, "duration")) || 0;
        if (c.tagName === "backup") pos -= dur;
        else if (c.tagName === "forward") pos += dur;
        else if (c.tagName === "note") {
          if (kid(c, "grace")) { extras += 0.5; continue; }
          if (kid(c, "chord")) continue;
          onsets.add(Math.round((pos / div) * 960));
          if (kid(c, "accidental")) extras += 0.3;
          pos += dur;
        }
      }
    });
    return Math.max(1, onsets.size) + extras;
  }

  /**
   * MusicXML for measures [a, b) on their own: the header, each part's measures, and at
   * the first measure the attributes in force there, so it renders as a new system would.
   */
  slice(a: number, b: number, opts: { header?: boolean; abbreviate?: boolean } = {}): string {
    const out = parseXml("<score-partwise/>");
    const root = out.documentElement;
    for (const at of Array.from(this.root.attributes)) root.setAttribute(at.name, at.value);
    for (const c of kids(this.root)) {
      if (c.tagName === "part") continue;
      if (!opts.header && (c.tagName === "credit" || c.tagName === "work" || c.tagName === "movement-title" || c.tagName === "movement-number")) continue;
      const copy = root.appendChild(out.importNode(c, true)) as Element;
      // Later systems name parts by their short name, made up where the score has none. Each
      // slice renders as a first system, so the short name goes where the name is read.
      if (opts.abbreviate && c.tagName === "part-list")
        for (const sp of kids(copy, "score-part")) {
          const short = text(sp, "part-abbreviation") || (this.parts.length > 1 ? abbreviate(text(sp, "part-name")) : "");
          const name = kid(sp, "part-name");
          if (name) name.textContent = short;
          kid(sp, "part-name-display")?.remove();
        }
    }
    kids(this.root, "part").forEach((part, p) => {
      const np = out.importNode(part, false) as Element;
      root.appendChild(np);
      const ms = this.measures[p].slice(a, b);
      ms.forEach((m, i) => {
        const nm = out.importNode(m, true) as Element;
        stripBreaks(nm);
        if (i === 0) carryAttributes(out, nm, this.attributesAt(p, a));
        np.appendChild(nm);
      });
    });
    return new XMLSerializer().serializeToString(out);
  }

  /**
   * The score with only the parts at these indices, for showing a few of them. System text
   * (tempo, rehearsal marks, jumps) written on a hidden first part moves to the first shown.
   */
  only(keep: number[]): ScoreDoc {
    const set = new Set(keep);
    const out = parseXml("<score-partwise/>");
    const root = out.documentElement;
    for (const at of Array.from(this.root.attributes)) root.setAttribute(at.name, at.value);
    const partEls = kids(this.root, "part");
    const firstShown = partEls.findIndex((_, p) => set.has(p));
    for (const c of kids(this.root)) {
      if (c.tagName === "part") continue;
      if (c.tagName !== "part-list") {
        root.appendChild(out.importNode(c, true));
        continue;
      }
      // Part groups (brackets) are dropped: their members may be hidden.
      const list = root.appendChild(out.importNode(c, false)) as Element;
      const ids = new Set(partEls.filter((_, p) => set.has(p)).map((e) => e.getAttribute("id")));
      for (const sp of kids(c, "score-part")) if (ids.has(sp.getAttribute("id"))) list.appendChild(out.importNode(sp, true));
    }
    partEls.forEach((part, p) => {
      if (!set.has(p)) return;
      const np = root.appendChild(out.importNode(part, true)) as Element;
      if (p === firstShown && p > 0) copySystemText(out, this.measures[0], kids(np, "measure"));
    });
    const doc = new ScoreDoc(out);
    doc.sections = this.sections;
    return doc;
  }

  /** The score as a MusicXML file. */
  serialize(): string {
    const xml = new XMLSerializer().serializeToString(this.doc);
    return xml.startsWith("<?xml") ? xml : `<?xml version="1.0" encoding="UTF-8"?>\n${xml}`;
  }
}

/** A short name for a part: short names kept, else the first word cut, with its number. */
export function abbreviate(name: string): string {
  const n = name.trim();
  if (n.length <= 8) return n;
  const words = n.split(/\s+/);
  const first = words[0].length > 5 ? words[0].slice(0, 4) + "." : words[0];
  const last = words[words.length - 1];
  return words.length > 1 && /^([IVX]+|\d+)$/.test(last) ? `${first} ${last}` : first;
}

// Directions shown once per system, above the top part.
const SYSTEM_TEXT = new Set(["metronome", "rehearsal", "segno", "coda"]);
function isSystemText(d: Element): boolean {
  const snd = kid(d, "sound");
  if (snd && ["tempo", "dacapo", "dalsegno", "fine", "tocoda", "segno", "coda"].some((a) => snd.hasAttribute(a))) return true;
  return kids(d, "direction-type").some((dt) => kids(dt).some((c) => SYSTEM_TEXT.has(c.tagName)));
}

// Copies system text from one part's measures to another's: at the start of the measure when
// it stood at the start, else at the end (where jumps and Fine stand).
function copySystemText(doc: Document, from: Element[], to: Element[]): void {
  from.forEach((m, i) => {
    const target = to[i];
    if (!target) return;
    let pos = 0;
    for (const c of kids(m)) {
      const dur = Number(text(c, "duration")) || 0;
      if (c.tagName === "backup") pos -= dur;
      else if (c.tagName === "forward") pos += dur;
      else if (c.tagName === "note" && !kid(c, "chord") && !kid(c, "grace")) pos += dur;
      else if (c.tagName === "direction" && isSystemText(c)) {
        const copy = doc.importNode(c, true) as Element;
        for (const st of kids(copy, "staff")) st.remove();
        for (const v of kids(copy, "voice")) v.remove();
        if (pos > 0) target.appendChild(copy);
        else target.insertBefore(copy, kids(target).find((e) => e.tagName === "note" || e.tagName === "backup" || e.tagName === "forward") ?? null);
      }
    }
  });
}

// The renderer lays out systems itself: page and system breaks from the source would
// split a slice into several lines.
function stripBreaks(m: Element): void {
  for (const pr of kids(m, "print")) {
    pr.removeAttribute("new-system");
    pr.removeAttribute("new-page");
  }
}

function carryAttributes(doc: Document, measure: Element, inForce: Element[]): void {
  if (!inForce.length) return;
  let at = kids(measure, "attributes")[0];
  // Attributes must come before the first note of the measure to apply from its start.
  const firstMusic = kids(measure).find((c) => c.tagName === "note" || c.tagName === "backup" || c.tagName === "forward");
  if (!at || (firstMusic && at.compareDocumentPosition(firstMusic) & Node.DOCUMENT_POSITION_PRECEDING)) {
    at = doc.createElementNS(null, "attributes");
    measure.insertBefore(at, kids(measure).find((c) => c.tagName !== "print") ?? null);
  }
  const have = new Set(kids(at).map(attrKey));
  for (const e of inForce) {
    if (have.has(attrKey(e))) continue;
    const copy = doc.importNode(e, true) as Element;
    // A new system repeats clef and key, not the time signature.
    if (copy.tagName === "time") copy.setAttribute("print-object", "no");
    // In schema order, and by staff number within one kind: OSMD takes clefs in order.
    const rank = ATTR_ORDER.indexOf(copy.tagName);
    const num = Number(copy.getAttribute("number") ?? 0);
    const before = kids(at).find((c) => ATTR_ORDER.indexOf(c.tagName) > rank || (c.tagName === copy.tagName && Number(c.getAttribute("number") ?? 0) > num)) ?? null;
    at.insertBefore(copy, before);
  }
}

function timewiseToPartwise(src: Document): Document {
  const tw = src.documentElement;
  const out = parseXml("<score-partwise/>");
  const root = out.documentElement;
  for (const at of Array.from(tw.attributes)) root.setAttribute(at.name, at.value);
  for (const c of kids(tw)) if (c.tagName !== "measure") root.appendChild(out.importNode(c, true));
  const parts = new Map<string, Element>();
  for (const m of kids(tw, "measure")) {
    for (const p of kids(m, "part")) {
      const id = p.getAttribute("id") ?? "";
      let part = parts.get(id);
      if (!part) {
        part = out.createElementNS(null, "part");
        part.setAttribute("id", id);
        root.appendChild(part);
        parts.set(id, part);
      }
      const nm = out.createElementNS(null, "measure");
      for (const at of Array.from(m.attributes)) nm.setAttribute(at.name, at.value);
      for (const c of kids(p)) nm.appendChild(out.importNode(c, true));
      part.appendChild(nm);
    }
  }
  return out;
}

export type PartFamily = "keys" | "guitar" | "bass" | "drums" | "strings" | "winds" | "brass" | "voice" | "other";
export const PART_FAMILIES: PartFamily[] = ["keys", "guitar", "bass", "drums", "strings", "winds", "brass", "voice"];

const BY_NAME: [PartFamily, RegExp][] = [
  ["drums", /drum|batterie|perc|snare|cymbal|timpani|timbales|pauke|tambour|xylo|glock|marimba|vibra|bell|cloche|triangle|bateria|schlagzeug/i],
  ["winds", /flute|fl[uû]te|piccolo|oboe|hautbois|clarinet|bassoon|basson|sax|recorder|fl[oö]te|fagott|klarinette|cor anglais|english horn/i],
  ["brass", /trumpet|trompette|horn|cor\b|trombone|tuba|cornet|euphonium|flugel|bugle|posaune|trompete/i],
  ["guitar", /guitar|gitar|guitare|chitarra|guitarra|gitarre|ukulele|banjo|mandolin/i],
  ["keys", /piano|organ|orgue|orgel|keyboard|clavier|harpsichord|clavecin|cembalo|synth|celesta|accordion|accord[ée]on/i],
  ["strings", /violin|viol|cello|violon|geige|contrabass|harp|harpe|string|cordes/i],
  ["bass", /bass|basse|bajo|basso/i],
  ["voice", /voice|vocal|voix|chant|soprano|alto\b|tenor|t[ée]nor|baritone?|choir|ch(oe|œ)ur|chorus|coro|stimme|gesang|sopran/i],
];

/** The instrument family of a part, from its name, else its General MIDI program. */
export function partFamily(p: PartInfo): PartFamily {
  // An orchestra's double bass is a string; "bass" alone (or a bass guitar) is the bass. Voices
  // come last: an alto sax or a tenor trombone is not a singer.
  if (/double bass|contrabass\b|contrebasse|kontrabass|contrabbasso/i.test(p.name)) return "strings";
  if (/bass (guitar|gitarre)|basse [ée]lectrique|electric bass/i.test(p.name)) return "bass";
  for (const [f, re] of BY_NAME) if (re.test(p.name)) return f;
  const g = p.program;
  if (g === null) return "other";
  if (g === 128 || g === 47 || (g >= 8 && g <= 15) || (g >= 112 && g <= 119)) return "drums";
  if (g <= 7 || (g >= 16 && g <= 23)) return "keys";
  if (g <= 31) return "guitar";
  if (g <= 39) return "bass";
  if (g <= 51 || g === 55) return "strings";
  if (g <= 54) return "voice";
  if (g <= 63) return "brass";
  if (g <= 79) return "winds";
  return "other";
}
