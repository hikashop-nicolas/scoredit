import type { SystemRange } from "../layout/systems";

/**
 * Cuts each system holding more measures than its start measure is capped at, and breaks
 * the rest again from the cut with `breakFrom` (which returns systems from that measure on).
 */
export function capSystems(systems: SystemRange[], caps: ReadonlyMap<number, number>, breakFrom: (m: number) => SystemRange[]): SystemRange[] {
  let out = systems;
  for (let k = 0; k < out.length; k++) {
    const { start, end } = out[k];
    const cap = caps.get(start);
    if (cap === undefined || end - start <= Math.max(1, cap)) continue;
    const cut = start + Math.max(1, cap);
    out = [...out.slice(0, k), { start, end: cut }, ...breakFrom(cut)];
  }
  return out;
}
