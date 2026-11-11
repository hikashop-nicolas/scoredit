#!/usr/bin/env node
// Cuts scoredit's instrument sounds out of MuseScore_General.sf3 (MIT, S. Christian Collins)
// into small SoundFonts a player downloads when a score needs them. Instruments that share
// recordings (the three pianos, say) go in one file, so every large sample is stored once; the drum
// kit is the program "drums". index.json maps each program to its file, name and size.
// The samples keep their compressed form; nothing is re-encoded.
//   node scripts/make-sound-packs.mjs path/to/MuseScore_General.sf3 out-dir
// Source: https://ftp.osuosl.org/pub/musescore/soundfont/MuseScore_General/
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BasicSoundBank, SoundBankLoader } from "spessasynth_core";

await BasicSoundBank.ready;
const [src, outDir] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const source = readFileSync(src);
const load = () => SoundBankLoader.fromArrayBuffer(source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength));

const keyOf = (p) => (p.isGMGSDrum ? (p.program === 0 ? "drums" : null) : p.bankMSB === 0 ? String(p.program) : null);
// Samples big enough to be worth sharing a file over; smaller ones are simply copied into each.
const SHARE_BYTES = 64 * 1024;
const sizeOf = (smp) => smp.compressedData?.byteLength ?? smp.getRawData(true).byteLength;
const samplesOf = (p) => {
  const out = new Set();
  for (const z of p.zones) for (const iz of z.instrument?.zones ?? []) if (iz.sample && sizeOf(iz.sample) >= SHARE_BYTES) out.add(iz.sample.name);
  return out;
};

// Group the programs that share a sample (union-find).
const bank = load();
const programs = bank.presets.filter((p) => keyOf(p) !== null);
const parent = new Map(programs.map((p) => [keyOf(p), keyOf(p)]));
const find = (k) => (parent.get(k) === k ? k : find(parent.get(k)));
const owner = new Map();
for (const p of programs) {
  for (const s of samplesOf(p)) {
    const o = owner.get(s);
    if (o === undefined) owner.set(s, keyOf(p));
    else parent.set(find(keyOf(p)), find(o));
  }
}
const groups = new Map();
for (const p of programs) {
  const g = find(keyOf(p));
  (groups.get(g) ?? groups.set(g, []).get(g)).push(keyOf(p));
}

const index = {};
for (const [, keys] of groups) {
  const sorted = keys.sort((a, b) => (a === "drums" ? 1 : b === "drums" ? -1 : Number(a) - Number(b)));
  const file = `${sorted[0] === "drums" ? "drums" : String(sorted[0]).padStart(3, "0")}.sf3`;
  const b = load();
  const keep = new Set(sorted);
  for (const p of [...b.presets]) if (!keep.has(keyOf(p))) b.deletePreset(p);
  b.removeUnusedElements();
  const out = b.writeSF2({ compress: false });
  writeFileSync(join(outDir, file), Buffer.from(out));
  for (const k of sorted) index[k] = { name: b.presets.find((p) => keyOf(p) === k)?.name ?? "", file, bytes: out.byteLength };
  process.stdout.write(`${file}(${sorted.join(",")}) `);
}
writeFileSync(join(outDir, "index.json"), JSON.stringify(index, null, 1) + "\n");
console.log("\ndone", Object.keys(index).length, "instruments in", groups.size, "files");
