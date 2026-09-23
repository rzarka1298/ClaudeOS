// Lint fixture (plan 03-01, task 3). Exists to TRIP the
// NETWORK_ISOLATION_RULES `no-restricted-globals` entry for `fetch`.
//
// The global `fetch` needs no import at all, so every import-based rule in
// the repository -- the boundaries element map, no-restricted-imports, and
// the former grep backstop rule 2 -- is blind to it (03-RESEARCH.md,
// Pitfall 3). In an Electron renderer this is the easiest way to violate
// ADR-0001's "the plugin reaches the service only through
// @ccc/service-api-client".
//
// Asserted by packages/test-fixtures/src/plugin-lint.test.ts.
export async function loadRemoteStatus(url: string): Promise<string> {
  const response = await fetch(url);
  return response.text();
}
