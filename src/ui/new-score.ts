import type { NewScore } from "../formats/mscx-new";
import { INSTRUMENTS, instrument, type InstrumentDef } from "../model/instruments";
import type { PartFamily } from "../model/score";
import { keyName } from "./editing";
import { t } from "./i18n";

// The form for a new score, for a host's "new document" dialog: title, composer, the
// instruments (added from a list by family, taken out again), key, time, tempo, pickup and
// bars. value() gives what newMuseScore() writes.

export interface NewScoreForm {
  el: HTMLElement;
  value(): NewScore;
}

export interface NewScoreFormOptions {
  /** Class names to match the host's own fields. */
  inputClass?: string;
  selectClass?: string;
  labelClass?: string;
  /** Instruments to start with (keys of the instrument list). */
  instruments?: string[];
}

const FAMILIES: PartFamily[] = ["keys", "strings", "winds", "brass", "guitar", "bass", "voice", "other", "drums"];
const TIMES = ["2/4", "3/4", "4/4", "5/4", "6/4", "2/2", "3/2", "3/8", "5/8", "6/8", "7/8", "9/8", "12/8"];
const PICKUPS = [0, 0.5, 1, 1.5, 2, 3];

export function createNewScoreForm(o: NewScoreFormOptions = {}): NewScoreForm {
  const el = document.createElement("div");
  el.className = "sv-newscore";
  // A label above each field, so it fits a narrow dialog.
  el.style.cssText = "display:flex;flex-direction:column;gap:4px";
  const field = <T extends HTMLElement>(label: string, input: T): T => {
    const l = document.createElement("label");
    l.className = o.labelClass ?? "";
    l.textContent = label;
    l.style.marginTop = "6px";
    const id = `sv-new-${Math.random().toString(36).slice(2, 8)}`;
    input.id = id;
    l.htmlFor = id;
    el.append(l, input);
    return input;
  };
  const text = (label: string, value = "") => {
    const i = document.createElement("input");
    i.type = "text";
    i.className = o.inputClass ?? "";
    i.value = value;
    return field(label, i);
  };
  const select = (label: string, options: [string, string][], value: string) => {
    const s = document.createElement("select");
    s.className = o.selectClass ?? "";
    for (const [v, n] of options) s.add(new Option(n, v));
    s.value = value;
    return field(label, s);
  };
  const number = (label: string, value: number, min: number, max: number) => {
    const i = document.createElement("input");
    i.type = "number";
    i.className = o.inputClass ?? "";
    i.min = String(min);
    i.max = String(max);
    i.value = String(value);
    return field(label, i);
  };
  const title = text(t("newTitle"));
  const composer = text(t("newComposer"));
  // The instruments: chosen ones as a list with a remove button, then a picker to add one.
  const chosen: string[] = [...(o.instruments ?? ["piano"])];
  const list = document.createElement("div");
  list.style.cssText = "display:flex;flex-wrap:wrap;gap:6px";
  const label = document.createElement("span");
  label.className = o.labelClass ?? "";
  label.textContent = t("newInstruments");
  label.style.marginTop = "6px";
  const box = document.createElement("div");
  box.style.cssText = "display:flex;flex-direction:column;gap:6px";
  const adder = document.createElement("select");
  adder.className = o.selectClass ?? "";
  adder.setAttribute("aria-label", t("newAdd"));
  adder.add(new Option(t("newAdd"), ""));
  for (const fam of FAMILIES) {
    const g = document.createElement("optgroup");
    g.label = t(`fam_${fam}`);
    for (const d of INSTRUMENTS.filter((x) => x.family === fam)) g.appendChild(new Option(t(`inst_${d.key}`), d.key));
    if (g.children.length) adder.appendChild(g);
  }
  adder.addEventListener("change", () => {
    if (adder.value) chosen.push(adder.value);
    adder.value = "";
    draw();
  });
  box.append(list, adder);
  el.append(label, box);
  function draw(): void {
    list.replaceChildren(
      ...chosen.map((key, i) => {
        const chip = document.createElement("span");
        chip.style.cssText = "display:inline-flex;align-items:center;gap:4px;padding:2px 4px 2px 10px;border:1px solid currentColor;border-radius:999px;opacity:.9";
        chip.append(t(`inst_${key}`));
        const x = document.createElement("button");
        x.type = "button";
        x.textContent = "×";
        x.title = t("newRemove");
        x.setAttribute("aria-label", `${t("newRemove")}: ${t(`inst_${key}`)}`);
        x.style.cssText = "border:0;background:none;color:inherit;font-size:16px;cursor:pointer;padding:0 4px";
        x.addEventListener("click", () => {
          chosen.splice(i, 1);
          draw();
        });
        chip.append(x);
        return chip;
      }),
    );
  }
  draw();
  const key = select(t("newKey"), Array.from({ length: 15 }, (_, i) => i - 7).map((f) => [String(f), keyName(f)] as [string, string]), "0");
  const time = select(t("newTime"), TIMES.map((x) => [x, x] as [string, string]), "4/4");
  const tempo = number(t("newTempo"), 120, 20, 300);
  const pickup = select(t("newPickup"), PICKUPS.map((q) => [String(q), q ? t("newPickupBeats").replace("{0}", String(q)) : t("newPickupNone")] as [string, string]), "0");
  const bars = number(t("newBars"), 16, 1, 999);
  return {
    el,
    value(): NewScore {
      const [n, d] = time.value.split("/").map(Number);
      const defs = (chosen.length ? chosen : ["piano"]).map((k) => instrument(k)).filter((x): x is InstrumentDef => !!x);
      const pick = Number(pickup.value) || 0;
      return {
        title: title.value.trim(),
        composer: composer.value.trim(),
        parts: defs.map((def) => ({ def, name: t(`inst_${def.key}`) })),
        fifths: Number(key.value) || 0,
        time: [n || 4, d || 4],
        tempo: Math.max(20, Math.min(300, Number(tempo.value) || 120)),
        pickup: pick,
        measures: Math.max(1, Math.min(999, Math.round(Number(bars.value) || 16))) + (pick ? 1 : 0),
      };
    },
  };
}
