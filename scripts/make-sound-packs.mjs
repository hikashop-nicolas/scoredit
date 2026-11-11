#!/usr/bin/env node
// Cuts scoredit's sound packs out of MuseScore_General.sf3 (MIT, S. Christian Collins):
//   node scripts/make-sound-packs.mjs path/to/MuseScore_General.sf3
// Source: https://ftp.osuosl.org/pub/musescore/soundfont/MuseScore_General/
import { readFileSync, writeFileSync } from "node:fs";
import { BasicSoundBank, SoundBankLoader } from "spessasynth_core";

const PACKS = {
  plucked: [24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 46, 104, 105, 106, 107],
};

await BasicSoundBank.ready;
const source = readFileSync(process.argv[2]);
for (const [name, programs] of Object.entries(PACKS)) {
  const bank = SoundBankLoader.fromArrayBuffer(source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength));
  const keep = new Set(programs);
  for (const p of [...bank.presets]) if (p.isGMGSDrum || p.bankMSB !== 0 || !keep.has(p.program)) bank.deletePreset(p);
  bank.removeUnusedElements();
  const out = bank.writeSF2({ compress: false });
  writeFileSync(new URL(`../sounds/${name}.sf3`, import.meta.url), Buffer.from(out));
  console.log(name, bank.presets.length, "presets,", out.byteLength, "bytes");
}
