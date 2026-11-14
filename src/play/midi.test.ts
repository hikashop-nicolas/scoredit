import { describe, expect, it } from "vitest";
import { midiDeduper, parseNote, webMidiInput, type MidiMessage, type MidiPortLike } from "./midi";

const msg = (data: number[], time: number, source = "a"): MidiMessage => ({ data: new Uint8Array(data), time, source });

describe("parseNote", () => {
  it("reads note-on, note-off and note-on at velocity 0", () => {
    expect(parseNote([0x91, 60, 100])).toEqual({ pitch: 60, velocity: 100, on: true, channel: 1 });
    expect(parseNote([0x80, 60, 40])).toMatchObject({ pitch: 60, on: false });
    expect(parseNote([0x90, 60, 0])).toMatchObject({ pitch: 60, on: false });
    expect(parseNote([0xb0, 64, 127])).toBeNull();
    expect(parseNote([0xf8])).toBeNull();
  });
});

describe("midiDeduper", () => {
  it("drops the twin of a message from another port within the window", () => {
    const keep = midiDeduper(2);
    expect(keep(msg([0x90, 60, 100], 10, "a"))).toBe(true);
    expect(keep(msg([0x90, 60, 100], 10.5, "b"))).toBe(false);
    expect(keep(msg([0x90, 64, 100], 10.6, "b"))).toBe(true);
    expect(keep(msg([0x80, 60, 0], 11, "a"))).toBe(true);
    expect(keep(msg([0x80, 60, 0], 11, "b"))).toBe(false);
  });

  it("keeps the same message played again later", () => {
    const keep = midiDeduper(2);
    expect(keep(msg([0x90, 60, 100], 10))).toBe(true);
    expect(keep(msg([0x90, 60, 100], 15))).toBe(true);
    expect(keep(msg([0x90, 60, 100], 15.5, "b"))).toBe(false);
  });
});

// A Web MIDI access with ports that can be plugged in and fed messages.
class FakePort extends EventTarget implements MidiPortLike {
  state = "connected";
  constructor(readonly id: string) {
    super();
  }
  feed(data: number[]) {
    const e = new Event("midimessage") as Event & { data: Uint8Array };
    e.data = new Uint8Array(data);
    this.dispatchEvent(e);
  }
}
class FakeAccess extends EventTarget {
  ports = new Map<string, FakePort>();
  inputs = { forEach: (cb: (p: FakePort) => void) => this.ports.forEach((p) => cb(p)) };
  plug(p: FakePort) {
    this.ports.set(p.id, p);
    const e = new Event("statechange") as Event & { port: FakePort };
    e.port = p;
    this.dispatchEvent(e);
  }
  unplug(id: string) {
    const p = this.ports.get(id)!;
    p.state = "disconnected";
    this.ports.delete(id);
    const e = new Event("statechange") as Event & { port: FakePort };
    e.port = p;
    this.dispatchEvent(e);
  }
}

describe("webMidiInput", () => {
  it("merges twin ports, follows hotplug, and stops on unsubscribe", () => {
    const access = new FakeAccess();
    const a = new FakePort("a");
    const b = new FakePort("b");
    access.ports.set("a", a);
    access.ports.set("b", b);
    const got: string[] = [];
    const stop = webMidiInput(access).subscribe((m) => got.push(`${m.source}:${[...m.data].join(" ")}`));
    a.feed([0x90, 60, 100]);
    b.feed([0x90, 60, 100]);
    expect(got).toEqual(["a:144 60 100"]);
    const c = new FakePort("c");
    access.plug(c);
    c.feed([0x90, 62, 90]);
    expect(got).toContain("c:144 62 90");
    access.unplug("c");
    c.feed([0x90, 64, 90]);
    expect(got.some((g) => g.includes("64"))).toBe(false);
    stop();
    a.feed([0x80, 60, 0]);
    expect(got).toHaveLength(2);
  });
});
