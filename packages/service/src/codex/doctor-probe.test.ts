import { spawn as nodeSpawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEX_DOCTOR_CAP_MS, CodexDoctorSummarySchema } from "@ccc/domain";
import { afterAll, describe, expect, it } from "vitest";
import {
  DOCTOR_DECOY_ACCOUNT,
  DOCTOR_DECOY_PATH,
  doctorReport,
  type FakeDoctorScenario,
  readFakeDoctorStarts,
  writeFakeDoctor,
} from "../test-support/fake-codex-doctor.js";
import { createDoctorProbe } from "./doctor-probe.js";
import type { SpawnFn, SpawnOptionsLite } from "./rate-limits-client.js";

/**
 * The owner-triggered doctor run (plan 05.1-21, CODEX-03, R4, Pitfall 11).
 * The child is always a baked fake script in a temporary directory; the real
 * `codex` never runs.
 */

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ccc-doc-"));
  dirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const NOW_MS = Date.UTC(2026, 9, 10, 12, 0, 0);

function fake(scenario: FakeDoctorScenario) {
  return writeFakeDoctor(tempDir(), scenario);
}

/** True while a process with this pid exists (signal 0 sends nothing). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface SpawnRecord {
  readonly file: string;
  readonly args: readonly string[];
  readonly options: SpawnOptionsLite;
}

/** The real spawn, recording every call so the options can be asserted. */
function recordingSpawn(): { spawn: SpawnFn; calls: SpawnRecord[] } {
  const calls: SpawnRecord[] = [];
  return {
    calls,
    spawn: (file, args, options) => {
      calls.push({ file, args: [...args], options });
      return nodeSpawn(file, [...args], { ...options, env: { ...options.env } });
    },
  };
}

function logger() {
  const reasons: string[] = [];
  const fields: unknown[] = [];
  return {
    reasons,
    fields,
    warn(entry: { readonly reason: string }, message: string) {
      reasons.push(entry.reason);
      fields.push(entry, message);
    },
  };
}

describe("createDoctorProbe (tracer, CODEX-03, R4)", () => {
  it("Test 1: a report becomes the allowlisted summary with a checkedAt from the clock, run as [doctor, --json]", async () => {
    const doctor = fake({
      behavior: { kind: "print", stdout: doctorReport({ overallStatus: "warning" }) },
    });
    const { spawn, calls } = recordingSpawn();
    const probe = createDoctorProbe({
      executablePath: () => doctor.path,
      homeDir: () => "/Users/USERNAME",
      spawn,
      now: () => NOW_MS,
    });
    const result = await probe.run();
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.checkedAt).toBe("2026-10-10T12:00:00.000Z");
    expect(result.summary).toEqual({
      overall: "warning",
      codexVersion: "0.159.2",
      checks: [
        { id: "install.version", category: "install", status: "ok" },
        { id: "auth.account", category: "auth", status: "warning" },
      ],
    });
    expect(CodexDoctorSummarySchema.safeParse(result.summary).success).toBe(true);

    // The spawn: exactly [doctor, --json], no shell, stdin pipe / stdout pipe / stderr ignored.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.file).toBe(doctor.path);
    expect(calls[0]?.args).toEqual(["doctor", "--json"]);
    expect(calls[0]?.options.shell).toBe(false);
    expect(calls[0]?.options.stdio).toEqual(["pipe", "pipe", "ignore"]);
    // The child saw argv [doctor, --json] and exactly the minimal environment.
    const [start] = readFakeDoctorStarts(doctor.logPath);
    expect(start?.argv).toEqual(["doctor", "--json"]);
    expect(start?.envKeys).toEqual(["HOME", "LC_ALL", "PATH"]);
  });

  it("the production cap is the domain's 60 second constant", () => {
    expect(CODEX_DOCTOR_CAP_MS).toBe(60_000);
  });
});

describe("only the allowlist survives (T-05.1-06, D-17)", () => {
  it("Test 2: details, summary, remediation, notes, the home and the account marker never come back", async () => {
    const doctor = fake({ behavior: { kind: "print", stdout: doctorReport() }, stderrNoise: true });
    const log = logger();
    const probe = createDoctorProbe({
      executablePath: () => doctor.path,
      now: () => NOW_MS,
      logger: log,
    });
    const result = await probe.run();
    expect(result.kind).toBe("ok");
    const text = JSON.stringify(result.kind === "ok" ? result.summary : null);
    expect(text).not.toContain(DOCTOR_DECOY_PATH);
    expect(text).not.toContain(DOCTOR_DECOY_ACCOUNT);
    expect(text).not.toContain("summary");
    expect(text).not.toContain("remediation");
    expect(text).not.toContain("details");
    expect(text).not.toContain("notes");
    // Test 6: nothing from the report reaches a log call either.
    expect(JSON.stringify(log.fields)).not.toContain(DOCTOR_DECOY_PATH);
    expect(JSON.stringify(log.fields)).not.toContain(DOCTOR_DECOY_ACCOUNT);
  });

  it("Test 2: another schema version is unrecognised with no checks", async () => {
    const doctor = fake({
      behavior: { kind: "print", stdout: doctorReport({ schemaVersion: 2 }) },
    });
    const result = await createDoctorProbe({ executablePath: () => doctor.path }).run();
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.summary).toEqual({ overall: "unrecognised", codexVersion: null, checks: [] });
  });

  it("Test 2: output that is not JSON is a failed run, and the log names a reason only", async () => {
    const doctor = fake({
      behavior: { kind: "print", stdout: `not json ${DOCTOR_DECOY_ACCOUNT}\n` },
    });
    const log = logger();
    const result = await createDoctorProbe({
      executablePath: () => doctor.path,
      logger: log,
    }).run();
    expect(result).toEqual({ kind: "failed" });
    expect(log.reasons).toEqual(["unparseable-output"]);
    expect(JSON.stringify(log.fields)).not.toContain(DOCTOR_DECOY_ACCOUNT);
  });

  it("a report printed by a doctor that exits non-zero is still read", async () => {
    const doctor = fake({
      behavior: { kind: "print", stdout: doctorReport({ overallStatus: "fail" }), exitCode: 2 },
    });
    const result = await createDoctorProbe({ executablePath: () => doctor.path }).run();
    expect(result.kind === "ok" && result.summary.overall).toBe("fail");
  });
});

describe("a hung, crashing or noisy child never lingers (T-05.1-11, Pitfall 11)", () => {
  async function pidOf(logPath: string): Promise<number> {
    const [start] = readFakeDoctorStarts(logPath);
    if (start === undefined) throw new Error("the fake never started");
    return start.pid;
  }

  it("Test 3: a hang is cut at the cap, the child is killed and gone when run() resolves", async () => {
    const doctor = fake({ behavior: { kind: "hang" } });
    const log = logger();
    const probe = createDoctorProbe({
      executablePath: () => doctor.path,
      capMs: 300,
      killWaitMs: 500,
      logger: log,
    });
    const started = Date.now();
    const result = await probe.run();
    expect(result).toEqual({ kind: "failed" });
    expect(Date.now() - started).toBeLessThan(2500);
    expect(alive(await pidOf(doctor.logPath))).toBe(false);
    expect(log.reasons).toEqual(["timeout"]);
  });

  it("Test 3: a child that ignores the default signal is forced after the kill wait", async () => {
    const doctor = fake({ behavior: { kind: "hang" }, ignoreTermination: true });
    const probe = createDoctorProbe({
      executablePath: () => doctor.path,
      capMs: 200,
      killWaitMs: 300,
    });
    expect(await probe.run()).toEqual({ kind: "failed" });
    expect(alive(await pidOf(doctor.logPath))).toBe(false);
  });

  it("Test 3: output beyond the byte cap ends the run and the child", async () => {
    const doctor = fake({ behavior: { kind: "endless" } });
    const log = logger();
    const probe = createDoctorProbe({
      executablePath: () => doctor.path,
      capMs: 5000,
      killWaitMs: 500,
      maxOutputBytes: 8 * 1024,
      logger: log,
    });
    const started = Date.now();
    expect(await probe.run()).toEqual({ kind: "failed" });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(alive(await pidOf(doctor.logPath))).toBe(false);
    expect(log.reasons).toEqual(["output-cap"]);
  });

  it("Test 3: a crash with no output is a failed run and leaves no child", async () => {
    const doctor = fake({ behavior: { kind: "crash" } });
    expect(await createDoctorProbe({ executablePath: () => doctor.path }).run()).toEqual({
      kind: "failed",
    });
    expect(alive(await pidOf(doctor.logPath))).toBe(false);
  });

  it("a spawn that cannot start is a failed run", async () => {
    const result = await createDoctorProbe({
      executablePath: () => join(tempDir(), "does-not-exist", "codex"),
    }).run();
    expect(result).toEqual({ kind: "failed" });
  });

  it("a spawn function that throws is a failed run", async () => {
    const result = await createDoctorProbe({
      executablePath: () => "/Users/USERNAME/codex",
      spawn: () => {
        throw new Error(`EACCES ${DOCTOR_DECOY_PATH}`);
      },
    }).run();
    expect(result).toEqual({ kind: "failed" });
  });

  it("with no saved executable it is unavailable and spawns nothing", async () => {
    const { spawn, calls } = recordingSpawn();
    const result = await createDoctorProbe({ executablePath: () => null, spawn }).run();
    expect(result).toEqual({ kind: "unavailable" });
    expect(calls).toHaveLength(0);
  });

  it("two overlapping runs share one child", async () => {
    const doctor = fake({ behavior: { kind: "print", stdout: doctorReport() } });
    const probe = createDoctorProbe({ executablePath: () => doctor.path });
    const [a, b] = await Promise.all([probe.run(), probe.run()]);
    expect(a.kind).toBe("ok");
    expect(b.kind).toBe("ok");
    expect(readFakeDoctorStarts(doctor.logPath)).toHaveLength(1);
  });

  it("sets CODEX_HOME only when the owner configured one", async () => {
    const doctor = fake({ behavior: { kind: "print", stdout: doctorReport() } });
    await createDoctorProbe({
      executablePath: () => doctor.path,
      codexHome: () => "/Users/USERNAME/custom-codex-home",
    }).run();
    expect(readFakeDoctorStarts(doctor.logPath)[0]?.envKeys).toEqual([
      "CODEX_HOME",
      "HOME",
      "LC_ALL",
      "PATH",
    ]);
  });
});
