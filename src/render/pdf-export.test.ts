// @vitest-environment happy-dom
import { loadScore } from "../formats/load";
import { closeOpenEndings, crossingBoundaries } from "./pdf-export";

const score = (body: string) => `<score-partwise version="4.0"><part-list><score-part id="P1"><part-name/></score-part></part-list><part id="P1">${body}</part></score-partwise>`;
const endings = (xml: string) =>
  [...new DOMParser().parseFromString(xml, "application/xml").getElementsByTagName("measure")].map((m) =>
    [...m.getElementsByTagName("ending")].map((e) => `${e.getAttribute("number")}:${e.getAttribute("type")}`).join(" "),
  );

describe("closeOpenEndings", () => {
  it("ends a second volta left open at the end of its bar", () => {
    const xml = score(
      '<measure number="1"><barline location="left"><ending number="1" type="start"/></barline><barline location="right"><ending number="1" type="stop"/><repeat direction="backward"/></barline></measure>' +
        '<measure number="2"><barline location="left"><ending number="2" type="start"/></barline></measure>' +
        '<measure number="3"></measure>',
    );
    expect(endings(closeOpenEndings(xml))).toEqual(["1:start 1:stop", "2:start 2:discontinue", ""]);
  });

  it("leaves closed voltas alone", () => {
    const xml = score('<measure number="1"><barline location="left"><ending number="1" type="start"/></barline></measure><measure number="2"><barline location="right"><ending number="1" type="stop"/></barline></measure>');
    expect(endings(closeOpenEndings(xml))).toEqual(["1:start", "1:stop"]);
  });
});

describe("crossingBoundaries", () => {
  const n = (step: string, extra = "") => `<note><pitch><step>${step}</step><octave>4</octave></pitch><duration>4</duration><type>whole</type>${extra}</note>`;
  const tie = (t: string) => `<notations><tied type="${t}"/></notations>`;
  const slur = (t: string) => `<notations><slur number="1" type="${t}"/></notations>`;
  it("gives where the oldest tie chain or slur running into each bar began", () => {
    const xml = score(
      `<measure number="1"><attributes><divisions>1</divisions></attributes>${n("C", tie("start"))}</measure>` +
        `<measure number="2">${n("C", tie("stop") + tie("start"))}</measure>` +
        `<measure number="3">${n("C", tie("stop"))}</measure>` +
        `<measure number="4">${n("D", slur("start"))}</measure>` +
        `<measure number="5">${n("E", slur("stop"))}</measure>` +
        `<measure number="6">${n("F")}</measure>`,
    );
    expect(crossingBoundaries(loadScore(new TextEncoder().encode(xml)).score)).toEqual([-1, 0, 0, -1, 3, -1, -1]);
  });
});
