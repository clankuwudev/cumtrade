// Resolve hook for trace-modules.mjs. Appends each resolved file URL once.
import { appendFileSync } from "node:fs";

let out;
const seen = new Set();

export async function initialize(data) {
  out = data?.out;
}

export async function resolve(specifier, context, next) {
  const result = await next(specifier, context);
  if (out && result.url.startsWith("file:") && !seen.has(result.url)) {
    seen.add(result.url);
    appendFileSync(out, result.url + "\n");
  }
  return result;
}
