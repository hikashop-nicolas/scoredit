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
  // LilyPond's triangle heads point right.
  "noteheads.s0triangle": "noteheadTriangleRightWhite", "noteheads.s1triangle": "noteheadTriangleRightWhite", "noteheads.s2triangle": "noteheadTriangleRightBlack",
  "noteheads.sM1double": "noteheadDoubleWholeSquare",
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
  // Compound ornaments: the SMuFL precomposed glyph built from the same strokes.
  "scripts.prallmordent": "ornamentPrecompTrillWithMordent", "scripts.upprall": "ornamentPrecompSlideTrillDAnglebert",
  "scripts.upmordent": "ornamentPrecompSlideTrillBach", "scripts.downprall": "ornamentPrecompMordentUpperPrefix",
  "scripts.downmordent": "ornamentPrecompInvertedMordentUpperPrefix", "scripts.prallup": "ornamentPrecompSlide",
  "scripts.pralldown": "ornamentPrecompTrillLowerSuffix", "scripts.lineprall": "ornamentPrecompAppoggTrill",
  "scripts.segno": "segno", "scripts.varsegno": "segnoSerpent1", "scripts.coda": "coda", "scripts.varcoda": "codaSquare",
  "scripts.rcomma": "breathMarkComma", "scripts.raltcomma": "breathMarkComma", "scripts.rvarcomma": "breathMarkTick", "scripts.tickmark": "breathMarkTick",
  "scripts.caesura.curved": "caesuraCurved", "scripts.caesura.straight": "caesura",
  "scripts.arpeggio": "wiggleArpeggiatoUp", "scripts.arpeggio.arrow.M1": "wiggleArpeggiatoDownArrow", "scripts.arpeggio.arrow.1": "wiggleArpeggiatoUpArrow",
  "scripts.snappizzicato": "pluckedSnapPizzicatoAbove",
  "scripts.ictus": "chantIctusAbove", "scripts.uaccentus": "chantAccentusAbove", "scripts.daccentus": "chantAccentusBelow",
  "scripts.usemicirculus": "chantSemicirculusAbove", "scripts.dsemicirculus": "chantSemicirculusBelow",
  "scripts.circulus": "chantCirculusAbove", "scripts.augmentum": "chantAugmentum",
  "scripts.usignumcongruentiae": "mensuralSignumUp", "scripts.dsignumcongruentiae": "mensuralSignumDown",
  "pedal.Ped": "keyboardPedalPed", "pedal.*": "keyboardPedalUp", "pedal..": "keyboardPedalDot",
  "pedal.P": "keyboardPedalP", "pedal.d": "keyboardPedalD", "pedal.e": "keyboardPedalE", "pedal.M": "keyboardPedalHyphen",
  "brackettips.up": "bracketTop", "brackettips.down": "bracketBottom",
  "ties.lyric.short": "lyricsElision", "ties.lyric.default": "lyricsElision",
  "figbass.twoplus": "figbass2Raised", "figbass.fourplus": "figbass4Raised", "figbass.fiveplus": "figbass5Raised1",
  "figbass.sixstroked": "figbass6Raised", "figbass.sevenstroked": "figbass7Raised1", "figbass.ninestroked": "figbass9Raised",
  "arrowheads.open.01": "arrowheadOpenRight", "arrowheads.open.0M1": "arrowheadOpenLeft",
  "arrowheads.open.11": "arrowheadOpenUp", "arrowheads.open.1M1": "arrowheadOpenDown",
  "arrowheads.close.01": "arrowheadBlackRight", "arrowheads.close.0M1": "arrowheadBlackLeft",
  "arrowheads.close.11": "arrowheadBlackUp", "arrowheads.close.1M1": "arrowheadBlackDown",
  "accordion.discant": "accdnCombRH3RanksEmpty", "accordion.freebass": "accdnCombLH2RanksEmpty",
  "accordion.bayanbass": "accdnCombLH3RanksEmptySquare", "accordion.dot": "accdnCombDot",
  "accordion.push": "accdnPush", "accordion.pull": "accdnPull",
  // Mensural notation (rests, clefs, custodes, accidentals, time signatures).
  "rests.M3mensural": "mensuralRestMaxima", "rests.M2mensural": "mensuralRestLongaImperfecta", "rests.M1mensural": "mensuralRestBrevis",
  "rests.0mensural": "mensuralRestSemibrevis", "rests.1mensural": "mensuralRestMinima", "rests.2mensural": "mensuralRestSemiminima",
  "rests.3mensural": "mensuralRestFusa", "rests.4mensural": "mensuralRestSemifusa",
  "clefs.mensural.c": "mensuralCclef", "clefs.blackmensural.c": "mensuralCclef", "clefs.neomensural.c": "mensuralCclef",
  "clefs.mensural.f": "mensuralFclef", "clefs.mensural.g": "mensuralGclef",
  "clefs.petrucci.c1": "mensuralCclefPetrucciPosLowest", "clefs.petrucci.c2": "mensuralCclefPetrucciPosLow",
  "clefs.petrucci.c3": "mensuralCclefPetrucciPosMiddle", "clefs.petrucci.c4": "mensuralCclefPetrucciPosHigh",
  "clefs.petrucci.c5": "mensuralCclefPetrucciPosHighest", "clefs.petrucci.f": "mensuralFclefPetrucci", "clefs.petrucci.g": "mensuralGclefPetrucci",
  "clefs.vaticana.do": "chantCclef", "clefs.vaticana.fa": "chantFclef", "clefs.medicaea.do": "chantCclef", "clefs.medicaea.fa": "chantFclef",
  "clefs.hufnagel.do": "chantCclef", "clefs.hufnagel.fa": "chantFclef", "clefs.hufnagel.do.fa": "chantCclef",
  "accidentals.mensural1": "medRenSharpCroix", "accidentals.mensuralM1": "medRenFlatSoftB",
  "accidentals.vaticanaM1": "medRenFlatSoftB", "accidentals.vaticana0": "medRenNatural",
  "accidentals.medicaeaM1": "medRenFlatSoftB", "accidentals.hufnagelM1": "medRenFlatSoftB",
  "timesig.mensural44": "mensuralProlation6", "timesig.mensural22": "mensuralProlation7", "timesig.mensural32": "mensuralProlation2",
  "timesig.mensural64": "mensuralProlation5", "timesig.mensural94": "mensuralProlation1", "timesig.mensural34": "mensuralProlation3",
  "timesig.mensural68": "mensuralProlation8", "timesig.mensural98": "mensuralProlation4",
  "dots.dotvaticana": "chantAugmentum",
  // Gregorian chant heads (Vaticana, Medicaea, Hufnagel, Solesmes).
  "noteheads.svaticana.punctum": "chantPunctum", "noteheads.svaticana.punctum.cavum": "chantPunctumCavum",
  "noteheads.svaticana.linea.punctum": "chantPunctumLinea", "noteheads.svaticana.linea.punctum.cavum": "chantPunctumLineaCavum",
  "noteheads.svaticana.inclinatum": "chantPunctumInclinatum", "noteheads.svaticana.quilisma": "chantQuilisma",
  "noteheads.svaticana.lpes": "chantPodatusLower", "noteheads.svaticana.vlpes": "chantPodatusLower",
  "noteheads.svaticana.upes": "chantPodatusUpper", "noteheads.svaticana.vupes": "chantPodatusUpper",
  "noteheads.smedicaea.punctum": "chantPunctum", "noteheads.smedicaea.inclinatum": "chantPunctumInclinatum",
  "noteheads.smedicaea.virga": "chantPunctumVirga", "noteheads.smedicaea.rvirga": "chantPunctumVirgaReversed",
  "noteheads.shufnagel.punctum": "chantPunctum", "noteheads.shufnagel.virga": "chantPunctumVirga", "noteheads.shufnagel.lpes": "chantPodatusLower",
  "noteheads.ssolesmes.incl.parvum": "chantPunctumInclinatumDeminutum", "noteheads.ssolesmes.auct.asc": "chantAuctumAsc",
  "noteheads.ssolesmes.auct.desc": "chantAuctumDesc", "noteheads.ssolesmes.incl.auctum": "chantPunctumInclinatumAuctum",
  "noteheads.ssolesmes.stropha": "chantStrophicus", "noteheads.ssolesmes.stropha.aucta": "chantStrophicusAuctus",
  "noteheads.ssolesmes.oriscus": "chantOriscusAscending",
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
  if (name.endsWith(".figbass")) {
    const fb = FIGBASS[name.slice(12, -8)];
    return fb ? smufl(fb) : emmentalerName(name.slice(0, -8));
  }
  const shape = shapeNote(name);
  if (shape) return smufl(shape);
  const mens = mensuralHead(name);
  if (mens) return smufl(mens);
  // Custodes: the position on the staff is the glyph's own.
  const custos = /^custodes\.(mensural|vaticana|medicaea|hufnagel)\.([ud])[0-2]$/.exec(name);
  if (custos) return smufl(custos[1] === "mensural" ? (custos[2] === "u" ? "mensuralCustosUp" : "mensuralCustosDown") : custos[2] === "u" ? "chantCustosStemUpPosMiddle" : "chantCustosStemDownPosMiddle");
  // Change clefs and the neomensural or Petrucci rests share the plain glyph.
  if (name.endsWith("_change")) return emmentalerName(name.slice(0, -7));
  const rest = /^rests\.(M3|M2|M1|[0-4])(neomensural|petrucci|blackpetrucci|semipetrucci)$/.exec(name);
  if (rest) return emmentalerName(`rests.${rest[1]}mensural`);
  const time = /^timesig\.neomensural(\d\d)$/.exec(name);
  if (time) return emmentalerName(`timesig.mensural${time[1]}`);
  return undefined;
}

const FIGBASS: Record<string, string> = {
  sharp: "figbassSharp", flat: "figbassFlat", natural: "figbassNatural", doublesharp: "figbassDoubleSharp", flatflat: "figbassDoubleFlat",
};

/** Shape-note heads by syllable and style: s0/s1 white, s2 black; u/d pick fa's direction. */
const SHAPES: Record<string, Record<string, string>> = {
  default: { do: "TriangleUp", re: "Moon", mi: "Diamond", sol: "Round", la: "Square", ti: "TriangleRound" },
  Funk: { do: "MoonLeft", re: "ArrowheadLeft", mi: "Diamond", sol: "Round", la: "Square", ti: "TriangleRoundLeft" },
  Walker: { do: "Keystone", re: "QuarterMoon", mi: "Diamond", sol: "Round", la: "Square", ti: "IsoscelesTriangle" },
};

export function shapeNote(name: string): string | undefined {
  const m = /^noteheads\.([sud])([0-2])(do|re|mi|fa|sol|la|ti)(Thin|Mirror|Funk|Walker)?$/.exec(name);
  if (!m) return undefined;
  const style = m[4] === "Funk" || m[4] === "Walker" ? m[4] : "default";
  // Fa points left with the stem up and right with the stem down (SMuFL's convention).
  const shape = m[3] === "fa" ? (m[1] === "d" ? "TriangleRight" : "TriangleLeft") : SHAPES[style][m[3]];
  return `noteShape${shape}${m[2] === "2" ? "Black" : "White"}`;
}

/** Mensural heads: s0 semibrevis, s1 minima, s2 semiminima, M1 brevis, M2 longa, M3 maxima. */
function mensuralHead(name: string): string | undefined {
  const m = /^noteheads\.[uds]r?(M3|M2|M1|0|1|2)(lig)?(mensural|semimensural|blackmensural|neomensural|petrucci|blackpetrucci|semipetrucci)$/.exec(name);
  if (!m) return undefined;
  const black = m[3].startsWith("black") || m[1] === "2";
  if (m[1] === "M3") return black ? "mensuralNoteheadMaximaBlack" : "mensuralNoteheadMaximaVoid";
  if (m[1] === "M2" || m[1] === "M1") return black ? "mensuralNoteheadLongaBlack" : "mensuralNoteheadLongaVoid";
  if (m[1] === "1" && !black) return "mensuralNoteheadMinimaWhite";
  return black ? "mensuralNoteheadSemibrevisBlack" : "mensuralNoteheadSemibrevisVoid";
}

export const isEmmentaler = (font: string) => /emmentaler|feta|parmesan|aybabtu/i.test(font) && !/smufl/i.test(font);

/** Maps an Emmentaler glyph through its name; unnamed or unknown glyphs are dropped. */
export const emmentalerMapper: FontMapper = (g, font) => {
  const name = glyphNameLookup(font)?.(g.code);
  if (name === "space" || name === "period" || name === "comma") return null;
  if (!name || name === ".notdef") return DROP;
  return emmentalerName(name) ?? DROP;
};
