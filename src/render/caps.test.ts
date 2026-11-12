import { describe, expect, it } from "vitest";
import { breakSystems } from "../layout/systems";
import { capSystems } from "./caps";

const weights = Array.from({ length: 12 }, () => 4);
const opts = { width: 62, measureBase: 5, perWeight: 2, systemStart: 9 };
const from = (m: number) => breakSystems(weights.slice(m), opts).map((r) => ({ start: r.start + m, end: r.end + m }));

describe("capSystems", () => {
  it("leaves systems alone without caps", () => {
    const s = from(0);
    expect(capSystems(s, new Map(), from)).toEqual(s);
  });

  it("cuts a wrapped system and breaks the rest again from the cut", () => {
    // Four measures a line: [0,4) [4,8) [8,12).
    expect(from(0).map((r) => r.end)).toEqual([4, 8, 12]);
    const out = capSystems(from(0), new Map([[4, 3]]), from);
    expect(out).toEqual([
      { start: 0, end: 4 },
      { start: 4, end: 7 },
      { start: 7, end: 11 },
      { start: 11, end: 12 },
    ]);
  });

  it("applies caps met again after a cut, and keeps at least one measure", () => {
    const out = capSystems(from(0), new Map([[0, 0], [1, 2], [3, 1]]), from);
    expect(out.slice(0, 3)).toEqual([
      { start: 0, end: 1 },
      { start: 1, end: 3 },
      { start: 3, end: 4 },
    ]);
    expect(out.at(-1)?.end).toBe(12);
  });
});
