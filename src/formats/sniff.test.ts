import { existsSync, readFileSync } from "node:fs";
import { zlibSync } from "fflate";
import { isNotationMidi, isScorePdf, onGrid, pdfNotationApp } from "./sniff";

const enc = (s: string) => new TextEncoder().encode(s);
const pdf = (body: string) => enc(`%PDF-1.4\n${body}\n%%EOF\n`);

describe("isScorePdf", () => {
  it("knows a score by its music font", () => {
    expect(isScorePdf(pdf("5 0 obj << /Type /Font /BaseFont /ABCDEF+Leland >> endobj"))).toBe(true);
    expect(isScorePdf(pdf("5 0 obj << /Type /Font /BaseFont /QHBAAA+OpusStd >> endobj"))).toBe(true);
    expect(isScorePdf(pdf("5 0 obj << /Type /FontDescriptor /FontName /TYAZLR+Emmentaler-20 >> endobj"))).toBe(true);
  });

  it("leaves other PDFs, and files that are not PDFs, alone", () => {
    expect(isScorePdf(pdf("5 0 obj << /Type /Font /BaseFont /Helvetica >> endobj"))).toBe(false);
    expect(isScorePdf(enc("not a pdf /BaseFont /Leland"))).toBe(false);
  });

  it("looks inside compressed object streams", () => {
    const packed = zlibSync(enc("<< /Type /Font /BaseFont /ABCDEF+Bravura >>"));
    const head = enc("%PDF-1.5\n7 0 obj << /Type /ObjStm /N 1 /First 0 /Filter /FlateDecode >>\nstream\n");
    const tail = enc("\nendstream endobj\n%%EOF\n");
    const bytes = new Uint8Array(head.length + packed.length + tail.length);
    bytes.set(head);
    bytes.set(packed, head.length);
    bytes.set(tail, head.length + packed.length);
    expect(isScorePdf(bytes)).toBe(true);
  });

  it("names the notation program when the PDF says", () => {
    expect(pdfNotationApp(pdf("1 0 obj << /Creator (LilyPond 2.24.4) /Producer (Ghostscript) >> endobj"))).toBe("LilyPond 2.24.4");
    expect(pdfNotationApp(pdf("1 0 obj << /Creator (Writer) >> endobj"))).toBe(null);
  });
});

// A one-track MIDI file with these note onsets (ticks), each a 16th long.
function midi(onsets: number[], ppq = 480): Uint8Array {
  const ev: number[] = [];
  const vlq = (n: number) => {
    const out = [n & 0x7f];
    while ((n >>= 7)) out.unshift((n & 0x7f) | 0x80);
    return out;
  };
  const events = onsets.flatMap((t, i) => [
    { t, d: [0x90, 60 + (i % 12), 80] },
    { t: t + ppq / 4, d: [0x80, 60 + (i % 12), 0] },
  ]);
  events.sort((a, b) => a.t - b.t);
  let at = 0;
  for (const e of events) {
    ev.push(...vlq(e.t - at), ...e.d);
    at = e.t;
  }
  ev.push(0, 0xff, 0x2f, 0);
  const head = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, ppq >> 8, ppq & 0xff];
  const len = ev.length;
  return new Uint8Array([...head, 0x4d, 0x54, 0x72, 0x6b, len >>> 24, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff, ...ev]);
}

describe("isNotationMidi", () => {
  const grid = Array.from({ length: 64 }, (_, i) => i * 120 + (i % 7 === 3 ? 160 - 120 : 0));
  it("takes onsets on a beat grid (16ths, triplets) for notation", () => {
    expect(isNotationMidi(midi(Array.from({ length: 64 }, (_, i) => i * 120)))).toBe(true);
    expect(isNotationMidi(midi(Array.from({ length: 48 }, (_, i) => i * 160)))).toBe(true);
    expect(onGrid(grid, 480)).toBeGreaterThan(0.75);
  });

  it("takes played-in timing for a performance", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
    const played = Array.from({ length: 64 }, (_, i) => Math.max(0, Math.round(i * 120 + rnd() * 30)));
    expect(isNotationMidi(midi(played))).toBe(false);
  });

  it("is false for bytes that are not MIDI", () => {
    expect(isNotationMidi(enc("MThd but not really"))).toBe(false);
  });

  const fe = "corpus/musescore-com/fur-elise-beethoven.mid";
  it.skipIf(!existsSync(fe))("reads MuseScore's MIDI export as notation", () => {
    expect(isNotationMidi(new Uint8Array(readFileSync(fe)))).toBe(true);
  });
});
