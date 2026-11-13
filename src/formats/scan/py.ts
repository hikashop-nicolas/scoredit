// Python and NumPy semantics the port relies on.

/** Python's round(): halves go to the even neighbour. */
export function pyRound(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/** Python's % on integers (sign of the divisor). */
export function pyMod(a: number, b: number): number {
  const m = a % b;
  return m !== 0 && m < 0 !== b < 0 ? m + b : m;
}

/** Python's int(x) on a float: truncation toward zero. */
export const pyInt = Math.trunc;

/** numpy.mean of a list. */
export function mean(xs: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < xs.length; i++) s += xs[i];
  return s / xs.length;
}

/** numpy.std (population). */
export function std(xs: ArrayLike<number>): number {
  const m = mean(xs);
  let s = 0;
  for (let i = 0; i < xs.length; i++) s += (xs[i] - m) ** 2;
  return Math.sqrt(s / xs.length);
}

/** Stable sort by key, descending when asked (Python's sorted(reverse=True) keeps ties in order). */
export function sortedBy<T>(xs: readonly T[], key: (x: T) => number, reverse = false): T[] {
  const idx = xs.map((x, i) => [key(x), i] as const);
  idx.sort((a, b) => (reverse ? b[0] - a[0] : a[0] - b[0]) || a[1] - b[1]);
  return idx.map(([, i]) => xs[i]);
}

/** Slope of an ordinary least-squares fit y = a*x + b. */
export function slope(xs: ArrayLike<number>, ys: ArrayLike<number>): number {
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  return den === 0 ? 0 : num / den;
}
