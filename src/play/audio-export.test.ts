import { encodeMp3, encodeWav } from "./audio-export";

const tone = (seconds: number, sr = 44100) => {
  const n = Math.round(seconds * sr);
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  for (let i = 0; i < n; i++) left[i] = right[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / sr);
  return { left, right, sampleRate: sr };
};

describe("audio export", () => {
  it("writes a 16-bit stereo WAV", () => {
    const wav = encodeWav(tone(0.1));
    const v = new DataView(wav.buffer);
    expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe("RIFF");
    expect(v.getUint16(22, true)).toBe(2);
    expect(v.getUint32(24, true)).toBe(44100);
    expect(v.getUint32(40, true)).toBe(4410 * 4);
  });

  it("encodes a gapless MP3 at the asked bitrate", async () => {
    const seen: number[] = [];
    const mp3 = await encodeMp3(tone(3), { kbps: 128, onProgress: (f) => seen.push(f) });
    expect(mp3[0]).toBe(0xff);
    expect(mp3[1] & 0xe0).toBe(0xe0);
    // The first frame is the Info tag that carries the encoder delay and padding.
    expect(new TextDecoder().decode(mp3.subarray(0, 200))).toMatch(/Info|Xing/);
    // About 3 s at 128 kbps.
    expect(mp3.length).toBeGreaterThan(40000);
    expect(mp3.length).toBeLessThan(56000);
    expect(seen.at(-1)).toBe(1);
  });
});

