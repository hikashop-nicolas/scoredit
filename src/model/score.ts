import { kid, kids, parseXml, text } from "./xml";

export interface PartInfo {
  id: string;
  name: string;
  abbreviation: string;
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
  /** Attributes in force at the start of each measure, per part. */
  private attrsAt: Map<string, Element>[][] = [];

  constructor(xml: string) {
    let doc = parseXml(xml);
    if (doc.documentElement.tagName === "score-timewise") doc = timewiseToPartwise(doc);
    if (doc.documentElement.tagName !== "score-partwise") throw new Error("Not a MusicXML score");
    this.doc = doc;
    this.root = doc.documentElement;
    const list = kid(this.root, "part-list");
    const named = new Map<string, PartInfo>();
    for (const sp of list ? kids(list, "score-part") : []) {
      const id = sp.getAttribute("id") ?? "";
      named.set(id, { id, name: text(sp, "part-name"), abbreviation: text(sp, "part-abbreviation") });
    }
    const partEls = kids(this.root, "part");
    this.parts = partEls.map((p) => named.get(p.getAttribute("id") ?? "") ?? { id: p.getAttribute("id") ?? "", name: "", abbreviation: "" });
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
  slice(a: number, b: number, opts: { header?: boolean } = {}): string {
    const out = parseXml("<score-partwise/>");
    const root = out.documentElement;
    for (const at of Array.from(this.root.attributes)) root.setAttribute(at.name, at.value);
    for (const c of kids(this.root)) {
      if (c.tagName === "part") continue;
      if (!opts.header && (c.tagName === "credit" || c.tagName === "work" || c.tagName === "movement-title" || c.tagName === "movement-number")) continue;
      root.appendChild(out.importNode(c, true));
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

  serialize(): string {
    return new XMLSerializer().serializeToString(this.doc);
  }
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
    const rank = ATTR_ORDER.indexOf(copy.tagName);
    const before = kids(at).find((c) => ATTR_ORDER.indexOf(c.tagName) > rank) ?? null;
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
