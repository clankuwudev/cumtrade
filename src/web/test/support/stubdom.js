// Just enough of a page for a renderer to paint into, under node --test.
//
// Every selector answers with its own element, made on first ask. paint()
// parses through DOMParser, which here hands the markup straight back, so an
// element's `markup` is exactly what was painted into it. Nothing is parsed:
// a test reads the markup, or its text with the tags stripped.

/** An element that remembers what was painted, written or appended to it. */
function element(markup = "") {
  return {
    markup, textContent: "", value: "", className: "", dataset: {}, children: [], appended: [],
    style: { display: "", setProperty() {} },
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    attrs: {},
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    addEventListener() {}, focus() {}, remove() {}, replaceWith() {},
    querySelector: () => null,
    appendChild(el) { this.appended.push(el); return el; },
    replaceChildren(...nodes) { this.markup = nodes.map((x) => x.markup).join(""); },
  };
}

/**
 * Install the stub page on globalThis. `el(selector)` is the element that
 * selector finds; `reset()` forgets every element, so each test starts blank.
 */
export function stubDom() {
  const els = new Map();
  const el = (sel) => {
    if (!els.has(sel)) els.set(sel, element());
    return els.get(sel);
  };
  globalThis.document = {
    querySelector: el,
    querySelectorAll: () => [],
    importNode: (x) => x,
    createElement: () => element(),
    activeElement: null,
  };
  globalThis.DOMParser = class {
    parseFromString(markup) {
      const only = element(markup);
      return { body: { childNodes: [only], firstElementChild: only }, querySelector: () => null };
    }
  };
  globalThis.window = { scrollTo() {} };
  globalThis.location = { hash: "" };
  return { el, reset: () => els.clear() };
}

/** The words a reader sees in some markup: tags out, entities for the few the renderers use. */
export const textOf = (markup) => String(markup)
  .replace(/<[^>]*>/g, " ")
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/\s+/g, " ")
  .trim();
