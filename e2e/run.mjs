// End-to-end tests of edit mode: the demo is driven in headless Chrome with real mouse,
// touch and key events, at desktop and phone sizes. Each scenario says in plain words what
// it does and what should happen, so the report reads without knowing music.
//
//   npm run test:e2e              all scenarios; report in e2e-report/index.html
//   npm run test:e2e -- triplet   only scenarios whose id contains "triplet"
//
// Chrome: CHROME_PATH, else the usual install places.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";
import { HELPERS, scenarios } from "./scenarios.mjs";

const root = new URL("..", import.meta.url).pathname;
const only = process.argv[2];
const out = join(root, "e2e-report");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function chromePath() {
  const tries = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  const p = tries.find((t) => existsSync(t));
  if (!p) throw new Error("Chrome not found; set CHROME_PATH");
  return p;
}

const DEVICES = {
  desktop: { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false, touch: false },
  phone: { width: 412, height: 870, deviceScaleFactor: 2.5, mobile: true, touch: true },
};

// A tab in Chrome over the DevTools protocol.
async function openTab(port) {
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  let id = 0;
  const pending = new Map();
  const logs = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id) {
      pending.get(d.id)?.(d);
      pending.delete(d.id);
    } else if (d.method === "Runtime.exceptionThrown") logs.push(d.params.exceptionDetails?.exception?.description ?? "exception");
    else if (d.method === "Runtime.consoleAPICalled" && d.params.type === "error") logs.push(d.params.args.map((a) => a.value ?? a.description).join(" "));
  };
  const send = (method, params = {}) =>
    new Promise((r, j) => {
      const i = ++id;
      pending.set(i, (d) => (d.error ? j(new Error(`${method}: ${d.error.message}`)) : r(d.result)));
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  await send("Runtime.enable");
  return {
    id: t.id,
    send,
    logs,
    async eval(expr) {
      const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    },
    close: () => ws.close(),
  };
}

// What a scenario can do and check. Every step and check is logged for the report.
function makeDriver(tab, device, record) {
  const dev = DEVICES[device];
  const settle = (ms = 450) => sleep(ms);
  const mouse = async (x, y) => {
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await tab.send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" ? "none" : "left", clickCount: 1 });
  };
  const touch = async (x, y) => {
    await tab.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    await sleep(60);
    await tab.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  };
  const press = (x, y) => (dev.touch ? touch(x, y) : mouse(x, y));
  const KEYCODES = { ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Escape: 27, Delete: 46, Backspace: 8, ".": 190, "+": 187, "0": 48 };
  const point = async (expr, what) => {
    const p = await tab.eval(expr);
    if (!p) throw new Error(`could not find ${what} on the page`);
    return p;
  };
  const d = {
    async step(text, fn) {
      record.steps.push(text);
      await fn();
      await settle();
    },
    /** A key, as on a desktop keyboard (mods: shift, ctrl, alt). */
    key(k, mods = {}) {
      const label = [mods.ctrl && "Ctrl", mods.alt && "Alt", mods.shift && "Shift", k === " " ? "Space" : k].filter(Boolean).join("+");
      return d.step(`Press ${label}`, async () => {
        const modifiers = (mods.alt ? 1 : 0) | (mods.ctrl ? 2 : 0) | (mods.shift ? 8 : 0);
        const single = k.length === 1;
        const text = single && !mods.ctrl && !mods.alt ? (mods.shift ? k.toUpperCase() : k) : undefined;
        const code = /^\d$/.test(k) ? `Digit${k}` : single && /[a-z]/i.test(k) ? `Key${k.toUpperCase()}` : k;
        const vk = KEYCODES[k] ?? (single ? k.toUpperCase().charCodeAt(0) : 0);
        const key = single && mods.shift ? k.toUpperCase() : k;
        await tab.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: vk, modifiers, text });
        await tab.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk, modifiers });
      });
    },
    async keys(str) {
      for (const k of str) await d.key(k);
    },
    /** A palette or bar button, by its label. */
    button(label) {
      return d.step(`${dev.touch ? "Tap" : "Click"} the "${label}" button`, async () => {
        const p = await point(`e2e.buttonPoint(${JSON.stringify(label)})`, `the ${label} button`);
        await press(p.x, p.y);
      });
    },
    /** On a staff, at a beat of a bar, at the line or space of a pitch (or on a note there). */
    tapStaff(bar, beat, staff, pitch, o = {}) {
      return d.step(`${dev.touch ? "Tap" : "Click"} the ${o.staffName ?? `staff ${staff}`} in bar ${bar}, beat ${beat}, where ${pitch} is written`, async () => {
        const p = await point(`e2e.staffPoint(${bar}, ${beat}, ${staff}, ${JSON.stringify(pitch)}, ${o.part ?? 0})`, `bar ${bar} beat ${beat}`);
        await press(p.x, p.y);
      });
    },
    /** Touch and hold on a staff, slide to another line, read the bubble, let go. */
    async hold(bar, beat, staff, from, to) {
      let bubble = "";
      await d.step(`Touch and hold the staff in bar ${bar}, beat ${beat} on ${from}, slide to ${to}, let go`, async () => {
        const a = await point(`e2e.staffPoint(${bar}, ${beat}, ${staff}, ${JSON.stringify(from)})`, "the start point");
        const b = await point(`e2e.staffPoint(${bar}, ${beat}, ${staff}, ${JSON.stringify(to)})`, "the end point");
        await tab.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: a.x, y: a.y }] });
        await sleep(450);
        for (let k = 1; k <= 6; k++) {
          await tab.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: a.x, y: a.y + ((b.y - a.y) * k) / 6 }] });
          await sleep(40);
        }
        bubble = await tab.eval(`document.querySelector('.sv-loupe:not([hidden])')?.textContent ?? ''`);
        await tab.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      });
      return bubble;
    },
    /** A one-finger swipe up the score (scrolls down). */
    swipe(dy) {
      return d.step(`Swipe the score up by ${dy} pixels`, async () => {
        const c = await tab.eval(`(() => { const r = document.querySelector('.sv-root').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height * 0.7 }; })()`);
        await tab.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [c] });
        for (let k = 1; k <= 8; k++) {
          await tab.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: c.x, y: c.y - (dy * k) / 8 }] });
          await sleep(16);
        }
        await tab.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await sleep(800);
      });
    },
    /** A key of the keyboard strip. */
    stripKey(name) {
      return d.step(`Tap the ${name} key on the keyboard strip`, async () => {
        const p = await point(`e2e.stripPoint(${JSON.stringify(name)})`, `the ${name} key`);
        await press(p.x, p.y);
      });
    },
    /** A string and fret on the fretboard strip (string 1 is the highest). */
    fret(string, fret) {
      return d.step(`Tap string ${string} at fret ${fret} on the fretboard`, async () => {
        const p = await point(`e2e.fretPoint(${string}, ${fret})`, "the fretboard");
        await press(p.x, p.y);
      });
    },
    run(text, expr) {
      return d.step(text, () => tab.eval(expr));
    },
    eval: (expr) => tab.eval(expr),

    // ---- checks
    check(what, ok, detail = "") {
      record.checks.push({ what, ok: !!ok, detail });
    },
    /** The bars of a staff, written as "C4 quarter, rest half" (bars counted from 1). */
    async bars(want, o = {}) {
      const got = await tab.eval(`e2e.bars(${o.part ?? 0}, ${o.staff ?? 1})`);
      for (const [bar, text] of Object.entries(want)) {
        const g = got[Number(bar) - 1] ?? "(no such bar)";
        d.check(`${o.label ?? (o.staff && o.staff > 1 ? `Staff ${o.staff}, bar ${bar}` : `Bar ${bar}`)} reads: ${text}`, g === text, g === text ? "" : `It reads: ${g}`);
      }
    },
    /** What playback sounds, as "C4 at bar 1 beat 1, 1 beat long". */
    async sounds(want, label = "Playback") {
      const got = await tab.eval(`e2e.sounds()`);
      const ok = JSON.stringify(got) === JSON.stringify(want);
      d.check(`${label} plays: ${want.length ? want.join("; ") : "nothing"}`, ok, ok ? "" : `It plays: ${got.join("; ") || "nothing"}`);
    },
  };
  return d;
}

const css = `body{font:15px/1.5 system-ui,sans-serif;margin:0;background:#f4f5f7;color:#1d2330}
header{padding:20px 24px;background:#1d2330;color:#fff}header h1{margin:0 0 4px;font-size:22px}
main{max-width:1100px;margin:0 auto;padding:16px}
.card{background:#fff;border-radius:10px;margin:16px 0;padding:16px 20px;box-shadow:0 1px 3px rgba(0,0,0,.08);display:grid;grid-template-columns:minmax(0,1fr) minmax(0,420px);gap:20px}
.card h2{margin:0 0 6px;font-size:18px}.ok{color:#137333}.bad{color:#c5221f}
.why{color:#4a5160;margin:0 0 10px}ol{margin:4px 0 10px;padding-left:20px}ul.checks{list-style:none;padding:0;margin:0}
ul.checks li{padding:3px 0}.detail{display:block;color:#c5221f;margin-left:22px}
img{width:100%;border:1px solid #dde1e6;border-radius:6px}.tag{font-size:12px;background:#e8eaed;border-radius:4px;padding:1px 6px;margin-left:6px;vertical-align:middle}
@media (max-width:800px){.card{grid-template-columns:1fr}}`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

async function main() {
  const server = await createServer({ root: join(root, "demo"), configFile: join(root, "vite.config.ts"), server: { port: 0, host: "127.0.0.1" }, logLevel: "error" });
  await server.listen();
  const base = server.resolvedUrls.local[0];
  const port = 9300 + Math.floor(Math.random() * 500);
  const profile = mkdtempSync(join(tmpdir(), "scoredit-e2e-"));
  const chrome = spawn(chromePath(), ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "--lang=en-US", "--mute-audio", "about:blank"], { stdio: "ignore" });
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`http://127.0.0.1:${port}/json/version`);
      break;
    } catch {
      await sleep(200);
    }
  }
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const results = [];
  for (const sc of scenarios.filter((s) => !only || s.id.includes(only))) {
    const record = { ...sc, steps: [], checks: [], error: null, shot: null };
    const tab = await openTab(port);
    try {
      const dev = DEVICES[sc.device];
      await tab.send("Emulation.setDeviceMetricsOverride", { width: dev.width, height: dev.height, deviceScaleFactor: dev.deviceScaleFactor, mobile: dev.mobile });
      if (dev.touch) await tab.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
      await tab.send("Page.enable");
      await tab.send("Page.navigate", { url: `${base}?fixture=${sc.fixture}&layout=page` });
      for (let i = 0; i < 100; i++) {
        await sleep(150);
        if (await tab.eval(`!!(window.viewer && document.querySelector('.sv-system svg') && document.querySelector('.sv-page')?.style.visibility !== 'hidden')`).catch(() => false)) break;
      }
      await sleep(800);
      await tab.eval(HELPERS);
      const d = makeDriver(tab, sc.device, record);
      if (sc.edit !== false) await d.button("Edit");
      await sc.run(d);
    } catch (e) {
      record.error = e instanceof Error ? e.message : String(e);
    }
    try {
      const { data } = await tab.send("Page.captureScreenshot", { format: "png" });
      record.shot = `${sc.id}.png`;
      writeFileSync(join(out, record.shot), Buffer.from(data, "base64"));
    } catch {}
    if (tab.logs.length) record.checks.push({ what: "No errors on the page", ok: false, detail: tab.logs.slice(0, 3).join(" | ") });
    record.ok = !record.error && record.checks.every((c) => c.ok);
    results.push(record);
    console.log(`${record.ok ? "PASS" : "FAIL"}  ${sc.id}  ${record.error ?? record.checks.filter((c) => !c.ok).map((c) => `${c.what} / ${c.detail}`).join(" | ")}`);
    await fetch(`http://127.0.0.1:${port}/json/close/${tab.id}`);
    tab.close();
  }
  chrome.kill();
  await new Promise((r) => chrome.once("exit", r));
  await server.close();
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {}
  const passed = results.filter((r) => r.ok).length;
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>scoredit edit tests</title><style>${css}</style>
<header><h1>Edit mode tests: ${passed} of ${results.length} passed</h1><div>${new Date().toLocaleString()} · each card says what was done, what should happen, and shows the screen afterwards (the selected or last entered note is orange).</div></header><main>
${results
  .map(
    (r) => `<section class="card"><div><h2 class="${r.ok ? "ok" : "bad"}">${r.ok ? "✓" : "✗"} ${esc(r.title)}<span class="tag">${r.device}</span></h2>
<p class="why">${esc(r.why)}</p><strong>What the test does</strong><ol>${r.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>
<strong>What should happen</strong><ul class="checks">${r.checks.map((c) => `<li class="${c.ok ? "ok" : "bad"}">${c.ok ? "✓" : "✗"} ${esc(c.what)}${c.detail ? `<span class="detail">${esc(c.detail)}</span>` : ""}</li>`).join("")}${r.error ? `<li class="bad">✗ The test could not finish<span class="detail">${esc(r.error)}</span></li>` : ""}</ul>
${r.look ? `<p class="why"><strong>In the picture:</strong> ${esc(r.look)}</p>` : ""}</div>
<div>${r.shot ? `<img src="${r.shot}" alt="The screen after the test">` : ""}</div></section>`,
  )
  .join("\n")}</main>`;
  writeFileSync(join(out, "index.html"), html);
  console.log(`\n${passed}/${results.length} passed. Report: ${join(out, "index.html")}`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
