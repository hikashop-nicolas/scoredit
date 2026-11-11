// scoredit: a client-side music score viewer and editor.
//
// - formats/  detect, read (and later write) MusicXML, mxl, MuseScore, MIDI, ABC, Guitar Pro
// - model/    ScoreDoc, a MusicXML DOM with the index layout and editing need
// - layout/   system (line) breaking
// - render/   the viewer: one OSMD render per system, rendered as it scrolls into view
export { detectFormat, type ScoreFormat } from "./formats/detect";
export { loadScore, type LoadedScore, type LoadOptions } from "./formats/load";
export { readMxl } from "./formats/mxl";
export { ScoreDoc, type PartInfo } from "./model/score";
export { breakSystems, systemOf, type SystemRange, type BreakOptions } from "./layout/systems";
export { createScoreViewer, type LayoutMode, type ScoreViewerHandle, type ScoreViewerOptions } from "./render/viewer";
export type { LineView } from "./render/line-view";
export { setLocale, t } from "./ui/i18n";
