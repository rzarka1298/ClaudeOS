/**
 * The browser-safe subset of `@ccc/domain` — everything in `index.ts`
 * EXCEPT `path-containment.ts`, whose `checkPathContainment` genuinely needs
 * `node:fs`'s `realpathSync` (real filesystem syscalls have no browser
 * equivalent; this is inherently service-only logic, not a bundling
 * limitation).
 *
 * Every other domain file is now free of top-level Node built-in imports
 * (`posix-path.ts`'s and `ids.ts`'s docblocks record the two swaps that made
 * this true), so this entry point is safe to import from code that must run
 * in a plain browser page with zero Node built-ins available — today, the
 * `packages/test-fixtures` visual-regression harness, reached transitively
 * through `@ccc/plugin`'s public entry (PRIV-04 layer 1). `@ccc/plugin`
 * itself keeps importing the full `@ccc/domain` for TYPES (erased at build
 * time, so they carry no bundling cost); only a genuine VALUE import that
 * the harness's bundle must resolve needs this subpath instead.
 *
 * A bundler resolving a barrel's `export *` must resolve every star-source's
 * own imports to build the graph, whether or not tree-shaking later proves
 * the specific binding used is dead code (import resolution happens before
 * dead-code elimination) — so `index.ts`'s barrel, which still re-exports
 * `path-containment.js`, is unsafe for a browser bundle even for consumers
 * who need none of its exports. This second, narrower barrel is the fix.
 */
export * from "./api.js";
export * from "./auth.js";
export * from "./capability.js";
export * from "./events.js";
export * from "./freshness.js";
export * from "./ids.js";
export * from "./launch.js";
export * from "./layout.js";
export * from "./note-schema.js";
export * from "./projects.js";
export * from "./run.js";
