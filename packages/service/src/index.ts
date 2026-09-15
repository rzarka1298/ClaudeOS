// `@ccc/service`'s real entry point is `main.ts` (the composition root
// launchd/dev runs directly as `dist/main.js`) — importing it triggers
// startup side effects, so it is intentionally not re-exported here. This
// file exists so the package follows the same `src/index.ts` shape every
// other workspace package does; it re-exports the side-effect-free pieces.
export { resolveDbPath, resolveRuntimeDir, resolveSocketPath, SocketPathTooLongError } from "./paths.js";
export { createRequestListener } from "./routes.js";
export type { RouteContext } from "./routes.js";
