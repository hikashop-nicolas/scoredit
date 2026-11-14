// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { PRACTICE_DEFAULTS, createBar, type PracticeState } from "./bar";

const noop = () => {};
const make = () => {
  const changes: PracticeState[] = [];
  const bar = createBar({ zoom: 1, layout: "page", onZoomInput: noop, onZoomCommit: noop, onLayout: noop, onKeyboard: noop, onPlay: noop, onSpeed: noop, onPractice: (p) => changes.push(p), onConnectMidi: noop });
  const sec = (name: string) => bar.el.querySelector<HTMLDetailsElement>(`.sv-sec-${name}`)!;
  const state = (name: string) => sec(name).querySelector(".sv-sec-state")!.textContent;
  return { bar, sec, state, changes };
};

describe("practice pop-up sections", () => {
  it("starts folded, each heading telling what is chosen inside", () => {
    const { bar, sec, state } = make();
    bar.setPractice(true, true, { ...PRACTICE_DEFAULTS, mode: "wait" }, 8, undefined, true);
    for (const name of ["sound", "clicks", "loop"]) expect(sec(name).open).toBe(false);
    expect(state("sound")).toBe("From the computer, Play the other parts");
    expect(state("clicks")).toBe("");
    expect(state("loop")).toBe("");
  });

  it("opens a section when something in it is turned on, and leaves it as the user left it", () => {
    const { bar, sec, state } = make();
    const s = { ...PRACTICE_DEFAULTS, mode: "wait" as const };
    bar.setPractice(true, true, s, 8, ["0", "1", "2", "3", "4", "5", "6", "7"]);
    // A loop set from the seek bar: the loop section opens, its heading shows the printed bar numbers.
    bar.setPractice(true, true, { ...s, loop: { from: 2, to: 5 } }, 8);
    expect(sec("loop").open).toBe(true);
    expect(state("loop")).toBe("From bar 2 to 5");
    sec("loop").open = false;
    bar.setPractice(true, true, { ...s, loop: { from: 3, to: 5 } }, 8);
    expect(sec("loop").open).toBe(false);
    bar.setPractice(true, true, { ...s, metronome: true }, 8);
    expect(sec("clicks").open).toBe(true);
    expect(state("clicks")).toBe("Click on every beat");
  });

  it("hides the sound section when nothing in it applies (no keyboard)", () => {
    const { bar, sec } = make();
    bar.setPractice(false, false, PRACTICE_DEFAULTS, 8);
    expect(sec("sound").hidden).toBe(true);
    expect(sec("clicks").hidden).toBe(false);
    expect(sec("loop").hidden).toBe(false);
  });

  it("updates a heading as the user ticks inside", () => {
    const { bar, state, changes } = make();
    bar.setPractice(true, true, { ...PRACTICE_DEFAULTS, mode: "wait" }, 8);
    const countIn = [...bar.el.querySelectorAll(".sv-sec-clicks label")].find((l) => l.textContent === "Count-in")!.querySelector("input")!;
    countIn.checked = true;
    countIn.dispatchEvent(new Event("change"));
    expect(changes.at(-1)?.countIn).toBe(true);
    expect(state("clicks")).toBe("Count-in");
  });
});
