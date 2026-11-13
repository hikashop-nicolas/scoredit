import { breakSystems } from "./systems";

const o = { width: 100, measureBase: 0, perWeight: 1, systemStart: 0 };

describe("breakSystems", () => {
  it("fills systems greedily", () => {
    expect(breakSystems([40, 40, 40, 40, 40, 40], o)).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
      { start: 4, end: 6 },
    ]);
  });

  it("does not end on a lone short bar: the last two systems are evened out", () => {
    // Greedy: [0,4) full, [4,5) at 25%.
    expect(breakSystems([25, 25, 25, 25, 25], o)).toEqual([
      { start: 0, end: 3 },
      { start: 3, end: 5 },
    ]);
  });

  it("leaves a last system at least half full alone", () => {
    expect(breakSystems([30, 30, 30, 60], o)).toEqual([
      { start: 0, end: 3 },
      { start: 3, end: 4 },
    ]);
  });
});
