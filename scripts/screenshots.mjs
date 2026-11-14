// The README screenshots, taken from the demo in headless Chrome. Scores come from the local
// corpus (OpenScore, CC0, and OSMD's test files): run `npm run corpus` first.
//
//   node scripts/screenshots.mjs           all shots into docs/screenshots/
//   node scripts/screenshots.mjs keys      only the shots whose name contains "keys"
//
// Chrome: CHROME_PATH, else the usual install places.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";
import { HELPERS } from "../e2e/scenarios.mjs";

const root = new URL("..", import.meta.url).pathname;
const out = join(root, "docs", "screenshots");
const only = process.argv[2];
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
  desktop: { width: 1000, height: 680, deviceScaleFactor: 1.5, mobile: false, touch: false },
  phone: { width: 390, height: 780, deviceScaleFactor: 2, mobile: true, touch: true },
};

async function openTab(port) {
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id) {
      pending.get(d.id)?.(d);
      pending.delete(d.id);
    }
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
    async eval(expr) {
      const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    },
    close: () => ws.close(),
  };
}

// A click (or tap on a touch device) on a bar or palette button, by its label.
async function button(tab, dev, label) {
  const p = await tab.eval(`e2e.buttonPoint(${JSON.stringify(label)})`);
  if (!p) throw new Error(`no "${label}" button`);
  if (dev.touch) {
    await tab.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [p] });
    await sleep(60);
    await tab.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } else {
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await tab.send("Input.dispatchMouseEvent", { type, x: p.x, y: p.y, button: type === "mouseMoved" ? "none" : "left", clickCount: 1 });
  }
  await sleep(500);
}

// The demo's header is not part of the library: it is hidden in every shot.
const HIDE_HEADER = `document.querySelector("header").style.display = "none"; dispatchEvent(new Event("resize"));`;

// A simulated MIDI keyboard that strikes the practised notes of the first `seconds` of the
// piece, each at a chosen offset (ms) from when it is heard, then stops playback.
const PLAY_ALONG = (seconds, part) => `(async () => {
  const cbs = new Set();
  const send = (data, time) => { for (const cb of cbs) cb({ data: new Uint8Array(data), time, source: "demo" }); };
  viewer.setMidiInput({ subscribe(cb) { cbs.add(cb); return () => cbs.delete(cb); } });
  viewer.setPractice({ mode: "time", hand: "right", echo: false });
  const tl = scoreditLib.buildTimeline(viewer.score);
  const notes = tl.events.filter((e) => e.part === ${part} && e.staff === 1 && !e.grace && e.time < ${seconds});
  const p = viewer.player;
  const at = (ms, fn) => setTimeout(fn, Math.max(0, ms - performance.now()));
  notes.forEach((e, i) => {
    if (i === 5) return; // missed
    const offset = i % 7 === 3 ? -80 : i % 9 === 6 ? 85 : (i * 13) % 30 - 15;
    const when = p.heardWhen(e.time, 0) + offset;
    at(when, () => send([0x90, e.midi, 90], when));
    at(when + 120, () => send([0x80, e.midi, 0], when + 120));
    if (i === 8) at(when + 300, () => send([0x90, e.midi + 1, 90], when + 300));
  });
  await new Promise((r) => setTimeout(r, ${seconds} * 1000 + 600));
  p.pause();
  await new Promise((r) => setTimeout(r, 600));
})()`;

// Schubert, Schwanengesang; Kralik, Blumenlieder (its arpeggiated piano part).
const SONG = "openscore/li_lc4985964.mscx";
const ARPEGGIOS = "openscore/li_lc6166096.mscx";
const shots = [
  {
    name: "page-piano",
    device: "desktop",
    url: `?f=${SONG}&layout=page`,
    async run(tab) {
      await tab.eval(HIDE_HEADER);
    },
  },
  {
    name: "guitar-tab",
    device: "desktop",
    url: "?f=osmd/OSMD_Function_Test_Tabulature_hayden_study_1.mscz&layout=page",
    async run(tab) {
      await tab.eval(HIDE_HEADER);
    },
  },
  {
    name: "falling-notes",
    device: "desktop",
    url: `?f=${ARPEGGIOS}&layout=page&parts=keys`,
    async run(tab, dev) {
      await tab.eval(HIDE_HEADER);
      await button(tab, dev, "Falling notes");
      await button(tab, dev, "Play");
      await sleep(5200);
      await button(tab, dev, "Pause");
      await sleep(400);
    },
  },
  {
    name: "edit-phone",
    device: "phone",
    url: `?f=${SONG}&layout=page`,
    async run(tab, dev) {
      await tab.eval(HIDE_HEADER);
      await button(tab, dev, "Edit");
      // The voice's F#4 on beat 2 of bar 5: 7 half spaces below the top line.
      const p = await tab.eval(`viewer.pointFor(4, 1, 0, 1, 7)`);
      if (p) {
        await tab.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [p] });
        await sleep(60);
        await tab.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await sleep(500);
      }
    },
  },
  {
    name: "practice-time",
    device: "desktop",
    url: `?f=${ARPEGGIOS}&layout=page&parts=keys`,
    async run(tab, dev) {
      await tab.eval(HIDE_HEADER);
      await tab.eval(`viewer.setMidiInput({ subscribe() { return () => {}; } })`);
      await button(tab, dev, "Keyboard");
      await button(tab, dev, "Play");
      await button(tab, dev, "Pause");
      await tab.eval(`viewer.player.seek(0)`);
      const part = await tab.eval(`viewer.score.parts.findIndex((p) => scoreditLib.partFamily(p) === "keys")`);
      await tab.eval(`(viewer.togglePlay(), ${PLAY_ALONG(7, part)})`);
      // Back to the top of the page, where the notes played are coloured.
      await tab.eval(`for (const el of document.querySelectorAll("#score *")) if (el.scrollTop > 0) el.scrollTop = 0;`);
      await sleep(600);
    },
  },
];

async function main() {
  const server = await createServer({ root: join(root, "demo"), configFile: join(root, "vite.config.ts"), server: { port: 0, host: "127.0.0.1" }, logLevel: "error" });
  await server.listen();
  const base = server.resolvedUrls.local[0];
  const port = 9300 + Math.floor(Math.random() * 500);
  const profile = mkdtempSync(join(tmpdir(), "scoredit-shots-"));
  const chrome = spawn(chromePath(), ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "--lang=en-US", "--mute-audio", "--autoplay-policy=no-user-gesture-required", "about:blank"], { stdio: "ignore" });
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`http://127.0.0.1:${port}/json/version`);
      break;
    } catch {
      await sleep(200);
    }
  }
  mkdirSync(out, { recursive: true });
  for (const shot of shots.filter((s) => !only || s.name.includes(only))) {
    const tab = await openTab(port);
    const dev = DEVICES[shot.device];
    try {
      await tab.send("Emulation.setDeviceMetricsOverride", { width: dev.width, height: dev.height, deviceScaleFactor: dev.deviceScaleFactor, mobile: dev.mobile });
      if (dev.touch) await tab.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
      await tab.send("Page.enable");
      await tab.send("Page.navigate", { url: base + shot.url });
      for (let i = 0; i < 150; i++) {
        await sleep(150);
        if (await tab.eval(`!!(window.viewer && document.querySelector('.sv-system svg') && document.querySelector('.sv-page')?.style.visibility !== 'hidden')`).catch(() => false)) break;
      }
      await sleep(1000);
      await tab.eval(HELPERS);
      await shot.run(tab, dev);
      await sleep(800);
      const { data } = await tab.send("Page.captureScreenshot", { format: "webp", quality: 82 });
      const file = join(out, `${shot.name}.webp`);
      writeFileSync(file, Buffer.from(data, "base64"));
      console.log(`${shot.name}.webp  ${Math.round(Buffer.from(data, "base64").length / 1024)} KB`);
    } catch (e) {
      console.log(`FAIL ${shot.name}: ${e instanceof Error ? e.message : e}`);
    }
    await fetch(`http://127.0.0.1:${port}/json/close/${tab.id}`);
    tab.close();
  }
  chrome.kill();
  await new Promise((r) => chrome.once("exit", r));
  await server.close();
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {}
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
