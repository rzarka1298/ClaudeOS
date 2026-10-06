import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The collectors package root, resolved from this file (src/test-support/). */
export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** The compiled hook entry the tests spawn — never the TypeScript source. */
export const COMPILED_HOOK_ENTRY = join(PACKAGE_ROOT, "dist", "hook", "entry.js");

/** The compiled status-line wrapper entry. */
export const COMPILED_STATUSLINE_WRAPPER = join(PACKAGE_ROOT, "dist", "statusline", "wrapper.js");

export interface CompiledRunResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: Buffer;
  readonly stderr: string;
  /** Wall time from spawn to the child's `close`, in milliseconds. */
  readonly wallMs: number;
  /** `Date.now()` at the child's `close`. */
  readonly closedAt: number;
}

export interface RunCompiledOptions {
  readonly args?: readonly string[];
  readonly stdin?: Buffer | string;
  /**
   * The child's whole environment on top of PATH and HOME. The test runner's
   * own environment is NOT inherited: a test run inside a Claude Code session
   * carries CLAUDE_PID and friends, which would leak into records.
   */
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * Spawns a compiled entry with `process.execPath` (async, so wall time is
 * measurable), writes stdin and ends it, and resolves once the child closes.
 */
export function runCompiled(
  entryPath: string,
  options: RunCompiledOptions = {},
): Promise<CompiledRunResult> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME ?? "/",
    ...options.env,
  };
  return new Promise((resolveRun, reject) => {
    const startedAt = performance.now();
    const child = spawn(process.execPath, [entryPath, ...(options.args ?? [])], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    // The child may exit before reading all of a large stdin; that EPIPE is
    // the child's business, not a test failure.
    child.stdin.on("error", () => {});
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolveRun({
        code,
        signal,
        stdout: Buffer.concat(stdout),
        stderr,
        wallMs: performance.now() - startedAt,
        closedAt: Date.now(),
      });
    });
    child.stdin.end(options.stdin ?? "");
  });
}
