import { describe, expect, it } from "vitest";
import { midiOf, spellInKey } from "./notes";

const name = (midi: number, fifths: number) => {
  const p = spellInKey(midi, fifths);
  return `${p.step}${p.alter > 0 ? "#".repeat(p.alter) : "b".repeat(-p.alter)}${p.octave}`;
};

describe("spellInKey", () => {
  it("spells white keys plainly in C and black keys with sharps", () => {
    expect([60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71].map((m) => name(m, 0))).toEqual(["C4", "C#4", "D4", "D#4", "E4", "F4", "F#4", "G4", "G#4", "A4", "A#4", "B4"]);
  });

  it("uses flats in flat keys and sharps in sharp keys", () => {
    expect([61, 63, 66, 68, 70].map((m) => name(m, -2))).toEqual(["Db4", "Eb4", "Gb4", "Ab4", "Bb4"]);
    expect([61, 63, 66, 68, 70].map((m) => name(m, 3))).toEqual(["C#4", "D#4", "F#4", "G#4", "A#4"]);
  });

  it("writes the key's own scale notes as the key does", () => {
    expect(name(65, 6)).toBe("E#4");
    expect(name(71, -6)).toBe("Cb5");
    expect(name(64, -7)).toBe("Fb4");
    expect(name(60, 7)).toBe("B#3");
  });

  it("keeps a natural that leaves the key plain", () => {
    expect(name(71, -1)).toBe("B4");
    expect(name(65, 1)).toBe("F4");
  });

  it("always gives back the key's pitch", () => {
    for (let f = -7; f <= 7; f++) for (let m = 21; m <= 108; m++) expect(midiOf(spellInKey(m, f))).toBe(m);
  });
});
