/**
 * Doubles for the network and process modules, used with `vi.mock` (FIX2A F7). A test that replaces
 * `node:http`, `node:https`, `node:net`, `node:tls`, `node:dns`, `node:dgram`, `node:http2` and
 * `node:child_process` with these makes any call into them throw and be recorded, so "the probe makes
 * no network call" is checked against the modules the probe could actually reach, not against a spy
 * on an object the probe never imports.
 *
 * ```ts
 * vi.mock("node:http", async () => (await import("../test-support/no-network.js")).networkDouble("node:http"));
 * ```
 */

/** Every call into a double, as `module.member`. */
export const networkCalls: string[] = [];

const MEMBERS: Readonly<Record<string, readonly string[]>> = {
  "node:http": ["request", "get", "createServer", "Agent", "ClientRequest"],
  "node:https": ["request", "get", "createServer", "Agent"],
  "node:http2": ["connect", "createServer", "createSecureServer"],
  "node:net": ["connect", "createConnection", "createServer", "Socket"],
  "node:tls": ["connect", "createServer", "TLSSocket"],
  "node:dgram": ["createSocket"],
  "node:dns": ["lookup", "resolve", "resolve4", "resolve6", "Resolver"],
  "node:dns/promises": ["lookup", "resolve", "resolve4", "resolve6", "Resolver"],
  "node:child_process": [
    "spawn",
    "exec",
    "execFile",
    "fork",
    "spawnSync",
    "execSync",
    "execFileSync",
  ],
};

/** The module names {@link networkDouble} knows. */
export const NETWORK_DOUBLE_MODULES: readonly string[] = Object.keys(MEMBERS);

/** An ES module namespace whose every member throws when called, with a `default` of the same members. */
export function networkDouble(moduleName: string): Record<string, unknown> {
  const names = MEMBERS[moduleName];
  if (names === undefined) throw new Error(`no network double for ${moduleName}`);
  const members: Record<string, unknown> = {};
  for (const name of names) {
    members[name] = (): never => {
      networkCalls.push(`${moduleName}.${name}`);
      throw new Error(`a probe called ${moduleName}.${name}`);
    };
  }
  return { ...members, default: { ...members } };
}

/** Replaces `globalThis.fetch` with a throwing recorder; returns the undo. */
export function installFetchDouble(): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = ((): never => {
    networkCalls.push("globalThis.fetch");
    throw new Error("a probe called fetch");
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}
