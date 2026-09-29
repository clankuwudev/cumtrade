/**
 * Query results are deliberately `any`, as they always were in practice: the
 * console reads `.value`, `.dataset` and friends off whatever it selects, and
 * typing every element precisely is its own piece of work. What the frontend
 * type check is for is what a module split can break — unknown identifiers,
 * missing imports, wrong arguments.
 *
 * @param {string} s
 * @param {ParentNode} [r]
 * @returns {any}
 */
export const $ = (s, r = document) => r.querySelector(s);

/**
 * @param {string} s
 * @param {ParentNode} [r]
 * @returns {any[]}
 */
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

// ------------------------------------------------------------- templating --
const escape = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** Markup this file produced. The only thing `html` will not escape. */
class Raw { constructor(s) { this.s = s; } }

const flatten = (v) =>
  Array.isArray(v) ? v.map(flatten).join("") :
  v instanceof Raw ? v.s :
  escape(v);

export const html = (strings, ...vals) => new Raw(
  strings.reduce((out, s, i) => out + s + (i < vals.length ? flatten(vals[i]) : ""), ""));

/**
 * The page's one Trusted Types policy (P4 T1). Every hosted page's policy
 * requires trusted HTML at each HTML sink and allows this policy alone, so
 * markup reaches a parser only here, and only as `html` built it, with every
 * value it interpolates escaped. Anything else that writes HTML throws in the
 * browser. Where there is no Trusted Types, markup passes as its string.
 */
const ttPolicy = (() => {
  try {
    return globalThis.trustedTypes?.createPolicy?.("clank-dom", { createHTML: (s) => s }) ?? null;
  } catch {
    return null;
  }
})();
/** @param {string} markup @returns {any} */
const trusted = (markup) => (ttPolicy ? ttPolicy.createHTML(markup) : markup);

/**
 * Replace a node's children with parsed markup.
 *
 * Table sections need their table context or the parser drops every <tr>,
 * which is why the wrap exists rather than a bare body parse.
 */
/** Parse markup into a single detached element, for insertion into a list. */
/**
 * Parsed as `text/html`, so the element is always an HTML element.
 * @returns {HTMLElement | null}
 */
export function node(content) {
  const markup = flatten(content);
  // A table row needs its table around it, as in paint(), or the parser
  // drops the <tr> and every <td> and hands back the first cell's contents.
  const row = /^\s*<tr[\s>]/i.test(markup);
  const doc = new DOMParser().parseFromString(trusted(row ? `<table><tbody>${markup}</tbody></table>` : markup), "text/html");
  const el = (row && doc.querySelector("tr")) || doc.body.firstElementChild;
  return el ? /** @type {HTMLElement} */ (document.importNode(el, true)) : null;
}

export function paint(node, content) {
  const markup = flatten(content);
  const tag = node.tagName;
  const inTable = tag === "TBODY" || tag === "THEAD";
  const doc = new DOMParser().parseFromString(
    trusted(inTable ? `<table>${markup}</table>` : markup), "text/html");
  const src = inTable ? (doc.querySelector(tag.toLowerCase()) ?? doc.body) : doc.body;
  node.replaceChildren(...Array.from(src.childNodes, (c) => document.importNode(c, true)));
}
