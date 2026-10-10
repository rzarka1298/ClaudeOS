// Local import resolver for eslint-plugin-boundaries (research Pattern 1,
// defect B; docs/adr/0019-import-boundary-enforcement.md).
//
// Every relative import in this repository is written with a `.js` suffix
// (NodeNext), but only `.ts` sources exist under `src/`. The default resolver
// therefore finds nothing, the dependency's target is "unknown", and
// `boundaries/dependencies` silently skips the edge -- which made every
// intra-package edge (including the `untrusted` element) invisible to the
// lint. This resolver maps `./x.js` to `./x.ts` so those edges are evaluated.
// No dependency: Node built-ins only. It is CommonJS because the root
// package.json is `type: module` and the plugin loads resolvers with require.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { builtinModules, createRequire } = require("node:module");

exports.interfaceVersion = 2;

exports.resolve = (source, file) => {
  if (source.startsWith("node:") || builtinModules.includes(source)) {
    return { found: true, path: null };
  }
  if (source.startsWith(".")) {
    const base = path.resolve(path.dirname(file), source);
    const stem = base.replace(/\.(m|c)?js$/, "");
    const candidates = [
      `${stem}.ts`,
      `${stem}.tsx`,
      `${stem}/index.ts`,
      base,
      `${base}.ts`,
      `${base}.tsx`,
      `${base}/index.ts`,
    ];
    for (const candidate of candidates) {
      try {
        if (fs.statSync(candidate).isFile()) return { found: true, path: candidate };
      } catch {
        // try the next candidate
      }
    }
    return { found: false };
  }
  try {
    return { found: true, path: createRequire(file).resolve(source) };
  } catch {
    return { found: false };
  }
};
