import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CodexHookRecordSchema } from "@ccc/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SPOOL_MAX_BYTES } from "../hook/limits.js";
import {
  buildCodexStdin,
  CODEX_EXPECTED_KEYS,
  CODEX_TEST_CWD,
  CODEX_TEST_EVENTS,
  CODEX_TEST_MODEL,
  CODEX_TEST_SESSION_ID,
  CODEX_TEST_TURN_ID,
} from "../test-support/codex-hook-stdin.js";
import { SENTINEL } from "../test-support/hook-stdin.js";
import { COMPILED_CODEX_HOOK_ENTRY, runCompiled } from "../test-support/run-compiled.js";
import {
  createStaleSocket,
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

const HOOK_ARGS = (): string[] => ["--runtime-dir", runtime.dir];
const spoolDirOf = (): string => join(runtime.dir, "spool");
const spoolFileOf = (): string => join(runtime.dir, "spool", "codex-hooks.ndjson");
const dropFileOf = (): string => join(runtime.dir, "spool", "codex-hooks.dropped");
const claudeSpoolFileOf = (): string => join(runtime.dir, "spool", "hooks.ndjson");

function spoolLines(): Record<string, unknown>[] {
  if (!existsSync(spoolFileOf())) return [];
  return readFileSync(spoolFileOf(), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Fills the Codex spool file to exactly the cap with syntactically valid lines. */
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
    stdin: () => buildCodexStdin("Stop"),
    check: () => expect(spoolLines()).toHaveLength(1),
  },
  {
    name: "socket file present but nothing listening (connection refused)",
    setup: () => createStaleSocket(runtime.socketPath),
    stdin: () => buildCodexStdin("Stop"),
    check: () => expect(spoolLines()).toHaveLength(1),
  },
  {
    name: "server accepts and stalls",
    setup: async () => {
      server = await startUdsTestServer(runtime.socketPath, "stall");
    },
    stdin: () => buildCodexStdin("Stop"),
    check: () => expect(spoolLines()).toHaveLength(1),
  },
  {
    name: "server returns 500",
    setup: async () => {
      server = await startUdsTestServer(runtime.socketPath, "status500");
    },
    stdin: () => buildCodexStdin("Stop"),
    check: () => expect(spoolLines()).toHaveLength(1),
  },
  {
    name: "spool dir missing (created 0700)",
    setup: () => expect(existsSync(spoolDirOf())).toBe(false),
    stdin: () => buildCodexStdin("Stop"),
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
    stdin: () => buildCodexStdin("Stop"),
    check: () => expect(statSync(spoolFileOf()).size).toBe(SPOOL_MAX_BYTES),
  },
  {
    name: "malformed stdin",
    setup: () => {},
    stdin: () => '{"session_id": "abc", <<not json>>',
    check: () => expect(existsSync(spoolFileOf())).toBe(false),
  },
  {
    name: "stdin of 8 MiB, identifiers inside the retain cap",
    setup: () => {},
    stdin: () =>
      buildCodexStdin("Stop", {
        tail: { last_assistant_message: 4 * 1024 * 1024, prompt: 4 * 1024 * 1024 },
      }),
    check: () => {
      const lines = spoolLines();
      expect(lines).toHaveLength(1);
      expect(lines[0]?.hook_event_name).toBe("Stop");
      expect(lines[0]?.session_id).toBe(CODEX_TEST_SESSION_ID);
      expect(JSON.stringify(lines[0])).not.toContain(SENTINEL);
    },
  },
  {
    name: "stdin of 8 MiB, content first (nothing recoverable)",
    setup: () => {},
    stdin: () =>
      buildCodexStdin("Stop", { overrides: { prompt: "p".repeat(4 * 1024 * 1024) }, tail: {} }),
    check: () => expect(existsSync(spoolFileOf())).toBe(false),
  },
];

describe("Test 4: the hook fails open in every failure case", () => {
  it.each(FAIL_OPEN_CASES)(
    "$name: exits 0, writes no stdout or stderr, finishes within 350 ms",
    async ({ setup, stdin, check }) => {
      await setup();
      const result = await runCompiled(COMPILED_CODEX_HOOK_ENTRY, {
        args: HOOK_ARGS(),
        stdin: stdin(),
      });
      expect(result.code).toBe(0);
      expect(result.stdout.toString("utf8")).toBe("");
      expect(result.stderr).toBe("");
      expect(result.wallMs).toBeLessThanOrEqual(350);
      // The Claude spool is never touched by the Codex hook.
      expect(existsSync(claudeSpoolFileOf())).toBe(false);
      check?.();
    },
  );

  it("at the cap, codex-hooks.ndjson is byte-unchanged and codex-hooks.dropped grows by one byte", async () => {
    const before = fillSpoolToCap();
    writeFileSync(dropFileOf(), "xxx", { mode: 0o600 });

    const result = await runCompiled(COMPILED_CODEX_HOOK_ENTRY, {
      args: HOOK_ARGS(),
      stdin: buildCodexStdin("Stop"),
    });

    expect(result.code).toBe(0);
    expect(readFileSync(spoolFileOf()).equals(before)).toBe(true);
    expect(statSync(dropFileOf()).size).toBe(4);
    expect(statSync(dropFileOf()).mode & 0o777).toBe(0o600);
    expect(existsSync(join(spoolDirOf(), "hooks.dropped"))).toBe(false);
  });

  it("a Claude spool at its cap does not stop the Codex hook spooling (separate files)", async () => {
    mkdirSync(spoolDirOf(), { recursive: true, mode: 0o700 });
    writeFileSync(claudeSpoolFileOf(), Buffer.alloc(SPOOL_MAX_BYTES, 10), { mode: 0o600 });

    const result = await runCompiled(COMPILED_CODEX_HOOK_ENTRY, {
      args: HOOK_ARGS(),
      stdin: buildCodexStdin("Stop"),
    });

    expect(result.code).toBe(0);
    expect(spoolLines()).toHaveLength(1);
    expect(statSync(claudeSpoolFileOf()).size).toBe(SPOOL_MAX_BYTES);
  });
});

describe("Test 5: write-ahead for SessionEnd", () => {
  it("a delivered SessionEnd still leaves its line in the spool, with the delivered eventId", async () => {
    server = await startUdsTestServer(runtime.socketPath, "accept");
    const result = await runCompiled(COMPILED_CODEX_HOOK_ENTRY, {
      args: HOOK_ARGS(),
      stdin: buildCodexStdin("SessionEnd"),
    });

    expect(result.code).toBe(0);
    const posted = server.requests.find((r) => r.url === "/api/v1/codex/hook-events");
    const delivered = JSON.parse(posted?.body ?? "{}") as Record<string, unknown>;
    const lines = spoolLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]?.hook_event_name).toBe("SessionEnd");
    expect(lines[0]?.eventId).toBe(delivered.eventId);
  });

  it("an undelivered SessionEnd is spooled exactly once, not twice", async () => {
    const result = await runCompiled(COMPILED_CODEX_HOOK_ENTRY, {
      args: HOOK_ARGS(),
      stdin: buildCodexStdin("SessionEnd"),
    });

    expect(result.code).toBe(0);
    expect(spoolLines()).toHaveLength(1);
  });

  it("the SessionEnd line is already on disk when the server first sees the connection", async () => {
    server = await startUdsTestServer(runtime.socketPath, "stall");
    const run = runCompiled(COMPILED_CODEX_HOOK_ENTRY, {
      args: HOOK_ARGS(),
      stdin: buildCodexStdin("SessionEnd"),
    });
    const deadline = Date.now() + 2000;
    while (server.started() < 1 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(server.started()).toBeGreaterThanOrEqual(1);
    // The hook is still waiting on the stalled handshake; the write-ahead line is already there.
    expect(spoolLines()).toHaveLength(1);
    const result = await run;
    expect(result.code).toBe(0);
    expect(spoolLines()).toHaveLength(1);
  });

  it.each(["SessionStart", "UserPromptSubmit", "Stop", "Interrupt"] as const)(
    "a delivered %s is not spooled",
    async (event) => {
      server = await startUdsTestServer(runtime.socketPath, "accept");
      const result = await runCompiled(COMPILED_CODEX_HOOK_ENTRY, {
        args: HOOK_ARGS(),
        stdin: buildCodexStdin(event),
      });

      expect(result.code).toBe(0);
      expect(server.requests).toHaveLength(2);
      expect(existsSync(spoolFileOf())).toBe(false);
    },
  );
});

describe("Test 6: the recursion guards", () => {
  it.each(["CCC_HOOK", "CCC_INTERNAL"])(
    "with %s=1 the hook neither delivers nor spools",
    async (marker) => {
      server = await startUdsTestServer(runtime.socketPath, "accept");
      const result = await runCompiled(COMPILED_CODEX_HOOK_ENTRY, {
        args: HOOK_ARGS(),
        stdin: buildCodexStdin("SessionEnd"),
        env: { [marker]: "1" },
      });

      expect(result.code).toBe(0);
      expect(result.stdout.toString("utf8")).toBe("");
      expect(server.started()).toBe(0);
      expect(existsSync(spoolDirOf())).toBe(false);
    },
  );

  it("the compiled entry marks its own process with CCC_HOOK=1 before any work", () => {
    const source = readFileSync(COMPILED_CODEX_HOOK_ENTRY, "utf8");
    const markIndex = source.search(/process\.env\.CCC_HOOK\s*=\s*"1"/);
    const stdinIndex = source.search(/await readStdinCapped\(/);
    expect(markIndex).toBeGreaterThan(-1);
    expect(stdinIndex).toBeGreaterThan(markIndex);
  });

  it("without --runtime-dir the hook does nothing and still exits 0 silently", async () => {
    const result = await runCompiled(COMPILED_CODEX_HOOK_ENTRY, {
      args: [],
      stdin: buildCodexStdin("Stop"),
    });
    expect(result.code).toBe(0);
    expect(result.stdout.toString("utf8")).toBe("");
    expect(existsSync(spoolDirOf())).toBe(false);
  });
});

describe("Test 7: every delivered body is the exact allowlist and parses with the domain schema", () => {
  it.each(CODEX_TEST_EVENTS)("%s", async (event) => {
    server = await startUdsTestServer(runtime.socketPath, "accept");
    const result = await runCompiled(COMPILED_CODEX_HOOK_ENTRY, {
      args: HOOK_ARGS(),
      stdin: buildCodexStdin(event),
    });

    expect(result.code).toBe(0);
    expect(result.stdout.toString("utf8")).toBe("");
    const post = server.requests.find((r) => r.url === "/api/v1/codex/hook-events");
    const body = JSON.parse(post?.body ?? "{}") as Record<string, unknown>;
    expect(CodexHookRecordSchema.safeParse(body).success).toBe(true);
    expect(Object.keys(body).sort()).toEqual([...CODEX_EXPECTED_KEYS[event]].sort());
    expect(post?.body).not.toContain(SENTINEL);
  });
});

describe("the hook's overall deadline", () => {
  it("exits 0 within its budget when stdin never reaches EOF, delivering and spooling nothing", async () => {
    server = await startUdsTestServer(runtime.socketPath, "accept");
    const child = spawn(
      process.execPath,
      [COMPILED_CODEX_HOOK_ENTRY, "--runtime-dir", runtime.dir],
      {
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/" },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const startedAt = performance.now();
    child.stdin.on("error", () => {});
    // Half a payload, and stdin is never ended: Codex must not wait on it.
    child.stdin.write(buildCodexStdin("Stop").slice(0, 40));
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
