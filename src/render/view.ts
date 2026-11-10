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
}

export interface ViewOptions {
  zoom: number;
  onError?(err: unknown): void;
  onSystemRendered?(index: number, ms: number): void;
  /** The view changed its own zoom (the line view fits the score to the height). */
  onZoom?(zoom: number): void;
}
