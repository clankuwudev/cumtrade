import { html } from "./dom.js";
import { n } from "./format.js";

// ------------------------------------------------------------------ svg --
// Ring geometry per size, taken from the artboards rather than derived, so a
// ring drawn here is pixel-identical to the one on the canvas.
const RING = {
  66: { r: 29, sw: 4, fs: 16 },
  // The token page's header (U4), between the old token page's 66 and the board's 44.
  56: { r: 24.5, sw: 3.5, fs: 14 },
  44: { r: 19, sw: 3, fs: 11.5 },
  30: { r: 13, sw: 2.5, fs: 9 },
  26: { r: 11, sw: 2.5, fs: 0 },
};

/**
 * Progress ring, optionally with the token's own picture inside it.
 *
 * `token` is opt-in: the initials stay as the fallback and are rendered
 * underneath, so a logo that 404s, times out or turns out not to be an image
 * reveals them rather than leaving a hole. A failed <img> is removed by
 * `dropBrokenLogo` instead of showing a broken-image glyph.
 */
export function ring(size, progress, color, label, token) {
  const g = RING[size];
  const c = 2 * Math.PI * g.r;
  const p = Math.min(1, Math.max(0, n(progress)));
  const half = size / 2;
  const inner = (g.r - g.sw / 2) * 2 - 1;
  return html`<span class="ringwrap" style="width:${size}px;height:${size}px">
      <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
        <circle cx="${half}" cy="${half}" r="${g.r}" fill="none" stroke="#202026" stroke-width="${g.sw}"/>
        <circle cx="${half}" cy="${half}" r="${g.r}" fill="none" stroke="${color}" stroke-width="${g.sw}"
          stroke-linecap="round" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${(c * (1 - p)).toFixed(1)}"
          transform="rotate(-90 ${half} ${half})"/>
      </svg>${g.fs ? html`<span class="mono" style="font-size:${g.fs}px">${label}</span>` : ""}${token
        ? html`<img class="pfp" style="width:${inner}px;height:${inner}px"
            src="/api/logo?token=${encodeURIComponent(token)}" alt="" loading="lazy"
            referrerpolicy="no-referrer">`
        : ""}</span>`;
}

/**
 * Remove a token logo that failed to load, so the initials under it show.
 * main.js installs this once on the document in the capture phase, because
 * error events do not bubble. It replaces an inline `onerror`, which the
 * page's CSP forbids (public-release F5.2).
 *
 * @param {Event} e
 */
export function dropBrokenLogo(e) {
  const t = /** @type {any} */ (e.target);
  if (t && t.tagName === "IMG" && t.classList && t.classList.contains("pfp")) t.remove();
}

/** Filled sparkline. Returns nothing below two points rather than drawing a lie. */
export function spark(vals, w, h, color, fill, cls) {
  if (!vals || vals.length < 2) return "";
  const max = Math.max(...vals), min = Math.min(...vals);
  const span = max - min || 1;
  const pts = vals.map((v, i) =>
    `${((i / (vals.length - 1)) * w).toFixed(1)},${(h - 2 - ((v - min) / span) * (h - 4)).toFixed(1)}`).join(" ");
  return html`<svg class="${cls || ""}" width="100%" height="${h}" viewBox="0 0 ${w} ${h}"
      preserveAspectRatio="none" style="display:block">
      <polyline points="0,${h} ${pts} ${w},${h}" fill="${fill}" stroke="none"/>
      <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.6"
        stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

// ---------------------------------------------------------------- icons --
// The login sheet's and the Log in button's icons (the user, 2026-09-23).
// Inline, so nothing is fetched from Google, X or anyone else.

/** Google's four-colour G. */
export const googleIcon = (size = 16) => html`<svg width="${size}" height="${size}" viewBox="0 0 48 48" aria-hidden="true">
    <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
    <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
    <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
    <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
  </svg>`;

/** X's mark, in the text colour. */
export const xIcon = (size = 14) => html`<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">
    <path fill="currentColor" d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
  </svg>`;

/** A wallet, in the text colour. */
export const walletIcon = (size = 16) => html`<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true"
    fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M19 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-3"/>
    <path d="M21 9h-5a3 3 0 0 0 0 6h5a1 1 0 0 0 1-1v-4a1 1 0 0 0-1-1z"/>
  </svg>`;

