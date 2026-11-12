// Saves every MuseScore file of the corpus back after marking all its measures edited, two
// ways: keeping unchanged chords as they were (keep) and writing every chord (fresh). Each
// saved file is read again and compared with the original note by note; both are also
// converted by MuseScore itself (when installed) and compared with MuseScore's own
// conversion of the original. Report: e2e-report/save.html.
//   node scripts/save-corpus.mjs [filter]
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = new URL("..", import.meta.url).pathname;
const corpus = join(root, "corpus");
const only = process.argv[2];
const files = (dir) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : /\.(mscz|mscx)$/.test(e.name) ? [join(dir, e.name)] : [])) : []);
const list = files(corpus).filter((f) => !only || f.includes(only)).sort();
const mscore = ["/usr/local/bin/mscore", "/Applications/MuseScore 4.app/Contents/MacOS/mscore"].find((p) => existsSync(p));
const tmp = join(tmpdir(), `scoredit-save-${process.pid}`);
mkdirSync(tmp, { recursive: true });
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
const vitest = (env) => spawnSync("npx", ["vitest", "run", ...env.args], { cwd: root, env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=12288", ...env.vars }, stdio: "ignore" });
const rows = [];
let good = 0;
let unwritable = 0;
for (const f of list) {
  const name = f.slice(corpus.length + 1);
  const json = join(tmp, "r.json");
  const ext = f.endsWith(".mscx") ? "mscx" : "mscz";
  const saved = join(tmp, `saved.${ext}`);
  const savedFresh = join(tmp, `fresh.${ext}`);
  // Keep and fresh in a process each: a big quartet needs all the memory one process has.
  const r = {};
  for (const mode of ["keep", "fresh"]) {
    rmSync(json, { force: true });
    vitest({ args: ["src/formats/mscx-write.test.ts", "-t", "corpus score"], vars: { SCOREDIT_SAVE: f, SCOREDIT_SAVE_MODE: mode, SCOREDIT_SAVE_JSON: json, SCOREDIT_SAVE_OUT: saved, SCOREDIT_SAVE_FRESH_OUT: savedFresh } });
    try {
      Object.assign(r, JSON.parse(readFileSync(json, "utf8")));
    } catch {
      r[mode] = { error: "did not finish" };
    }
    if (r.unwritable) break;
  }
  if (r.unwritable) {
    unwritable++;
    console.log(`SKIP ${name}: not writable yet (MuseScore 2 file or linked tuplets)`);
    rows.push(`<tr><td>${esc(name)}</td><td colspan="3">Not writable yet (MuseScore 2 file or linked tuplets): opens read-only.</td></tr>`);
    continue;
  }
  // MuseScore's reading of each saved file against its reading of the original.
  const ms = { keep: null, fresh: null };
  if (mscore && !r.keep.error) {
    const a = join(tmp, "a.musicxml");
    rmSync(a, { force: true });
    spawnSync(mscore, ["-f", "-o", a, f], { stdio: "ignore", timeout: 600000 });
    for (const [mode, file] of [["keep", saved], ["fresh", savedFresh]]) {
      if (!existsSync(file)) continue;
      const b = join(tmp, "b.musicxml");
      rmSync(b, { force: true });
      spawnSync(mscore, ["-f", "-o", b, file], { stdio: "ignore", timeout: 600000 });
      if (!existsSync(a) || !existsSync(b)) {
        ms[mode] = { error: "MuseScore could not convert " + (existsSync(a) ? "the saved file" : "the original") };
        continue;
      }
      const cj = join(tmp, "c.json");
      rmSync(cj, { force: true });
      vitest({ args: ["src/formats/mscx-write.test.ts", "-t", "MuseScore reads"], vars: { SCOREDIT_COMPARE_A: a, SCOREDIT_COMPARE_B: b, SCOREDIT_COMPARE_OUT: cj } });
      try {
        ms[mode] = JSON.parse(readFileSync(cj, "utf8"));
      } catch {
        ms[mode] = { error: "comparison did not finish" };
      }
    }
  }
  rmSync(saved, { force: true });
  rmSync(savedFresh, { force: true });
  const ok = (x) => x && !x.error && !x.missing && !x.extra;
  const allOk = ok(r.keep) && ok(r.fresh) && (!ms.keep || ok(ms.keep)) && (!ms.fresh || ok(ms.fresh));
  if (allOk) good++;
  const cell = (x) => (!x ? "not checked" : x.error ? `✗ ${esc(x.error)}` : `${ok(x) ? "✓" : "✗"} ${x.total - x.missing} of ${x.total}${x.extra ? `, ${x.extra} extra` : ""}${x.dropped && Object.keys(x.dropped).length ? ` (not written: ${esc(Object.entries(x.dropped).map(([k, n]) => `${n} ${k}`).join(", "))})` : ""}`);
  console.log(`${allOk ? "PASS" : "FAIL"} ${name}: keep ${cell(r.keep)} | fresh ${cell(r.fresh)} | MuseScore ${cell(ms.keep)} / ${cell(ms.fresh)}`);
  rows.push(`<tr class="${allOk ? "ok" : "bad"}"><td>${esc(name)}</td><td>${cell(r.keep)}</td><td>${cell(r.fresh)}</td><td>${cell(ms.keep)}<br>${cell(ms.fresh)}</td></tr>` + (allOk ? "" : `<tr class="detail"><td colspan="4">${[...(r.keep?.examples ?? []).map((e) => "keep, " + e), ...(r.fresh?.examples ?? []).map((e) => "fresh, " + e), ...(ms.keep?.examples ?? []).map((e) => "MuseScore keep, " + e), ...(ms.fresh?.examples ?? []).map((e) => "MuseScore fresh, " + e)].map(esc).join("<br>")}</td></tr>`));
}
rmSync(tmp, { recursive: true, force: true });
mkdirSync(join(root, "e2e-report"), { recursive: true });
writeFileSync(
  join(root, "e2e-report/save.html"),
  `<!doctype html><meta charset="utf-8"><title>Saving MuseScore files</title><style>body{font:15px/1.5 system-ui,sans-serif;margin:24px;color:#1d2330}table{border-collapse:collapse;width:100%}td,th{padding:6px 10px;border-bottom:1px solid #e3e5e8;vertical-align:top;text-align:left}.bad td:first-child{color:#c5221f}.detail td{background:#fbf3f2;font-size:14px}</style>
<h1>Saving MuseScore files: ${good} of ${list.length - unwritable} come back exactly${unwritable ? ` (${unwritable} not writable yet)` : ""}</h1>
<p>Each MuseScore file of the corpus is saved back with every measure marked as edited. <b>Keep</b>: chords left unchanged are copied from the file (ties, slurs and accidentals written again). <b>Fresh</b>: every chord is written by scoredit. Both are read again and compared with the original, note by note and mark by mark. <b>MuseScore</b>: MuseScore itself converts both saved files and the original to MusicXML, and each is compared with the original the same way (kept file first, fresh one below)${mscore ? "" : " (MuseScore is not installed here)"}.</p>
<table><tr><th>Score</th><th>Keep</th><th>Fresh</th><th>MuseScore reads the saved files</th></tr>${rows.join("")}</table>`,
);
console.log(`\n${good}/${list.length - unwritable} exact, ${unwritable} not writable. Report: ${join(root, "e2e-report/save.html")}`);
