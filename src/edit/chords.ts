import { kid, text } from "../model/xml";

// Chord symbols as typed ("Cm7", "B♭/D", "F#m7b5") and as MusicXML's <harmony>: a root, a
// kind (one of MusicXML's names, the typed suffix kept as its text) and a bass.

export interface ChordSymbol {
  root: { step: string; alter: number };
  /** MusicXML's kind of chord. */
  kind: string;
  /** The suffix as typed ("m7", "maj7", "sus4"...). */
  suffix: string;
  bass?: { step: string; alter: number };
}

const KINDS: [RegExp, string][] = [
  [/^$/, "major"],
  [/^(maj|M)$/, "major"],
  [/^(m|min|-)$/, "minor"],
  [/^7$/, "dominant"],
  [/^(maj7|M7|Δ|Δ7|ma7)$/, "major-seventh"],
  [/^(m7|min7|-7)$/, "minor-seventh"],
  [/^(dim|°|o)$/, "diminished"],
  [/^(dim7|°7|o7)$/, "diminished-seventh"],
  [/^(m7b5|m7♭5|ø|ø7|-7b5)$/, "half-diminished"],
  [/^(aug|\+|\+5)$/, "augmented"],
  [/^(aug7|\+7|7#5|7♯5)$/, "augmented-seventh"],
  [/^(sus|sus4)$/, "suspended-fourth"],
  [/^sus2$/, "suspended-second"],
  [/^6$/, "major-sixth"],
  [/^(m6|min6|-6)$/, "minor-sixth"],
  [/^9$/, "dominant-ninth"],
  [/^(maj9|M9|Δ9)$/, "major-ninth"],
  [/^(m9|min9|-9)$/, "minor-ninth"],
  [/^11$/, "dominant-11th"],
  [/^13$/, "dominant-13th"],
  [/^(mMaj7|mmaj7|m\(maj7\)|mM7|-Δ7)$/, "major-minor"],
  [/^(m11|min11|-11)$/, "minor-11th"],
  [/^5$/, "power"],
];

const alterOf = (s: string) => (s === "#" || s === "♯" ? 1 : s === "b" || s === "♭" ? -1 : s === "##" || s === "𝄪" ? 2 : s === "bb" || s === "𝄫" ? -2 : 0);

/** A typed chord symbol, or null when it does not start with a note name. */
export function parseChord(input: string): ChordSymbol | null {
  const m = /^([A-Ga-g])(##|bb|[#b♯♭𝄪𝄫]?)(.*?)(?:\/([A-Ga-g])(##|bb|[#b♯♭𝄪𝄫]?))?$/.exec(input.trim());
  if (!m) return null;
  const suffix = m[3].trim();
  // "B(sus4)", "Gm(maj7)": the brackets are only how it is written.
  const bare = suffix.replace(/[()]/g, "");
  const kind = KINDS.find(([re]) => re.test(suffix))?.[1] ?? KINDS.find(([re]) => re.test(bare))?.[1] ?? "other";
  return {
    root: { step: m[1].toUpperCase(), alter: alterOf(m[2]) },
    kind,
    suffix,
    ...(m[4] ? { bass: { step: m[4].toUpperCase(), alter: alterOf(m[5]) } } : {}),
  };
}

const ACC: Record<number, string> = { [-2]: "𝄫", [-1]: "♭", 0: "", 1: "♯", 2: "𝄪" };

/** A chord symbol as it reads: "B♭m7/D". */
export function chordText(c: ChordSymbol): string {
  return `${c.root.step}${ACC[c.root.alter] ?? ""}${c.suffix}${c.bass ? `/${c.bass.step}${ACC[c.bass.alter] ?? ""}` : ""}`;
}

/** A <harmony>'s chord symbol, or null if it has no root. */
export function readHarmony(h: Element): ChordSymbol | null {
  const root = kid(h, "root");
  if (!root || !kid(root, "root-step")) return null;
  const kindEl = kid(h, "kind");
  const bass = kid(h, "bass");
  const kind = text(kindEl) || "major";
  // The kind's own text when it has one, else MusicXML's usual way of writing it.
  const DEFAULT: Record<string, string> = { major: "", minor: "m", dominant: "7", "major-seventh": "maj7", "minor-seventh": "m7", diminished: "dim", "diminished-seventh": "dim7", "half-diminished": "m7b5", augmented: "+", "augmented-seventh": "+7", "suspended-fourth": "sus4", "suspended-second": "sus2", "major-sixth": "6", "minor-sixth": "m6", "dominant-ninth": "9", "major-ninth": "maj9", "minor-ninth": "m9", "dominant-11th": "11", "dominant-13th": "13", "major-minor": "mMaj7", power: "5" };
  const suffix = kindEl?.hasAttribute("text") ? (kindEl.getAttribute("text") ?? "") : (DEFAULT[kind] ?? "");
  return {
    root: { step: text(root, "root-step"), alter: Number(text(root, "root-alter")) || 0 },
    kind,
    suffix,
    ...(bass && kid(bass, "bass-step") ? { bass: { step: text(bass, "bass-step"), alter: Number(text(bass, "bass-alter")) || 0 } } : {}),
  };
}

/** A new <harmony> for a chord symbol. */
export function makeHarmony(doc: Document, c: ChordSymbol, staff?: number): Element {
  const h = doc.createElementNS(null, "harmony");
  const add = (parent: Element, tag: string, value?: string | number) => {
    const e = doc.createElementNS(null, tag);
    if (value !== undefined) e.textContent = String(value);
    parent.appendChild(e);
    return e;
  };
  const root = add(h, "root");
  add(root, "root-step", c.root.step);
  if (c.root.alter) add(root, "root-alter", c.root.alter);
  add(h, "kind", c.kind).setAttribute("text", c.suffix);
  if (c.bass) {
    const b = add(h, "bass");
    add(b, "bass-step", c.bass.step);
    if (c.bass.alter) add(b, "bass-alter", c.bass.alter);
  }
  if (staff) add(h, "staff", staff);
  return h;
}

// MuseScore spells pitches as a "tpc": the line of fifths, C = 14, G = 15, F = 13; a sharp adds 7.
const LINE = "FCGDAEB";
export const tpcOf = (n: { step: string; alter: number }) => 13 + LINE.indexOf(n.step) + 7 * n.alter;
export const noteOfTpc = (tpc: number) => ({ step: LINE[(((tpc + 1) % 7) + 7) % 7], alter: Math.floor((tpc + 1) / 7) - 2 });

/** A chord symbol from MuseScore's name (the suffix as typed), root and bass. */
export function chordFromMuseScore(name: string, root: number, bass: number | null): ChordSymbol {
  const parsed = parseChord(`C${name}`);
  return { root: noteOfTpc(root), kind: parsed?.kind ?? "other", suffix: name, ...(bass !== null ? { bass: noteOfTpc(bass) } : {}) };
}
