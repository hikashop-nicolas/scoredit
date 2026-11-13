// @vitest-environment happy-dom
import { closeOpenEndings } from "./pdf-export";

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
