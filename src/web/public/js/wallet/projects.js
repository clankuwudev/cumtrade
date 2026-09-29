// ====================================================================== //
// which Coinbase project each origin uses                               //
// ====================================================================== //
//
// The trading wallet's Coinbase project, pinned by origin in the release
// (public-release W1.1). Project IDs are public, but they are never taken
// from our server: a compromised server could otherwise point visitors at a
// project of its own, with server-side signing turned on. An origin that is
// not listed here, or whose entry is not filled in, gets no wallet at all.
//
// Coinbase also refuses a project ID from any origin not on that project's
// own list, so a clone that copies this file gets nothing from it.

/** A CDP project ID, as the portal shows it. Anything else is refused. */
const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * @typedef {{ name: string, origin: string, projectId: string }} Project
 * `origin` is exact: scheme, host and port, as `location.origin` gives it.
 */

/** @type {ReadonlyArray<Readonly<Project>>} */
export const PROJECTS = Object.freeze([
  // WAITING ON THE USER'S CDP STAGING PROJECT (W1.1, "What the user must do",
  // 2). Fill in the staging site's origin and the staging project's ID when
  // the user shares them. Never guess either one: while they are empty, the
  // provider refuses to start on every origin.
  Object.freeze({ name: "staging", origin: "", projectId: "" }),
  // The web app on the operator's own machine, first (the user, 2026-09-22):
  // the ClankUwuModel project, whose allowed origins list exactly this one.
  // Never production's project.
  Object.freeze({ name: "staging-local", origin: "http://localhost:8790", projectId: "5fa3921d-9617-48e5-a02e-bb0540fb6203" }),
  // Production: clankuwu.com (L1 N-D1) and the cumtrade-production project.
  // The site moved there from cumtrade.com, and the project stayed the same
  // (N-D5, the user, 2026-09-24), so a visitor who signs in again with their
  // email gets the same address. cumtrade.com only redirects here since L5,
  // so it has no entry: no page runs there.
  Object.freeze({ name: "production", origin: "https://clankuwu.com", projectId: "71cd77b1-e4a1-4bc6-8d53-8ec5c0e549b6" }),
]);

/** Whether an entry is filled in completely and correctly. */
export function usable(p) {
  if (!p || typeof p.origin !== "string" || typeof p.projectId !== "string") return false;
  if (!PROJECT_ID.test(p.projectId)) return false;
  let url;
  try { url = new URL(p.origin); } catch { return false; }
  if (url.origin !== p.origin) return false;
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  return url.protocol === "https:" || (url.protocol === "http:" && local);
}

/**
 * The project ID pinned for this exact origin, or null: no entry, an entry
 * not filled in, or two entries for one origin (a mistake worth refusing).
 */
export function projectFor(origin, projects = PROJECTS) {
  if (typeof origin !== "string" || origin === "") return null;
  const hits = projects.filter((p) => p && p.origin === origin);
  if (hits.length !== 1 || !usable(hits[0])) return null;
  return hits[0].projectId;
}
