// Rebuilds every corpus score through the editor (src/edit/rebuild.ts), each in its own
// process, and writes e2e-report/rebuild.html: per score, how many notes came back exactly,
// examples of any that did not, and what edit mode cannot enter yet.
//   node scripts/rebuild-corpus.mjs [filter]
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = new URL("..", import.meta.url).pathname;
const corpus = join(root, "corpus");
const only = process.argv[2];
const files = (dir) =>
  existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : /\.(mscz|mxl|musicxml)$/.test(e.name) ? [join(dir, e.name)] : [])) : [];
const list = files(corpus).filter((f) => !only || f.includes(only)).sort();
if (!list.length) throw new Error("No corpus scores (npm run corpus)");
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
const rows = [];
let exact = 0;
for (const f of list) {
  const name = f.slice(corpus.length + 1);
  const out = join(tmpdir(), `scoredit-rebuild-${process.pid}.json`);
  spawnSync("npx", ["vitest", "run", "src/edit/rebuild.test.ts", "-t", "corpus score"], {
    cwd: root,
    env: { ...process.env, SCOREDIT_REBUILD: f, SCOREDIT_REBUILD_OUT: out, NODE_OPTIONS: "--max-old-space-size=12288" },
    stdio: "ignore",
  });
  let r;
  try {
    r = JSON.parse(readFileSync(out, "utf8"));
  } catch {
    r = { error: "the test process did not finish (out of memory?)" };
  }
  const ok = !r.error && !r.missing && !r.extra;
  if (ok) exact++;
  const not = Object.entries(r.skipped ?? {}).map(([k, n]) => `${n} ${k}`).join(", ") || "nothing";
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${r.error ?? `${r.total - r.missing}/${r.total}${r.extra ? ` +${r.extra}` : ""}`} (${((r.ms ?? 0) / 1000).toFixed(1)} s)`);
  rows.push(
    r.error
      ? `<tr class="bad"><td>${esc(name)}</td><td colspan="3">✗ could not rebuild: ${esc(r.error)}</td></tr>`
      : `<tr class="${ok ? "ok" : "bad"}"><td>${esc(name)}</td><td>${ok ? "✓" : "✗"} ${r.total - r.missing} of ${r.total} notes match${r.extra ? `, ${r.extra} extra` : ""}</td><td>${r.entered} entries, ${(r.ms / 1000).toFixed(1)} s</td><td>${esc(not)}</td></tr>` +
          (ok ? "" : `<tr class="detail"><td colspan="4"><b>Expected but not rebuilt:</b><ul>${r.examplesMissing.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>${r.examplesExtra.length ? `<b>Rebuilt but not in the original:</b><ul>${r.examplesExtra.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}</td></tr>`),
  );
}
mkdirSync(join(root, "e2e-report"), { recursive: true });
writeFileSync(
  join(root, "e2e-report/rebuild.html"),
  `<!doctype html><meta charset="utf-8"><title>Rebuilding scores</title><style>body{font:15px/1.5 system-ui,sans-serif;margin:24px;color:#1d2330}table{border-collapse:collapse;width:100%}td,th{padding:6px 10px;border-bottom:1px solid #e3e5e8;vertical-align:top;text-align:left}.ok td:nth-child(2){color:#137333}.bad td:nth-child(2){color:#c5221f}.detail td{background:#fbf3f2;font-size:14px}ul{margin:4px 0}</style>
<h1>Rebuilding scores through the editor: ${exact} of ${list.length} exact</h1>
<p>Each score is emptied (bars, signatures, clefs, repeats and text kept; every note removed), then every note is entered again with the editor, as edit mode does. The notes are compared one by one: pitch, bar, beat, length, voice and ties. The last column lists what edit mode cannot enter yet, so it was left out on purpose and is not counted.</p>
<table><tr><th>Score</th><th>Result</th><th>Work</th><th>Not entered (not supported yet)</th></tr>${rows.join("")}</table>`,
);
console.log(`\n${exact}/${list.length} exact. Report: ${join(root, "e2e-report/rebuild.html")}`);
