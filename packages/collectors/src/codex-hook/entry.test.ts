import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CodexHookRecordSchema } from "@ccc/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildCodexStdin,
  CODEX_TEST_CWD,
  CODEX_TEST_MODEL,
  CODEX_TEST_SESSION_ID,
  CODEX_TEST_TURN_ID,
} from "../test-support/codex-hook-stdin.js";
import { SENTINEL } from "../test-support/hook-stdin.js";
import { COMPILED_CODEX_HOOK_ENTRY, runCompiled } from "../test-support/run-compiled.js";
import {
  makeTestRuntimeDir,
  startUdsTestServer,
  TEST_SERVER_TOKEN,
  type TestRuntimeDir,
  type UdsTestServer,
} from "../test-support/uds-test-server.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let runtime: TestRuntimeDir;
let server: UdsTestServer | undefined;

beforeEach(() => {
  runtime = makeTestRuntimeDir();
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  runtime.remove();
});

describe("compiled Codex hook entry (tracer)", () => {
  it("Test 1: authenticates, then posts one minimized Stop record over the Unix socket", async () => {
    server = await startUdsTestServer(runtime.socketPath, "accept");

    const result = await runCompiled(COMPILED_CODEX_HOOK_ENTRY, {
      args: ["--runtime-dir", runtime.dir],
      stdin: buildCodexStdin("Stop"),
    });

    expect(server.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      "POST /api/v1/handshake",
      "POST /api/v1/codex/hook-events",
    ]);
    const post = server.requests[1];
    expect(post?.headers.authorization).toBe(`Bearer ${TEST_SERVER_TOKEN}`);
    const body = JSON.parse(post?.body ?? "") as Record<string, unknown>;
    expect(body.hook_event_name).toBe("Stop");
    expect(body.eventId).toMatch(UUID_PATTERN);
    expect(new Date(String(body.observedAt)).toISOString()).toBe(body.observedAt);
    expect(body.session_id).toBe(CODEX_TEST_SESSION_ID);
    expect(body.turn_id).toBe(CODEX_TEST_TURN_ID);
    expect(body.model).toBe(CODEX_TEST_MODEL);
    expect(body.cwd).toBe(CODEX_TEST_CWD);
    expect(post?.body).not.toContain(SENTINEL);
    expect(body).not.toHaveProperty("last_assistant_message");
    expect(body).not.toHaveProperty("transcript_path");
    expect(CodexHookRecordSchema.safeParse(body).success).toBe(true);
    expect(result.code).toBe(0);
    expect(result.stdout.toString("utf8")).toBe("");
  });

  it("Test 2: with no server, exits 0 silently within 350 ms and spools exactly one line to the Codex spool", async () => {
    const result = await runCompiled(COMPILED_CODEX_HOOK_ENTRY, {
      args: ["--runtime-dir", runtime.dir],
      stdin: buildCodexStdin("Stop"),
    });

    const spoolDir = join(runtime.dir, "spool");
    const spoolFile = join(spoolDir, "codex-hooks.ndjson");
    expect(existsSync(spoolFile)).toBe(true);
    const lines = readFileSync(spoolFile, "utf8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
    expect(record.hook_event_name).toBe("Stop");
    expect(CodexHookRecordSchema.safeParse(record).success).toBe(true);
    expect(lines[0]).not.toContain(SENTINEL);
    expect(existsSync(join(spoolDir, "hooks.ndjson"))).toBe(false);
    expect(statSync(spoolDir).mode & 0o777).toBe(0o700);
    expect(statSync(spoolFile).mode & 0o777).toBe(0o600);
    expect(result.code).toBe(0);
    expect(result.stdout.toString("utf8")).toBe("");
    expect(result.wallMs).toBeLessThanOrEqual(350);
  });
});
