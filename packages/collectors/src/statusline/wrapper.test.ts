import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StatusLineSnapshotSchema } from "@ccc/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SPOOL_MAX_BYTES, STATUSLINE_SPOOL_FILE_NAME } from "../hook/limits.js";
import { COMPILED_STATUSLINE_WRAPPER, runCompiled } from "../test-support/run-compiled.js";
import {
  makeTestRuntimeDir,
  startUdsTestServer,
  type TestRuntimeDir,
  type UdsTestServer,
} from "../test-support/uds-test-server.js";
import { minimizeStatusLine } from "./minimize-status.js";

/** A private repository name that must never leave the machine through the wrapper. */
const REPO_SENTINEL = "ccc-sentinel-private-repo";

/** A status-line JSON in its documented shape (statusline.md). Synthetic values only. */
const STATUS_JSON = {
  hook_event_name: "Status",
  session_id: "0b5c2f7e-3d1a-4c8e-9f60-2a7b1c4d5e6f",
  session_name: "Demo session ✓",
  transcript_path: "/Users/USERNAME/.claude/projects/demo/0b5c2f7e.jsonl",
  cwd: "/Users/USERNAME/code/demo",
  model: { id: "claude-opus-5-5", display_name: "Opus" },
  workspace: {
    current_dir: "/Users/USERNAME/code/demo",
    project_dir: "/Users/USERNAME/code/demo",
    repo: { name: REPO_SENTINEL, owner: REPO_SENTINEL },
  },
  version: "2.1.284",
  output_style: { name: "default" },
  cost: { total_cost_usd: 1.23, total_duration_ms: 45_000, total_lines_added: 12 },
  context_window: { total_input_tokens: 1200, context_window_size: 200_000 },
  rate_limits: {
    five_hour: { used_percentage: 42, resets_at: 1_790_000_000 },
    seven_day: { used_percentage: 10.5, resets_at: "2026-10-01T00:00:00Z" },
  },
  effort: { level: "high" },
  pr: { number: 12, title: `${REPO_SENTINEL} pull request` },
  worktree: { name: REPO_SENTINEL, path: `/Users/USERNAME/code/${REPO_SENTINEL}` },
};

const STATUS_STDIN = JSON.stringify(STATUS_JSON);

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

/** Records the owner's original status-line command, as the installer would. */
function writeOriginal(command: string): void {
  const dir = join(runtime.dir, "statusline");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "original.json"), JSON.stringify({ command }), { mode: 0o600 });
}

function spoolLines(): Record<string, unknown>[] {
  const file = join(runtime.dir, "spool", "hooks.ndjson");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** The latest-only status-line spool file's snapshot, or `undefined` when absent. */
function latestStatusLine(): Record<string, unknown> | undefined {
  const file = join(runtime.dir, "spool", STATUSLINE_SPOOL_FILE_NAME);
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

function runWrapper(stdin: string | Buffer = STATUS_STDIN) {
  return runCompiled(COMPILED_STATUSLINE_WRAPPER, {
    args: ["--runtime-dir", runtime.dir],
    stdin,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("the status-line wrapper relays the owner's command unchanged", () => {
  it("Test 1: stdout bytes (ANSI escapes and trailing newline) and the exit code are the child's", async () => {
    writeOriginal("printf '\\033[1;32mhello\\033[0m world\\n'; exit 3");

    const result = await runWrapper();

    expect(result.stdout.equals(Buffer.from("\u001b[1;32mhello\u001b[0m world\n"))).toBe(true);
    expect(result.code).toBe(3);
  });

  it("Test 2: the child receives the wrapper's stdin byte-for-byte, past the 64 KiB retain cap", async () => {
    const copy = join(runtime.dir, "stdin-copy.bin");
    writeOriginal(`cat > '${copy}'; printf ok`);
    const stdin = Buffer.from(
      JSON.stringify({ ...STATUS_JSON, padding: "é".repeat(60_000), tail: "✓" }),
    );
    expect(stdin.length).toBeGreaterThan(64 * 1024);

    const result = await runWrapper(stdin);

    expect(result.stdout.toString("utf8")).toBe("ok");
    expect(readFileSync(copy).equals(stdin)).toBe(true);
  });

  it("Test 6: with no recorded original command it exits 0 silently and does nothing", async () => {
    server = await startUdsTestServer(runtime.socketPath, "accept");

    const result = await runWrapper();

    expect(result.code).toBe(0);
    expect(result.stdout.length).toBe(0);
    expect(server.started()).toBe(0);
    expect(existsSync(join(runtime.dir, "spool"))).toBe(false);
  });
});

describe("the wrapper forwards documented usage fields only", () => {
  it("Test 3: one POST /api/v1/claude/statusline with the snapshot and no repository, PR or worktree", async () => {
    server = await startUdsTestServer(runtime.socketPath, "accept");
    writeOriginal("sleep 0.3; printf ok");

    const result = await runWrapper();

    expect(result.stdout.toString("utf8")).toBe("ok");
    expect(server.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      "POST /api/v1/handshake",
      "POST /api/v1/claude/statusline",
    ]);
    const body = JSON.parse(server.requests[1]?.body ?? "{}") as Record<string, unknown>;
    expect(StatusLineSnapshotSchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({
      session_id: STATUS_JSON.session_id,
      session_name: STATUS_JSON.session_name,
      model_id: "claude-opus-5-5",
      version: "2.1.284",
      cost_total_usd: 1.23,
      effort_level: "high",
      rate_limits: {
        five_hour: { used_percentage: 42, resets_at: 1_790_000_000 },
        seven_day: { used_percentage: 10.5, resets_at: "2026-10-01T00:00:00Z" },
      },
    });
    for (const key of ["workspace", "pr", "worktree", "repo", "cwd", "transcript_path", "cost"]) {
      expect(body).not.toHaveProperty(key);
    }
    expect(server.requests[1]?.body).not.toContain(REPO_SENTINEL);
    expect(spoolLines()).toEqual([]);
  });

  it.each([
    ["no server", undefined],
    ["a stalling server", "stall"],
  ] as const)(
    "Test 4: with %s the snapshot is kept as the latest status line and the wrapper exits within 150 ms of the child",
    async (_label, mode) => {
      if (mode !== undefined) server = await startUdsTestServer(runtime.socketPath, mode);
      const marker = join(runtime.dir, "child-exited");
      writeOriginal(`printf ok; : > '${marker}'`);

      const result = await runWrapper();

      expect(result.code).toBe(0);
      expect(result.stdout.toString("utf8")).toBe("ok");
      expect(result.closedAt - statSync(marker).mtimeMs).toBeLessThan(150);
      const snapshot = latestStatusLine();
      expect(StatusLineSnapshotSchema.safeParse(snapshot).success).toBe(true);
      expect(JSON.stringify(snapshot)).not.toContain(REPO_SENTINEL);
      // Status-line snapshots never ride in the hook spool (wave 2 review).
      expect(spoolLines()).toEqual([]);
    },
  );
});

describe("status-line snapshots have their own latest-only spool file (wave 2 review)", () => {
  it("a full hook spool is left byte-unchanged and no drop is counted", async () => {
    const spoolDir = join(runtime.dir, "spool");
    mkdirSync(spoolDir, { recursive: true, mode: 0o700 });
    const hookLine = `${JSON.stringify({ hook_event_name: "SessionEnd", filler: "x".repeat(1000) })}\n`;
    const full = Buffer.from(hookLine.repeat(Math.floor(SPOOL_MAX_BYTES / hookLine.length)));
    writeFileSync(join(spoolDir, "hooks.ndjson"), full, { mode: 0o600 });
    writeOriginal("printf ok");

    await runWrapper();

    expect(readFileSync(join(spoolDir, "hooks.ndjson")).equals(full)).toBe(true);
    expect(existsSync(join(spoolDir, "hooks.dropped"))).toBe(false);
    expect(StatusLineSnapshotSchema.safeParse(latestStatusLine()).success).toBe(true);
  });

  it("repeated undelivered snapshots keep only the latest, 0600 in a 0700 dir, with no temp file left", async () => {
    writeOriginal("printf ok");

    await runWrapper(JSON.stringify({ ...STATUS_JSON, cost: { total_cost_usd: 1 } }));
    await runWrapper(JSON.stringify({ ...STATUS_JSON, cost: { total_cost_usd: 2 } }));

    expect(latestStatusLine()?.cost_total_usd).toBe(2);
    const spoolDir = join(runtime.dir, "spool");
    expect(readdirSync(spoolDir)).toEqual([STATUSLINE_SPOOL_FILE_NAME]);
    expect(statSync(spoolDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(spoolDir, STATUSLINE_SPOOL_FILE_NAME)).mode & 0o777).toBe(0o600);
  });
});

describe("the wrapper shares its process group with the owner's command", () => {
  it("Test 5: killing the wrapper's process group leaves no orphaned child", async () => {
    const pidFile = join(runtime.dir, "child.pid");
    writeOriginal(`echo $$ > '${pidFile}'; exec sleep 5`);
    const wrapper = spawn(
      process.execPath,
      [COMPILED_STATUSLINE_WRAPPER, "--runtime-dir", runtime.dir],
      {
        detached: true,
        stdio: ["pipe", "ignore", "ignore"],
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/" },
      },
    );
    const closed = new Promise<void>((resolve) => wrapper.once("close", () => resolve()));
    wrapper.stdin.on("error", () => {});
    wrapper.stdin.end(STATUS_STDIN);

    let childPid = Number.NaN;
    for (let waited = 0; waited < 2000 && Number.isNaN(childPid); waited += 20) {
      await sleep(20);
      const text = existsSync(pidFile) ? readFileSync(pidFile, "utf8").trim() : "";
      if (/^\d+$/.test(text)) childPid = Number(text);
    }
    expect(Number.isNaN(childPid)).toBe(false);
    expect(isAlive(childPid)).toBe(true);

    process.kill(-(wrapper.pid ?? 0), "SIGTERM");
    await closed;
    for (let waited = 0; waited < 1000 && isAlive(childPid); waited += 20) {
      await sleep(20);
    }
    expect(isAlive(childPid)).toBe(false);
  });
});

describe("minimizeStatusLine", () => {
  const meta = {
    eventId: "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b",
    observedAt: "2026-09-28T10:00:00.000Z",
  };

  it("keeps only the documented usage and identity fields", () => {
    const snapshot = minimizeStatusLine(STATUS_STDIN, meta);
    expect(Object.keys(snapshot ?? {}).sort()).toEqual(
      [
        "cost_total_usd",
        "effort_level",
        "eventId",
        "model_id",
        "observedAt",
        "rate_limits",
        "session_id",
        "session_name",
        "version",
      ].sort(),
    );
  });

  it("cuts an over-long session name to the schema cap rather than invalidating the snapshot", () => {
    const snapshot = minimizeStatusLine(
      JSON.stringify({ ...STATUS_JSON, session_name: "n".repeat(1000) }),
      meta,
    );
    expect(snapshot?.session_name).toBe("n".repeat(256));
    expect(StatusLineSnapshotSchema.safeParse(snapshot).success).toBe(true);
  });

  it("keeps a rate-limit window absent when it is absent", () => {
    const snapshot = minimizeStatusLine(
      JSON.stringify({
        ...STATUS_JSON,
        rate_limits: { seven_day: STATUS_JSON.rate_limits.seven_day },
      }),
      meta,
    );
    expect(snapshot?.rate_limits).toEqual({ seven_day: STATUS_JSON.rate_limits.seven_day });
  });

  it("returns null without a session_id or for unparseable input", () => {
    expect(minimizeStatusLine(JSON.stringify({ model: { id: "x" } }), meta)).toBeNull();
    expect(minimizeStatusLine("{not json", meta)).toBeNull();
  });
});
