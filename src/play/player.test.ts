import { followStart, heldUntil, pedalSpans, positionAt } from "./player";
import { heardWhen } from "./practice";

describe("pedal", () => {
  const spans = pedalSpans([
    { time: 1, channel: 0, cc: 64, value: 127 },
    { time: 3, channel: 0, cc: 64, value: 0 },
    { time: 5, channel: 1, cc: 64, value: 127 },
  ]);
  it("holds a note released under the pedal until the pedal comes up", () => {
    expect(heldUntil(spans, 0, 2)).toBe(3);
    expect(heldUntil(spans, 0, 0.5)).toBe(0.5);
    expect(heldUntil(spans, 0, 3)).toBe(3);
    expect(heldUntil(spans, 2, 2)).toBe(2);
  });
  it("lets a pedal never released ring a few seconds", () => {
    expect(heldUntil(spans, 1, 6)).toBe(10);
  });
});

describe("cursor", () => {
  it("waits at a pause inside the bar", () => {
    const spans = [{ measure: 0, start: 0, end: 3, quarters: 4, tempo: [[0, 0.5]] as [number, number][], pauses: [[2, 1]] as [number, number][] }];
    expect(positionAt(spans, 1).quarter).toBeCloseTo(2);
    expect(positionAt(spans, 1.5).quarter).toBeCloseTo(2);
    expect(positionAt(spans, 2.25).quarter).toBeCloseTo(2.5);
  });
});

describe("following another device", () => {
  const clock = { audio: 10, perf: 5000 };
  it("starts so the piece time is heard at the moment given", () => {
    const { start, offset } = followStart(4, 6000, clock, 1, 0.02);
    expect(offset).toBe(4);
    // The leader's own heardWhen of that start gives the moment back.
    expect(heardWhen(4, clock, start, 1, 0.02)).toBeCloseTo(6000);
  });
  it("joins a playback already under way where it is by now", () => {
    const { start, offset } = followStart(4, 3000, clock, 2, 0);
    // Two seconds ago at double speed, plus the 50 ms lead: 4 + 2 * 2.05.
    expect(offset).toBeCloseTo(8.1);
    expect((clock.audio + 0.05 - start) * 2).toBeCloseTo(offset);
  });
});
