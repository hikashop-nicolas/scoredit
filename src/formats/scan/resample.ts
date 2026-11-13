// Image resizing that matches Pillow's Image.resize (bicubic, 8-bit fixed point) pixel for
// pixel, so the models see what they saw under oemer.

const PRECISION_BITS = 32 - 8 - 2;

function bicubic(x: number): number {
  const a = -0.5;
  if (x < 0) x = -x;
  if (x < 1) return ((a + 2) * x - (a + 3)) * x * x + 1;
  if (x < 2) return (((x - 5) * x + 8) * x - 4) * a;
  return 0;
}

interface Coeffs {
  bounds: Int32Array; // per output: xmin, xmax (count)
  kk: Int32Array; // ksize per output
  ksize: number;
}

function coeffs(inSize: number, outSize: number): Coeffs {
  const scale = inSize / outSize;
  const filterscale = scale < 1 ? 1 : scale;
  const support = 2 * filterscale;
  const ksize = Math.ceil(support) * 2 + 1;
  const kk = new Int32Array(outSize * ksize);
  const bounds = new Int32Array(outSize * 2);
  const pre = new Float64Array(ksize);
  for (let xx = 0; xx < outSize; xx++) {
    const center = (xx + 0.5) * scale;
    const ss = 1 / filterscale;
    let xmin = Math.trunc(center - support + 0.5);
    if (xmin < 0) xmin = 0;
    let xmax = Math.trunc(center + support + 0.5);
    if (xmax > inSize) xmax = inSize;
    xmax -= xmin;
    let ww = 0;
    for (let x = 0; x < xmax; x++) {
      const w = bicubic((x + xmin - center + 0.5) * ss);
      pre[x] = w;
      ww += w;
    }
    for (let x = 0; x < ksize; x++) {
      const v = x < xmax && ww !== 0 ? pre[x] / ww : 0;
      kk[xx * ksize + x] = v < 0 ? Math.trunc(-0.5 + v * (1 << PRECISION_BITS)) : Math.trunc(0.5 + v * (1 << PRECISION_BITS));
    }
    bounds[xx * 2] = xmin;
    bounds[xx * 2 + 1] = xmax;
  }
  return { bounds, kk, ksize };
}

const clip8 = (v: number) => (v <= 0 ? 0 : v >= 255 ? 255 : v);

// Sums of up to ~20 products of 8-bit values and 22-bit coefficients stay below 2^53.
function pass(src: Uint8Array, w: number, h: number, ch: number, outW: number, outH: number, horizontal: boolean): Uint8Array {
  const c = horizontal ? coeffs(w, outW) : coeffs(h, outH);
  const out = new Uint8Array(outW * outH * ch);
  const half = 1 << (PRECISION_BITS - 1);
  const div = 2 ** PRECISION_BITS;
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const o = horizontal ? x : y;
      const min = c.bounds[o * 2];
      const n = c.bounds[o * 2 + 1];
      const k = o * c.ksize;
      for (let b = 0; b < ch; b++) {
        let ss = half;
        if (horizontal) for (let i = 0; i < n; i++) ss += src[(y * w + min + i) * ch + b] * c.kk[k + i];
        else for (let i = 0; i < n; i++) ss += src[((min + i) * w + x) * ch + b] * c.kk[k + i];
        out[(y * outW + x) * ch + b] = clip8(Math.floor(ss / div));
      }
    }
  }
  return out;
}

/** Pillow-style bicubic resize of an interleaved 8-bit image with `ch` channels. */
export function resizeBicubic(src: Uint8Array, w: number, h: number, ch: number, outW: number, outH: number): Uint8Array {
  let data = src;
  let cw = w;
  if (outW !== w) {
    data = pass(data, w, h, ch, outW, h, true);
    cw = outW;
  }
  if (outH !== h) data = pass(data, cw, h, ch, outW, outH, false);
  return data === src ? src.slice() : data;
}

/** oemer's target size: about 3 to 4.35 million pixels. */
export function modelSize(w: number, h: number): [number, number] {
  const pis = w * h;
  const ratio = Math.sqrt((3000000 / pis + 4350000 / pis) / 2);
  return [Math.round(ratio * w), Math.round(ratio * h)];
}
