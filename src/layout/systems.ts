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
  return out;
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
