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

## Practice with a MIDI instrument

```ts
import { createScoreViewer, webMidiInput } from "scoredit";

const access = await navigator.requestMIDIAccess(); // the host asks; scoredit never does
const viewer = createScoreViewer(container, score, { midi: webMidiInput(access) });
viewer.setPractice({ mode: "wait", hand: "right", echo: true });
```

A `MidiInput` is anything with `subscribe(cb)` that hands over `{ data, time, source }` messages
(time in `performance.now()` ms), so a native bridge can stand in for Web MIDI.
`webMidiInput` merges every input, drops the doubled messages of a device listed twice (within
2 ms) and follows devices plugged in later. With an input, the bar shows Practice: in wait
mode playback holds before each next note or chord of the parts shown (or one hand of a piano)
until its keys are struck, while the other parts accompany. Keys struck in any order count,
wrong keys are ignored, a key held from before must be struck again, tied notes are not struck
again, grace notes never block and an ornament or tremolo expects its written note once. The
keyboard outlines the keys to play and shows those pressed (green expected, red not); "Hear my
notes" sounds the keys with the part's instrument.

### In time

```ts
viewer.setPractice({ mode: "time", hand: "both", latencyMs: 0 });
createScoreViewer(container, score, { midi, onPracticeEnd: (s) => console.log(s.accuracy) });
```

Playback runs at the chosen speed and the practised notes (same choice of parts, hands, ties,
graces, ornaments and tremolos as wait mode) are not sounded. Each one is matched to a key of
its pitch (`TimeMatcher`):

- Window: ±max(80, 120 / speed) ms around the note, in real time (±120 ms at speed 1, ±240 ms
  at half speed). On time within ±max(35, 50 / speed) ms, early or late beyond that, missed
  once the window has passed. A window never reaches past halfway to the previous or next note
  of the same pitch, so fast repeated notes each keep their own.
- A key that matches no note waiting for it (none of its pitch in the window, or that note
  already played) is a wrong key; it consumes nothing.
- Accuracy: on time counts 1, early or late 1/2, over the notes judged plus the wrong keys.
- Feedback: keys pressed green (on time), amber (early or late), red (wrong); a missed note's
  key flashes grey; the keys due now are outlined. The notes themselves take the same colours
  in the score and in falling notes.
- A run goes from where playback starts to where it stops or the piece ends: then a summary
  shows (on time, early, late, missed, wrong keys, accuracy) and `onPracticeEnd` hears it.
  Nothing is kept; playing again or seeking starts a new run. `practiceStatus.counts` has the
  running counts.

Timing is judged on the audio clock: a key's MIDI time (`performance.now()` ms) is moved onto
`AudioContext` time, less the output latency (`outputLatency`, else `baseLatency`) and less
`practice.latencyMs`, which covers what the browser cannot know (the instrument, Bluetooth
audio, the ear). To calibrate, a host has the player play along in time with a steady passage
(a scale in quarter notes), reads `meanOffsetMs` from the summary (the mean signed offset of
the notes played, positive when late) and adds it to `latencyMs`; one or two passes settle it.

### Note entry from a MIDI keyboard

The same input feeds the editor; practice and editing are exclusive (while editing, keys never
reach wait mode). In note input (N), a key enters its pitch at the caret with the chosen length
and the caret moves on, like a typed letter; lengths, dots, ties, voices and rests keep coming
from the computer keyboard and the palette.

- Spelling: a note of the key's scale is written as the key writes it (E♯ in F♯ major, C♭ in
  G♭ major); any other black key takes a sharp in sharp keys and in C, a flat in flat keys
  (`spellInKey`).
- Chords: keys struck within 60 ms of a group's first key make one chord (`ChordGrouper`);
  holding a key while striking another does not, so legato melodies stay single notes.
- Rests: pressing the sustain pedal (CC64) enters a rest of the chosen length; 0 still does too.
- Undo: each note, chord or rest entered is one step.
- Transposing instruments: keys sound concert pitch, so the written note is the key moved by the
  part's transposition (B♭ on the keyboard is a written C for a B♭ clarinet).
- Drums: a key enters the part's drum on that General MIDI key (38 snare, 42 closed hi-hat...),
  as the part writes it; a key the part has no drum for is ignored.
- Out of note input, a key gives the one selected note its pitch (a chord or range selected is
  left alone). With "Hear my notes" on, keys also sound with the edited part's instrument.

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
`renderPages` gives the same pages as SVG, for printing. A long score is laid out a few pages at a
time (OSMD gets a slice of measures, its pages are kept but the last, where the next slice starts),
and each page is drawn and compressed as it comes, so `onProgress` moves steadily from 0 to 1 and
the page stays responsive: on a 153-page orchestral score it is never busy for more than about two
seconds (it was 13 seconds at a time before), for about the same total time. A slice ends at a
page turn that no tie, slur, hairpin or octave line crosses; when every page turn of the slice is
crossed, the next slice lays out again (up to three pages) from where the oldest of them began. On
that score every tie and slur matches a layout of the whole score at once.

The standard PDF fonts only draw Western European letters. For titles, part names, lyrics, words
and chord text in other scripts, give `fonts`: a TrueType or OpenType (CFF) font per script, as a
URL, bytes or a function giving them.

```ts
await exportPdf(score, {
  fonts: {
    japanese: "/fonts/BIZUDPGothic-Regular.ttf",
    chinese: () => fetchFont("OmnitextHans-Regular.otf"),
    korean: koreanBytes,
    cyrillic: sans, greek: sans, latin: sans, // Latin beyond Western European
    arabic: arabicUrl, hebrew: hebrewUrl,
  },
});
```

Nothing is fetched for a score whose text the standard fonts draw (its PDF is the same as without
`fonts`), and otherwise only the fonts of the scripts it uses: a function is called, or a URL
fetched, when its script is needed. Han characters go to `japanese` when the score has kana and to
`chinese` otherwise, then to the other font when the first lacks them. Each font is cut down to the
characters used and embedded, so the text can be selected and searched; Arabic is shaped into its
joined forms and right-to-left text is put in reading order. A script without a font (left out, `""`
or `null`), or a font that fails to load, keeps the standard font for its characters. Bold and italic
text in an embedded font is drawn upright. Fonts with complex shaping (Thai, Indic scripts) are not
handled. scoredit ships no font; OFL fonts such as BIZ UDPGothic, Noto Sans, Noto Sans Arabic and
Noto Sans Hebrew allow embedding.

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

The symbol network is the slow part: over the whole page it runs on about 200 overlapping
tiles. On a 2019 laptop that is about 70 seconds with WebGPU, 4 minutes in WebAssembly with
eight threads and 20 minutes with one. By default (`tiles: "staffs"`) it only runs on tiles
over the staffs the staff-line step found, 4 line spacings above and below, overlapping by
32 pixels: 38 tiles on average on the test bed's pages where `step: 256` over the page needs
63, for the same reading (80% and 72%). `tiles: "page"` covers the whole page every `step`
pixels, as oemer does. With the int8 copy one thread then takes about 3 minutes on that
laptop and about 8 on a mid-range phone. Staff lines take about a second and the
post-processing 5 to 7 seconds.

For phones, `scripts/scan-student/` distils seg_net into a small network (1.75 M parameters,
7 MB, about 25 times less work per tile) trained on seg_net's own output over MuseScore
renders with scan-like degradations. Given as `models.symbols` with `tiles: "strips"` (one
window per band of staffs, which needs a network of free input size such as these), it reads
the test bed as well as seg_net (82% and 74%) and the symbol step takes about 10 seconds a
page on one laptop thread. `label.py` makes the training tiles, `train.py` trains (MPS,
CUDA or CPU), `export.py` writes the ONNX file; `render.py` renders scores to train on.

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
