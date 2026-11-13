// oemer's SVM symbol classifiers (sklearn SVC, RBF kernel), evaluated as libsvm does:
// one-against-one votes. The weights come from a JSON export of the pickled models.
import { resizeBicubic } from "./resample";

export interface SvmJson {
  w: number;
  h: number;
  classes: string[];
  gamma: number;
  nSV: number[];
  rho: number[];
  coef: string; // base64 float64, (classes - 1) x total SV
  sv: string; // base64 uint8, total SV x (w * h)
}

export type ClassifiersJson = Record<"clef" | "rests" | "rests_above8" | "sfn", SvmJson>;

function b64(s: string): Uint8Array {
  if (typeof atob === "function") return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  return new Uint8Array((globalThis as unknown as { Buffer: { from(s: string, e: string): Uint8Array } }).Buffer.from(s, "base64"));
}

export class Svm {
  readonly w: number;
  readonly h: number;
  private sv: Uint8Array;
  private coef: Float64Array;
  private starts: number[];
  constructor(private m: SvmJson) {
    this.w = m.w;
    this.h = m.h;
    this.sv = b64(m.sv);
    const c = b64(m.coef);
    this.coef = new Float64Array(c.buffer, c.byteOffset, c.byteLength / 8).slice();
    this.starts = [];
    let s = 0;
    for (const n of m.nSV) {
      this.starts.push(s);
      s += n;
    }
  }

  /** Class name for a grey region (0..255 values), resized like oemer does. */
  predict(region: Uint8Array, rw: number, rh: number): string {
    const x = resizeBicubic(region, rw, rh, 1, this.w, this.h);
    const dim = this.w * this.h;
    const total = this.sv.length / dim;
    const k = new Float64Array(total);
    for (let i = 0; i < total; i++) {
      let s = 0;
      const o = i * dim;
      for (let j = 0; j < dim; j++) {
        const d = x[j] - this.sv[o + j];
        s += d * d;
      }
      k[i] = Math.exp(-this.m.gamma * s);
    }
    const nc = this.m.nSV.length;
    const vote = new Array<number>(nc).fill(0);
    let p = 0;
    for (let i = 0; i < nc; i++)
      for (let j = i + 1; j < nc; j++) {
        let s = 0;
        const si = this.starts[i];
        const sj = this.starts[j];
        for (let q = 0; q < this.m.nSV[i]; q++) s += this.coef[(j - 1) * total + si + q] * k[si + q];
        for (let q = 0; q < this.m.nSV[j]; q++) s += this.coef[i * total + sj + q] * k[sj + q];
        s -= this.m.rho[p++];
        vote[s > 0 ? i : j]++;
      }
    let best = 0;
    for (let i = 1; i < nc; i++) if (vote[i] > vote[best]) best = i;
    return this.m.classes[best];
  }
}

export type Classifiers = Record<keyof ClassifiersJson, Svm>;

export function classifiers(json: ClassifiersJson): Classifiers {
  return { clef: new Svm(json.clef), rests: new Svm(json.rests), rests_above8: new Svm(json.rests_above8), sfn: new Svm(json.sfn) };
}

/** oemer's predict(): scales a 0/1 region to 0/255 (in place, as oemer does), then classifies. */
export function predictRegion(cls: Svm, region: Float32Array, w: number, h: number): string {
  let max = -Infinity;
  for (const v of region) if (v > max) max = v;
  if (max === 1) for (let i = 0; i < region.length; i++) region[i] *= 255;
  const u = new Uint8Array(region.length);
  for (let i = 0; i < u.length; i++) u[i] = Math.trunc(region[i]) & 255;
  return cls.predict(u, w, h);
}
