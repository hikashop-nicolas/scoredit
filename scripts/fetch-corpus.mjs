#!/usr/bin/env node
// Fetches the test corpus into corpus/ (gitignored): OpenScore scores (CC0) pinned to a
// commit, then, when MuseScore 4 is installed (`mscore` on PATH), converts each one to an
// MS4 .mscz and to MusicXML so every score exists in three forms.
//   npm run corpus
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const REPOS = {
  Lieder: "38c5db510224d9facdc4b08d741fc788cfb58ea8",
  StringQuartets: "2614b0b2958dd1ce3f52e172a43e5f4d0e29570f",
};
const FILES = [
  ["Lieder", "scores/Wolf,_Hugo/Eichendorff-Lieder/16_Liebesglück/lc4928198.mscx"],
  ["Lieder", "scores/Schubert,_Franz/Schwanengesang,_D.957/13_Der_Doppelgänger/lc4985964.mscx"],
  ["Lieder", "scores/Brahms,_Johannes/9_Lieder_und_Gesänge,_Op.32/7_Bitteres_zu_sagen_denkst_du/lc5033089.mscx"],
  ["Lieder", "scores/Cornelius,_Peter/6_Lieder,_Op.5/5_Zum_Ossa_sprach_der_Pelion_(Unerhört)/lc5051358.mscx"],
  ["Lieder", "scores/Brahms,_Johannes/7_Lieder,_Op.48/2_Der_Überläufer/lc5071622.mscx"],
  ["Lieder", "scores/Brahms,_Johannes/5_Lieder,_Op.47/5_Die_Liebende_schreibt/lc5071644.mscx"],
  ["Lieder", "scores/Franz,_Robert/12_Gesänge,_Op.1/12_In_meinem_Garten_die_Nelken/lc5801830.mscx"],
  ["Lieder", "scores/Boulanger,_Lili/Clairières_dans_le_ciel/05_Au_pied_de_mon_lit/lc5861338.mscx"],
  ["Lieder", "scores/Holmès,_Augusta_Mary_Anne/Paysages_d’amour/4_Parmi_les_meules/lc5995173.mscx"],
  ["Lieder", "scores/Schröter,_Corona/25_Lieder/23_Das_Mädchen_am_Ufer/lc6054087.mscx"],
  ["Lieder", "scores/Lang,_Josephine/6_Lieder,_Op.26/6_Schilflied/lc6119892.mscx"],
  ["Lieder", "scores/Kralik,_Mathilde/Blumenlieder/5_Rosen/lc6166096.mscx"],
  ["Lieder", "scores/Boulton,_Harold/12_New_Songs/11_To_Welcome_You/lc6414608.mscx"],
  ["Lieder", "scores/Schumann,_Robert/Myrthen,_Op.25/04_Jemand/lc6909438.mscx"],
  ["StringQuartets", "scores/Haydn,_Joseph/String_Quartet_in_E-flat_major,_Hob.III20,_Op.9_No.2/sq10328092.mscx"],
  ["StringQuartets", "scores/Beethoven,_Ludwig_van/String_Quartet_No.12,_Op.127/sq10527526.mscx"],
  ["StringQuartets", "scores/Haydn,_Joseph/String_Quartet_in_D_minor,_Hob.III76,_Op.76_No.2/sq12772795.mscx"],
  ["StringQuartets", "scores/Dvořák,_Antonín/String_Quartet_No.12,_Op.96_(“American”)/sq8885439.mscx"],
  ["StringQuartets", "scores/Beethoven,_Ludwig_van/String_Quartet_No.3,_Op.18_No.3/sq8907120.mscx"],
];

const root = new URL("../corpus/", import.meta.url).pathname;
for (const d of ["openscore", "ms4", "musicxml"]) mkdirSync(join(root, d), { recursive: true });

let mscore = true;
try { execFileSync("mscore", ["--version"], { stdio: "ignore" }); } catch { mscore = false; }

for (const [repo, path] of FILES) {
  const name = `${repo === "Lieder" ? "li" : "sq"}_${basename(path, ".mscx")}`;
  const src = join(root, "openscore", `${name}.mscx`);
  if (!existsSync(src)) {
    const url = `https://raw.githubusercontent.com/OpenScore/${repo}/${REPOS[repo]}/${path.split("/").map(encodeURIComponent).join("/")}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    writeFileSync(src, Buffer.from(await res.arrayBuffer()));
  }
  if (mscore) {
    for (const [dir, ext] of [["ms4", "mscz"], ["musicxml", "musicxml"]]) {
      const out = join(root, dir, `${name}.${ext}`);
      if (!existsSync(out)) execFileSync("mscore", ["-o", out, src], { stdio: "ignore" });
    }
  }
  console.log(name);
}
// Guitar tablature: OSMD's own test scores (BSD-3), turned into MuseScore files with tab
// staves by MuseScore itself, and exported back to MusicXML as the reference.
const OSMD = "53043fdfe8e624f28cd6c2fac506a73bb2ee4a05";
const TAB = ["OSMD_Function_Test_Tabulature_hayden_study_1.mxl", "test_slurs_standard_and_tab_staff.musicxml", "test_tab_plus_treble_staff_correctNotePositions_pr1703.musicxml"];
for (const d of ["osmd", "guitar"]) mkdirSync(join(root, d), { recursive: true });
for (const f of TAB) {
  const src = join(root, "osmd", f);
  if (!existsSync(src)) {
    const res = await fetch(`https://raw.githubusercontent.com/opensheetmusicdisplay/opensheetmusicdisplay/${OSMD}/test/data/${f}`);
    if (!res.ok) throw new Error(`${res.status} ${f}`);
    writeFileSync(src, Buffer.from(await res.arrayBuffer()));
  }
  if (mscore) {
    const b = f.replace(/\.[^.]+$/, "");
    const mscz = join(root, "guitar", `${b}.mscz`);
    if (!existsSync(mscz)) execFileSync("mscore", ["-o", mscz, src], { stdio: "ignore" });
    const xml = join(root, "guitar", `${b}.musicxml`);
    if (!existsSync(xml)) execFileSync("mscore", ["-o", xml, mscz], { stdio: "ignore" });
  }
  console.log(f);
}
if (!mscore) console.log("mscore not found: only the MuseScore 3 originals were fetched");
