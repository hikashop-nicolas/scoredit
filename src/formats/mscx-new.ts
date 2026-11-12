import { strToU8, zipSync } from "fflate";
import { DRUM_KIT, type InstrumentDef } from "../model/instruments";
import { plainKey } from "../edit/transpose";

// A new MuseScore 4 file written from nothing: the instruments as their MuseScore id,
// names, clefs, transposition and sound (MuseScore fills in the rest of each instrument
// itself), a title frame, and empty bars in the key, time and tempo asked for.

export interface NewScore {
  title: string;
  composer: string;
  parts: { def: InstrumentDef; name: string }[];
  /** Concert key, in fifths. */
  fifths: number;
  time: [number, number];
  /** Quarters per minute; null for none written. */
  tempo: number | null;
  /** A pickup bar's length in quarters (0: none). */
  pickup: number;
  /** Bars, the pickup included. */
  measures: number;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function gcd(a: number, b: number): number {
  return b ? gcd(b, a % b) : a;
}
const frac = (n: number, d: number) => {
  const g = gcd(n, d) || 1;
  return `${n / g}/${d / g}`;
};

const HEAD: Record<string, string> = { normal: "normal", cross: "cross", diamond: "diamond", "circle-x": "xcircle", triangle: "triangle-up" };

/** The Part definition of one instrument, its staves numbered from `first`. */
export function partXml(def: InstrumentDef, name: string, id: number, first: number): string {
  const drums = !!def.drums;
  const staves = def.clefs.map((clef, i) => {
    const group = drums ? "percussion" : "pitched";
    const brace = i === 0 && def.clefs.length > 1 ? `<bracket type="1" span="${def.clefs.length}" col="0"/><barLineSpan>1</barLineSpan>` : "";
    const dflt = clef !== "G" ? `<defaultClef>${clef}</defaultClef>` : "";
    return `\n      <Staff id="${first + i}"><StaffType group="${group}"/>${brace}${dflt}</Staff>`;
  });
  const tr = def.transpose ? `<transposeDiatonic>${def.transpose[0]}</transposeDiatonic><transposeChromatic>${def.transpose[1]}</transposeChromatic>` : "";
  const strings = def.strings ? `<StringData><frets>24</frets>${def.strings.map((s) => `<string>${s}</string>`).join("")}</StringData>` : "";
  const kit = drums
    ? `<useDrumset>1</useDrumset>${DRUM_KIT.map((d) => `<Drum pitch="${d.pitch}"><head>${HEAD[d.head]}</head><line>${d.line}</line><voice>${d.up ? 0 : 1}</voice><name>${esc(d.name)}</name><stem>${d.up ? 1 : 2}</stem></Drum>`).join("")}`
    : "";
  return `\n    <Part id="${id}">${staves.join("")}\n      <trackName>${esc(name)}</trackName>\n      <Instrument id="${def.key}"><longName>${esc(name)}</longName><shortName>${esc(def.short)}</shortName><trackName>${esc(name)}</trackName><instrumentId>${def.musescore}</instrumentId>${tr}${strings}${kit}<Channel><program value="${def.program}"/></Channel></Instrument>\n      </Part>`;
}

/** The bars of one staff: rests, the first holding its clef, key, time (and the score's tempo). */
export function staffBarsXml(o: Pick<NewScore, "fifths" | "time" | "tempo" | "pickup" | "measures">, def: InstrumentDef, clef: string, opening: { tempo: boolean; frame?: string }): string {
  const [n, d] = o.time;
  const out: string[] = [];
  for (let m = 0; m < o.measures; m++) {
    const pickup = m === 0 && o.pickup > 0;
    const len = pickup ? frac(Math.round(o.pickup * 4), 16) : frac(n, d);
    let head = "";
    if (m === 0) {
      head += `<Clef><concertClefType>${clef}</concertClefType><transposingClefType>${clef}</transposingClefType><isHeader>1</isHeader></Clef>`;
      // A transposing staff names its written key too.
      const written = def.transpose ? plainKey(o.fifths - (7 * def.transpose[1] - 12 * def.transpose[0])) : o.fifths;
      if ((o.fifths || written) && !def.drums) head += `<KeySig><concertKey>${o.fifths}</concertKey>${def.transpose ? `<actualKey>${written}</actualKey>` : ""}</KeySig>`;
      head += `<TimeSig><sigN>${n}</sigN><sigD>${d}</sigD></TimeSig>`;
      if (opening.tempo && o.tempo) head += `<Tempo><tempo>${Math.round((o.tempo / 60) * 1e6) / 1e6}</tempo><followText>1</followText><text><sym>metNoteQuarterUp</sym> = ${o.tempo}</text></Tempo>`;
    }
    // A pickup bar is shorter and not counted in the bar numbers.
    out.push(`\n      <Measure${pickup ? ` len="${len}"` : ""}>${pickup ? "<irregular>1</irregular>" : ""}<voice>${head}<Rest><durationType>measure</durationType><duration>${len}</duration></Rest></voice></Measure>`);
  }
  return (opening.frame ?? "") + out.join("");
}

/** The .mscx text of a new score. */
export function newMscx(o: NewScore): string {
  let staff = 1;
  const parts: string[] = [];
  const bodies: string[] = [];
  const frame = `\n      <VBox><height>10</height>${o.title ? `<Text><style>title</style><text>${esc(o.title)}</text></Text>` : ""}${o.composer ? `<Text><style>composer</style><text>${esc(o.composer)}</text></Text>` : ""}</VBox>`;
  o.parts.forEach(({ def, name }, i) => {
    parts.push(partXml(def, name, i + 1, staff));
    def.clefs.forEach((clef, k) => {
      const first = staff === 1;
      bodies.push(`\n    <Staff id="${staff}">${staffBarsXml(o, def, clef, { tempo: first, frame: first && (o.title || o.composer) ? frame : undefined })}\n      </Staff>`);
      staff++;
      void k;
    });
  });
  const meta = `\n    <metaTag name="workTitle">${esc(o.title)}</metaTag>\n    <metaTag name="composer">${esc(o.composer)}</metaTag>`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<museScore version="4.50">\n  <Score>\n    <Division>480</Division>${meta}${parts.join("")}${bodies.join("")}\n    </Score>\n  </museScore>\n`;
}

/** A new score as an .mscz. */
export function newMuseScore(o: NewScore, name = "score"): Uint8Array {
  const file = `${name}.mscx`;
  const container = `<?xml version="1.0" encoding="UTF-8"?>\n<container>\n  <rootfiles>\n    <rootfile full-path="${file}"/>\n    </rootfiles>\n  </container>\n`;
  return zipSync({ [file]: strToU8(newMscx(o)), "META-INF/container.xml": strToU8(container) });
}
