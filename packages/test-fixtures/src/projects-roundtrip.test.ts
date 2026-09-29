import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { type ProjectsSnapshot, SNAPSHOT_PATH, SnapshotResponseSchema } from "@ccc/domain";
import { projectShortcutsStateFor } from "@ccc/plugin";
import { createAuthenticatedClient, registerProject } from "@ccc/service-api-client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startServiceForTest, type TestServiceHandle } from "./service-harness.js";
import { withTempSocketDir } from "./socket-fixture.js";

/**
 * The Phase 4 tracer (plan 04-07, Task 1): a real registered repository,
 * read by the real built service, shows up on the Project shortcuts card.
 *
 * Every link in the chain is real except the render itself: a mkdtemp Git
 * repository → the real `@ccc/service` built entry point (spawned exactly
 * like `authenticated-roundtrip.test.ts`, with its own throwaway runtime
 * dir and Keychain account) → the typed `registerProject`/`GET /snapshot`
 * client helpers → `projectShortcutsStateFor`, the pure function the
 * Overview card's signal is built from.
 */

const KEYCHAIN_SERVICE_NAME = "com.claude-command-center";
const ITEM_NOT_FOUND_EXIT_CODE = 44;
const FIXTURE_GIT = "/usr/bin/git";
/** Built at runtime so no tracked line is email-shaped (ci:privacy rule 2). */
const AT = String.fromCharCode(64);
const FIXTURE_EMAIL = `example${AT}example.invalid`;
const TEST_BASE = join(homedir(), ".ccc-test");

let throwawayAccount: string;

beforeEach(() => {
  throwawayAccount = `install-secret-test-${randomBytes(6).toString("hex")}`;
  process.env.CCC_INSTALL_SECRET_ACCOUNT = throwawayAccount;
});

afterEach(() => {
  delete process.env.CCC_INSTALL_SECRET_ACCOUNT;
  try {
    execFileSync(
      "security",
      ["delete-generic-password", "-a", throwawayAccount, "-s", KEYCHAIN_SERVICE_NAME],
      { stdio: "ignore" },
    );
  } catch (err: unknown) {
    const status = (err as { status?: number }).status;
    if (status !== ITEM_NOT_FOUND_EXIT_CODE) throw err;
  }
});

/**
 * A real one-commit repository on `main`, built with `/usr/bin/git` through
 * `execFileSync` (argv only, no shell), an empty `HOME` and a runtime-built
 * identity (the same hardened-invocation style as the service's own
 * `git-fixture.ts`) — never the owner's real git configuration.
 */
function buildFixtureRepo(): { root: string; cleanup: () => void } {
  mkdirSync(TEST_BASE, { recursive: true });
  const base = realpathSync.native(mkdtempSync(join(TEST_BASE, "repo-")));
  const home = join(base, "home");
  mkdirSync(home);
  const env = { PATH: "/usr/bin:/bin", HOME: home, GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C" };
  const identity = [
    "-c",
    "user.name=Example",
    "-c",
    `user.email=${FIXTURE_EMAIL}`,
    "-c",
    "init.defaultBranch=main",
    "-c",
    "commit.gpgsign=false",
  ];
  const git = (cwd: string, args: readonly string[]): void => {
    execFileSync(FIXTURE_GIT, [...identity, ...args], { cwd, env, stdio: "ignore" });
  };
  const root = join(base, "example-project");
  mkdirSync(root, { recursive: true });
  git(root, ["init", "-q"]);
  git(root, ["commit", "-q", "--allow-empty", "-m", "initial commit"]);
  return { root, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

/** Polls `GET /snapshot` until the registered project's git state is a read repo (≤10s). */
async function pollUntilRepoRead(
  client: ReturnType<typeof createAuthenticatedClient>,
  attempts = 50,
  delayMs = 200,
): Promise<ProjectsSnapshot> {
  for (let i = 0; i < attempts; i += 1) {
    const res = await client.request<unknown>({ method: "GET", path: SNAPSHOT_PATH });
    const parsed = SnapshotResponseSchema.parse(res.body);
    const [project] = parsed.state.projects.projects;
    if (project !== undefined && project.git.kind === "repo") {
      return parsed.state.projects;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error("Timed out waiting for the registered project's git state to become 'repo'");
}

describe("a real registered repository shows up on the Project shortcuts card (tracer, PROJ-01, PROJ-04, D-43)", () => {
  it("built service → client → projectShortcutsStateFor: one ready row named after the folder", async () => {
    const fixture = buildFixtureRepo();
    try {
      await withTempSocketDir(async ({ dir, socketPath }) => {
        const handle: TestServiceHandle = await startServiceForTest({
          socketPath,
          dbPath: join(dir, "operational.db"),
        });
        try {
          const client = createAuthenticatedClient({ socketPath });

          const registered = await registerProject(client, fixture.root);
          expect(registered.kind).toBe("registered");

          const snapshot = await pollUntilRepoRead(client);
          const [project] = snapshot.projects;
          if (project === undefined || project.git.kind !== "repo") {
            throw new Error("unreachable — pollUntilRepoRead guarantees a read repo");
          }
          expect(project.git.branch).toBe("main");
          expect(project.git.dirty).toBe(false);
          // D-43: the displayPath is home-abbreviated, and the raw home
          // directory string never appears in it.
          expect(project.displayPath.startsWith(homedir())).toBe(false);

          const state = projectShortcutsStateFor(
            snapshot,
            { kind: "live" },
            new Date().toISOString(),
          );
          expect(state.kind).toBe("ready");
          if (state.kind !== "ready") throw new Error("unreachable");
          expect(state.data.projects).toHaveLength(1);
          expect(state.data.projects[0]?.name).toBe(basename(fixture.root));
          expect(state.data.projects[0]?.git.kind).toBe("repo");
        } finally {
          await handle.stop();
        }
      });
    } finally {
      fixture.cleanup();
    }
  }, 15_000);
});
