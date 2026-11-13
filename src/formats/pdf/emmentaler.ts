// LilyPond's Emmentaler (and older feta) fonts: subsets renumber the codes, so glyphs are
// recognised by the glyph names kept in the embedded CFF. Names follow the LilyPond Notation
// Reference list "The Emmentaler font"; values are SMuFL glyph names.
import { glyphNameLookup } from "./cff";
import type { FontMapper } from "./normalize";
import { DROP, smufl } from "./smufl";

export const EMMENTALER: Record<string, string> = {
  "clefs.G": "gClef", "clefs.G_change": "gClefChange", "clefs.F": "fClef", "clefs.F_change": "fClefChange",
  "clefs.C": "cClef", "clefs.C_change": "cClefChange", "clefs.varC": "cClefSquare", "clefs.varC_change": "cClefSquare",
  "clefs.tenorG": "gClef8vbCClef", "clefs.tenorG_change": "gClef8vbCClef",
  "clefs.percussion": "unpitchedPercussionClef1", "clefs.percussion_change": "unpitchedPercussionClef1",
  "clefs.varpercussion": "unpitchedPercussionClef2", "clefs.varpercussion_change": "unpitchedPercussionClef2",
  "clefs.tab": "6stringTabClef", "clefs.tab_change": "6stringTabClef",
  "timesig.C44": "timeSigCommon", "timesig.C22": "timeSigCutCommon",
  plus: "timeSigPlus", hyphen: "timeSigMinus",
  zero: "timeSig0", one: "timeSig1", two: "timeSig2", three: "timeSig3", four: "timeSig4",
  five: "timeSig5", six: "timeSig6", seven: "timeSig7", eight: "timeSig8", nine: "timeSig9",
  "accidentals.sharp": "accidentalSharp", "accidentals.natural": "accidentalNatural", "accidentals.flat": "accidentalFlat",
  "accidentals.doublesharp": "accidentalDoubleSharp", "accidentals.flatflat": "accidentalDoubleFlat",
  "accidentals.sharp.slashslash.stem": "accidentalQuarterToneSharpStein",
  "accidentals.sharp.slashslash.stemstemstem": "accidentalThreeQuarterTonesSharpStein",
  "accidentals.mirroredflat": "accidentalQuarterToneFlatStein",
  "accidentals.mirroredflat.flat": "accidentalThreeQuarterTonesFlatZimmermann",
  "accidentals.sharp.arrowup": "accidentalThreeQuarterTonesSharpArrowUp",
  "accidentals.sharp.arrowdown": "accidentalQuarterToneSharpArrowDown",
  "accidentals.natural.arrowup": "accidentalQuarterToneSharpNaturalArrowUp",
  "accidentals.natural.arrowdown": "accidentalQuarterToneFlatNaturalArrowDown",
  "accidentals.flat.arrowup": "accidentalQuarterToneFlatArrowUp",
  "accidentals.flat.arrowdown": "accidentalThreeQuarterTonesFlatArrowDown",
  "accidentals.flat.koron": "accidentalKoron", "accidentals.sharp.sori": "accidentalSori",
  "accidentals.leftparen": "accidentalParensLeft", "accidentals.rightparen": "accidentalParensRight",
  // LilyPond 2.10 and older number accidentals in quarter tones.
  "accidentals.2": "accidentalSharp", "accidentals.0": "accidentalNatural", "accidentals.M2": "accidentalFlat",
  "accidentals.4": "accidentalDoubleSharp", "accidentals.M4": "accidentalDoubleFlat",
  "accidentals.1": "accidentalQuarterToneSharpStein", "accidentals.M1": "accidentalQuarterToneFlatStein",
  "accidentals.3": "accidentalThreeQuarterTonesSharpStein", "accidentals.M3": "accidentalThreeQuarterTonesFlatZimmermann",
  "noteheads.sM1": "noteheadDoubleWhole", "noteheads.s0": "noteheadWhole", "noteheads.s1": "noteheadHalf", "noteheads.s2": "noteheadBlack",
  "noteheads.s0diamond": "noteheadDiamondWhole", "noteheads.s1diamond": "noteheadDiamondHalf", "noteheads.s2diamond": "noteheadDiamondBlack",
  "noteheads.s0slash": "noteheadSlashWhiteWhole", "noteheads.s1slash": "noteheadSlashWhiteHalf", "noteheads.s2slash": "noteheadSlashHorizontalEnds",
  "noteheads.s0cross": "noteheadXWhole", "noteheads.s1cross": "noteheadXHalf", "noteheads.s2cross": "noteheadXBlack",
  "noteheads.s2xcircle": "noteheadCircleX", "noteheads.s0harmonic": "noteheadDiamondWhite", "noteheads.s2harmonic": "noteheadDiamondBlack",
  "rests.0": "restWhole", "rests.1": "restHalf", "rests.0o": "restWholeLegerLine", "rests.1o": "restHalfLegerLine",
  "rests.M3": "restMaxima", "rests.M2": "restLonga", "rests.M1": "restDoubleWhole", "rests.M1o": "restDoubleWholeLegerLine",
  "rests.2": "restQuarter", "rests.2classical": "restQuarterOld", "rests.2z": "restQuarterZ",
  "rests.3": "rest8th", "rests.4": "rest16th", "rests.5": "rest32nd", "rests.6": "rest64th", "rests.7": "rest128th",
  "rests.8": "rest256th", "rests.9": "rest512th", "rests.10": "rest1024th",
  "flags.u3": "flag8thUp", "flags.u4": "flag16thUp", "flags.u5": "flag32ndUp", "flags.u6": "flag64thUp", "flags.u7": "flag128thUp",
  "flags.u8": "flag256thUp", "flags.u9": "flag512thUp", "flags.u10": "flag1024thUp",
  "flags.d3": "flag8thDown", "flags.d4": "flag16thDown", "flags.d5": "flag32ndDown", "flags.d6": "flag64thDown", "flags.d7": "flag128thDown",
  "flags.d8": "flag256thDown", "flags.d9": "flag512thDown", "flags.d10": "flag1024thDown",
  "flags.ugrace": "graceNoteSlashStemUp", "flags.dgrace": "graceNoteSlashStemDown",
  "dots.dot": "augmentationDot",
  f: "dynamicForte", m: "dynamicMezzo", n: "dynamicNiente", p: "dynamicPiano", r: "dynamicRinforzando", s: "dynamicSforzando", z: "dynamicZ",
  "scripts.ufermata": "fermataAbove", "scripts.dfermata": "fermataBelow",
  "scripts.ushortfermata": "fermataShortAbove", "scripts.dshortfermata": "fermataShortBelow",
  "scripts.ulongfermata": "fermataLongAbove", "scripts.dlongfermata": "fermataLongBelow",
  "scripts.uverylongfermata": "fermataVeryLongAbove", "scripts.dverylongfermata": "fermataVeryLongBelow",
  "scripts.uveryshortfermata": "fermataVeryShortAbove", "scripts.dveryshortfermata": "fermataVeryShortBelow",
  "scripts.uhenzeshortfermata": "fermataShortHenzeAbove", "scripts.dhenzeshortfermata": "fermataShortHenzeBelow",
  "scripts.uhenzelongfermata": "fermataLongHenzeAbove", "scripts.dhenzelongfermata": "fermataLongHenzeBelow",
  "scripts.thumb": "stringsThumbPosition", "scripts.sforzato": "articAccentAbove", "scripts.staccato": "articStaccatoAbove",
  "scripts.ustaccatissimo": "articStaccatissimoAbove", "scripts.dstaccatissimo": "articStaccatissimoBelow",
  "scripts.tenuto": "articTenutoAbove", "scripts.uportato": "articTenutoStaccatoAbove", "scripts.dportato": "articTenutoStaccatoBelow",
  "scripts.umarcato": "articMarcatoAbove", "scripts.dmarcato": "articMarcatoBelow",
  "scripts.open": "brassMuteOpen", "scripts.halfopen": "brassMuteHalfClosed", "scripts.stopped": "brassMuteClosed",
  "scripts.upbow": "stringsUpBow", "scripts.downbow": "stringsDownBow", "scripts.flageolet": "stringsHarmonic",
  "scripts.turn": "ornamentTurn", "scripts.reverseturn": "ornamentTurnInverted", "scripts.slashturn": "ornamentTurnSlash",
  "scripts.haydnturn": "ornamentHaydn", "scripts.trill": "ornamentTrill", "scripts.trill_element": "wiggleTrill",
  "scripts.prall": "ornamentShortTrill", "scripts.mordent": "ornamentMordent", "scripts.prallprall": "ornamentTremblement",
  "scripts.prallmordent": "ornamentPrecompTrillWithMordent",
  "scripts.segno": "segno", "scripts.varsegno": "segnoSerpent1", "scripts.coda": "coda", "scripts.varcoda": "codaSquare",
  "scripts.rcomma": "breathMarkComma", "scripts.raltcomma": "breathMarkComma", "scripts.rvarcomma": "breathMarkTick", "scripts.tickmark": "breathMarkTick",
  "scripts.caesura.curved": "caesuraCurved", "scripts.caesura.straight": "caesura",
  "scripts.arpeggio": "wiggleArpeggiatoUp", "scripts.arpeggio.arrow.M1": "wiggleArpeggiatoDownArrow", "scripts.arpeggio.arrow.1": "wiggleArpeggiatoUpArrow",
  "scripts.snappizzicato": "pluckedSnapPizzicatoAbove",
  "pedal.Ped": "keyboardPedalPed", "pedal.*": "keyboardPedalUp", "pedal..": "keyboardPedalDot",
  "pedal.P": "keyboardPedalP", "pedal.d": "keyboardPedalD", "pedal.e": "keyboardPedalE", "pedal.M": "keyboardPedalHyphen",
  "brackettips.up": "bracketTop", "brackettips.down": "bracketBottom",
  "ties.lyric.short": "lyricsElision", "ties.lyric.default": "lyricsElision",
  // GNU LilyPond feta fonts before 2.0.
  quarthead: "noteheadBlack", halfhead: "noteheadHalf", wholehead: "noteheadWhole", brevishead: "noteheadDoubleWhole",
  trebleclef: "gClef", bassclef: "fClef", altoclef: "cClef", sharp: "accidentalSharp", flat: "accidentalFlat", natural: "accidentalNatural",
  flatflat: "accidentalDoubleFlat", sharpsharp: "accidentalDoubleSharp", dot: "augmentationDot",
  eighthflag: "flag8thUp", deighthflag: "flag8thDown", sixteenthflag: "flag16thUp", dsixteenthflag: "flag16thDown",
  ufermata: "fermataAbove", dfermata: "fermataBelow",
};

/** The SMuFL code point of an Emmentaler glyph name; numbers and braces come in many variants. */
export function emmentalerName(name: string): number | undefined {
  const direct = EMMENTALER[name];
  if (direct) return smufl(direct);
  if (/^brace/.test(name)) return smufl("brace");
  // Number variants: fixedwidth.four.alt, fattened.seven...
  const digit = /^(?:fattened\.)?(?:fixedwidth\.)?(zero|one|two|three|four|five|six|seven|eight|nine)(?:\.alt)?$/.exec(name);
  if (digit) return smufl(EMMENTALER[digit[1]]);
  // Figured-bass forms of the accidentals.
  if (name.endsWith(".figbass")) return emmentalerName(name.slice(0, -8));
  return undefined;
}

export const isEmmentaler = (font: string) => /emmentaler|feta|parmesan|aybabtu/i.test(font) && !/smufl/i.test(font);

/** Maps an Emmentaler glyph through its name; unnamed or unknown glyphs are dropped. */
export const emmentalerMapper: FontMapper = (g, font) => {
  const name = glyphNameLookup(font)?.(g.code);
  if (name === "space" || name === "period" || name === "comma") return null;
  if (!name || name === ".notdef") return DROP;
  return emmentalerName(name) ?? DROP;
};
