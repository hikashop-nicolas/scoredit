// Whether a picture shows sheet music: staves (five evenly spaced lines) found by the classic
// staff detector on a smaller copy. No model, a fraction of a second: a host can ask it before
// choosing between reading text and reading music.
import { findStaffLines, grey, sauvola } from "./stafflines";

const WIDTH = 1000;

export interface SheetMusicGuess {
  sheetMusic: boolean;
  staves: number;
}

/** Staves on the picture: two or more, or one across most of its width, make it sheet music. */
export async function looksLikeSheetMusic(image: ImageData | Blob): Promise<SheetMusicGuess> {
  const { bgr, w, h } = await small(image);
  const ink = sauvola(grey(bgr, w, h), w, h, 31, 0.15);
  let staves: { xs: number[]; ys: number[][] }[] = [];
  let thickness = 1;
  try {
    const found = findStaffLines(ink, w, h);
    thickness = found.thickness;
    // Lines of text also come in evenly spaced fives: a staff line is a long, thin stroke.
    staves = found.staffs.filter((st) => {
      const lines = st.ys.map((line) => profile(ink, w, h, st.xs, line, thickness));
      if (lines.filter((l) => l.cover >= 0.55 && l.thin >= 0.6).length < 4) return false;
      // A ruled table or lined paper goes on past five lines at the same spacing; a staff stops.
      const shifted = (by: number) => profile(ink, w, h, st.xs, st.ys[by < 0 ? 0 : 4].map((y) => y + by), thickness);
      const rule = (l: { cover: number; thin: number }) => l.cover >= 0.8 && l.thin >= 0.8;
      return !rule(shifted(-found.spacing)) && !rule(shifted(found.spacing));
    });
  } catch {
    staves = [];
  }
  const wide = staves.filter((s) => s.xs.length > 1 && s.xs[s.xs.length - 1] - s.xs[0] > w * 0.5).length;
  return { sheetMusic: staves.length >= 2 || wide >= 1, staves: staves.length };
}

/**
 * Along a line (sampled at xs, ys): the share of columns with ink on it, and of those, the share
 * where the ink there is a thin horizontal stroke (a vertical run near the line thickness).
 */
function profile(ink: Uint8Array, w: number, h: number, xs: number[], ys: number[], thickness: number): { cover: number; thin: number } {
  const x0 = Math.max(0, Math.round(xs[0]));
  const x1 = Math.min(w - 1, Math.round(xs[xs.length - 1]));
  if (x1 <= x0) return { cover: 0, thin: 0 };
  const r = Math.max(1, Math.ceil(thickness / 2) + 1);
  const thinMax = Math.max(3, Math.round(thickness * 2.5));
  let inked = 0;
  let thin = 0;
  for (let x = x0; x <= x1; x++) {
    let k = 0;
    while (k < xs.length - 2 && xs[k + 1] < x) k++;
    const t = xs[k + 1] === xs[k] ? 0 : (x - xs[k]) / (xs[k + 1] - xs[k]);
    const y = Math.round(ys[k] + (ys[Math.min(k + 1, ys.length - 1)] - ys[k]) * Math.min(1, Math.max(0, t)));
    let at = -1;
    for (let dy = 0; dy <= r && at < 0; dy++) {
      for (const yy of dy ? [y - dy, y + dy] : [y]) if (yy >= 0 && yy < h && ink[yy * w + x]) at = yy;
    }
    if (at < 0) continue;
    inked++;
    let top = at;
    let bottom = at;
    while (top > 0 && ink[(top - 1) * w + x] && at - top < thinMax + 1) top--;
    while (bottom < h - 1 && ink[(bottom + 1) * w + x] && bottom - at < thinMax + 1) bottom++;
    if (bottom - top + 1 <= thinMax) thin++;
  }
  return { cover: inked / (x1 - x0 + 1), thin: inked ? thin / inked : 0 };
}

/** The picture at most WIDTH pixels wide, as interleaved BGR over white. */
async function small(image: ImageData | Blob): Promise<{ bgr: Uint8Array; w: number; h: number }> {
  let data: { width: number; height: number; data: Uint8ClampedArray };
  if (typeof Blob !== "undefined" && image instanceof Blob) {
    const bmp = await createImageBitmap(image);
    const k = Math.min(1, WIDTH / bmp.width);
    const cw = Math.max(1, Math.round(bmp.width * k));
    const ch = Math.max(1, Math.round(bmp.height * k));
    const canvas = new OffscreenCanvas(cw, ch);
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, cw, ch);
    ctx.drawImage(bmp, 0, 0, cw, ch);
    bmp.close();
    data = ctx.getImageData(0, 0, cw, ch);
  } else data = shrink(image as ImageData);
  const { width: w, height: h } = data;
  const bgr = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    const a = data.data[i * 4 + 3] / 255;
    const over = (v: number) => Math.round(v * a + 255 * (1 - a));
    bgr[i * 3] = over(data.data[i * 4 + 2]);
    bgr[i * 3 + 1] = over(data.data[i * 4 + 1]);
    bgr[i * 3 + 2] = over(data.data[i * 4]);
  }
  return { bgr, w, h };
}

/** Nearest-neighbour shrink of image data to WIDTH, for hosts that pass ImageData (and tests). */
function shrink(img: ImageData): { width: number; height: number; data: Uint8ClampedArray } {
  const k = Math.min(1, WIDTH / img.width);
  if (k === 1) return img;
  const w = Math.round(img.width * k);
  const h = Math.round(img.height * k);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(img.height - 1, Math.floor(y / k));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(img.width - 1, Math.floor(x / k));
      out.set(img.data.subarray((sy * img.width + sx) * 4, (sy * img.width + sx) * 4 + 4), (y * w + x) * 4);
    }
  }
  return { width: w, height: h, data: out };
}
