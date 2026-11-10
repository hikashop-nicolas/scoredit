// Small DOM helpers that avoid querySelector, so they behave the same in browsers and in
// the test DOM.

export function kids(el: Element, tag?: string): Element[] {
  const out: Element[] = [];
  for (let c = el.firstElementChild; c; c = c.nextElementSibling) if (!tag || c.tagName === tag) out.push(c);
  return out;
}

export function kid(el: Element, tag: string): Element | null {
  for (let c = el.firstElementChild; c; c = c.nextElementSibling) if (c.tagName === tag) return c;
  return null;
}

export function text(el: Element | null | undefined, tag?: string): string {
  const e = el && tag ? kid(el, tag) : el;
  return e?.textContent?.trim() ?? "";
}

export function parseXml(xml: string): Document {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) throw new Error("The file is not well-formed XML");
  return doc;
}
