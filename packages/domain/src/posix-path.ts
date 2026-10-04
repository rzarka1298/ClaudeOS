/**
 * A pure, isomorphic `path.isAbsolute` equivalent for POSIX paths (project
 * constraint: macOS only for v1, so POSIX-only is the whole platform).
 *
 * `@ccc/domain` ships both to the service (Node) and to the Obsidian
 * plugin — which the visual-regression harness (`packages/test-fixtures`)
 * bundles for a plain browser page with zero Node built-ins available
 * (`platform: "browser"`, no externals, by design — PRIV-04 layer 1). Node's
 * own `path.isAbsolute` needs `node:path`, which an unconditional top-level
 * import makes fatal to resolve there even when the binding using it is
 * never called: a bundler must resolve every import in a file it includes,
 * whether or not tree-shaking would later prove the code path dead. This
 * one-line equivalent lets `api.ts` and `projects.ts` — both reachable from
 * the plugin's public entry — carry zero Node dependency, while
 * `path-containment.ts`'s genuine `node:fs` need (real `realpathSync`, which
 * has no browser equivalent) stays exactly where it is, service-only.
 */
export function isAbsolutePosixPath(value: string): boolean {
  return value.length > 0 && value.charCodeAt(0) === 0x2f; // "/"
}
