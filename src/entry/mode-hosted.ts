// Marks this process as hosted before anything else is evaluated, so that
// src/self/guard.ts throws if a self-mode module is ever loaded into it.
// It must stay the first import of src/entry/hosted.ts.
(globalThis as { __CLANK_MODE__?: string }).__CLANK_MODE__ = "hosted";

export {};
