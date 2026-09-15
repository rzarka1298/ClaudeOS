// `@ccc/plugin`'s real entry point is `main.ts` (esbuild bundles it to
// `main.js` at the plugin root, per Obsidian's loader contract) — this
// file exists so the package follows the same `src/index.ts` shape every
// other workspace package does; it re-exports the side-effect-free pieces.

export type { ConnectionState } from "./connection-state.js";
export { connectionState, probeConnection } from "./connection-state.js";
