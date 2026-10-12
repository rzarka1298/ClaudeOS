import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { LedgerEntry } from "../ledger.js";
import { HOOK_ENTRY } from "../repo-paths.js";
import {
  activateAllowlistedApp,
  assertTargetIsSacrificial,
  bannerRegion,
  buildHookEnv,
  buildSessionStartRecord,
  checkAuditSequence,
  checkNoNotificationWhileFocused,
  checkNotificationRecord,
  hookArgs,
  ledgerPidsOf,
  reapSacrificialChildren,
  recordedPidFor,
  runHook,
  SACRIFICIAL_MARKER,
  type SacrificialChild,
  spawnSacrificialChild,
} from "./synthetic-session.js";

const RUN_ROOT = "/tmp/ccc-uat.abc123";

describe("assertTargetIsSacrificial (Test 1)", () => {
  it("passes only for a pid this spec spawned and ledgered", () => {
    expect(() => assertTargetIsSacrificial(4242, [4242, 4300])).not.toThrow();
  });

  it("throws a fixed message for any other pid, for null and for an empty ledger", () => {
    const message = "Refusing to approve a termination";
    expect(() => assertTargetIsSacrificial(4243, [4242])).toThrow(message);
    expect(() => assertTargetIsSacrificial(null, [4242])).toThrow(message);
    expect(() => assertTargetIsSacrificial(4242, [])).toThrow(message);
  });

  it("never accepts pid 1, the test process or its parent, even if they were ledgered", () => {
    for (const pid of [1, process.pid, process.ppid, 0, -5, 1.5]) {
      expect(() => assertTargetIsSacrificial(pid, [pid])).toThrow("Refusing to approve");
    }
  });

  it("does not echo the pid in the message", () => {
    try {
      assertTargetIsSacrificial(987654, [4242]);
    } catch (error) {
      expect(String(error)).not.toContain("987654");
    }
  });
});

describe("hook record, environment and arguments (Test 2)", () => {
  it("builds the SessionStart record the compiled hook accepts, with a cwd in the run root", () => {
    const record = buildSessionStartRecord("0123456789abcdef", `${RUN_ROOT}/tmp/scratch`, RUN_ROOT);
    expect(record).toEqual({
      session_id: "0123456789abcdef",
      cwd: `${RUN_ROOT}/tmp/scratch`,
      permission_mode: "default",
      model: "claude-test-model",
      hook_event_name: "SessionStart",
      source: "startup",
    });
  });

  it("refuses a cwd outside the run root and a malformed session id", () => {
    expect(() => buildSessionStartRecord("0123456789abcdef", "/tmp/elsewhere", RUN_ROOT)).toThrow();
    expect(() => buildSessionStartRecord("0123456789abcdef", RUN_ROOT, RUN_ROOT)).toThrow();
    expect(() => buildSessionStartRecord("x", `${RUN_ROOT}/tmp/a`, RUN_ROOT)).toThrow();
    expect(() => buildSessionStartRecord("a b; rm", `${RUN_ROOT}/tmp/a`, RUN_ROOT)).toThrow();
  });

  it("gives the hook PATH, HOME as given and CLAUDE_PID only", () => {
    const env = buildHookEnv({ home: `${RUN_ROOT}/tmp`, claudePid: 4242 });
    expect(Object.keys(env).sort()).toEqual(["CLAUDE_PID", "HOME", "PATH"]);
    expect(env.HOME).toBe(`${RUN_ROOT}/tmp`);
    expect(env.CLAUDE_PID).toBe("4242");
  });

  it("lists the entry path plus --runtime-dir with the sandbox runtime directory", () => {
    expect(hookArgs(`${RUN_ROOT}/rt`)).toEqual([HOOK_ENTRY, "--runtime-dir", `${RUN_ROOT}/rt`]);
  });

  it("runs the hook through spawn with that environment, feeds the record and refuses a non-ledgered pid", async () => {
    const calls: Array<{
      file: string;
      args: string[];
      env: Record<string, string>;
      viaShell: boolean;
    }> = [];
    let stdinText = "";
    const spawnFn = ((
      file: string,
      args: string[],
      options: { env: Record<string, string>; shell?: unknown },
    ) => {
      calls.push({ file, args, env: options.env, viaShell: Boolean(options.shell) });
      const child = new EventEmitter() as EventEmitter & { stdin: PassThrough };
      child.stdin = new PassThrough();
      child.stdin.on("data", (chunk: Buffer) => {
        stdinText += chunk.toString();
      });
      child.stdin.on("end", () => setImmediate(() => child.emit("close", 0)));
      return child;
    }) as never;
    const input = {
      runtimeDir: `${RUN_ROOT}/rt`,
      runRoot: RUN_ROOT,
      home: `${RUN_ROOT}/tmp`,
      pid: 4242,
      ledgerPids: [4242],
      record: { hello: "world" },
      spawnFn,
    };
    await runHook(input);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.file).toBe(process.execPath);
    expect(calls[0]?.args).toEqual(hookArgs(`${RUN_ROOT}/rt`));
    expect(Object.keys(calls[0]?.env ?? {}).sort()).toEqual(["CLAUDE_PID", "HOME", "PATH"]);
    expect(calls[0]?.viaShell).toBe(false);
    expect(JSON.parse(stdinText)).toEqual({ hello: "world" });
    await expect(runHook({ ...input, pid: 999999 })).rejects.toThrow("Refusing to approve");
    await expect(runHook({ ...input, runtimeDir: "/tmp/elsewhere/rt" })).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });
});

describe("sacrificial children (Test 3)", () => {
  it("spawns a node idle process, ledgers it as sacrificial and reaps it through the handle", async () => {
    const ledger: LedgerEntry[] = [];
    const registry: SacrificialChild[] = [];
    const sacrificial = await spawnSacrificialChild({
      registry,
      ledger: (entry) => ledger.push(entry),
      readStart: async () => "Mon Jan  1 00:00:00 2026",
    });
    try {
      expect(sacrificial.pid).toBeGreaterThan(1);
      expect(sacrificial.pid).not.toBe(process.pid);
      expect(sacrificial.child.spawnfile).toBe(process.execPath);
      expect(sacrificial.child.spawnargs).toContain(SACRIFICIAL_MARKER);
      expect(sacrificial.child.spawnargs.join(" ")).toContain("setInterval");
      expect(ledger).toEqual([
        {
          kind: "pid",
          role: "sacrificial",
          pid: sacrificial.pid,
          start: "Mon Jan  1 00:00:00 2026",
          marker: SACRIFICIAL_MARKER,
        },
      ]);
      expect(ledgerPidsOf(registry)).toEqual([sacrificial.pid]);
      expect(sacrificial.child.exitCode).toBeNull();
    } finally {
      expect(await reapSacrificialChildren(registry)).toBe(1);
    }
    expect(sacrificial.child.exitCode !== null || sacrificial.child.signalCode !== null).toBe(true);
    expect(registry).toEqual([]);
  });

  it("reaping an empty registry or an already-ended child is harmless", async () => {
    expect(await reapSacrificialChildren([])).toBe(0);
  });
});

describe("banner region (Test 4)", () => {
  it("is the small top-right rectangle of the screen, in whole numbers", () => {
    expect(bannerRegion({ width: 1504, height: 982 })).toEqual({ x: 1064, y: 32, w: 440, h: 180 });
    const small = bannerRegion({ width: 300, height: 100 });
    expect(small.x + small.w).toBeLessThanOrEqual(300);
    expect(small.y + small.h).toBeLessThanOrEqual(100);
    expect(small.w).toBeLessThanOrEqual(300);
  });

  it("throws for a non-positive or fractional size", () => {
    expect(() => bannerRegion({ width: 0, height: 100 })).toThrow();
    expect(() => bannerRegion({ width: 100, height: -1 })).toThrow();
    expect(() => bannerRegion({ width: 100.5, height: 100 })).toThrow();
  });
});

describe("notification assertions (Test 5)", () => {
  const good = {
    title: "Approval needed",
    body: "The dashboard asks to run a test that does nothing.",
    tag: "01H-proposal",
    hasOnclick: true,
    permission: "granted",
  };

  it("passes the approval title, the generic body, no actions and a recorded permission", () => {
    expect(checkNotificationRecord(good)).toEqual({ ok: true, problems: [] });
  });

  it("fails a wrong title, a body naming a target, offered actions and a missing permission", () => {
    expect(checkNotificationRecord({ ...good, title: "Something" }).ok).toBe(false);
    expect(
      checkNotificationRecord({ ...good, body: "The dashboard asks to delete /var/data/notes." })
        .ok,
    ).toBe(false);
    expect(checkNotificationRecord(good, { forbidden: ["run a test"] }).ok).toBe(false);
    expect(checkNotificationRecord({ ...good, body: null }).ok).toBe(false);
    expect(checkNotificationRecord({ ...good, actions: [{ action: "approve" }] }).ok).toBe(false);
    expect(checkNotificationRecord({ ...good, permission: null }).ok).toBe(false);
    expect(checkNotificationRecord({ ...good, permission: "denied" }).ok).toBe(false);
  });

  it("asserts no notification exists while the window is reported focused", () => {
    expect(checkNoNotificationWhileFocused([])).toEqual({ ok: true, problems: [] });
    expect(checkNoNotificationWhileFocused([{}]).ok).toBe(false);
  });
});

describe("store facts and window activation", () => {
  it("reads the recorded pid of a session from the runs rows", () => {
    const rows = [
      { run_id: "r1", claude_session_id: "aaaa1111bbbb2222", pid: 4242, state: "running" },
      { run_id: "r2", claude_session_id: "cccc3333dddd4444", pid: null, state: "running" },
    ];
    expect(recordedPidFor(rows, "aaaa1111bbbb2222")).toBe(4242);
    expect(recordedPidFor(rows, "cccc3333dddd4444")).toBeNull();
    expect(recordedPidFor(rows, "missing")).toBeNull();
  });

  it("checks the audit sequence requested, denied, requested, approved then executed and failed", () => {
    const full = [
      "requested",
      "denied",
      "requested",
      "approved",
      "claimed",
      "executed",
      "requested",
      "approved",
      "claimed",
      "failed",
    ];
    expect(checkAuditSequence(full)).toEqual({ ok: true, reason: "" });
    expect(checkAuditSequence(["requested", "approved"]).ok).toBe(false);
    expect(checkAuditSequence(full.filter((e) => e !== "failed")).ok).toBe(false);
    expect(checkAuditSequence(full.filter((e) => e !== "executed")).ok).toBe(false);
  });

  it("activates Finder only, with an argv array, and throws before spawning for any other name", async () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const run = async (file: string, args: readonly string[]) => {
      calls.push({ file, args });
    };
    await activateAllowlistedApp("Finder", run);
    expect(calls).toEqual([{ file: "/usr/bin/open", args: ["-a", "Finder"] }]);
    for (const name of ["Obsidian", "Terminal", "Finder; rm", "finder", ""]) {
      await expect(activateAllowlistedApp(name, run)).rejects.toThrow();
    }
    expect(calls).toHaveLength(1);
  });
});
