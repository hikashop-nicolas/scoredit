import { heldUntil, pedalSpans } from "./player";

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
