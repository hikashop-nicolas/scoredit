import type { NoteEvent } from "../play/timeline";
import type { NoteMark } from "./positions";

/** Practice marks: drawn notes by markKey (page and line views), timeline notes (falling notes). */
export interface PracticeMarks {
  notes: Map<string, NoteMark>;
  events: Map<NoteEvent, NoteMark>;
}

/** What the viewer shell needs from a layout (page or line). */
export interface View {
  /** The scrolling element the view lives in; the shell places it above the bar. */
  readonly root: HTMLElement;
  readonly zoom: number;
  /** Shows zoom `z` at once (a CSS scale about `at`, client coordinates), without re-layout. */
  preview(z: number, at?: { x: number; y: number }): void;
  /** Lays the score out again at zoom `z`. */
  commit(z: number): void;
  relayout(): void;
  destroy(): void;
  /** Puts the playback cursor at quarter `q` of measure `m` (`quarters` long); `follow` scrolls to it. */
  showPosition(m: number, q: number, quarters: number, follow: boolean): void;
  hidePosition(): void;
  /** Lights or unlights the notes starting at these `noteKey`s. */
  highlight(keys: string[], on: boolean): void;
  /** Colours practised notes by how they were played (the marks are kept and put back on redraws). */
  mark(marks: PracticeMarks): void;
  /** The measure and beat under a client point, for "play from here". */
  hit(clientX: number, clientY: number): { measure: number; quarter: number } | null;
}

export interface ViewOptions {
  zoom: number;
  onError?(err: unknown): void;
  onSystemRendered?(index: number, ms: number): void;
  /** The view changed its own zoom (the line view fits the score to the height). */
  onZoom?(zoom: number): void;
}
