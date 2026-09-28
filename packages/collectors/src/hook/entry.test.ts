import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { HOOK_RECORD_SCHEMAS } from "@ccc/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COMPILED_HOOK_ENTRY, runCompiled } from "../test-support/run-compiled.js";
import {
  makeTestRuntimeDir,
  startUdsTestServer,
  TEST_SERVER_TOKEN,
  type TestRuntimeDir,
  type UdsTestServer,
} from "../test-support/uds-test-server.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A SessionStart payload in its documented input shape. Synthetic values only. */
const SESSION_START_STDIN = JSON.stringify({
  session_id: "0b5c2f7e-3d1a-4c8e-9f60-2a7b1c4d5e6f",
  transcript_path: "/Users/USERNAME/.claude/projects/demo/0b5c2f7e.jsonl",
  cwd: "/Users/USERNAME/code/demo",
  hook_event_name: "SessionStart",
  source: "startup",
  model: "claude-opus-5-5",
});

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

describe("compiled hook entry (tracer)", () => {
  it("Test 1: authenticates, then posts one minimized SessionStart record over the Unix socket", async () => {
    server = await startUdsTestServer(runtime.socketPath, "accept");

    const result = await runCompiled(COMPILED_HOOK_ENTRY, {
      args: ["--runtime-dir", runtime.dir],
      stdin: SESSION_START_STDIN,
      env: { CLAUDE_PID: "4242" },
    });

    expect(server.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      "POST /api/v1/handshake",
      "POST /api/v1/claude/hook-events",
    ]);
    const post = server.requests[1];
    expect(post?.headers.authorization).toBe(`Bearer ${TEST_SERVER_TOKEN}`);
    const body = JSON.parse(post?.body ?? "") as Record<string, unknown>;
    expect(body.hook_event_name).toBe("SessionStart");
    expect(body.eventId).toMatch(UUID_PATTERN);
    expect(new Date(String(body.observedAt)).toISOString()).toBe(body.observedAt);
    expect(body.session_id).toBe("0b5c2f7e-3d1a-4c8e-9f60-2a7b1c4d5e6f");
    expect(body.source).toBe("startup");
    expect(body.env).toEqual({ CLAUDE_PID: "4242" });
    expect(HOOK_RECORD_SCHEMAS.SessionStart.safeParse(body).success).toBe(true);
    expect(result.code).toBe(0);
    expect(result.stdout.toString("utf8")).toBe("");
  });

  it("Test 2: with no server, exits 0 silently within 350 ms and spools exactly one line", async () => {
    const result = await runCompiled(COMPILED_HOOK_ENTRY, {
      args: ["--runtime-dir", runtime.dir],
      stdin: SESSION_START_STDIN,
      env: { CLAUDE_PID: "4242" },
    });

    const spoolDir = join(runtime.dir, "spool");
    const spoolFile = join(spoolDir, "hooks.ndjson");
    const lines = readFileSync(spoolFile, "utf8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
    expect(record.hook_event_name).toBe("SessionStart");
    expect(HOOK_RECORD_SCHEMAS.SessionStart.safeParse(record).success).toBe(true);
    expect(statSync(spoolDir).mode & 0o777).toBe(0o700);
    expect(statSync(spoolFile).mode & 0o777).toBe(0o600);
    expect(result.code).toBe(0);
    expect(result.stdout.toString("utf8")).toBe("");
    expect(result.wallMs).toBeLessThanOrEqual(350);
  });
});
