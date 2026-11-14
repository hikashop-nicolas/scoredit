# scoredit: details

Measurements and inner workings behind the [README](../README.md).

## PDF reader accuracy

`npm run test:pdf-corpus` exports the corpus scores to PDF with MuseScore 4 (and to MusicXML, the
reference), reads the PDFs back with `readPdfScore` and compares each staff: measure count, then
pitches and notes (pitch with duration) by edit distance.

On 26 scores (14 lieder, 5 string quartets, Für Elise and 6 guitar pieces with tablature; 73
staves, 75,613 notes):

| | |
|---|---|
| Pitches right | 99.1% |
| Pitches and durations right | 97.3% |
| Staves with the right measure count | 67 of 73 |

The string quartets (up to 1150 measures and 20,206 notes) are at 98.4% to 99.9% on both
measures; the lieder at 89.6% to 100% for pitch and duration. The weakest result is a guitar
tablature collection of riffs, with 97% of its pitches right but only 10% of its durations.

## Long PDF exports

A long score is not laid out at once. OSMD gets a slice of measures; its pages are kept except the
last, where the next slice starts; each page is drawn into the PDF and compressed as it comes. So
`onProgress` moves steadily from 0 to 1 and the page stays responsive: on a 153-page orchestral
score it is never busy for more than about two seconds at a time (13 seconds before slicing), for
about the same total time.

A slice ends at a page turn that no tie, slur, hairpin or octave line crosses. When every page
turn of the slice is crossed, the next slice lays out again (up to three pages) from where the
oldest of them began. On that score every tie and slur matches a layout of the whole score at
once.

## Scans

### Pipeline

Staff lines are found without machine learning: binarisation, run lengths, projections in
vertical strips, each line followed across the page. The symbol network (oemer's seg_net, or the
distilled one below) segments stems, rests, noteheads, clefs and accidentals; oemer's
post-processing, ported line by line, turns that into notes, beams, rests, clefs, accidentals and
dots, with oemer's four SVM classifiers (clef, rests, rests_above8, sfn).

The test bed is 14 pages (piano and voice, clean renders and their scans, 24 staffs):

| Symbol network | Tiles | Pitch | Pitch and duration |
|---|---|---|---|
| oemer itself (with its unet_big staff network) | page | 80% | 69% |
| seg_net, scoredit's staff lines | staffs | 80% | 72% |
| distilled network | strips | 82% | 74% |

### Tiles and timings

The symbol network is the slow part. Over the whole page (`tiles: "page"`, every `step` pixels,
as oemer does) it runs on about 200 overlapping tiles; on a 2019 laptop that is about 70 seconds
with WebGPU, 4 minutes in WebAssembly with eight threads and 20 minutes with one.

By default (`tiles: "staffs"`) it only runs on tiles over the staffs the staff-line step found, 4
line spacings above and below, overlapping by 32 pixels: 38 tiles on average on the test bed's
pages where `step: 256` over the page needs 63, for the same reading. With the int8 copy of
seg_net, one thread then takes about 3 minutes on that laptop and about 8 on a mid-range phone.
Staff lines take about a second and the post-processing 5 to 7 seconds.

`tiles: "strips"` runs one window per band of staffs (about 40% less work than `"staffs"`). It
needs a network whose input height and width are free, which oemer's file is not (it fixes them at
288) but the distilled network is.

In a worker, one WebAssembly thread read a page with `step: 256` in about 11 minutes, against 2
minutes on the page itself with four threads (which freeze it). More threads inside a worker do not
work in Chrome with onnxruntime-web 1.31.1 (the session never finishes loading, with or without a
bundler).

### Models

`python scripts/scan-models.py out/` writes the models from an oemer install:

- `oemer-symbols.onnx`: seg_net, 38.4 MB; `--int8 page.png` also writes a 10.3 MB int8 copy that
  reads about as well;
- `oemer-classifiers.json`: the four SVM classifiers, 5.9 MB;
- with `--staff`, oemer's unet_big staff network, for comparison only (`staffLines: "unet"`,
  `models.staff`). It is not needed and should not be shipped: it was trained on CVC-MUSCIMA, a
  non-commercial dataset.

### The distilled network

`scripts/scan-student/` distils seg_net into a small network (1.75 M parameters, 7 MB, about 25
times less work per tile) trained on seg_net's own output over MuseScore renders with scan-like
degradations. With `tiles: "strips"` it reads the test bed as well as seg_net and the symbol step
takes about 10 seconds a page on one laptop thread. `render.py` renders scores to train on,
`label.py` makes the training tiles, `train.py` trains (MPS, CUDA or CPU) and `export.py` writes
the ONNX file. The published network was trained on pages of 24 scores: 15 from the OpenScore
corpus (CC0), 6 test files from OpenSheetMusicDisplay's test suite (BSD-3) and 3 guitar scores
published by their users on musescore.com.

All models, seg_net's int8 copy and the distilled network included, are published at
[huggingface.co/hikashop-nicolas/scoredit-scan](https://huggingface.co/hikashop-nicolas/scoredit-scan)
(MIT). oemer's models were trained by its author on DeepScoresV2 (CC BY 4.0); credit
DeepScoresV2 and oemer where the models are shipped.

### Progress

`progress` reports the network tiles (`symbols`, and `staff` with unet_big), then `lines` and
`post` as 0 or 1 of 1.
