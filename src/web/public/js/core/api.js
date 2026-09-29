// ------------------------------------------------------------- transport --
/**
 * The session token a self page carries in `<meta name="clank-token">`, as a
 * header, or nothing. A hosted page has no meta tag: nothing there is
 * authorised by a token (public-release F5.2).
 *
 * @param {Pick<Document, "querySelector">} [doc]
 * @returns {Record<string, string>}
 */
export const tokenHeader = (doc = document) => {
  const meta = /** @type {HTMLMetaElement | null} */ (doc.querySelector('meta[name="clank-token"]'));
  return meta && meta.content ? { "x-clank-token": meta.content } : {};
};

/**
 * @param {string} path
 * @param {unknown} [body] present → POST as JSON; absent → GET
 * @returns {Promise<{ status: number, data: any }>}
 */
export const api = async (path, body) => {
  const res = await fetch(path, body === undefined ? { headers: { accept: "application/json" } } : {
    method: "POST",
    headers: { "content-type": "application/json", ...tokenHeader() },
    body: JSON.stringify(body),
  });
  let data = /** @type {any} */ ({});
  try { data = await res.json(); } catch { /* an empty body is still a status */ }
  return { status: res.status, data };
};
