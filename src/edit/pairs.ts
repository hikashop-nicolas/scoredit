// Slur (and line) ends paired up the way scoredit reads them.

/** A slur end in a part: when, where, and what it belongs to. */
export interface SlurItem<T> {
  t: number;
  /** Grace notes (their index) before the event's own notes (100). */
  order: number;
  staff: string;
  voice: string;
  end: { type: "start" | "stop"; number: number };
  ref: T;
}

/**
 * Pairs slur ends in time order: a stop closes the latest open start of its number in the
 * same voice, else staff, else part. Starts that never end, and stops without a start, drop.
 */
export function pairEnds<T>(items: SlurItem<T>[]): [T, T][] {
  const sorted = [...items].sort((a, b) => a.t - b.t || a.order - b.order || (a.end.type === "stop" ? -1 : 1) - (b.end.type === "stop" ? -1 : 1));
  const open: SlurItem<T>[] = [];
  const pairs: [T, T][] = [];
  const close = (e: SlurItem<T>): boolean => {
    let i = -1;
    for (let level = 0; level < 3 && i < 0; level++)
      for (let k = open.length - 1; k >= 0 && i < 0; k--) {
        const o = open[k];
        if (o.end.number === e.end.number && (level > 1 || o.staff === e.staff) && (level > 0 || o.voice === e.voice)) i = k;
      }
    if (i < 0) return false;
    pairs.push([open[i].ref, e.ref]);
    open.splice(i, 1);
    return true;
  };
  // A stop closes what was open before; one left over may close a start on the same note
  // (a trill line on a single note).
  let waiting: SlurItem<T>[] = [];
  let at = NaN;
  const flush = () => {
    for (const w of waiting) close(w);
    waiting = [];
  };
  for (const e of sorted) {
    if (e.t !== at || e.order !== 100) flush();
    at = e.t;
    if (e.end.type === "start") open.push(e);
    else if (!close(e) && e.order === 100) waiting.push(e);
  }
  flush();
  return pairs;
}
