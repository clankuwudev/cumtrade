import { html } from "../core/dom.js";
import { SITE_DOMAIN } from "../core/constants.js";
import { BANDS } from "../core/domain.js";
import { API_LIMITS, CHANGES, ENDPOINTS, EVENTS } from "../core/apiFacts.js";

// ====================================================================== //
// the Data API (X21)                                                     //
// ====================================================================== //
//
// The free data API's docs: a section of the About page, listed in Learn's
// contents under Developers (#/learn/api). Everything it states comes from
// core/apiFacts.js, which `npm run test:apidocs` checks against the server.

/** The site the examples call: the one official domain, never whatever page this is served from. */
export const API_BASE = `https://${SITE_DOMAIN}`;

const withBase = (s) => s.split("{base}").join(API_BASE);

/** Fields as a list of name and meaning. */
const fieldList = (fields) => html`<dl class="apif">${fields.map((f) => html`
  <dt><code>${f.name}</code></dt><dd>${f.what}</dd>`)}</dl>`;

/** One endpoint: what it does, what it takes, what it answers, how it refuses, and a real example. */
const endpoint = (e) => html`
  <h3 id="${"api-" + e.path.replace(/\W+/g, "-").replace(/^-|-$/g, "")}"><code>${e.method} ${e.path}</code> · ${e.title}</h3>
  ${e.summary.map((p) => html`<p>${p}</p>`)}
  ${e.params.length ? html`<p><b>Parameters</b></p>${fieldList(e.params)}` : ""}
  ${e.fields.length ? html`<p><b>Answer</b></p>${fieldList(e.fields)}` : ""}
  ${(e.nested || []).map((n) => html`<p><b><code>${n.name}</code></b></p>${fieldList(n.fields)}`)}
  ${e.path === "/events" ? html`<p><b>Events</b></p>${fieldList(EVENTS)}` : ""}
  ${e.errors.length ? html`<p><b>Errors</b></p><dl class="apif">${e.errors.map((x) => html`
    <dt><code>${x.status}</code></dt><dd>${x.when}</dd>`)}</dl>` : ""}
  <pre class="mo">${withBase(e.example)}</pre>
  <pre class="mo apians">${e.answer}</pre>`;

/**
 * The section's body. The About page wraps it in its card, as `api`.
 *
 * @param {string} brand
 */
export const apiBody = (brand) => {
  const L = API_LIMITS;
  return html`
  <p>${brand}&rsquo;s data is free to use from your own code: every launch&rsquo;s verdict, any
    address&rsquo;s positions, price history, and the board as it changes. No key, no sign-up. It
    answers JSON over HTTPS at <code class="mo">${API_BASE}</code>.</p>
  <p><b>Call it from a script or your own server.</b> A page on another website cannot call it from
    the browser: the site sends no CORS headers and refuses requests a browser marks as coming from
    another site, so no website can spend this one&rsquo;s budget through its visitors.</p>

  <h3>Limits</h3>
  <p>Per client, where a client is an IPv4 address or an IPv6 /64:</p>
  <ul>
    <li><code>/api/check</code>: ${L.check.perMin} a minute, ${L.check.burst} of them at once.</li>
    <li><code>/api/ledger</code>: ${L.ledger.perMin} a minute, ${L.ledger.burst} at once, and ${L.ledger.distinctPerHour}
      different addresses an hour. Asking again about the same ones does not count.</li>
    <li>Everything else: ${L.read.perMin} a minute.</li>
    <li><code>/events</code>: ${L.streams} streams open at a time.</li>
  </ul>
  <p>An IPv4 address gets ${L.ipv4Factor}× the last two, because one is often shared by many people.
    There is also a limit shared by all clients, so when the site is busy a request can be refused
    below your own limit.</p>

  <h3>When you are refused</h3>
  <p><code>429</code> means a limit, and <code>503</code> means a chain node is refusing the site for a
    while. Both carry a <code>retry-after</code> header in seconds, and a body like this one. Wait that
    long: asking sooner is refused again.</p>
  <pre class="mo apians">{ "error": "rate-limited", "retryAfter": 12, "text": "Too many requests right now. Try again in 12s." }</pre>

  <h3>Verdicts</h3>
  <p>A <code>band</code> is one of four keys. The site shows each in these words:</p>
  <dl class="apif">${Object.entries(BANDS).map(([key, [, words]]) => html`
    <dt><code>${key}</code></dt><dd>${words}</dd>`)}</dl>
  <p>A band says what the checks found, not whether a token is a good buy: the lowest one means no
    check found anything.</p>

  <h3>Endpoints</h3>
  ${ENDPOINTS.map(endpoint)}

  <h3>What the data is and is not</h3>
  <ul>
    <li>A verdict is the result of automated checks, not advice: see <a href="#/learn/verdicts">how
      verdicts are made</a> and <a href="#/learn/advice">not financial advice</a>.</li>
    <li>Price history is sampled from when this site began watching a token. It is not every trade.</li>
    <li>Positions are rebuilt from the chain&rsquo;s events. <code>confidence</code> and
      <code>partial</code> say where that is incomplete.</li>
    <li>There is no uptime promise. The site can be slow, refuse requests or be down.</li>
  </ul>

  <h3>Changes</h3>
  <p>Fields can be added at any time, so ignore ones you do not know. A field or endpoint removed or
    renamed is listed here, with its date, before it happens.</p>
  <dl class="apif">${CHANGES.map((c) => html`<dt>${c.date}</dt><dd>${c.what}</dd>`)}</dl>`;
};
