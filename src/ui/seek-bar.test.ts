import { describe, expect, it } from "vitest";
import type { MeasureSpan } from "../play/timeline";
import { clock, measureOfLabel, nearestSpan, spansBetween } from "./seek-bar";

// Measures 0 1 2 1 2 3 (a repeat of 1-2), two seconds each.
const order = [0, 1, 2, 1, 2, 3];
const spans: MeasureSpan[] = order.map((measure, i) => ({ measure, start: i * 2, end: i * 2 + 2, quarters: 4, tempo: [[0, 0.5]] }));

describe("seek bar", () => {
  it("writes times as m:ss", () => {
    expect(clock(0)).toBe("0:00");
    expect(clock(65.9)).toBe("1:05");
    expect(clock(600)).toBe("10:00");
  });

  it("draws a loop over the bars between two times, either way round", () => {
    expect(spansBetween(spans, 2.5, 5.9)).toEqual([1, 2]);
    expect(spansBetween(spans, 5.9, 2.5)).toEqual([1, 2]);
    expect(spansBetween(spans, 0, 99)).toEqual([0, 5]);
  });

  it("snaps a handle to the nearest bar line", () => {
    expect(nearestSpan(spans, 3.2, "start")).toBe(2);
    expect(nearestSpan(spans, 2.8, "start")).toBe(1);
    expect(nearestSpan(spans, 4.9, "end")).toBe(1);
    expect(nearestSpan(spans, 5.9, "end")).toBe(2);
  });

  it("finds a bar by the number the score prints", () => {
    // A pickup (0), then 1 to 3, then a second movement numbered from 1 again.
    const labels = ["0", "1", "2", "3", "1", "2a"];
    expect(measureOfLabel(labels, "0")).toBe(0);
    expect(measureOfLabel(labels, " 2 ")).toBe(2);
    expect(measureOfLabel(labels, "1", 0)).toBe(1);
    expect(measureOfLabel(labels, "1", 5)).toBe(4);
    expect(measureOfLabel(labels, "2A")).toBe(5);
    expect(measureOfLabel(labels, "9")).toBeNull();
    expect(measureOfLabel(labels, "")).toBeNull();
  });
});
