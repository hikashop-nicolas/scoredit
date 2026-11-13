# scoredit

Client-side music score viewer and editor for the browser: open MusicXML (and soon
MuseScore, MIDI, ABC and Guitar Pro), play it, and edit it with real note entry on phone
and desktop. No server, no framework. MIT.

Engraving is done by [OpenSheetMusicDisplay](https://github.com/opensheetmusicdisplay/opensheetmusicdisplay)
(BSD-3), one **system** (line) at a time: scoredit breaks the score into systems itself,
renders only those near the viewport, and re-renders a single system after an edit. A
1150-measure string quartet opens as fast as a song, and an edit costs about 0.15 s on a
phone whatever the length of the score.

Status: early. Phase 1 (viewer) is in progress; the plan lives in Omnitext's
`_plans/SCORE_PLAN.md`.

## Use

```ts
import { createScoreViewer, loadScore } from "scoredit";

const { score } = loadScore(bytes); // Uint8Array of a .musicxml / .xml / .mxl file
const viewer = createScoreViewer(container, score, { zoom: 1 });
viewer.setZoom(1.2);
viewer.destroy();
```

## MIDI

```ts
import { midiToMusicXml, writeMidi } from "scoredit";

const mid = writeMidi(score); // Standard MIDI File, type 1, 480 ticks a quarter
const xml = midiToMusicXml(mid); // and back, quantised to written values
```

The export plays the score the way scoredit plays it: repeats and jumps unfolded, transposing
instruments at concert pitch, drums on channel 10, velocities from dynamics and accents,
staccato shortened, grace notes and arpeggios timed, fermatas held and pauses taken after
caesuras and at section ends. `{ straight: true }` writes each measure once instead.

A MuseScore file can set how long each fermata holds and each pause lasts; MusicXML has no
place for those, so the score keeps them as `scoredit-stretch` and `scoredit-pause` attributes
that playback reads and that `score.serialize()` leaves out.

## Sound

Playback starts on a built-in synthesizer (webaudio-tinysynth, Apache-2.0) and a plucked-string
model, which need no download. With a `sounds` source, the instruments a score uses are
replaced by recordings as they arrive: `remoteSounds({ base: SOUNDS_CDN, ask })` fetches them
from [scoredit-sounds](https://github.com/hikashop-nicolas/scoredit-sounds) (MuseScore_General,
MIT; most instruments are under 0.5 MB, the piano 15 MB), asks the host first through `ask`,
and keeps them in Cache Storage. scoredit itself never downloads anything.

`exportMp3(score, { sounds, onProgress })` and `exportWav(...)` render the whole score to audio,
with the same instruments (recorded ones straight through spessasynth, the rest on the built-in
synth), and give the file bytes; `renderAudio` and `encodeMp3` are the two steps apart. The MP3
encoder is [rusty_mp3](https://github.com/Remade-With-Rust/remade_ffmpeg_rs) (Apache-2.0),
compiled to WebAssembly (`scripts/build-mp3-wasm.sh`, from `wasm/mp3`) and loaded only when
an MP3 is made.

`exportPdf(score, { paper: "a4" | "letter", onProgress })` lays the score out on pages and gives a
vector PDF (OSMD's paged layout drawn with jsPDF and svg2pdf.js, both MIT, loaded on first use);
`renderPages` gives the same pages as SVG, for printing.

## Scans and photos (experimental)

```ts
import { readScanScore } from "scoredit";

const doc = await readScanScore(blobOrImageData, {
  models: { symbols: urlOrBytes, classifiers: urlOrBytes },
  session: { executionProviders: ["webgpu", "wasm"] },
});
```

One page of printed music becomes a MusicXML document. Staff lines are found without
machine learning (binarisation, run lengths, projections in vertical strips, each line
followed across the page); the symbols come from a TypeScript port of
[oemer](https://github.com/BreezeWhite/oemer) (MIT): its symbol segmentation network runs in
onnxruntime-web (imported on first use) and its post-processing (noteheads, beams, rests,
clefs, accidentals, dots) is ported line by line. On a test bed of 14 pages (piano, voice,
clean renders and their scans, 24 staffs) it gets 80% of the pitches and 72% of pitch and
duration together right, where oemer's own staff network gives 80% and 69%.

scoredit ships no model. The host gives each as a URL, bytes or a fetch function, and
`python scripts/scan-models.py out/` writes them from an oemer install:

- `symbols`: oemer-symbols.onnx, oemer's seg_net (38.4 MB; `--int8 page.png` also writes a
  10.3 MB int8 copy that reads about as well);
- `classifiers`: oemer-classifiers.json, oemer's four SVM classifiers (5.9 MB).

Both were trained by oemer's author on [DeepScoresV2](https://zenodo.org/record/4012193)
(Tuggener et al., CC BY 4.0); credit DeepScoresV2 and oemer where the models are shipped.
oemer's staff network (unet_big) is not needed and is not shipped: it was trained on
CVC-MUSCIMA, a non-commercial dataset. For comparison it can still be used
(`staffLines: "unet"`, `models.staff`, `scan-models.py --staff`).

The symbol network is the slow part: it runs on about 200 overlapping tiles per page. On a
2019 laptop that is about 70 seconds with WebGPU, 4 minutes in WebAssembly with eight
threads and 20 minutes with one. `step: 256` (63 tiles) with the int8 copy brings that to
80 seconds with eight threads and 4 minutes with one, reading about as well. Staff lines
take about a second and the post-processing 5 to 7 seconds.

### Off the main thread

`worker` runs the whole scan (networks and post-processing) in a module worker and passes
its progress back; `signal` stops it. Without it, everything runs on the calling thread
(Node, tests, or a worker of the host's own).

```ts
// Bundlers that follow new Worker(new URL(..., import.meta.url)) (Vite build, webpack 5)
// emit scoredit's scan-worker.js themselves:
await scanToMusicXml(blob, { models, worker: true, wasmPaths: "/ort/", progress });

// Vite, dev server included: a factory from Vite's ?worker import.
import ScanWorker from "scoredit/scan-worker?worker";
await scanToMusicXml(blob, { models, worker: () => new ScanWorker(), progress });

// Or the URL where the host serves dist/formats/scan/scan-worker.js, bundled.
await scanToMusicXml(blob, { models, worker: "/js/scan-worker.js" });
```

`worker: true` works in a Vite production build; the Vite dev server pre-bundles
dependencies and loses the worker file, so use the `?worker` factory there (or
`optimizeDeps: { exclude: ["scoredit"] }`). Model URLs are resolved against the page and
fetched by the worker; bytes are copied to it and fetch functions run on the page first. The
worker imports onnxruntime-web itself, so `ort` is ignored; give `wasmPaths` when the
bundler does not serve onnxruntime-web's .wasm and .mjs files. Progress reports the network
tiles (`symbols`, and `staff` with unet_big), then `lines` and `post` as 0 or 1 of 1.

In Chrome with onnxruntime-web 1.31.1, a session created inside a worker with more than one
WebAssembly thread never finished loading (the same happens with plain onnxruntime-web in a
module worker, no bundler), so use `threads: 1` or WebGPU with `worker`. One thread in the
worker read a page with `step: 256` in about 11 minutes, against 2 minutes on the page with
four threads, which freeze it.

## Develop

```sh
npm install
npm run corpus   # fetch the test corpus (OpenScore, CC0) into corpus/; converts with MuseScore 4 if installed
npm run dev      # demo at http://127.0.0.1:5173, with the local corpus in its picker
npm test
npm run test:corpus   # the corpus checks against MuseScore's own export (needs the corpus)
npm run test:e2e      # edit mode driven in headless Chrome (desktop and phone); report in e2e-report/
# then http://127.0.0.1:5173/sounds.html: a blind listening test of the instrument sounds
```

The corpus folder is gitignored and only the dev server serves it: scores downloaded
from elsewhere for testing never end up in the repo or the built demo.

`npm run test:e2e` plays edit-mode scenarios (typing notes, taps, long press, keyboard and
fretboard strips, triplets, copy/paste, drums, undo, saving) on the small scores in
demo/fixtures/ with real mouse, touch and key events, and checks what the score then holds
and what playback would sound. The report, e2e-report/index.html, explains each scenario in
plain words with a screenshot, so it reads without knowing music. `npm run test:e2e -- tie`
runs only the scenarios whose id contains "tie". It needs Chrome (or CHROME_PATH).
