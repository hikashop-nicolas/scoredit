// scoredit: a client-side music score viewer and editor.
//
// - formats/  detect, read (and later write) MusicXML, mxl, MuseScore, MIDI, ABC, Guitar Pro, PDF
// - model/    ScoreDoc, a MusicXML DOM with the index layout and editing need
// - layout/   system (line) breaking
// - render/   the viewer: one OSMD render per system, rendered as it scrolls into view
export { detectFormat, type ScoreFormat } from "./formats/detect";
export { loadScore, loadScoreAsync, type LoadedScore, type LoadOptions } from "./formats/load";
export { readPdfScore } from "./formats/pdf/read";
export { readMxl, writeMxl } from "./formats/mxl";
export { readAbc, abcTunes, type AbcOptions } from "./formats/abc";
export { readGuitarPro, type GuitarProOptions } from "./formats/gp";
export { writeGuitarPro, type GuitarProWriteOptions } from "./formats/gp-write";
export { midiToMusicXml } from "./formats/midi";
export { writeMidi, type MidiWriteOptions } from "./formats/midi-write";
export type { Dropped } from "./formats/mscx-write";
export { ScoreDoc, partFamily, PART_FAMILIES, type PartFamily, type PartInfo } from "./model/score";
export { breakSystems, systemOf, type SystemRange, type BreakOptions } from "./layout/systems";
export { ScoreEditor, type Caret, type Change, type NoteInput } from "./edit/editor";
export { createScoreViewer, type LayoutMode, type ScoreViewerHandle, type ScoreViewerOptions } from "./render/viewer";
export type { LineView } from "./render/line-view";
export { buildTimeline, type Timeline, type NoteEvent } from "./play/timeline";
export { remoteSounds, SOUNDS_CDN, type RemoteSoundsOptions, type SoundDownloads, type SoundRequest } from "./play/sounds";
export { setLocale, t } from "./ui/i18n";
export { getVolume, setVolume } from "./play/player";
export { isNotationMidi, isScorePdf, pdfNotationApp } from "./formats/sniff";
export { embedScore, exportPdf, renderPages, type PageOptions, type Paper, type PdfExportOptions } from "./render/pdf-export";
export { encodeMp3, encodeWav, exportMp3, exportWav, renderAudio, type AudioExportOptions, type RenderedAudio } from "./play/audio-export";
export { newMuseScore, newMscx, type NewScore } from "./formats/mscx-new";
export { INSTRUMENTS, instrument, type InstrumentDef } from "./model/instruments";
export { createNewScoreForm, type NewScoreForm, type NewScoreFormOptions } from "./ui/new-score";
