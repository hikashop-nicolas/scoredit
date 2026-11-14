import * as scoreditLib from "../src/index";
import { layoutKeys, keyRange, noteLane } from "../src/ui/keyboard";
import * as scoreditRebuild from "../src/edit/rebuild";
import { SOUNDS_CDN, createScoreViewer, loadScore, loadScoreAsync, partFamily, remoteSounds, webMidiInput, type MidiInput, type ScoreViewerHandle } from "../src/index";

// Recorded sounds: from the local corpus copy of scoredit-sounds, or ?sounds=cdn for jsDelivr.
const sounds = remoteSounds({ base: new URLSearchParams(location.search).get("sounds") === "cdn" ? SOUNDS_CDN : new URL("corpus/sounds/gm/", location.href).href });

const host = document.getElementById("score")!;
const stats = document.getElementById("stats")!;
const select = document.getElementById("corpus") as HTMLSelectElement;
let viewer: ScoreViewerHandle | null = null;
// A MIDI instrument, once the MIDI button was pressed (the browser asks for permission).
let midi: MidiInput | null = null;
let rendered = 0;
let renderMs = 0;

async function open(bytes: Uint8Array, name: string): Promise<void> {
  viewer?.destroy();
  viewer = null;
  host.textContent = "";
  rendered = 0;
  renderMs = 0;
  const t0 = performance.now();
  try {
    const loaded = await loadScoreAsync(bytes, { tab: new URLSearchParams(location.search).get("tab") === "1" ? "always" : "auto", tune: Number(new URLSearchParams(location.search).get("tune")) || undefined });
    const { score, format } = loaded;
    const parsed = performance.now() - t0;
    (window as unknown as { viewer?: unknown }).viewer = null;
    viewer = createScoreViewer(host, score, {
      layout: ((l) => (l === "line" || l === "keys" ? l : "page"))(new URLSearchParams(location.search).get("layout")),
      onError: (e) => console.error(e),
      sounds,
      midi,
      editable: true,
      onChange: () => ((window as unknown as { svEdits?: number }).svEdits = ((window as unknown as { svEdits?: number }).svEdits ?? 0) + 1),
      // The end of an in-time run, as a host would hear it (e2e reads it).
      onPracticeEnd: (s) => ((window as unknown as { svPracticeEnd?: unknown }).svPracticeEnd = s),
      // ?parts=drums shows the parts of one instrument family, as a host setting would.
      parts: { show: ((f) => (f ? score.parts.flatMap((p, i) => (partFamily(p) === f ? [i] : [])) : null))(new URLSearchParams(location.search).get("parts")) },
      tablature: loaded.fretted ? { on: loaded.tab, toggle: (on) => loadScore(bytes, { tab: on ? "always" : "never" }).score } : undefined,
      onFullscreen: () => (document.fullscreenElement ? void document.exitFullscreen() : void host.requestFullscreen()),
      onSystemRendered: (i, ms) => {
        rendered++;
        renderMs += ms;
        const w = window as unknown as { svLog?: string[] };
        (w.svLog ??= []).push(`system ${i}: ${Math.round(ms)}ms`);
        show();
      },
    });
    (window as unknown as { viewer?: unknown }).viewer = viewer;
    const show = () =>
      (stats.textContent = `${name} · ${format} · ${score.measureCount} measures · ${viewer?.systems.length} systems · parse ${Math.round(parsed)}ms · ${rendered} rendered, avg ${rendered ? Math.round(renderMs / rendered) : 0}ms`);
    show();
  } catch (e) {
    host.innerHTML = `<p class="err"></p>`;
    host.firstElementChild!.textContent = String(e);
  }
}

document.getElementById("file")!.addEventListener("change", async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) await open(new Uint8Array(await f.arrayBuffer()), f.name);
});

async function openUrl(path: string): Promise<void> {
  const res = await fetch(path.startsWith("fixtures/") ? path : `corpus/${path}`);
  await open(new Uint8Array(await res.arrayBuffer()), path);
}
select.addEventListener("change", () => select.value && void openUrl(select.value));

// The dev server lists the local corpus; the built demo has none.
fetch("corpus-index.json")
  .then((r) => (r.ok ? r.json() : []))
  .then((files: string[]) => {
    for (const f of files) select.add(new Option(f, f));
    const fixture = new URLSearchParams(location.search).get("fixture");
    if (fixture) return void openUrl(`fixtures/${fixture}`);
    const want = new URLSearchParams(location.search).get("f");
    if (want) {
      select.value = want;
      void openUrl(want);
    }
  })
  .catch(() => select.remove());

// Web MIDI behind a button, as it prompts; then Practice shows in the bar and the editor takes keys.
const midiBtn = document.getElementById("midi") as HTMLButtonElement;
midiBtn.hidden = !("requestMIDIAccess" in navigator);
midiBtn.addEventListener("click", async () => {
  try {
    midi = webMidiInput(await navigator.requestMIDIAccess());
    viewer?.setMidiInput(midi);
    midiBtn.textContent = "MIDI on";
    midiBtn.disabled = true;
  } catch (e) {
    midiBtn.textContent = `MIDI: ${e instanceof Error ? e.message : String(e)}`;
  }
});

document.addEventListener("fullscreenchange", () => viewer?.setReadingMode(document.fullscreenElement === host));

// For the end-to-end tests (e2e/): the library, the strip's key layout, and pdf.js to check exports.
Object.assign(window, { scoreditLib, scoreditRebuild, scoreditKeys: { layoutKeys, keyRange, noteLane }, scoreditPdfjs: () => import("pdfjs-dist/legacy/build/pdf.mjs") });
