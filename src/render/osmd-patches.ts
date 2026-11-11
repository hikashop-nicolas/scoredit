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
