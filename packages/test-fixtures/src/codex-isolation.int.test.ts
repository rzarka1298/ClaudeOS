import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AUTH_HEADER, HANDSHAKE_PATH, type HandshakeResponse, SNAPSHOT_PATH } from "@ccc/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  requestJsonOverSocket,
  requestOverSocket,
  startServiceForTest,
} from "./service-harness.js";
import { withTempSocketDir } from "./socket-fixture.js";

/**
 * Test isolation for the Codex surface: a service spawned by the harness never
 * stats or runs the machine's real Codex. A fake candidate directory holds a
 * script that records each execution, so "0 runs when disabled, 1 run when
 * pointed at the fake directory" is observable without any real binary.
 */
const KEYCHAIN_SERVICE_NAME = "com.claude-command-center";
let account: string;

beforeEach(() => {
  account = `install-secret-test-${randomBytes(6).toString("hex")}`;
  process.env.CCC_INSTALL_SECRET_ACCOUNT = account;
});

afterEach(() => {
  delete process.env.CCC_INSTALL_SECRET_ACCOUNT;
  try {
    execFileSync(
      "security",
      ["delete-generic-password", "-a", account, "-s", KEYCHAIN_SERVICE_NAME],
      {
        stdio: "ignore",
      },
    );
  } catch (err: unknown) {
    if ((err as { status?: number }).status !== 44) throw err;
  }
});

function fakeCandidateDir(root: string): { dir: string; log: string } {
  const dir = join(root, "fake-bin");
  const log = join(root, "runs.log");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "codex"), `#!/bin/sh\necho ran >> '${log}'\necho 'codex-cli 0.1.0'\n`);
  chmodSync(join(dir, "codex"), 0o755);
  return { dir, log };
}

const runs = (log: string): number =>
  existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0;

async function takeSnapshot(socketPath: string): Promise<void> {
  const hs = await requestJsonOverSocket<HandshakeResponse>(socketPath, {
    method: "POST",
    path: HANDSHAKE_PATH,
  });
  await requestOverSocket(socketPath, {
    method: "GET",
    path: SNAPSHOT_PATH,
    headers: { [AUTH_HEADER]: `Bearer ${hs.body.token}` },
  });
}

describe("a harness-spawned service never runs the real machine's Codex", () => {
  it("runs the fake candidate 0 times when candidates are disabled (the harness default)", async () => {
    await withTempSocketDir(async ({ dir, socketPath }) => {
      const fake = fakeCandidateDir(dir);
      const handle = await startServiceForTest({
        socketPath,
        dbPath: join(dir, "operational.db"),
        env: { CCC_CODEX_CANDIDATES_DIR: fake.dir },
      });
      try {
        await takeSnapshot(socketPath);
        await new Promise((r) => setTimeout(r, 1500));
        expect(runs(fake.log)).toBe(0);
      } finally {
        await handle.stop();
      }
    });
  }, 20000);

  it("runs the fake candidate once when pointed at the fake directory", async () => {
    await withTempSocketDir(async ({ dir, socketPath }) => {
      const fake = fakeCandidateDir(dir);
      const handle = await startServiceForTest({
        socketPath,
        dbPath: join(dir, "operational.db"),
        env: { CCC_CODEX_CANDIDATES_DISABLED: "0", CCC_CODEX_CANDIDATES_DIR: fake.dir },
      });
      try {
        await takeSnapshot(socketPath);
        for (let i = 0; i < 40 && runs(fake.log) === 0; i++) {
          await new Promise((r) => setTimeout(r, 100));
        }
        await new Promise((r) => setTimeout(r, 500));
        expect(runs(fake.log)).toBe(1);
      } finally {
        await handle.stop();
      }
    });
  }, 20000);
});
