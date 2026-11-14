// MIDI input and output that the host supplies: scoredit never asks for device access
// itself. webMidiInput() turns a Web MIDI access the host obtained into a MidiInput.

/** One MIDI message: its bytes, when it came (performance.now() ms) and from which port. */
export interface MidiMessage {
  data: Uint8Array;
  time: number;
  source: string;
}

/** Where incoming MIDI comes from; subscribe returns the function that stops listening. */
export interface MidiInput {
  subscribe(cb: (msg: MidiMessage) => void): () => void;
}

/** Where MIDI can be sent (time in performance.now() ms, now when left out). */
export interface MidiOutput {
  send(data: Uint8Array | number[], time?: number): void;
}

/** A note pressed (on) or released, from a message; null for anything else. */
export function parseNote(data: Uint8Array | number[]): { pitch: number; velocity: number; on: boolean; channel: number } | null {
  if (data.length < 3) return null;
  const type = data[0] & 0xf0;
  if (type !== 0x90 && type !== 0x80) return null;
  const on = type === 0x90 && data[2] > 0;
  return { pitch: data[1] & 0x7f, velocity: data[2] & 0x7f, on, channel: data[0] & 0x0f };
}

/** A control change (CC64 is the sustain pedal), from a message; null for anything else. */
export function parseControl(data: Uint8Array | number[]): { controller: number; value: number; channel: number } | null {
  if (data.length < 3 || (data[0] & 0xf0) !== 0xb0) return null;
  return { controller: data[1] & 0x7f, value: data[2] & 0x7f, channel: data[0] & 0x0f };
}

/**
 * Groups keys struck together into chords for step entry: a key struck within `windowMs` of
 * the first key of a group joins it; the group is handed over `windowMs` after its first key.
 */
export class ChordGrouper {
  private pitches: number[] = [];
  private start = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(
    private emit: (pitches: number[]) => void,
    readonly windowMs = 60,
  ) {}
  /** A key struck at `time` (ms, as MIDI messages carry it). */
  noteOn(pitch: number, time: number): void {
    if (this.pitches.length && time - this.start > this.windowMs) this.flush();
    if (!this.pitches.length) {
      this.start = time;
      this.timer = setTimeout(() => this.flush(), this.windowMs);
    }
    if (!this.pitches.includes(pitch)) this.pitches.push(pitch);
  }
  /** Hands over the group now (lowest key first); nothing when there is none. */
  flush(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const p = this.pitches.sort((a, b) => a - b);
    this.pitches = [];
    if (p.length) this.emit(p);
  }
  /** Forgets a group not handed over yet. */
  cancel(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.pitches = [];
  }
}

/**
 * A filter that drops a message identical to one from another port within `windowMs` of its time,
 * as when a device shows up as two ports and every message arrives twice. Returns true to keep it.
 */
export function midiDeduper(windowMs = 2): (msg: MidiMessage) => boolean {
  // Twin ports can deliver in bursts and out of order, so recent messages are kept by count, not by time.
  const recent: { key: string; time: number; source?: string }[] = [];
  return (msg) => {
    const key = Array.from(msg.data).join(",");
    if (recent.some((r) => r.key === key && r.source !== msg.source && Math.abs(msg.time - r.time) <= windowMs)) return false;
    recent.push({ key, time: msg.time, source: msg.source });
    if (recent.length > 64) recent.shift();
    return true;
  };
}

/** The parts of a Web MIDI access this module uses (MIDIAccess has them). */
export interface MidiAccessLike {
  inputs: { forEach(cb: (input: MidiPortLike) => void): void };
  addEventListener(type: "statechange", cb: (e: Event) => void): void;
  removeEventListener(type: "statechange", cb: (e: Event) => void): void;
}
export interface MidiPortLike {
  id: string;
  state?: string;
  addEventListener(type: "midimessage", cb: (e: Event) => void): void;
  removeEventListener(type: "midimessage", cb: (e: Event) => void): void;
}

/**
 * Every input of a Web MIDI access as one MidiInput: twin ports of one device merged (their
 * doubled messages dropped), devices plugged in later followed.
 */
export function webMidiInput(access: MidiAccessLike, opts: { windowMs?: number } = {}): MidiInput {
  return {
    subscribe(cb) {
      const keep = midiDeduper(opts.windowMs ?? 2);
      const attached = new Map<string, [MidiPortLike, (e: Event) => void]>();
      const attach = (port: MidiPortLike) => {
        if (attached.has(port.id) || port.state === "disconnected") return;
        const on = (e: Event) => {
          const m = e as Event & { data?: Uint8Array | null };
          if (!m.data?.length) return;
          const msg = { data: m.data, time: e.timeStamp || performance.now(), source: port.id };
          if (keep(msg)) cb(msg);
        };
        port.addEventListener("midimessage", on);
        attached.set(port.id, [port, on]);
      };
      const detach = (id: string) => {
        const a = attached.get(id);
        if (!a) return;
        a[0].removeEventListener("midimessage", a[1]);
        attached.delete(id);
      };
      // A port plugged in or out; inputs are listed again so a re-plugged one is found.
      const changed = (e: Event) => {
        const port = (e as Event & { port?: MidiPortLike & { type?: string } }).port;
        if (port && port.state === "disconnected") detach(port.id);
        access.inputs.forEach(attach);
      };
      access.inputs.forEach(attach);
      access.addEventListener("statechange", changed);
      return () => {
        access.removeEventListener("statechange", changed);
        for (const id of [...attached.keys()]) detach(id);
      };
    },
  };
}
