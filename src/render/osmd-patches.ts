import * as OSMD from "opensheetmusicdisplay";

// Each system is rendered as a score of its own. OSMD stores a first ending's forward jump on
// the measure before it, which a system starting with "1." does not have: the repetition
// pass then fails and the ending loses its label. A stand-in measure takes it for the call.
type Calc = { prototype: { handleRepetitionInstructions?: (this: CalcThis, t: unknown) => unknown } };
type CalcThis = { currentMeasureIndex: number; musicSheet: { SourceMeasures: unknown[] & Record<string, unknown> } };

let patched = false;
export function patchOsmd(): void {
  if (patched) return;
  patched = true;
  const lib = OSMD as unknown as Record<string, unknown> & { default?: Record<string, unknown> };
  const calc = (lib.RepetitionCalculator ?? lib.default?.RepetitionCalculator) as Calc | undefined;
  const original = calc?.prototype.handleRepetitionInstructions;
  if (!calc || !original) return;
  calc.prototype.handleRepetitionInstructions = function (this: CalcThis, t: unknown) {
    const measures = this.musicSheet?.SourceMeasures;
    if (this.currentMeasureIndex !== 0 || !measures || "-1" in measures) return original.call(this, t);
    measures["-1"] = { LastRepetitionInstructions: [], FirstRepetitionInstructions: [] };
    try {
      return original.call(this, t);
    } finally {
      delete measures["-1"];
    }
  };
}

// OSMD ends a repeat still open at the end of the music with an end-repeat sign. A system
// cut inside a repeat is not the end, so that made-up sign is taken off again.
const BACK_JUMP_LINE = 2; // RepetitionInstructionEnum.BackJumpLine
export function keepRepeatOpen(osmd: OSMD.OpenSheetMusicDisplay, xml: string): void {
  const tail = xml.slice(xml.lastIndexOf("<measure"));
  if (/<repeat\s+direction="backward"/.test(tail)) return;
  const last = osmd.Sheet?.SourceMeasures.at(-1) as { LastRepetitionInstructions?: { type: number }[] } | undefined;
  const list = last?.LastRepetitionInstructions;
  if (!list) return;
  for (let i = list.length - 1; i >= 0; i--) if (list[i].type === BACK_JUMP_LINE) list.splice(i, 1);
}
