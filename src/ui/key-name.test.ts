import { afterEach, describe, expect, it } from "vitest";
import { keyName } from "./editing";
import { setLocale } from "./i18n";

describe("keyName", () => {
  afterEach(() => setLocale("en"));
  it("uses each language's note names", () => {
    expect(keyName(-2)).toBe("B♭ major / G minor");
    setLocale("it");
    expect(keyName(2)).toBe("Re maggiore / Si minore");
    setLocale("tr");
    expect(keyName(-3)).toBe("Mi♭ majör / Do minör");
  });
  it("names B flat B and B natural H where that is the convention", () => {
    setLocale("pl");
    expect(keyName(-2)).toBe("B-dur / G-moll");
    expect(keyName(2)).toBe("D-dur / H-moll");
    setLocale("de");
    expect(keyName(-2)).toBe("B-Dur / G-Moll");
  });
});
