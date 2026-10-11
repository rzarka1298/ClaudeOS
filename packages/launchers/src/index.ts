// @ccc/launchers — Phase 4 (project registration, git state, application
// and terminal launchers).
//
// Package rule: pure, deterministic logic only. No process spawning, no
// filesystem access, no network; the service composes these functions and
// owns every side effect. The only internal import allowed is @ccc/domain
// (eslint.config.mjs boundary map, SC-7).

export * from "./agent-launch.js";
export * from "./app-actions.js";
export * from "./bridge-protocol.js";
export * from "./command-template.js";
export * from "./error-map.js";
export * from "./git-parse.js";
export * from "./github-url.js";
export * from "./launch-script.js";
export * from "./sh-quote.js";
