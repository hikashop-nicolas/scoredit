// Box helpers from oemer's bbox.py and general_filtering_rules.py.
import type { Box } from "./ndimage";
import { sortedBy } from "./py";
import { uniqueSet, wardLabels } from "./sci";
import { center, type Staffs } from "./staff";

/** Merges boxes whose centres cluster under ward linkage (sklearn AgglomerativeClustering). */
export function mergeNearby(boxes: Box[], distance: number, xf = 1, yf = 1): Box[] {
  if (boxes.length < 2) return boxes.slice();
  const labels = wardLabels(
    boxes.map((b) => [((b[0] + b[2]) / 2) * xf, ((b[1] + b[3]) / 2) * yf]),
    distance,
  );
  const out: Box[] = [];
  for (const l of [...new Set(labels)].sort((a, b) => a - b)) {
    const ids = labels.flatMap((v, i) => (v === l ? [i] : []));
    out.push([
      Math.min(...ids.map((i) => boxes[i][0])),
      Math.min(...ids.map((i) => boxes[i][1])),
      Math.max(...ids.map((i) => boxes[i][2])),
      Math.max(...ids.map((i) => boxes[i][3])),
    ]);
  }
  return out;
}

/** rm_merge_overlap_bbox: larger boxes first; a box mostly covered by a kept one is dropped (or merged into it). */
export function rmMergeOverlap(boxes: Box[], mode: "remove" | "merge" = "remove", ratioTh = 0.5): Box[] {
  if (!boxes.length) return [];
  const maxX = Math.max(...boxes.map((b) => b[2]));
  const maxY = Math.max(...boxes.map((b) => b[3]));
  const mask = new Uint16Array(maxX * maxY);
  const info = sortedBy(
    boxes.map((b) => ({ bbox: b.slice() as Box, area: (b[3] - b[1]) * (b[2] - b[0]) })),
    (i) => i.area,
    true,
  );
  const records = new Map<number, { bbox: Box; area: number }>();
  info.forEach((bi, idx) => {
    const b = bi.bbox;
    const y0 = Math.max(0, b[1]);
    const x0 = Math.max(0, b[0]);
    const vals = new Map<number, number>();
    for (let y = y0; y < b[3]; y++) for (let x = x0; x < b[2]; x++) {
      const v = mask[y * maxX + x];
      vals.set(v, (vals.get(v) ?? 0) + 1);
    }
    let valid = true;
    for (const v of uniqueSet(vals.keys(), 0)) {
      const tar = records.get(v)!;
      if (vals.get(v)! / bi.area > ratioTh) {
        if (mode === "merge") {
          const t = tar.bbox;
          tar.bbox = [Math.min(b[0], t[0]), Math.min(b[1], t[1]), Math.max(b[2], t[2]), Math.max(b[3], t[3])];
        }
        valid = false;
        break;
      }
    }
    if (valid) {
      records.set(idx + 1, bi);
      for (let y = y0; y < b[3]; y++) for (let x = x0; x < b[2]; x++) mask[y * maxX + x] = idx + 1;
    }
  });
  return [...records.values()].map((r) => r.bbox);
}

export function filterOutOfRange(boxes: Box[], S: Staffs): Box[] {
  return boxes.filter((b) => {
    const cx = center(b)[0];
    return !(cx > S.maxX || cx < S.minX);
  });
}

export function filterSmallArea(boxes: Box[], S: Staffs, f: (unit: number) => number): Box[] {
  return boxes.filter((b) => (b[2] - b[0]) * (b[3] - b[1]) > f(S.unitSize(...center(b))));
}
