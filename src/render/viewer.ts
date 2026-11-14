import type { SystemRange } from "../layout/systems";
import type { ScoreDoc } from "../model/score";
import { clampZoom, createBar, type LayoutMode, type PracticeState } from "../ui/bar";
import { Player, getVolume, setVolume } from "../play/player";
import type { SoundDownloads } from "../play/sounds";
import { buildTimeline, type Timeline } from "../play/timeline";
import { Fretboard, fretTuning, position } from "../ui/fretboard";
import { createEditing } from "../ui/editing";
import { Keyboard, PRESSED_RIGHT, PRESSED_WRONG, flash } from "../ui/keyboard";
import { parseNote, type MidiInput, type MidiMessage } from "../play/midi";
import { WaitMatcher, practiceGroups, practisedBy } from "../play/practice";
import { createKeysView, noteColors } from "./keys-view";
import { createLineView, type LineView } from "./line-view";
import { noteKey } from "./positions";
import { createPageView, type PageView } from "./page-view";
import { injectStyles } from "./styles";
import type { View } from "./view";

export type { LayoutMode, PracticeState } from "../ui/bar";

export interface ScoreViewerOptions {
  /** "page": lines stacked down the page (default). "line": one long line, sideways, sized to the height. */
  layout?: LayoutMode;
  /** Page zoom; 1 = OSMD's default size (10 px per staff space). Default: 0.6 on a phone-wide container, else 1. */
  zoom?: number;
  /** Shows a fullscreen button in the bar; the host enters fullscreen and calls setReadingMode. */
  onFullscreen?(): void;
  /** The user switched between page and line layout. */
  onLayoutChange?(layout: LayoutMode): void;
  onError?(err: unknown): void;
  /** Called after a page system finished rendering, with its index and time in ms. */
  onSystemRendered?(index: number, ms: number): void;
  /**
   * Tablature for fretted parts: shows a tab button in the bar. `toggle` returns the score
   * read again with (or without) the tab staff, and the viewer shows it.
   */
  tablature?: { on: boolean; toggle(on: boolean): ScoreDoc };
  /**
   * Recorded instrument sounds, fetched when a score needs them (see remoteSounds). Without
   * it the built-in synth and string model play; scoredit never downloads on its own.
   */
  sounds?: SoundDownloads | null;
  /**
   * Parts shown: a Parts button in the bar ticks them (playback keeps them all). `show` is
   * the first choice (indices into score.parts, null for all); `onChange` hears the user's.
   */
  parts?: { show?: number[] | null; onChange?(shown: number[] | null): void };
  /** Playback volume (0 to 1) and mute as they start; `onChange` hears the user's (to keep them). */
  volume?: { value?: number; muted?: boolean; onChange?(value: number, muted: boolean): void };
  /** Shows an Edit button: notes can then be entered and changed (on the page layout). */
  editable?: boolean;
  /** The score changed by an edit (the host marks the file modified; score.serialize() has it). */
  onChange?(): void;
  /** A MIDI instrument to play along with (see webMidiInput): the bar then shows Practice. */
  midi?: MidiInput | null;
  /** Practice settings as they start; `onChange` hears the user's (to keep them). */
  practice?: Partial<PracticeState> & { onChange?(p: PracticeState): void };
}

/** Wait mode as it stands: the group of notes waited for and whether playback holds for it. */
export interface PracticeStatus {
  index: number;
  count: number;
  /** MIDI pitches of the group waited for (empty once all are played). */
  expected: number[];
  /** Pitches of it not struck yet. */
  missing: number[];
  waiting: boolean;
}

export interface ScoreViewerHandle {
  readonly score: ScoreDoc;
  readonly layout: LayoutMode;
  /** Shows another score (the same piece read again), keeping layout and zoom. */
  setScore(score: ScoreDoc): void;
  /** Page systems (empty in line layout). */
  readonly systems: readonly SystemRange[];
  /** The page width model, in OSMD units (for tests and tuning). */
  readonly layoutParams: PageView["layoutParams"] | null;
  /** The line view while in line layout, for playback to drive. */
  readonly line: LineView | null;
  setLayout(layout: LayoutMode): void;
  /** Indices of the parts shown, null for all. */
  readonly parts: number[] | null;
  setParts(shown: number[] | null): void;
  /**
   * The client point of a staff position (half spaces below its top line) at a beat, in the
   * page layout, for driving the viewer in tests. Part indices are the score's.
   */
  pointFor(measure: number, quarter: number, part: number, staff: number, step: number): { x: number; y: number } | null;
  /** Whether edit mode is on. */
  readonly editing: boolean;
  setEditing(on: boolean): void;
  /** Starts or pauses playback (the bar's play button). */
  togglePlay(): void;
  /** The player, once playback was used. */
  readonly player: Player | null;
  /** Uses another MIDI instrument (null: none; the Practice button hides). */
  setMidiInput(input: MidiInput | null): void;
  readonly practice: PracticeState;
  setPractice(p: Partial<PracticeState>): void;
  /** Wait mode's state while it is on and playback was used, else null. */
  readonly practiceStatus: PracticeStatus | null;
  getZoom(): number;
  setZoom(zoom: number): void;
  /** The end of the bottom bar, where a host can put its own buttons. */
  getBarEnd(): HTMLElement;
  /** Fullscreen reading: the host's buttons in the bar hide. */
  setReadingMode(on: boolean): void;
  /** Lays the score out again, e.g. after it changed. */
  relayout(): void;
  destroy(): void;
}

// The viewer shell: a bottom bar (layout switch, zoom, fullscreen, host slot), pinch zoom,
// and the active layout. The page layout reads like sheet music; the line layout runs the
// score sideways on one line for playing along.
export function createScoreViewer(container: HTMLElement, initial: ScoreDoc, opts: ScoreViewerOptions = {}): ScoreViewerHandle {
  let score = initial;
  // The parts shown, and the score the views draw: the whole score, or those parts only.
  const validParts = (p: number[] | null | undefined, s: ScoreDoc) => {
    const ok = [...new Set(p ?? [])].filter((i) => i >= 0 && i < s.parts.length).sort((a, b) => a - b);
    return ok.length && ok.length < s.parts.length ? ok : null;
  };
  let shownParts = validParts(opts.parts?.show, score);
  let shownScore = shownParts ? score.only(shownParts) : score;
  const visible = (e: { part: number }) => !shownParts || shownParts.includes(e.part);
  injectStyles();
  let mode: LayoutMode = opts.layout ?? "page";
  let pageZoom = clampZoom(opts.zoom ?? (container.clientWidth > 0 && container.clientWidth < 700 ? 0.6 : 1));
  const shell = document.createElement("div");
  shell.className = "sv-shell";
  shell.tabIndex = -1;
  container.append(shell);

  let view: View;
  let pinching = false;
  let shown = 0;
  let zoomTimer = 0;
  if (opts.volume) setVolume(opts.volume.value ?? getVolume().volume, opts.volume.muted ?? false);
  const bar = createBar({
    zoom: pageZoom,
    layout: mode,
    onZoomInput: (z) => zoomTo(z, undefined, 400),
    onZoomCommit: () => commitZoom(),
    onLayout: (m) => {
      setLayout(m);
      opts.onLayoutChange?.(m);
    },
    onPlay: () => togglePlay(),
    onSpeed: (v) => setSpeed(v),
    volume: { value: getVolume().volume, muted: getVolume().muted },
    onVolume: (v, m) => {
      setVolume(v, m);
      opts.volume?.onChange?.(v, m);
    },
    onKeyboard: (on) => showKeyboard(on),
    fretboard: !!fretTuning(shownScore, []),
    onFretboard: (on) => showFretboard(on),
    tab: opts.tablature ? { on: opts.tablature.on, toggle: (on) => setScore(opts.tablature!.toggle(on)) } : undefined,
    onFullscreen: opts.onFullscreen,
    onParts: opts.parts ? (p) => setParts(p, true) : undefined,
    onEdit: opts.editable ? () => setEditing(true) : undefined,
    onPractice: (p) => setPractice(p),
  });

  // Edit mode: the palette takes the bar's place; edits draw again what they changed.
  let editingOn = false;
  const editing = createEditing({
    score: () => score,
    shown: () => shownParts,
    view: () => (mode === "page" ? (view as PageView) : null),
    changed: (c) => {
      player?.dispose();
      player = null;
      timeline = null;
      shownTimeline = null;
      matcher = null;
      bar.setPlaying(false);
      if (shownParts) shownScore = score.only(shownParts);
      if (mode === "page") (view as PageView).refresh(shownScore, c.from, c.appended ? score.measureCount : c.to);
      opts.onChange?.();
    },
    done: () => setEditing(false),
  });
  function setEditing(on: boolean): void {
    if (on === editingOn || (on && !opts.editable)) return;
    editingOn = on;
    if (on) {
      player?.pause();
      if (mode !== "page") setLayout("page");
      editing.attach(view as PageView);
      editing.start();
    } else editing.stop();
    bar.el.hidden = on;
    shell.focus({ preventScroll: true });
  }
  shell.addEventListener("keydown", (e) => {
    if (editingOn && editing.key(e)) {
      e.preventDefault();
      e.stopPropagation();
    }
  });
  bar.setParts(score.parts.map((p) => p.name), shownParts);

  // The timeline is built once, when playback or the keyboard first needs it.
  let timeline: Timeline | null = null;
  const getTimeline = () => (timeline ??= buildTimeline(score));
  // The notes of the parts shown, for the keyboard, fretboard and falling notes.
  let shownTimeline: Timeline | null = null;
  const getShownTimeline = () => (shownTimeline ??= shownParts ? { ...getTimeline(), events: getTimeline().events.filter(visible) } : getTimeline());
  let color = noteColors(score);

  // The fretboard strip under the score, for fretted parts: positions lit as notes sound.
  let frets: Fretboard | null = null;
  let tuning: number[] = [];
  function showFretboard(on: boolean): void {
    if (on && !frets) {
      const tl = getShownTimeline();
      tuning = fretTuning(shownScore, tl.events) ?? [];
      if (!tuning.length) return;
      frets = new Fretboard(tuning);
      let top = 0;
      for (const e of tl.events) top = Math.max(top, position(e, tuning)?.fret ?? 0);
      frets.setFrets(top + 1);
      const wrap = document.createElement("div");
      wrap.className = "sv-kbd";
      wrap.append(frets.canvas);
      shell.insertBefore(wrap, bar.el);
      requestAnimationFrame(() => frets?.draw());
    } else if (!on && frets) {
      frets.canvas.parentElement?.remove();
      frets = null;
    }
  }

  // The keyboard strip under the score (page and line layouts), lit as notes sound.
  let kbd: Keyboard | null = null;
  function showKeyboard(on: boolean): void {
    if (on && !kbd) {
      kbd = new Keyboard();
      const wrap = document.createElement("div");
      wrap.className = "sv-kbd";
      wrap.append(kbd.canvas);
      shell.insertBefore(wrap, bar.el);
      const tl = getShownTimeline();
      let lo = 127;
      let hi = 0;
      for (const e of tl.events) {
        lo = Math.min(lo, e.midi);
        hi = Math.max(hi, e.midi);
      }
      requestAnimationFrame(() => kbd?.setRange(lo, hi));
    } else if (!on && kbd) {
      kbd.canvas.parentElement?.remove();
      kbd = null;
    }
  }

  // Playback: the timeline is built on the first play; the view shows where it is. Scrolling
  // by hand pauses the view's following for a moment.
  let player: Player | null = null;
  let followPaused = 0;
  function ensurePlayer(): Player {
    if (player) return player;
    const tl = getTimeline();
    player = new Player(tl, {
      sounds: opts.sounds,
      onPosition: (p) => {
        const span = tl.spans[p.span];
        if (falls) falls.showTime(p.time);
        else if (span) view.showPosition(span.measure, p.quarter, span.quarters, performance.now() > followPaused);
      },
      onNotes: (all, on) => {
        const evs = shownParts ? all.filter(visible) : all;
        if (!evs.length) return;
        view.highlight(evs.map((e) => noteKey(e.measure, e.onset)), on);
        if (frets) {
          for (const e of evs) {
            const at = position(e, tuning);
            if (at) frets.set(`${e.part}:${e.midi}`, on ? { ...at, color: color(e) } : null);
          }
          frets.draw();
        }
        if (kbd) {
          const k = kbd;
          // A key struck again flashes lighter for a moment, then takes its colour.
          for (const e of evs) k.setLit(e.midi, on ? flash(color(e)) : null);
          k.draw();
          if (on)
            setTimeout(() => {
              for (const e of evs) if (k.isLit(e.midi)) k.setLit(e.midi, color(e));
              k.draw();
            }, 90);
        }
      },
      onStateChange: (on) => bar.setPlaying(on),
      onSeek: (t) => {
        if (!matcher || !player) return;
        matcher.seek(t);
        player.setGate(matcher.current?.time ?? null);
        refreshMarks();
      },
    });
    player.setSpeed(speed);
    applyPractice(player);
    return player;
  }

  // Practice with a MIDI instrument. Wait mode: playback holds before each group of the
  // practised notes (the parts shown, or a hand) until they are struck; the rest accompanies.
  let practice: PracticeState = { mode: opts.practice?.mode ?? "off", hand: opts.practice?.hand ?? "both", echo: opts.practice?.echo ?? false };
  let midiIn: MidiInput | null = null;
  let unsubscribe: (() => void) | null = null;
  let matcher: WaitMatcher | null = null;
  // Keys down on the instrument, with their colour: right or wrong when struck.
  const pressed = new Map<number, string>();
  let litKeys: string[] = [];
  const practising = () => practice.mode === "wait" && !!midiIn;
  const target = () => ({ parts: shownParts, hand: practice.hand });
  const multiStaff = (p: number) => Number(score.measures[p]?.[0]?.getElementsByTagName("staves")[0]?.textContent) > 1 || score.attributesAt(p, Math.min(1, score.measureCount - 1)).some((a) => a.tagName === "staves" && Number(a.textContent) > 1);
  function syncPracticeBar(): void {
    const hands = (shownParts ?? score.parts.map((_, i) => i)).some(multiStaff);
    bar.setPractice(!!midiIn, hands, practice);
  }
  function applyPractice(p: Player): void {
    if (!practising()) {
      matcher = null;
      p.setSkip(null);
      p.setGate(null);
      refreshMarks();
      return;
    }
    const tl = getTimeline();
    matcher ??= new WaitMatcher(practiceGroups(tl, target()));
    p.setSkip(practisedBy(tl, target()));
    matcher.seek(p.time);
    p.setGate(matcher.current?.time ?? null);
    refreshMarks();
  }
  // The practised notes or settings changed: wait mode starts again from where playback is.
  function resetPractice(): void {
    matcher = null;
    if (player || practising()) applyPractice(ensurePlayer());
    else refreshMarks();
    syncPracticeBar();
  }
  function setPractice(p: Partial<PracticeState>): void {
    practice = { ...practice, ...p };
    resetPractice();
    opts.practice?.onChange?.({ ...practice });
  }
  function setMidiInput(input: MidiInput | null): void {
    unsubscribe?.();
    unsubscribe = null;
    midiIn = input;
    pressed.clear();
    if (input) unsubscribe = input.subscribe(onMidi);
    resetPractice();
  }
  // Expected keys outlined, keys held filled; in the score, the notes waited for lit.
  function refreshMarks(): void {
    const m = practising() ? matcher : null;
    const expected = m?.current?.pitches ?? [];
    for (const k of [kbd, falls?.keyboard]) {
      if (!k) continue;
      k.setPractice(expected, pressed);
      k.draw();
    }
    const keys = m?.current ? [...new Set(m.current.events.filter(visible).map((e) => noteKey(e.measure, e.onset)))] : [];
    if (keys.join() === litKeys.join()) return;
    view.highlight(litKeys, false);
    view.highlight(keys, true);
    litKeys = keys;
  }
  function onMidi(msg: MidiMessage): void {
    const n = parseNote(msg.data);
    if (!n) return;
    const w = practising() ? matcher : null;
    if (n.on) pressed.set(n.pitch, !w ? flash(PRESSED_RIGHT, 0.3) : w.expects(n.pitch) ? PRESSED_RIGHT : PRESSED_WRONG);
    else pressed.delete(n.pitch);
    // Keys count only while playing: a paused score does not move on.
    const m = player?.isPlaying ? w : null;
    if (practice.echo) echo(n.pitch, n.on ? n.velocity : 0);
    if (m && n.on && m.noteOn(n.pitch)) player!.setGate(m.current?.time ?? null);
    else if (m && !n.on) m.noteOff(n.pitch);
    refreshMarks();
  }
  // The key sounds with the practised part's instrument.
  function echo(pitch: number, velocity: number): void {
    const p = ensurePlayer();
    const tl = getTimeline();
    const mine = practisedBy(tl, target());
    const e = tl.events.find(mine) ?? tl.events[0];
    p.live(e && e.channel !== 9 ? e.channel : 0, e && e.channel !== 9 ? e.program : 0, pitch, velocity);
  }
  function togglePlay(): void {
    ensurePlayer().toggle();
  }
  let speed = 1;
  function setSpeed(v: number): void {
    speed = v;
    player?.setSpeed(v);
  }

  // A tap on the score moves playback there (and plays on if it was playing).
  function bindTap(el: HTMLElement): void {
    let down: { x: number; y: number; t: number; id: number } | null = null;
    el.addEventListener("pointerdown", (e) => {
      down = e.isPrimary ? { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId } : null;
    });
    el.addEventListener("pointerup", (e) => {
      const d = down;
      down = null;
      if (!d || e.pointerId !== d.id || pinching || editingOn) return;
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 8 || performance.now() - d.t > 400) return;
      const hit = view.hit(e.clientX, e.clientY);
      if (!hit) return;
      followPaused = 0;
      ensurePlayer().seekMeasure(hit.measure, hit.quarter);
    });
    const pause = () => (followPaused = performance.now() + 2500);
    el.addEventListener("wheel", pause, { passive: true });
    el.addEventListener("touchmove", pause, { passive: true });
  }

  let falls: ReturnType<typeof createKeysView> | null = null;
  function mount(): void {
    litKeys = [];
    const common = { onError: opts.onError, onZoom: (z: number) => ((shown = z), bar.sync(z)) };
    falls = null;
    if (mode === "keys") {
      falls = createKeysView(score, getShownTimeline, { ...common, zoom: 1 });
      falls.showTime(player?.time ?? 0);
      view = falls;
    } else view = mode === "page" ? createPageView(shownScore, { ...common, zoom: pageZoom, onSystemRendered: opts.onSystemRendered }) : createLineView(shownScore, { ...common, zoom: pageZoom });
    if (kbd) kbd.canvas.parentElement!.hidden = mode === "keys";
    if (frets) frets.canvas.parentElement!.hidden = mode === "keys";
    shown = view.zoom;
    shell.prepend(view.root);
    bar.sync(view.zoom);
    bar.setLayout(mode);
    bindPinch(view.root);
    bindTap(view.root);
    if (editingOn) editing.attach(mode === "page" ? (view as PageView) : null);
    refreshMarks();
  }

  function setScore(next: ScoreDoc): void {
    player?.dispose();
    player = null;
    timeline = null;
    matcher = null;
    bar.setPlaying(false);
    score = next;
    editing.reset();
    color = noteColors(score);
    shownParts = validParts(shownParts, score);
    bar.setParts(score.parts.map((p) => p.name), shownParts);
    remount();
    syncPracticeBar();
  }

  // Shows other parts: playback goes on, the views and strips are built again.
  function setParts(next: number[] | null, fromBar = false): void {
    shownParts = validParts(next, score);
    if (!fromBar) bar.setParts(score.parts.map((p) => p.name), shownParts);
    remount();
    resetPractice();
    opts.parts?.onChange?.(shownParts);
  }

  function remount(): void {
    if (mode === "page") pageZoom = view.zoom;
    view.destroy();
    shownScore = shownParts ? score.only(shownParts) : score;
    shownTimeline = null;
    bar.setFretboard(!!fretTuning(shownScore, timeline ? getShownTimeline().events : []));
    if (kbd) {
      showKeyboard(false);
      showKeyboard(true);
    }
    if (frets) {
      showFretboard(false);
      showFretboard(true);
    }
    mount();
  }

  function setLayout(m: LayoutMode): void {
    if (m === mode) return;
    if (mode === "page") pageZoom = view.zoom;
    view.destroy();
    mode = m;
    mount();
  }

  function previewZoom(z: number, at?: { x: number; y: number }): void {
    shown = clampZoom(z);
    view.preview(shown, at);
    bar.sync(shown);
  }
  function commitZoom(): void {
    clearTimeout(zoomTimer);
    view.commit(shown);
    if (mode === "page") pageZoom = shown;
  }
  function zoomTo(z: number, at?: { x: number; y: number }, delay = 250): void {
    previewZoom(z, at);
    clearTimeout(zoomTimer);
    zoomTimer = window.setTimeout(commitZoom, delay);
  }

  // Two fingers zoom about the point between them.
  function bindPinch(el: HTMLElement): void {
    const dist = (e: TouchEvent) => Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY) || 1;
    let pinch: { dist: number; zoom: number } | null = null;
    el.addEventListener("touchstart", (e) => (pinching = e.touches.length > 1 || pinching), { passive: true });
    el.addEventListener("touchend", (e) => e.touches.length === 0 && setTimeout(() => (pinching = false), 50), { passive: true });
    el.addEventListener("touchstart", (e) => (pinch = e.touches.length === 2 ? { dist: dist(e), zoom: shown } : null), { passive: true });
    el.addEventListener(
      "touchmove",
      (e) => {
        if (!pinch || e.touches.length !== 2) return;
        e.preventDefault();
        clearTimeout(zoomTimer);
        previewZoom(pinch.zoom * (dist(e) / pinch.dist), {
          x: (e.touches[0].clientX + e.touches[1].clientX) / 2,
          y: (e.touches[0].clientY + e.touches[1].clientY) / 2,
        });
      },
      { passive: false },
    );
    const end = (e: TouchEvent) => {
      if (pinch && e.touches.length < 2) {
        pinch = null;
        commitZoom();
      }
    };
    el.addEventListener("touchend", end, { passive: true });
    el.addEventListener("touchcancel", end, { passive: true });
  }

  shell.append(editing.el, bar.el);
  mount();
  setMidiInput(opts.midi ?? null);

  return {
    get score() {
      return score;
    },
    setScore,
    get layout() {
      return mode;
    },
    get systems() {
      return mode === "page" ? (view as PageView).systems : [];
    },
    get layoutParams() {
      return mode === "page" ? (view as PageView).layoutParams : null;
    },
    get line() {
      return mode === "line" ? (view as LineView) : null;
    },
    setLayout,
    get parts() {
      return shownParts;
    },
    pointFor(measure, quarter, part, staff, step) {
      if (mode !== "page") return null;
      const shown = shownParts ? shownParts.indexOf(part) : part;
      return shown < 0 ? null : (view as PageView).pointFor(measure, quarter, shown, staff, step);
    },
    get editing() {
      return editingOn;
    },
    setEditing,
    setParts: (p) => setParts(p),
    togglePlay,
    get player() {
      return player;
    },
    setMidiInput,
    get practice() {
      return { ...practice };
    },
    setPractice: (p) => setPractice(p),
    get practiceStatus() {
      if (!practising() || !matcher) return null;
      return { index: matcher.index, count: matcher.groups.length, expected: matcher.current?.pitches ?? [], missing: matcher.missing, waiting: !!player?.waiting };
    },
    getZoom: () => view.zoom,
    setZoom(z: number) {
      previewZoom(z);
      commitZoom();
    },
    getBarEnd: () => bar.end,
    setReadingMode(on: boolean) {
      shell.classList.toggle("sv-reading", on);
      bar.reading(on);
    },
    relayout: () => view.relayout(),
    destroy() {
      unsubscribe?.();
      player?.dispose();
      kbd = null;
      clearTimeout(zoomTimer);
      view.destroy();
      shell.remove();
    },
  };
}
