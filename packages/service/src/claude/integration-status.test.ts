import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ClaudeIntegrationStatusSchema, newRunId } from "@ccc/domain";
import { applyMigrations, type OperationalStore, openStore } from "@ccc/operational-store";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEventBus, type EventBus } from "../events/event-bus.js";
import {
  buildIntegrationStatus,
  type ClaudeSettingsFacts,
  type IntegrationInputs,
  probeClaudeVersion,
  readClaudeSettingsFacts,
  readInstallRecord,
} from "./integration-status.js";
import { createClaudePipeline } from "./pipeline.js";
import { startUsageServices } from "./usage-services.js";

// The installer's own helpers produce the settings under test, so the
// service's read-only matcher is proven against exactly what 05-09 writes.
interface HookLib {
  mergeHooks(
    settings: Record<string, unknown>,
    entryPath: string,
    nodePath: string,
    runtimeDir: string,
  ): Record<string, unknown>;
  installedEntryPath(runtimeDir: string): string;
  wrapperCommand(nodePath: string, runtimeDir: string): string;
  SUBSCRIBED_EVENTS: readonly string[];
}
const LIB_URL = new URL("../../../../scripts/claude-hooks/lib.mjs", import.meta.url);
const lib = (await import(LIB_URL.href)) as HookLib;

const TEST_BASE = join(homedir(), ".ccc-test");
const silent = pino({ level: "silent" });
const FOREIGN_GROUP = { hooks: [{ type: "command", command: "/usr/local/bin/other-tool" }] };

let dir: string;
let runtimeDir: string;
let configDir: string;
let settingsPath: string;
let nodePath: string;

beforeEach(() => {
  mkdirSync(TEST_BASE, { recursive: true });
  dir = mkdtempSync(join(TEST_BASE, "is-"));
  runtimeDir = join(dir, "runtime");
  configDir = join(dir, "claude");
  settingsPath = join(configDir, "settings.json");
  nodePath = join(dir, "bin", "node");
  mkdirSync(join(runtimeDir, "hooks"), { recursive: true });
  mkdirSync(configDir, { recursive: true });
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(nodePath, "synthetic node stand-in\n");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function installedSettings(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const base = { hooks: { Stop: [FOREIGN_GROUP] }, ...extra };
  return lib.mergeHooks(base, lib.installedEntryPath(runtimeDir), nodePath, runtimeDir);
}

/** Reads the facts and proves the file is byte- and mtime-unchanged afterwards (T-05-51). */
function readUnchanged(): ClaudeSettingsFacts {
  const before = statSync(settingsPath, { bigint: true });
  const bytes = readFileSync(settingsPath);
  const facts = readClaudeSettingsFacts(settingsPath, runtimeDir);
  const after = statSync(settingsPath, { bigint: true });
  expect(after.mtimeNs).toBe(before.mtimeNs);
  expect(readFileSync(settingsPath).equals(bytes)).toBe(true);
  return facts;
}

describe("readClaudeSettingsFacts: a read-only look at Claude's settings (Test 1, PR-24, SESS-01)", () => {
  it("reports our 15 hook entries, the wrapper, disableAllHooks and cleanupPeriodDays", () => {
    const settings = installedSettings({
      disableAllHooks: true,
      cleanupPeriodDays: 7,
      statusLine: { type: "command", command: lib.wrapperCommand(nodePath, runtimeDir) },
    });
    const hooks = settings.hooks as Record<string, unknown>;
    expect(lib.SUBSCRIBED_EVENTS.every((event) => event in hooks)).toBe(true);
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
    expect(readUnchanged()).toEqual({
      hooks: "installed",
      statusLine: "installed",
      disableAllHooks: true,
      cleanupPeriodDays: 7,
      hookNodePath: nodePath,
    });
  });

  it("reports not-installed for foreign-only hooks and a foreign status line", () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: { Stop: [FOREIGN_GROUP] },
        statusLine: { type: "command", command: "/usr/local/bin/my-status" },
      }),
    );
    expect(readUnchanged()).toEqual({
      hooks: "not-installed",
      statusLine: "not-installed",
      disableAllHooks: false,
      cleanupPeriodDays: 30,
      hookNodePath: null,
    });
  });

  it("does not count another runtime dir's entries as ours", () => {
    const other = join(dir, "other-runtime");
    const settings = lib.mergeHooks({}, lib.installedEntryPath(other), nodePath, other);
    writeFileSync(settingsPath, JSON.stringify(settings));
    expect(readUnchanged().hooks).toBe("not-installed");
  });

  it("reports unknown for a missing or invalid file, never throws, never writes", () => {
    expect(readClaudeSettingsFacts(join(configDir, "absent.json"), runtimeDir)).toEqual({
      hooks: "unknown",
      statusLine: "unknown",
      disableAllHooks: null,
      cleanupPeriodDays: 30,
      hookNodePath: null,
    });
    writeFileSync(settingsPath, "{ not json");
    expect(readUnchanged()).toMatchObject({ hooks: "unknown", statusLine: "unknown" });
    writeFileSync(settingsPath, "[]");
    expect(readUnchanged()).toMatchObject({ hooks: "unknown", disableAllHooks: null });
  });

  it("clamps cleanupPeriodDays to at least 1 and defaults a non-number to 30", () => {
    writeFileSync(settingsPath, JSON.stringify({ cleanupPeriodDays: 0 }));
    expect(readUnchanged().cleanupPeriodDays).toBe(1);
    writeFileSync(settingsPath, JSON.stringify({ cleanupPeriodDays: "7" }));
    expect(readUnchanged().cleanupPeriodDays).toBe(30);
  });

  it("imports no fs write API (source scan, T-05-51)", () => {
    const source = readFileSync(new URL("./integration-status.ts", import.meta.url), "utf8");
    const fsImports = [
      ...source.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*"node:fs(?:\/promises)?"/g),
    ].map((match) => match[1] ?? "");
    expect(fsImports.length).toBeGreaterThan(0);
    const writeApi = new RegExp(
      `\\b(?:${[
        "write",
        "append",
        "rename",
        "unlink",
        "rm",
        "rmdir",
        "mkdir",
        "mkdtemp",
        "copyFile",
        "cp",
        "chmod",
        "chown",
        "truncate",
        "symlink",
        "link",
        "utimes",
        "open",
        "createWriteStream",
      ].join("|")})\\w*\\b`,
    );
    for (const names of fsImports) expect(names).not.toMatch(writeApi);
    expect(source).not.toMatch(/import\s+(?:\*\s+as\s+)?\w+\s+from\s+"node:fs/);
  });
});

describe("readInstallRecord", () => {
  it("reads the installer's record and ignores a malformed one", () => {
    const record = join(runtimeDir, "hooks", "install.json");
    writeFileSync(
      record,
      JSON.stringify({
        nodePath,
        claudeBin: "/opt/synthetic/claude",
        claudeVersion: "2.1.283",
        installedAt: "2026-09-20T12:00:00.000Z",
        withStatusline: false,
      }),
    );
    expect(readInstallRecord(runtimeDir)).toEqual({ nodePath, claudeBin: "/opt/synthetic/claude" });
    writeFileSync(record, JSON.stringify({ nodePath: "relative/node", claudeBin: 42 }));
    expect(readInstallRecord(runtimeDir)).toEqual({ nodePath: null, claudeBin: null });
    rmSync(record);
    expect(readInstallRecord(runtimeDir)).toBeNull();
  });
});

function probeDeps(output: () => Promise<string>) {
  let mtimeMs = 1;
  return {
    execFile: vi.fn(async () => ({ stdout: await output() })),
    realpath: vi.fn((path: string) => path),
    mtimeMs: vi.fn(() => mtimeMs),
    touch() {
      mtimeMs += 1;
    },
    cache: new Map<string, string | null>(),
  };
}

describe("probeClaudeVersion (Test 2, PR-09, T-05-54)", () => {
  it("runs the recorded absolute binary once per (realpath, mtime) and parses the version", async () => {
    const deps = probeDeps(() => Promise.resolve("2.1.283 (Claude Code)\n"));
    expect(await probeClaudeVersion("/opt/synthetic/claude", deps)).toBe("2.1.283");
    expect(await probeClaudeVersion("/opt/synthetic/claude", deps)).toBe("2.1.283");
    expect(deps.execFile).toHaveBeenCalledTimes(1);
    expect(deps.execFile).toHaveBeenCalledWith(
      "/opt/synthetic/claude",
      ["--version"],
      expect.objectContaining({ timeout: 3000 }),
    );
    deps.touch();
    await probeClaudeVersion("/opt/synthetic/claude", deps);
    expect(deps.execFile).toHaveBeenCalledTimes(2);
  });

  it("yields null for a failed probe, and never runs a relative or absent binary", async () => {
    const failing = probeDeps(() => Promise.reject(new Error("synthetic failure")));
    expect(await probeClaudeVersion("/opt/synthetic/claude", failing)).toBeNull();
    const deps = probeDeps(() => Promise.resolve("2.1.283 (Claude Code)\n"));
    expect(await probeClaudeVersion("claude", deps)).toBeNull();
    expect(await probeClaudeVersion(null, deps)).toBeNull();
    expect(deps.execFile).not.toHaveBeenCalled();
  });
});

describe("probeClaudeVersion failures are not cached (wave 4 review)", () => {
  it("re-probes after a failed or unparsable probe, so a transient failure never sticks as unknown", async () => {
    let attempt = 0;
    const deps = probeDeps(() => {
      attempt += 1;
      if (attempt === 1) return Promise.reject(new Error("synthetic timeout"));
      if (attempt === 2) return Promise.resolve("not a version\n");
      return Promise.resolve("2.1.283 (Claude Code)\n");
    });
    expect(await probeClaudeVersion("/opt/synthetic/claude", deps)).toBeNull();
    expect(await probeClaudeVersion("/opt/synthetic/claude", deps)).toBeNull();
    expect(await probeClaudeVersion("/opt/synthetic/claude", deps)).toBe("2.1.283");
    expect(await probeClaudeVersion("/opt/synthetic/claude", deps)).toBe("2.1.283");
    expect(deps.execFile).toHaveBeenCalledTimes(3);
  });
});

const HEALTHY: IntegrationInputs = {
  settings: {
    hooks: "installed",
    statusLine: "not-installed",
    disableAllHooks: false,
    cleanupPeriodDays: 30,
    hookNodePath: "/opt/synthetic/node",
  },
  install: { nodePath: "/opt/synthetic/node", claudeBin: "/opt/synthetic/claude" },
  pathExists: () => true,
  health: {
    lastEventAt: "2026-09-20T12:00:00.000Z",
    unknownEventCount: 3,
    rejectedEdgeCount: 0,
    shapeChanged: null,
  },
  dropCount: 2,
  analysisEnabled: false,
  statusLineReported: false,
  detectedClaudeVersion: "2.1.283",
};

describe("buildIntegrationStatus (Test 3, D-12, D-15, SESS-18)", () => {
  it("combines settings, install record, pipeline health, drops and the analysis setting", () => {
    expect(ClaudeIntegrationStatusSchema.parse(buildIntegrationStatus(HEALTHY))).toEqual({
      hooks: "installed",
      hookRuntimeMissing: false,
      disableAllHooks: false,
      lastEventAt: "2026-09-20T12:00:00.000Z",
      telemetry: { kind: "ok" },
      detectedClaudeVersion: "2.1.283",
      statusLine: "not-installed",
      statusLineReported: false,
      transcriptAnalysis: { enabled: false },
      spoolDropCount: 2,
      unknownEventCount: 3,
      cleanupPeriodDays: 30,
    });
  });

  it("flags a missing hook runtime, a shape change and an unsupported version", () => {
    expect(
      buildIntegrationStatus({ ...HEALTHY, pathExists: (p) => p !== "/opt/synthetic/node" })
        .hookRuntimeMissing,
    ).toBe(true);
    expect(
      buildIntegrationStatus({
        ...HEALTHY,
        health: { ...HEALTHY.health, shapeChanged: "Stop" },
      }).telemetry,
    ).toEqual({ kind: "shape-changed", version: "2.1.283" });
    expect(
      buildIntegrationStatus({ ...HEALTHY, detectedClaudeVersion: "2.1.100" }).telemetry,
    ).toEqual({ kind: "unsupported-version", version: "2.1.100" });
    const unknownVersion = buildIntegrationStatus({ ...HEALTHY, detectedClaudeVersion: null });
    expect(unknownVersion.telemetry).toEqual({ kind: "ok" });
    expect(unknownVersion.detectedClaudeVersion).toBeNull();
  });

  it("publishes claude-integration.updated once per change and nothing for an unchanged recompute", async () => {
    const dbDir = join(dir, "db");
    mkdirSync(dbDir);
    const store: OperationalStore = openStore(join(dbDir, "operational.db"));
    applyMigrations(store.db);
    const bus: EventBus = createEventBus();
    const pipeline = createClaudePipeline({
      db: store.db,
      bus,
      logger: silent,
      now: () => new Date(),
      mintRunId: newRunId,
      facts: {
        factsFor: async () => ({
          pidStartedAt: null,
          launchSource: null,
          projectId: null,
          worktreeRoot: null,
          transcriptPath: null,
        }),
      },
    });
    writeFileSync(settingsPath, JSON.stringify({ hooks: { Stop: [FOREIGN_GROUP] } }));
    const usage = startUsageServices({
      db: store.db,
      bus,
      pipeline,
      poller: { setStatusLineSink() {}, dropCount: () => 0 },
      logger: silent,
      env: {},
      now: () => new Date(),
      runtimeDir,
      claudeConfigDir: configDir,
      claudeProjectsRoot: join(configDir, "projects"),
    });
    const published = () => {
      const replay = bus.buffer.since(0);
      if (replay.mode !== "replay") throw new Error("expected a replay");
      return replay.events.filter((e) => e.type === "claude-integration.updated");
    };
    try {
      expect(usage.integration().hooks).toBe("not-installed");
      await usage.refreshIntegration();
      expect(published()).toHaveLength(0);

      writeFileSync(settingsPath, JSON.stringify(installedSettings()));
      await usage.refreshIntegration();
      expect(published()).toHaveLength(1);
      const payload = ClaudeIntegrationStatusSchema.parse(published()[0]?.payload);
      expect(payload.hooks).toBe("installed");

      await usage.refreshIntegration();
      expect(published()).toHaveLength(1);
    } finally {
      await usage.stop();
      await pipeline.stop();
      store.close();
    }
  });
});
