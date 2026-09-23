// Lint fixture (plan 03-01, task 3). Exists to TRIP the
// NETWORK_ISOLATION_RULES `no-restricted-imports` entry for the `obsidian`
// path's `requestUrl` import name.
//
// This is the non-obvious one (03-RESEARCH.md, Pitfall 3): `requestUrl` and
// `request` are Obsidian's OWN network helpers, and packages/plugin is the
// one element in the repository permitted to import `obsidian` at all. The
// boundaries element map therefore approves the edge, and a module-name rule
// would have to ban `obsidian` wholesale to see it. Restricting the import
// NAMES is what closes it.
//
// Asserted by packages/test-fixtures/src/plugin-lint.test.ts.
import { requestUrl } from "obsidian";

export async function loadRemoteBody(url: string): Promise<string> {
  const response = await requestUrl({ url });
  return response.text;
}
