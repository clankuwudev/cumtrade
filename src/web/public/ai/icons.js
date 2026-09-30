// cumAI's line icons (AP, the user's mockup): 24-unit strokes in the text's
// colour, drawn inline so the page loads no image for them. Each is fixed
// markup, never built from a value, and carries no style of its own: the
// page's policy allows none.
import { html } from "../js/core/dom.js";

const PATHS = {
  book: "M4 5.5C6.5 4 9.5 4 12 5.5v14c-2.5-1.5-5.5-1.5-8 0zM12 5.5c2.5-1.5 5.5-1.5 8 0v14c-2.5-1.5-5.5-1.5-8 0",
  code: "M8.5 7 3.5 12l5 5M15.5 7l5 5-5 5M13.5 4.5l-3 15",
  bulb: "M9 18h6M10 21h4M12 3a6 6 0 0 0-3.6 10.8c.7.6 1.1 1.4 1.1 2.2h5c0-.8.4-1.6 1.1-2.2A6 6 0 0 0 12 3z",
  sparkle: "M12 3c.6 4.4 2.6 6.4 7 7-4.4.6-6.4 2.6-7 7-.6-4.4-2.6-6.4-7-7 4.4-.6 6.4-2.6 7-7z",
  image: "M4 5h16v14H4zM4 16l5-5 4 4 2-2 5 5M15.5 9.5h.01",
  map: "M9 4 3 6.5v13L9 17l6 2.5 6-2.5V4l-6 2.5zM9 4v13M15 6.5v13",
  city: "M3 20h18M5 20V9l5-3v14M10 20V4h9v16M13 8h3M13 12h3M13 16h3",
  camera: "M4 8h3.5L9 5.5h6L16.5 8H20v11H4zM12 16.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z",
  cube: "M12 3 20 7.5v9L12 21l-8-4.5v-9zM4 7.5 12 12l8-4.5M12 12v9",
  chevron: "m9 6 6 6-6 6",
  down: "m6 9 6 6 6-6",
  alert: "M12 7.5v5.5M12 16.5h.01M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z",
  lock: "M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3",
  coin: "M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17zM14.5 9.5c-.5-.9-1.4-1.3-2.5-1.3-1.5 0-2.5.8-2.5 1.9 0 2.6 5 1.4 5 4 0 1.1-1 1.9-2.5 1.9-1.2 0-2.1-.5-2.6-1.4M12 6.8v1.4M12 15.8v1.4",
  info: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5.5M12 7.5h.01",
  up: "M12 19V5M6 11l6-6 6 6",
};

/** One icon by name, as markup for `html`; aria-hidden, since the words beside it say what it is. */
export const icon = (name, cls = "cai-ico") =>
  html`<svg class="${cls}" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="${PATHS[name] ?? ""}"/></svg>`;
