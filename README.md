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
# then http://127.0.0.1:5173/sounds.html: a blind listening test of the instrument sounds
```

The corpus folder is gitignored and only the dev server serves it: scores downloaded
from elsewhere for testing never end up in the repo or the built demo.
