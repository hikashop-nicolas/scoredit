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

/**
 * A filter that drops a message identical to one seen within `windowMs` before it, as when a
 * device shows up as two ports and every message arrives twice. Returns true to keep it.
 */
export function midiDeduper(windowMs = 2): (msg: MidiMessage) => boolean {
  const recent: { key: string; time: number }[] = [];
  return (msg) => {
    const key = Array.from(msg.data).join(",");
    while (recent.length && msg.time - recent[0].time > windowMs) recent.shift();
    if (recent.some((r) => r.key === key && Math.abs(msg.time - r.time) <= windowMs)) return false;
    recent.push({ key, time: msg.time });
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
