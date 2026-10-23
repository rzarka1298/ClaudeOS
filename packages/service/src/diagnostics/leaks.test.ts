import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ResearchStatusResponse } from "@ccc/domain";
import { describe, expect, it } from "vitest";
import { resolveRuntimeDir } from "../paths.js";
import { claudeStatus, codexStatus } from "../test-support/diagnostics-probe-fixtures.js";
import { createDiagnosticsServices, type DiagnosticsPorts } from "./services.js";

/**
 * Plan 08-12 Task 3 Test 4 (D-43; T-08-32): a probe port made to throw an error whose message holds a
 * path (and an errno name) yields a `probe-error` row and the message appears in neither the response
 * body nor the service log. The failing ports are injected through the services factory, never a
 * production switch. The service log here is the REAL default logger of the services (the file under
 * this test run's throwaway runtime folder), not an injected recorder: the whole path from the error
 * to the log line is exercised.
 */

const HOME = "/Users/USERNAME";
const SECRET_PATH = `${HOME}/private-project/settings.json`;
const MESSAGE = `EACCES: permission denied, open '${SECRET_PATH}'`;
const LOG_PATH = join(resolveRuntimeDir(), "logs", "service.log");

const STATUS: ResearchStatusResponse = {
  lastSuccess: null,
  lastFailure: null,
  inFlight: null,
  latestUnknown: null,
  configuredSources: [],
  topicLabel: null,
};

function boom(): never {
  throw new Error(MESSAGE);
}

const now = (): Date => new Date();

function baseline(): DiagnosticsPorts {
  return {
    vault: { readRoot: () => null },
    hooksPorts: { refreshSettingsFacts: () => Promise.resolve(claudeStatus()), now },
    collectorsPorts: {
      integration: () => Promise.resolve(claudeStatus()),
      spoolFacts: () => Promise.resolve({ count: 0, lastDropAt: null }),
      codexStatus: { status: () => codexStatus() },
      minimumClaudeVersion: "2.0.0",
      now,
    },
    schedulerPorts: {
      status: () => STATUS,
      keyPresence: () => Promise.resolve("absent"),
      overrideTransportActive: false,
    },
    launchersPorts: {
      listConfigs: () => [],
      probeBundle: () => Promise.resolve("found"),
      isExecutableFile: () => Promise.resolve(true),
    },
    keychain: { installSecret: "present" },
    counts: () => ({ projects: 0, scanFolders: 0, openTasks: 0, reports: 0 }),
    serviceFacts: {
      version: "0.1.0",
      startedAt: "2026-10-22T08:00:00.000Z",
      storeSchemaVersion: () => 12,
      homeDir: HOME,
      runtimeDir: `${HOME}/.example-runtime`,
      socketPath: `${HOME}/.example-runtime/svc.sock`,
    },
    now,
  };
}

function logText(): string {
  try {
    return readFileSync(LOG_PATH, "utf8");
  } catch {
    return "";
  }
}

describe("Task 3 Test 4: a probe that throws an error holding a path leaks it nowhere", () => {
  const cases: ReadonlyArray<
    readonly [name: string, row: number, over: Partial<DiagnosticsPorts>]
  > = [
    [
      "hooks port (rejects)",
      1,
      { hooksPorts: { refreshSettingsFacts: () => Promise.reject(new Error(MESSAGE)), now } },
    ],
    [
      "collectors port (throws synchronously)",
      2,
      {
        collectorsPorts: {
          integration: boom,
          spoolFacts: () => Promise.resolve({ count: 0, lastDropAt: null }),
          codexStatus: { status: () => codexStatus() },
          minimumClaudeVersion: "2.0.0",
          now,
        },
      },
    ],
    [
      "scheduler status port (throws)",
      3,
      {
        schedulerPorts: {
          status: boom,
          keyPresence: () => Promise.resolve("absent"),
          overrideTransportActive: false,
        },
      },
    ],
    [
      "launchers port (throws)",
      4,
      {
        launchersPorts: {
          listConfigs: boom,
          probeBundle: () => Promise.resolve("found"),
          isExecutableFile: () => Promise.resolve(true),
        },
      },
    ],
    ["vault root read (throws)", 0, { vault: { readRoot: boom } }],
  ];

  const FORBIDDEN = [SECRET_PATH, "private-project", "EACCES", "permission denied"];

  for (const [name, row, over] of cases) {
    it(`${name}: the row reads probe-error and neither the body nor the log holds the path or the errno`, async () => {
      const before = logText().length;
      const services = createDiagnosticsServices({ ...baseline(), ...over });
      const response = await services.check("gesture");
      expect(response.rows[row]).toMatchObject({ status: "unknown", reasonCode: "probe-error" });

      const body = JSON.stringify(response);
      for (const forbidden of FORBIDDEN) expect(body, forbidden).not.toContain(forbidden);
      const written = logText().slice(before);
      for (const forbidden of FORBIDDEN) expect(written, forbidden).not.toContain(forbidden);
    });
  }

  it("a whole probe that throws (not a port) is logged as a code and an error class name only", async () => {
    for (const name of ["hooks", "collectors", "scheduler", "launchers"] as const) {
      const before = logText().length;
      const services = createDiagnosticsServices({
        ...baseline(),
        [name]: () => Promise.reject(new TypeError(MESSAGE)),
      });
      const response = await services.check("gesture");
      const index = { hooks: 1, collectors: 2, scheduler: 3, launchers: 4 }[name];
      expect(response.rows[index]).toMatchObject({ status: "unknown", reasonCode: "probe-error" });

      const body = JSON.stringify(response);
      for (const forbidden of FORBIDDEN)
        expect(body, `${name} ${forbidden}`).not.toContain(forbidden);

      const written = logText().slice(before);
      for (const forbidden of FORBIDDEN) {
        expect(written, `${name} ${forbidden}`).not.toContain(forbidden);
      }
      const lines = written
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((line) => line.msg === "diagnostics probe did not answer");
      expect(lines, name).toHaveLength(1);
      const [line] = lines;
      expect(line).toMatchObject({ subsystem: name, code: "probe-error", errorName: "TypeError" });
      expect(Object.keys(line ?? {}).sort()).toEqual(
        ["code", "errorName", "hostname", "level", "msg", "pid", "subsystem", "time"].sort(),
      );
    }
  });

  it("the counts port and the schema-version reader that throw read null, with no log line naming them", async () => {
    const before = logText().length;
    const services = createDiagnosticsServices({
      ...baseline(),
      counts: boom,
      serviceFacts: { ...baseline().serviceFacts, storeSchemaVersion: boom },
    });
    const response = await services.check("reconnect");
    expect(response.counts).toEqual({
      projects: null,
      scanFolders: null,
      openTasks: null,
      reports: null,
    });
    expect(response.service.storeSchemaVersion).toBeNull();
    const body = JSON.stringify(response);
    for (const forbidden of FORBIDDEN) expect(body, forbidden).not.toContain(forbidden);
    expect(logText().slice(before)).not.toContain(SECRET_PATH);
  });
});
