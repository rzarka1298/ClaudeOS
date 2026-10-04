// Process-spawn violation fixture (plan 04-03, task 1). Violates D-18 ON
// PURPOSE: it imports the shell-running child_process function by name and
// calls it with a single command string, which a shell would parse. The root
// eslint.config.mjs `no-restricted-syntax` block for packages/launchers and
// packages/service also covers this folder, and
// packages/test-fixtures/src/boundary-lint.test.ts asserts that it fires here
// and falls silent once the body is rewritten to execFile with an argv array.
// The backstop (scripts/check-boundaries.sh rule 8) skips this tree, like
// every other boundary-violations fixture.
import { exec } from "node:child_process";

export function listProjectFolder(): void {
  exec("ls -la");
}
