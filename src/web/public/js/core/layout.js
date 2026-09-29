// The phone layout, where a script has to know about it (public-release F5.7).
//
// Almost all of the phone layout is phone.css. The exceptions are drawings a
// script sizes: the token chart is drawn in its own units, so its width is
// chosen here, and its readout is placed here.

/** The phone block's query in phone.css. phone.test.js holds the two equal. */
export const PHONE_QUERY = "(max-width: 680px)";

/** The token chart's drawing width: close to the width it is shown at. */
const CHART_WIDTH = { desktop: 600, phone: 340 };

/** Is the page laid out for a phone right now? False where there is no window. */
export const isPhone = () =>
  typeof matchMedia === "function" && matchMedia(PHONE_QUERY).matches;

/**
 * Call `fn(phone)` whenever the page moves across the phone breakpoint, such
 * as when a phone turns sideways.
 *
 * @param {(phone: boolean) => void} fn
 */
export function onPhoneChange(fn) {
  if (typeof matchMedia !== "function") return;
  matchMedia(PHONE_QUERY).addEventListener("change", (e) => fn(e.matches));
}

/**
 * The chart is drawn with `preserveAspectRatio="none"`, so drawn 600 wide and
 * shown 320 wide, its axis labels would be squeezed to half their width.
 *
 * @param {boolean} phone
 */
export const chartWidth = (phone) => (phone ? CHART_WIDTH.phone : CHART_WIDTH.desktop);

/**
 * Where the chart's readout goes: centred on the finger, but kept inside the
 * box, so a readout at either end neither spills out of the card nor widens a
 * phone's page.
 *
 * @param {number} x      the pointer's offset in the box, px
 * @param {number} boxW   the box's width, px
 * @param {number} tipW   the readout's width, px
 */
export function tipLeft(x, boxW, tipW) {
  const half = tipW / 2;
  if (tipW >= boxW) return boxW / 2;
  return Math.min(Math.max(x, half), boxW - half);
}
