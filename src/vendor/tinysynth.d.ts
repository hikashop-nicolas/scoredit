// The slice of webaudio-tinysynth's API scoredit uses.
export default class WebAudioTinySynth {
  constructor(opt?: { quality?: number; useReverb?: number; voices?: number });
  send(msg: number[], t?: number): void;
  setProgram(ch: number, program: number): void;
  allSoundOff(ch: number): void;
  setMasterVol(v: number): void;
  getAudioContext(): AudioContext;
}
