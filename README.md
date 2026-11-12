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
staccato shortened, grace notes and arpeggios timed. `{ straight: true }` writes each
measure once instead.

## Sound

Playback starts on a built-in synthesizer (webaudio-tinysynth, Apache-2.0) and a plucked-string
model, which need no download. With a `sounds` source, the instruments a score uses are
replaced by recordings as they arrive: `remoteSounds({ base: SOUNDS_CDN, ask })` fetches them
from [scoredit-sounds](https://github.com/hikashop-nicolas/scoredit-sounds) (MuseScore_General,
MIT; most instruments are under 0.5 MB, the piano 15 MB), asks the host first through `ask`,
and keeps them in Cache Storage. scoredit itself never downloads anything.

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
