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

// Children by tag, for elements read many times over (a chord asked for a dozen children):
// built once per element, and again when its number of children changes.
const index = new WeakMap<Element, { n: number; first: Map<string, Element> }>();
export function kidIndexed(el: Element, tag: string): Element | null {
  const n = el.childElementCount;
  if (n < 6) return kid(el, tag);
  let ix = index.get(el);
  if (!ix || ix.n !== n) {
    const first = new Map<string, Element>();
    for (let c = el.firstElementChild; c; c = c.nextElementSibling) if (!first.has(c.tagName)) first.set(c.tagName, c);
    ix = { n, first };
    index.set(el, ix);
  }
  return ix.first.get(tag) ?? null;
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
