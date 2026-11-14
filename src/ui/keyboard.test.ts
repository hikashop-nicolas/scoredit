import { describe, expect, it } from "vitest";
import { layoutKeys, noteLane, shade } from "./keyboard";

// C4 to B4 over 700 px: white keys 100 px wide.
const keys = layoutKeys(60, 71, 700);

describe("keyboard layout", () => {
  it("puts each black key across the line between its white neighbours", () => {
    for (const m of [61, 63, 66, 68, 70]) {
      const k = keys.get(m)!;
      const left = keys.get(m - 1)!;
      expect(k.black).toBe(true);
      expect(k.x).toBeGreaterThan(left.x);
      expect(k.x + k.w).toBeLessThan(left.x + 2 * left.w);
      expect(k.x).toBeLessThan(left.x + left.w);
      expect(k.x + k.w).toBeGreaterThan(left.x + left.w);
    }
  });

  it("leans the black keys of each group towards its middle", () => {
    const centre = (m: number) => keys.get(m)!.x + keys.get(m)!.w / 2;
    expect(centre(61)).toBeLessThan(100);
    expect(centre(63)).toBeGreaterThan(200);
    expect(centre(66)).toBeLessThan(400);
    expect(centre(68)).toBeCloseTo(500);
    expect(centre(70)).toBeGreaterThan(600);
  });

  it("runs white notes the whole key wide and black notes narrower, over them", () => {
    const d = noteLane(keys, 62)!;
    expect(d.x).toBeLessThan(102);
    expect(d.w).toBeGreaterThan(96);
    const cs = noteLane(keys, 61)!;
    const k = keys.get(61)!;
    expect(cs.w).toBeLessThan(k.w);
    expect(cs.w).toBeLessThan(d.w / 1.5);
    expect(cs.x + cs.w / 2).toBeCloseTo(k.x + k.w / 2);
    expect(noteLane(keys, 20)).toBeNull();
  });

  it("shades hex and rgb colours towards white or black", () => {
    expect(shade("#000000", 0.5)).toBe("rgb(128,128,128)");
    expect(shade("rgb(200, 100, 0)", -0.5)).toBe("rgb(100,50,0)");
  });
});
