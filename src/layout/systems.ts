export interface SystemRange {
  start: number;
  end: number;
}

export interface BreakOptions {
  /** Width available for one system, in the same unit as the weights. */
  width: number;
  /** Width every measure takes whatever its content (barline, padding). */
  measureBase: number;
  /** Width per unit of measure weight (one onset). */
  perWeight: number;
  /** Width the clef/key at a system start take. */
  systemStart: number;
}

// Greedy line breaking: fill each system up to the width, at least one measure per system.
export function breakSystems(weights: number[], o: BreakOptions): SystemRange[] {
  const out: SystemRange[] = [];
  let start = 0;
  let used = o.systemStart;
  for (let m = 0; m < weights.length; m++) {
    const w = o.measureBase + weights[m] * o.perWeight;
    if (m > start && used + w > o.width) {
      out.push({ start, end: m });
      start = m;
      used = o.systemStart;
    }
    used += w;
  }
  if (weights.length) out.push({ start, end: weights.length });
  return balanceLast(weights, out, o);
}

// A short last system takes measures from the one before while that leaves the two
// more even, so the piece does not end on a lone bar stretched across the page.
function balanceLast(weights: number[], out: SystemRange[], o: BreakOptions): SystemRange[] {
  if (out.length < 2) return out;
  const fill = (a: number, b: number) => {
    let used = o.systemStart;
    for (let m = a; m < b; m++) used += o.measureBase + weights[m] * o.perWeight;
    return used / o.width;
  };
  const prev = out[out.length - 2];
  const last = out[out.length - 1];
  if (fill(last.start, last.end) >= 0.5) return out;
  let cut = last.start;
  while (cut - 1 > prev.start && fill(prev.start, cut - 1) >= fill(cut - 1, last.end)) cut--;
  if (cut === last.start) return out;
  return [...out.slice(0, -2), { start: prev.start, end: cut }, { start: cut, end: last.end }];
}

/** Index of the system holding measure m. */
export function systemOf(systems: SystemRange[], m: number): number {
  let lo = 0;
  let hi = systems.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (systems[mid].start <= m) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
