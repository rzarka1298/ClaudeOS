// Plan 05.1-07 task 3 (D-22, CODEX-12): the product's TypeScript usage guard
// and the agents' wrapper (`scripts/codex/codex.mjs`) are two implementations
// of one refusal gate, so this test proves they agree.
//
// Black box only: the wrapper cannot be imported (it ends in a top-level
// `await main()` that exits), so it is copied into a throwaway repository and
// run as a child process with a FAKE `codex` first on PATH, exactly as
// `codex-wrapper.test.ts` does. The fake answers only the app-server handshake
// and the rate-limit read. No test starts a real Codex, opens a credential
// file or touches the network, and nothing here spends plan allowance.
//
// Scripting the fake through its environment is correct HERE because the
// wrapper hands its own environment to the child. The product's own RPC child
// runs with a minimal environment and must not be tested that way (research
// Pitfall 5).

import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  evaluateGuard,
  normalizeRateLimitsReply,
  normalizeRolloutRateLimits,
} from "@ccc/collectors";
import { afterAll, describe, expect, it } from "vitest";
import { type GateRepo, gateRepo, REPO_ROOT } from "./gate-repo.js";

const WRAPPER = "scripts/codex/codex.mjs";
const WRAPPER_FILES = [
  WRAPPER,
  "scripts/codex/schemas/review-output.schema.json",
  "scripts/codex/schemas/worker-report.schema.json",
  "scripts/codex/antigravity-extension/bridge-core.js",
  "scripts/codex/antigravity-extension/package.json",
];

const FIXTURE_DIR = join(REPO_ROOT, "packages/test-fixtures/fixtures/codex");

interface SharedCase {
  readonly id: string;
  readonly reply: unknown;
  readonly note: string;
  readonly offShape?: string;
}

interface TsOnlyCase {
  readonly id: string;
  readonly input: {
    readonly kind: "reply" | "rollout";
    readonly payload: unknown;
    readonly ageMs?: number;
    readonly pausedRunCount?: number;
  };
  readonly expect: {
    readonly allowed: boolean;
    readonly exitCode: number;
    readonly status: string;
    readonly reason: string | null;
    readonly usedPercent: number | null;
  };
  readonly wrapperExit?: number;
  readonly why: string;
}

interface GuardCases {
  readonly decoyAccountId: string;
  readonly shared: readonly SharedCase[];
  readonly tsOnly: readonly TsOnlyCase[];
}

const CASES = JSON.parse(readFileSync(join(FIXTURE_DIR, "guard-cases.json"), "utf8")) as GuardCases;
const SHAPE = JSON.parse(
  readFileSync(join(FIXTURE_DIR, "rate-limits-response.shape.json"), "utf8"),
) as ShapeSnapshot;
const MARKER = CASES.decoyAccountId;

// A fixed instant: the observation time injected into the TypeScript side.
const OBSERVED_AT_MS = Date.UTC(2026, 9, 10, 12, 0, 0);

// The fake Codex: only the app-server handshake and the one read.
const FAKE_CODEX = String.raw`
const fs = require("node:fs");
const argv = process.argv.slice(2);
if (argv[0] !== "app-server") process.exit(2);
function emit(message) { process.stdout.write(JSON.stringify(message) + "\n"); }
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (process.env.FAKE_CODEX_RPC_LOG) fs.appendFileSync(process.env.FAKE_CODEX_RPC_LOG, line + "\n");
    if (message.id === undefined) continue;
    if (message.method === "initialize") { emit({ id: message.id, result: { userAgent: "fake" } }); continue; }
    if (message.method === "account/rateLimits/read") {
      emit({ id: message.id, result: JSON.parse(process.env.FAKE_CODEX_REPLY) });
      continue;
    }
    emit({ id: message.id, error: { code: -32601, message: "unknown method " + message.method } });
  }
});
process.stdin.on("end", () => process.exit(0));
`;

interface RunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface Harness {
  readonly repo: GateRepo;
  readonly home: string;
  readonly rpcLog: string;
}

let sharedBin: string | null = null;
const cleanups: (() => void)[] = [];

// Written once per file: macOS may scan a freshly written executable on its
// first exec, which stalled whole runs when done for every case.
function fakeBin(): string {
  if (sharedBin) return sharedBin;
  const dir = mkdtempSync(join(tmpdir(), "ccc-parity-bin-"));
  writeFileSync(join(dir, "codex"), `#!${process.execPath}\n${FAKE_CODEX}`);
  chmodSync(join(dir, "codex"), 0o755);
  sharedBin = dir;
  return dir;
}

let sharedHarness: Harness | null = null;
function harness(): Harness {
  if (sharedHarness) return sharedHarness;
  const repo = gateRepo(WRAPPER_FILES);
  const home = realpathSync(mkdtempSync(join(tmpdir(), "ccc-parity-home-")));
  const rpcLog = join(home, "rpc.jsonl");
  cleanups.push(() => {
    repo.dispose();
    rmSync(home, { recursive: true, force: true });
  });
  sharedHarness = { repo, home, rpcLog };
  return sharedHarness;
}

afterAll(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  if (sharedBin) rmSync(sharedBin, { recursive: true, force: true });
});

/** The wrapper's environment: the real one minus anything that could point it at the owner's state. */
function wrapperEnv(over: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("CODEX_") || key.startsWith("FAKE_")) delete env[key];
  }
  delete env.XDG_STATE_HOME;
  return { ...env, ...over };
}

function runWrapper(subcommand: "usage" | "guard", reply: unknown): Promise<RunResult> {
  const { repo, home, rpcLog } = harness();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(repo.root, WRAPPER), subcommand], {
      cwd: repo.root,
      env: wrapperEnv({
        PATH: `${fakeBin()}:${process.env.PATH ?? ""}`,
        HOME: home,
        FAKE_CODEX_REPLY: JSON.stringify(reply),
        FAKE_CODEX_RPC_LOG: rpcLog,
        CCC_CODEX_USAGE_TIMEOUT_MS: "15000",
      }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`wrapper ${subcommand} timed out`));
    }, 30_000);
    child.on("error", reject);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

interface WrapperUsage {
  readonly plan: string | null;
  readonly usedPercent: number | null;
  readonly resetsAt: string | null;
  readonly allowed: boolean | null;
  readonly status: string;
}

function tsOutcome(
  snapshot: ReturnType<typeof normalizeRateLimitsReply>,
  ageMs = 1_000,
  pausedRunCount = 0,
) {
  const verdict = evaluateGuard({ snapshot, nowMs: OBSERVED_AT_MS + ageMs, pausedRunCount });
  return { snapshot, verdict };
}

function tsFromReply(reply: unknown, ageMs?: number, pausedRunCount?: number) {
  return tsOutcome(
    normalizeRateLimitsReply(reply, { observedAtMs: OBSERVED_AT_MS }),
    ageMs,
    pausedRunCount,
  );
}

describe("the shared case list (Test 2)", () => {
  const ids = CASES.shared.map((c) => c.id);

  it("covers every case the plan names", () => {
    for (const id of [
      "weekly-under-line",
      "two-windows-worst-in-by-id",
      "exactly-80",
      "exactly-100",
      "over-100",
      "reached-type-set",
      "allowed-false",
      "allowed-null",
      "rate-limits-absent",
      "plan-and-decoy-present",
      "unknown-extra-keys",
      "null-duration-window",
      "string-percent-sole-window",
      "empty-window-set",
    ]) {
      expect(ids, id).toContain(id);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("is synthetic: the account id is an obvious marker and appears in the replies", () => {
    expect(MARKER).toMatch(/^FAKE-/);
    const withMarker = CASES.shared.filter((c) => JSON.stringify(c.reply).includes(MARKER));
    expect(withMarker.length).toBeGreaterThan(10);
    expect(JSON.stringify(CASES)).not.toMatch(/\/Users\/[a-z]/i);
  });
});

describe("black-box parity with the real wrapper (Tests 1 and 5, D-22)", () => {
  for (const c of CASES.shared) {
    it(`agrees with the wrapper on: ${c.id}`, async () => {
      const [usage, guard] = await Promise.all([
        runWrapper("usage", c.reply),
        runWrapper("guard", c.reply),
      ]);
      expect(usage.status, usage.stderr).toBe(0);
      const wrapper = JSON.parse(usage.stdout) as WrapperUsage;
      // `guard` prints the same summary before it exits with the code.
      expect(JSON.parse(guard.stdout)).toEqual(wrapper);

      const { snapshot, verdict } = tsFromReply(c.reply);
      expect(verdict.status, "status").toBe(wrapper.status);
      // The domain percent is capped at 100; the wrapper keeps the raw number.
      expect(verdict.usedPercent, "used percent").toBe(
        wrapper.usedPercent === null ? null : Math.min(wrapper.usedPercent, 100),
      );
      expect(verdict.resetsAt, "reset time").toBe(wrapper.resetsAt);
      expect(verdict.exitCode, "exit code").toBe(guard.status);
      expect(verdict.allowed, "guard permission").toBe(guard.status === 0);
      if (snapshot.kind === "available") {
        expect(verdict.ordinaryUsageAllowed, "allowed").toBe(wrapper.allowed);
      } else {
        // An unavailable snapshot carries no allowance member at all.
        expect(wrapper.status, "wrapper status for an unavailable snapshot").toBe("unavailable");
        expect(verdict.ordinaryUsageAllowed, "allowed").toBeNull();
      }

      // Test 5: the decoy account id leaves neither side.
      for (const text of [usage.stdout, usage.stderr, guard.stdout, guard.stderr]) {
        expect(text).not.toContain(MARKER);
      }
      expect(JSON.stringify({ snapshot, verdict })).not.toContain(MARKER);
    });
  }

  it("sent the wrapper's requests only: no recorded request names the decoy account id", () => {
    const log = readFileSync(harness().rpcLog, "utf8");
    expect(log.length).toBeGreaterThan(0);
    expect(log).not.toContain(MARKER);
    const methods = new Set(
      log
        .trim()
        .split("\n")
        .map((line) => (JSON.parse(line) as { method: string }).method),
    );
    expect([...methods].sort()).toEqual(["account/rateLimits/read", "initialize", "initialized"]);
  });
});

describe("TypeScript-only cases (Test 3)", () => {
  it("each carries a reason why the TypeScript is stricter or has no wrapper equivalent", () => {
    expect(CASES.tsOnly.length).toBeGreaterThanOrEqual(6);
    for (const c of CASES.tsOnly) expect(c.why.length, c.id).toBeGreaterThan(20);
  });

  for (const c of CASES.tsOnly) {
    it(`${c.id}`, async () => {
      const { snapshot, verdict } =
        c.input.kind === "rollout"
          ? tsOutcome(
              normalizeRolloutRateLimits(c.input.payload, { observedAtMs: OBSERVED_AT_MS }),
              c.input.ageMs,
              c.input.pausedRunCount,
            )
          : tsFromReply(c.input.payload, c.input.ageMs, c.input.pausedRunCount);
      expect(verdict).toMatchObject(c.expect);
      expect(JSON.stringify({ snapshot, verdict })).not.toContain(MARKER);
      if (c.wrapperExit !== undefined) {
        // Where the wrapper can read the same reply, record how it answers, so the
        // documented strictness is a measured fact and not an assumption.
        const guard = await runWrapper("guard", c.input.payload);
        expect(guard.status, "wrapper exit code").toBe(c.wrapperExit);
        expect(verdict.exitCode, "TypeScript exit code differs").not.toBe(c.wrapperExit);
      }
    });
  }
});

interface ShapeSnapshot {
  readonly response: {
    readonly required: readonly string[];
    readonly members: Readonly<Record<string, string>>;
  };
  readonly snapshot: { readonly members: Readonly<Record<string, string>> };
  readonly window: {
    readonly required: readonly string[];
    readonly members: Readonly<Record<string, string>>;
  };
  readonly reachedTypes: readonly string[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Violations of the hand-authored response shape; unknown members are allowed (the schema grows). */
function shapeViolations(reply: unknown): string[] {
  const out: string[] = [];
  if (!isObject(reply)) return ["the result is not an object"];

  const checkWindow = (value: unknown, where: string): void => {
    if (value === null || value === undefined) return;
    if (!isObject(value)) {
      out.push(`${where} is not an object`);
      return;
    }
    for (const required of SHAPE.window.required) {
      if (!(required in value)) out.push(`${where}.${required} is missing`);
    }
    for (const [name, type] of Object.entries(SHAPE.window.members)) {
      const v = value[name];
      if (v === undefined) continue;
      if (type === "number" && typeof v !== "number") out.push(`${where}.${name} is not a number`);
      if (type === "integer|null" && v !== null && !Number.isInteger(v)) {
        out.push(`${where}.${name} is not an integer or null`);
      }
    }
  };

  const checkSnapshot = (value: unknown, where: string): void => {
    if (!isObject(value)) {
      out.push(`${where} is not a snapshot object`);
      return;
    }
    checkWindow(value.primary, `${where}.primary`);
    checkWindow(value.secondary, `${where}.secondary`);
    const reached = value.rateLimitReachedType;
    if (
      reached !== null &&
      reached !== undefined &&
      !SHAPE.reachedTypes.includes(String(reached))
    ) {
      out.push(`${where}.rateLimitReachedType is not a known type`);
    }
    for (const [name, type] of Object.entries(SHAPE.snapshot.members)) {
      const v = value[name];
      if (v === undefined || v === null) continue;
      if (type === "string|null" && typeof v !== "string")
        out.push(`${where}.${name} is not a string`);
      if (type === "boolean|null" && typeof v !== "boolean")
        out.push(`${where}.${name} is not a boolean`);
    }
  };

  for (const required of SHAPE.response.required) {
    const v = reply[required];
    if (v === undefined || v === null)
      out.push(`the required ${required} member is missing or null`);
  }
  if (reply.rateLimits !== undefined && reply.rateLimits !== null) {
    checkSnapshot(reply.rateLimits, "rateLimits");
  }
  const allowed = reply.ordinaryUsageAllowed;
  if (allowed !== undefined && allowed !== null && typeof allowed !== "boolean") {
    out.push("ordinaryUsageAllowed is not a boolean");
  }
  const byId = reply.rateLimitsByLimitId;
  if (byId !== undefined && byId !== null) {
    if (!isObject(byId)) out.push("rateLimitsByLimitId is not an object");
    else
      for (const [id, value] of Object.entries(byId))
        checkSnapshot(value, `rateLimitsByLimitId.${id}`);
  }
  return out;
}

describe("the hand-authored response shape snapshot (Test 4)", () => {
  it("names its provenance and was not fetched from the network", () => {
    const provenance = (SHAPE as unknown as { provenance: Record<string, unknown> }).provenance;
    expect(provenance.fetchedFromNetwork).toBe(false);
    expect(String(provenance.researchSection)).toContain("R2");
    expect(String(provenance.upstreamRelease).length).toBeGreaterThan(10);
  });

  it("every conformant shared reply satisfies it and every off-shape one violates it", () => {
    let conformant = 0;
    for (const c of CASES.shared) {
      const violations = shapeViolations(c.reply);
      if (c.offShape === undefined) {
        expect(violations, c.id).toEqual([]);
        conformant += 1;
      } else {
        expect(violations.length, `${c.id} should be off-shape (${c.offShape})`).toBeGreaterThan(0);
      }
    }
    expect(conformant).toBeGreaterThan(10);
  });

  it("the checker is not vacuous: hand-made violations are caught", () => {
    expect(shapeViolations({ rateLimits: { primary: { usedPercent: "5" } } })).not.toEqual([]);
    expect(shapeViolations({ rateLimits: { primary: { resetsAt: 1 } } })).not.toEqual([]);
    expect(shapeViolations({ rateLimits: { rateLimitReachedType: "nope" } })).not.toEqual([]);
    expect(shapeViolations({ rateLimits: {}, ordinaryUsageAllowed: "yes" })).not.toEqual([]);
    expect(shapeViolations({ rateLimits: {}, unknownNewMember: 1 })).toEqual([]);
  });
});
