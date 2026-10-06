import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOOK_RECORD_SCHEMAS } from "@ccc/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildHookStdin, SENTINEL } from "../test-support/hook-stdin.js";
import { COMPILED_HOOK_ENTRY, runCompiled } from "../test-support/run-compiled.js";
import {
  createStaleSocket,
  makeTestRuntimeDir,
  startUdsTestServer,
  TEST_SERVER_TOKEN,
  type TestRuntimeDir,
  type UdsTestServer,
} from "../test-support/uds-test-server.js";
import { SPOOL_MAX_BYTES } from "./limits.js";

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

const HOOK_ARGS = (): string[] => ["--runtime-dir", runtime.dir];
const spoolDirOf = (): string => join(runtime.dir, "spool");
const spoolFileOf = (): string => join(runtime.dir, "spool", "hooks.ndjson");
const dropFileOf = (): string => join(runtime.dir, "spool", "hooks.dropped");

function spoolLines(): Record<string, unknown>[] {
  if (!existsSync(spoolFileOf())) return [];
  return readFileSync(spoolFileOf(), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Fills the spool file to exactly the cap with syntactically valid lines. */
function fillSpoolToCap(): Buffer {
  mkdirSync(spoolDirOf(), { recursive: true, mode: 0o700 });
  const line = `${JSON.stringify({ filler: "x".repeat(1000) })}\n`;
  const lines = Math.floor(SPOOL_MAX_BYTES / Buffer.byteLength(line));
  const body = line.repeat(lines);
  const pad = "\n".repeat(SPOOL_MAX_BYTES - Buffer.byteLength(body));
  const content = Buffer.from(body + pad);
  writeFileSync(spoolFileOf(), content, { mode: 0o600 });
  return content;
}

interface FailOpenCase {
  readonly name: string;
  readonly setup: () => Promise<void> | void;
  readonly stdin: () => string | Buffer;
  readonly check?: () => void;
}

const FAIL_OPEN_CASES: readonly FailOpenCase[] = [
  {
    name: "no socket file",
    setup: () => {},
    stdin: () => buildHookStdin("Stop"),
    check: () => expect(spoolLines()).toHaveLength(1),
  },
  {
    name: "socket file present but nothing listening (connection refused)",
    setup: () => createStaleSocket(runtime.socketPath),
    stdin: () => buildHookStdin("Stop"),
    check: () => expect(spoolLines()).toHaveLength(1),
  },
  {
    name: "server accepts and stalls",
    setup: async () => {
      server = await startUdsTestServer(runtime.socketPath, "stall");
    },
    stdin: () => buildHookStdin("Stop"),
    check: () => expect(spoolLines()).toHaveLength(1),
  },
  {
    name: "server returns 500",
    setup: async () => {
      server = await startUdsTestServer(runtime.socketPath, "status500");
    },
    stdin: () => buildHookStdin("Stop"),
    check: () => expect(spoolLines()).toHaveLength(1),
  },
  {
    name: "spool dir missing (created 0700)",
    setup: () => expect(existsSync(spoolDirOf())).toBe(false),
    stdin: () => buildHookStdin("Stop"),
    check: () => {
      expect(statSync(spoolDirOf()).mode & 0o777).toBe(0o700);
      expect(spoolLines()).toHaveLength(1);
    },
  },
  {
    name: "spool file already at the cap",
    setup: () => {
      fillSpoolToCap();
    },
    stdin: () => buildHookStdin("Stop"),
    check: () => expect(statSync(spoolFileOf()).size).toBe(SPOOL_MAX_BYTES),
  },
  {
    name: "malformed stdin",
    setup: () => {},
    stdin: () => '{"session_id": "abc", <<not json>>',
    check: () => expect(existsSync(spoolFileOf())).toBe(false),
  },
  {
    name: "stdin of 8 MiB",
    setup: () => {},
    stdin: () => buildHookStdin("PostToolUse", { toolPayloadBytes: 4 * 1024 * 1024 }),
    check: () => {
      const lines = spoolLines();
      expect(lines).toHaveLength(1);
      expect(lines[0]?.hook_event_name).toBe("PostToolUse");
      expect(JSON.stringify(lines[0])).not.toContain(SENTINEL);
    },
  },
];

describe("Test 1: the hook fails open in every failure case", () => {
  it.each(FAIL_OPEN_CASES)(
    "$name: exits 0, writes no stdout, finishes within 350 ms",
    async ({ setup, stdin, check }) => {
      await setup();
      const result = await runCompiled(COMPILED_HOOK_ENTRY, { args: HOOK_ARGS(), stdin: stdin() });
      expect(result.code).toBe(0);
      expect(result.stdout.toString("utf8")).toBe("");
      expect(result.wallMs).toBeLessThanOrEqual(350);
      check?.();
    },
  );
});

describe("the spool cap, write-ahead and recursion guards", () => {
  it("Test 2: at the cap, hooks.ndjson is byte-unchanged and hooks.dropped grows by one byte", async () => {
    const before = fillSpoolToCap();
    writeFileSync(dropFileOf(), "xxx", { mode: 0o600 });

    const result = await runCompiled(COMPILED_HOOK_ENTRY, {
      args: HOOK_ARGS(),
      stdin: buildHookStdin("Stop"),
    });

    expect(result.code).toBe(0);
    expect(readFileSync(spoolFileOf()).equals(before)).toBe(true);
    expect(statSync(dropFileOf()).size).toBe(4);
    expect(statSync(dropFileOf()).mode & 0o777).toBe(0o600);
  });

  it("Test 3a: a delivered SessionEnd still leaves its line in the spool (write-ahead)", async () => {
    server = await startUdsTestServer(runtime.socketPath, "accept");
    const result = await runCompiled(COMPILED_HOOK_ENTRY, {
      args: HOOK_ARGS(),
      stdin: buildHookStdin("SessionEnd"),
    });

    expect(result.code).toBe(0);
    const posted = server.requests.find((r) => r.url === "/api/v1/claude/hook-events");
    const delivered = JSON.parse(posted?.body ?? "{}") as Record<string, unknown>;
    const lines = spoolLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]?.hook_event_name).toBe("SessionEnd");
    expect(lines[0]?.eventId).toBe(delivered.eventId);
  });

  it("Test 3b: an undelivered SessionEnd is spooled exactly once, not twice", async () => {
    const result = await runCompiled(COMPILED_HOOK_ENTRY, {
      args: HOOK_ARGS(),
      stdin: buildHookStdin("SessionEnd"),
    });

    expect(result.code).toBe(0);
    expect(spoolLines()).toHaveLength(1);
  });

  it.each(["CCC_HOOK", "CCC_INTERNAL"])(
    "Test 4: with %s=1 the hook neither delivers nor spools",
    async (marker) => {
      server = await startUdsTestServer(runtime.socketPath, "accept");
      const result = await runCompiled(COMPILED_HOOK_ENTRY, {
        args: HOOK_ARGS(),
        stdin: buildHookStdin("SessionEnd"),
        env: { [marker]: "1" },
      });

      expect(result.code).toBe(0);
      expect(result.stdout.toString("utf8")).toBe("");
      expect(server.started()).toBe(0);
      expect(existsSync(spoolDirOf())).toBe(false);
    },
  );

  it("the compiled entry marks its own process with CCC_HOOK=1 before any work", () => {
    const source = readFileSync(COMPILED_HOOK_ENTRY, "utf8");
    const markIndex = source.search(/process\.env\.CCC_HOOK\s*=\s*"1"/);
    const stdinIndex = source.search(/await readStdinCapped\(/);
    expect(markIndex).toBeGreaterThan(-1);
    expect(stdinIndex).toBeGreaterThan(markIndex);
  });
});

describe("the hook's overall deadline (wave 2 review)", () => {
  it("exits 0 within its budget when stdin never reaches EOF, delivering and spooling nothing", async () => {
    server = await startUdsTestServer(runtime.socketPath, "accept");
    const child = spawn(process.execPath, [COMPILED_HOOK_ENTRY, "--runtime-dir", runtime.dir], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const startedAt = performance.now();
    child.stdin.on("error", () => {});
    // Half a payload, and stdin is never ended: Claude Code must not wait on it.
    child.stdin.write(SESSION_START_STDIN.slice(0, 40));
    const stdout: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    const safety = setTimeout(() => child.kill("SIGKILL"), 3000);
    const code = await new Promise<number | null>((resolve) => child.once("close", resolve));
    clearTimeout(safety);
    const wallMs = performance.now() - startedAt;

    expect(code).toBe(0);
    expect(wallMs).toBeLessThanOrEqual(1000);
    expect(Buffer.concat(stdout).length).toBe(0);
    expect(server.started()).toBe(0);
    expect(existsSync(spoolDirOf())).toBe(false);
  });
});
