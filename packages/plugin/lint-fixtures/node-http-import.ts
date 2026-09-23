// Lint fixture (plan 03-01, task 3). Exists to TRIP the
// NETWORK_ISOLATION_RULES `no-restricted-imports` entry for `node:http`.
//
// `manifest.json` declares `isDesktopOnly: true`, so Node built-ins really
// are reachable from this package -- the ban is a policy, not a platform
// limitation, which is exactly why it needs a rule that fires. ADR-0001: the
// only transport the plugin may use is @ccc/service-api-client's Unix domain
// socket.
//
// Asserted by packages/test-fixtures/src/plugin-lint.test.ts.
import { request } from "node:http";

export function openDirectConnection(host: string): void {
  request({ host }).end();
}
