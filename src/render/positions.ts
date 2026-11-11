import type { OpenSheetMusicDisplay } from "opensheetmusicdisplay";

/** Where the beats and notes of one OSMD render are, for a playback cursor and highlights. */
export interface Positions {
  /** Per score measure: [quarter onset, x px] sorted by onset, and the measure's left and right edges. */
  beats: Map<number, { onsets: [number, number][]; left: number; right: number }>;
  /** Drawn note groups by `${measure}|${onset}`. */
  notes: Map<string, SVGGElement[]>;
  /** Top of the first staff and bottom of the last, px. */
  top: number;
  bottom: number;
}

export const noteKey = (measure: number, onset: number) => `${measure}|${Math.round(onset * 960)}`;

// Reads positions out of a rendered OSMD slice whose first measure is score measure `first`;
// x is in px from the left of the render, less `crop`.
export function collectPositions(osmd: OpenSheetMusicDisplay, first: number, zoom: number, crop = 0): Positions {
  const u = 10 * zoom;
  const beats: Positions["beats"] = new Map();
  const notes: Positions["notes"] = new Map();
  let top = Infinity;
  let bottom = -Infinity;
  osmd.GraphicSheet.MeasureList.forEach((staves, k) => {
    const m = first + k;
    const seen = new Map<number, number>();
    let left = Infinity;
    let right = -Infinity;
    for (const gm of staves) {
      if (!gm) continue;
      const x0 = gm.PositionAndShape.AbsolutePosition.x;
      const y = gm.ParentStaffLine?.PositionAndShape.AbsolutePosition.y;
      if (y !== undefined) {
        top = Math.min(top, y * u);
        bottom = Math.max(bottom, (y + 4) * u);
      }
      left = Math.min(left, (x0 + gm.beginInstructionsWidth) * u - crop);
      right = Math.max(right, (x0 + gm.PositionAndShape.Size.width) * u - crop);
      for (const se of gm.staffEntries) {
        const q = se.relInMeasureTimestamp.RealValue * 4;
        const x = se.PositionAndShape.AbsolutePosition.x * u - crop;
        const key = Math.round(q * 960);
        if (!seen.has(key) || x < seen.get(key)!) seen.set(key, x);
        for (const ve of se.graphicalVoiceEntries) {
          for (const gn of ve.notes) {
            const g = (gn as unknown as { getSVGGElement?(): SVGGElement }).getSVGGElement?.();
            if (!g) continue;
            const nk = noteKey(m, q);
            const list = notes.get(nk);
            if (list) list.push(g);
            else notes.set(nk, [g]);
          }
        }
      }
    }
    const onsets = [...seen.entries()].map(([k, x]) => [k / 960, x] as [number, number]).sort((a, b) => a[0] - b[0]);
    if (Number.isFinite(left)) beats.set(m, { onsets, left, right });
  });
  return { beats, notes, top: Number.isFinite(top) ? top : 0, bottom: Number.isFinite(bottom) ? bottom : 0 };
}

/** x of quarter offset q in measure m (px in the render's frame), or null if not in it. */
export function xAt(pos: Positions, m: number, q: number, quarters: number): number | null {
  const b = pos.beats.get(m);
  if (!b) return null;
  const pts = b.onsets.length ? b.onsets : [[0, b.left] as [number, number]];
  if (q <= pts[0][0]) return pts[0][1];
  for (let i = 0; i + 1 < pts.length; i++) {
    const [q0, x0] = pts[i];
    const [q1, x1] = pts[i + 1];
    if (q < q1) return x0 + ((x1 - x0) * (q - q0)) / (q1 - q0 || 1);
  }
  const [ql, xl] = pts[pts.length - 1];
  const end = Math.max(xl, b.right - 6);
  return xl + ((end - xl) * (q - ql)) / Math.max(1e-6, quarters - ql);
}
