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
  /** Each staff drawn: its part (in the rendered score) and staff number, top and bottom line, px. */
  staves: { part: number; staff: number; top: number; bottom: number; lines: number }[];
  /** Each note head drawn, for picking: its voice and beat, and its rank in its chord from the lowest. */
  drawn: { g: SVGGElement; part: number; staff: number; voice: string; measure: number; onset: number; rank: number; x: number; y: number }[];
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
  const staves: Positions["staves"] = [];
  const drawn: Positions["drawn"] = [];
  const instruments = osmd.Sheet.Instruments;
  const staffOf = (st: { ParentInstrument: unknown }) => {
    const ins = st.ParentInstrument as (typeof instruments)[number];
    return { part: instruments.indexOf(ins), staff: ins.Staves.indexOf(st as never) + 1 };
  };
  for (const sl of osmd.GraphicSheet.MusicPages[0]?.MusicSystems[0]?.StaffLines ?? []) {
    const y = sl.PositionAndShape.AbsolutePosition.y * u;
    const lines = sl.ParentStaff.StafflineCount || 5;
    staves.push({ ...staffOf(sl.ParentStaff), top: y, bottom: y + (lines - 1) * u, lines });
  }
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
          const where = gm.ParentStaff ? staffOf(gm.ParentStaff) : { part: 0, staff: 1 };
          const voice = String(ve.parentVoiceEntry?.ParentVoice?.VoiceId ?? 1);
          const byPitch = [...ve.notes].sort((a, b) => (a.sourceNote.halfTone ?? 0) - (b.sourceNote.halfTone ?? 0));
          for (const gn of ve.notes) {
            const g = (gn as unknown as { getSVGGElement?(): SVGGElement }).getSVGGElement?.();
            if (!g) continue;
            if (!gn.sourceNote.isRest())
              drawn.push({ g, ...where, voice, measure: m, onset: q, rank: byPitch.indexOf(gn), x: gn.PositionAndShape.AbsolutePosition.x * u - crop, y: gn.PositionAndShape.AbsolutePosition.y * u });
            else drawn.push({ g, ...where, voice, measure: m, onset: q, rank: -1, x: gn.PositionAndShape.AbsolutePosition.x * u - crop, y: gn.PositionAndShape.AbsolutePosition.y * u });
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
  return { beats, notes, top: Number.isFinite(top) ? top : 0, bottom: Number.isFinite(bottom) ? bottom : 0, staves, drawn };
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

/** The measure and quarter under x (px in the render's frame), or null. */
export function hitAt(pos: Positions, x: number): { measure: number; quarter: number } | null {
  for (const [m, b] of pos.beats) {
    // The first note can stand left of where the bar's clef and signatures end.
    const left = Math.min(b.left, (b.onsets[0]?.[1] ?? b.left) - 6);
    if (x < left - 4 || x >= b.right) continue;
    let q = 0;
    for (const [oq, ox] of b.onsets) if (ox <= x + 6) q = oq;
    return { measure: m, quarter: q };
  }
  return null;
}
