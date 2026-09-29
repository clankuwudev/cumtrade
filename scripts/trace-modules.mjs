// Record every module a process loads, one file URL per line, to the path in
// TRACE_MODULES_OUT. Used to show that a hosted process never loads anything
// under src/self/ (public-release B1.2):
//
//   TRACE_MODULES_OUT=loaded.txt node --import tsx --import ./scripts/trace-modules.mjs src/entry/hosted.ts
//
// Resolve hooks run on a separate thread, so the hooks live in their own
// module and write straight to the file rather than to this process's stdout.
import { register } from "node:module";

register("./trace-modules-hooks.mjs", import.meta.url, {
  data: { out: process.env.TRACE_MODULES_OUT },
});
