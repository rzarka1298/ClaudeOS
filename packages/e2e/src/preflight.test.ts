import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type Fingerprint, type PreflightPorts, runPreflight } from "./preflight.js";
import { pathsForRoot } from "./run-root.js";
import type { SandboxHandle, SandboxOutcome } from "./sandbox.js";

const ROOT = "/tmp/ccc-uat.test02";
const paths = pathsForRoot(ROOT, "0123abcd");
const STILL: Fingerprint = { storeHash: "h".repeat(64), socketMtimeMs: 1000, running: true };

function harness(
  over: Partial<PreflightPorts> = {},
  setup: { leaks?: number; removed?: boolean; fingerprints?: Fingerprint[] } = {},
) {
  const calls: string[] = [];
  const sandbox = {
    paths,
    runId: "0123abcd",
    account: "ccc-uat-0123abcd",
  } as unknown as SandboxHandle;
  const fingerprints = [...(setup.fingerprints ?? [STILL, STILL])];
  const ports: PreflightPorts = {
    runSandbox: async <T>(body: (box: SandboxHandle) => Promise<T>) => {
      calls.push("sandbox-start");
      let value: T | undefined;
      let error: unknown;
      try {
        value = await body(sandbox);
      } catch (err) {
        error = err;
      }
      calls.push("teardown", "delete-account", "leak-check");
      const leaks = Array.from({ length: setup.leaks ?? 0 }, (_unused, index) => ({
        pid: 9 + index,
      }));
      return {
        ok: error === undefined && leaks.length === 0,
        value,
        error,
        leaks,
        cleanupErrors: [],
        runId: "0123abcd",
        runRoot: ROOT,
        runRootRemoved: setup.removed ?? true,
        sweep: { status: "clean" },
      } as unknown as SandboxOutcome<T>;
    },
    startService: async () => {
      calls.push("start");
      return {
        stop: async () => {
          calls.push("stop");
        },
      };
    },
    handshake: async () => {
      calls.push("handshake");
    },
    proposeTestApproval: async () => {
      calls.push("propose");
      return "proposal-1";
    },
    pendingIds: async () => {
      calls.push("list");
      return ["proposal-1"];
    },
    auditRows: async () => {
      calls.push("store-copy");
      return 1;
    },
    fingerprint: async () => {
      calls.push("fingerprint");
      return fingerprints.shift() ?? STILL;
    },
    ...over,
  };
  return { ports, calls };
}

describe("runPreflight (Test 2)", () => {
  it("passes only when every step succeeds, in order, with the fingerprint taken before and after", async () => {
    const h = harness();
    const outcome = await runPreflight({ requireRealService: false }, h.ports);
    expect(outcome.ok).toBe(true);
    expect(h.calls).toEqual([
      "fingerprint",
      "sandbox-start",
      "start",
      "handshake",
      "propose",
      "list",
      "store-copy",
      "stop",
      "teardown",
      "delete-account",
      "leak-check",
      "fingerprint",
    ]);
  });

  it("fails when the real store hash differs before and after", async () => {
    const h = harness({}, { fingerprints: [STILL, { ...STILL, storeHash: "x".repeat(64) }] });
    const outcome = await runPreflight({ requireRealService: false }, h.ports);
    expect(outcome.ok).toBe(false);
    expect(outcome.lines.join("\n")).toMatch(/real store or socket changed/);
  });

  it("fails when the real socket modification time differs", async () => {
    const h = harness({}, { fingerprints: [STILL, { ...STILL, socketMtimeMs: 2000 }] });
    expect((await runPreflight({ requireRealService: false }, h.ports)).ok).toBe(false);
  });

  it("notes a real service that is not running, and fails only with --require-real-service", async () => {
    const off: Fingerprint = { storeHash: null, socketMtimeMs: null, running: false };
    const lax = await runPreflight(
      { requireRealService: false },
      harness({}, { fingerprints: [off, off] }).ports,
    );
    expect(lax.ok).toBe(true);
    expect(lax.lines.join("\n")).toMatch(/not running/);
    const strict = await runPreflight(
      { requireRealService: true },
      harness({}, { fingerprints: [off, off] }).ports,
    );
    expect(strict.ok).toBe(false);
  });

  it("fails on a leak, a run root left behind, no audit row, a missing proposal or a failed handshake", async () => {
    expect(
      (await runPreflight({ requireRealService: false }, harness({}, { leaks: 1 }).ports)).ok,
    ).toBe(false);
    expect(
      (await runPreflight({ requireRealService: false }, harness({}, { removed: false }).ports)).ok,
    ).toBe(false);
    expect(
      (
        await runPreflight(
          { requireRealService: false },
          harness({ auditRows: async () => 0 }).ports,
        )
      ).ok,
    ).toBe(false);
    expect(
      (
        await runPreflight(
          { requireRealService: false },
          harness({ pendingIds: async () => [] }).ports,
        )
      ).ok,
    ).toBe(false);
    const broken = harness({
      handshake: async () => {
        throw new Error("no socket");
      },
    });
    const outcome = await runPreflight({ requireRealService: false }, broken.ports);
    expect(outcome.ok).toBe(false);
    expect(broken.calls).toEqual(
      expect.arrayContaining(["teardown", "delete-account", "leak-check"]),
    );
  });

  it("prints fixed phrases and counts, never a path", async () => {
    const outcome = await runPreflight({ requireRealService: false }, harness().ports);
    expect(outcome.lines.join("\n")).not.toContain("/tmp");
    expect(outcome.lines.join("\n")).not.toContain("proposal-1");
  });
});

describe("the preflight never opens the real store (Test 3)", () => {
  const source = readFileSync(new URL("./preflight.ts", import.meta.url), "utf8");

  it("holds no database tool and no write operation", () => {
    expect(source).not.toMatch(/better-sqlite3|new Database|openDatabase/);
    for (const verb of [
      "writeFile",
      "appendFile",
      "mkdirSync",
      "rmSync",
      "unlinkSync",
      "renameSync",
      "chmodSync",
      "copyFileSync",
      "truncateSync",
    ]) {
      expect(source, verb).not.toContain(verb);
    }
  });

  it("uses the real store and socket paths only to hash bytes and read a stat", () => {
    const uses = source
      .split("\n")
      .filter(
        (line) =>
          /realStorePath|realSocketPath/.test(line) && !line.trimStart().startsWith("import"),
      )
      .filter((line) => !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//"));
    expect(uses.length).toBeGreaterThan(0);
    for (const line of uses) {
      expect(line, line).toMatch(
        /readFileSync|statSync|existsSync|\bconst \w+ = real(Store|Socket)Path\(\)/,
      );
    }
    expect(source).not.toContain("realRuntimeDir");
  });
});

describe("every store copy and read is bound to the run root (Wave 2 store-copy guard)", () => {
  const dir = new URL("../", import.meta.url);
  const files = [
    "src/preflight.ts",
    "src/spec-support/approvals-support.ts",
    "specs/cross-cutting.e2e.ts",
    "specs/synthetic-session.e2e.ts",
  ];

  it("passes runRoot to every copyStore and queryStore call", () => {
    for (const file of files) {
      const source = readFileSync(new URL(file, dir), "utf8");
      const calls = source.match(/(?:copyStore|queryStore)\(\{[\s\S]*?\}\)/g) ?? [];
      expect(calls.length, file).toBeGreaterThan(0);
      for (const call of calls) expect(call, `${file}: ${call.slice(0, 40)}`).toContain("runRoot");
    }
  });
});
