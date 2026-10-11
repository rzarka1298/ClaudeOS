import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandRunner } from "../projects/command-runner.js";
import { createCodexDetection } from "./detection.js";
import { createDoctorProbe } from "./doctor-probe.js";
import { createRateLimitsClient } from "./rate-limits-client.js";

/**
 * Codex final review (finding 2): building the child environment must not touch the filesystem
 * synchronously, and must give up under a deadline when the volume holding the launcher stalls.
 * Paths under /stalled-volume/ model a hung mount: the synchronous calls block the thread for
 * BLOCK_MS (which freezes the event loop), the asynchronous ones never settle.
 */
const STALLED = "/stalled-volume/";
const BLOCK_MS = 400;
const DEADLINE_MS = 150;

function blockThread(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
const hangs = (path: unknown): boolean => String(path).startsWith(STALLED);
function enoent(): never {
  throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
}

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const guard =
    <A extends unknown[], R>(fn: (...args: A) => R) =>
    (path: A[0], ...rest: unknown[]): R => {
      if (hangs(path)) {
        blockThread(BLOCK_MS);
        return enoent();
      }
      return (fn as (...args: unknown[]) => R)(path, ...rest);
    };
  return {
    ...actual,
    openSync: guard(actual.openSync) as typeof actual.openSync,
    realpathSync: Object.assign(guard(actual.realpathSync), {
      native: actual.realpathSync.native,
    }) as typeof actual.realpathSync,
    statSync: guard(actual.statSync) as typeof actual.statSync,
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const never = <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
    ((path: A[0], ...rest: unknown[]) =>
      hangs(path)
        ? new Promise<R>(() => {})
        : (fn as (...args: unknown[]) => Promise<R>)(path, ...rest)) as unknown as typeof fn;
  return {
    ...actual,
    open: never(actual.open),
    realpath: never(actual.realpath),
    stat: never(actual.stat),
  };
});

/** Records the longest gap between 10 ms timer ticks while `during` runs. */
async function withHeartbeat<T>(during: () => Promise<T>): Promise<{ value: T; maxGapMs: number }> {
  let last = performance.now();
  let maxGapMs = 0;
  const timer = setInterval(() => {
    const t = performance.now();
    maxGapMs = Math.max(maxGapMs, t - last);
    last = t;
  }, 10);
  try {
    const value = await during();
    return { value, maxGapMs };
  } finally {
    clearInterval(timer);
  }
}

const spawnNever = vi.fn(() => {
  throw new Error("must not be reached: preparation never finished");
});
afterEach(() => spawnNever.mockClear());

describe("child environment preparation on a stalled volume", () => {
  it("usage client: unavailable within the deadline, event loop responsive", async () => {
    const client = createRateLimitsClient({
      executablePath: () => `${STALLED}codex`,
      homeDir: () => "/Users/USERNAME",
      spawn: spawnNever,
      envDeadlineMs: DEADLINE_MS,
    });
    const { value, maxGapMs } = await withHeartbeat(() => client.read());
    expect(value.kind).toBe("unavailable");
    expect(maxGapMs).toBeLessThan(BLOCK_MS / 2);
    expect(spawnNever).not.toHaveBeenCalled();
  });

  it("doctor probe: unavailable within the deadline, event loop responsive", async () => {
    const probe = createDoctorProbe({
      executablePath: () => `${STALLED}codex`,
      homeDir: () => "/Users/USERNAME",
      spawn: spawnNever,
      envDeadlineMs: DEADLINE_MS,
    });
    const { value, maxGapMs } = await withHeartbeat(() => probe.run());
    expect(value.kind).toBe("unavailable");
    expect(maxGapMs).toBeLessThan(BLOCK_MS / 2);
    expect(spawnNever).not.toHaveBeenCalled();
  });

  it("detection version probe: no version within the deadline, event loop responsive", async () => {
    const run = vi.fn();
    const detection = createCodexDetection({
      runner: { run } as unknown as CommandRunner,
      homeDir: "/Users/USERNAME",
      candidates: () => [
        { candidateId: "stalled", path: `${STALLED}codex`, location: "user-local" } as never,
      ],
      isExecutable: () => Promise.resolve(true),
      readBridgeStatus: () => {
        throw new Error("not under test");
      },
      envDeadlineMs: DEADLINE_MS,
    });
    const { value, maxGapMs } = await withHeartbeat(() => detection.detectCodex());
    expect(value.executables.map((found) => found.version)).toEqual([null]);
    expect(maxGapMs).toBeLessThan(BLOCK_MS / 2);
    expect(run).not.toHaveBeenCalled();
  });
});
