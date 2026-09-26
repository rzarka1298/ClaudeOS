// @ccc/launchers — Phase 4 (project registration, git state, application
// and terminal launchers).
//
// Package rule: pure, deterministic logic only. No process spawning, no
// filesystem access, no network; the service composes these functions and
// owns every side effect. The only internal import allowed is @ccc/domain
// (eslint.config.mjs boundary map, SC-7).

export * from "./launch-script.js";
export * from "./sh-quote.js";
