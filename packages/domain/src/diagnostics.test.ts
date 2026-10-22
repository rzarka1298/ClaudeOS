import { describe, expect, it } from "vitest";
import { HEALTH_PATH } from "./auth.js";
import {
  DIAGNOSTICS_HEALTH_PATH,
  DiagnosticsHealthResponseSchema,
  summariseRows,
} from "./diagnostics.js";

const T0 = "2026-10-22T09:00:00.000Z";

function row(id: string, reasonCode: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    status: "setup-needed" as const,
    reasonCode,
    checkedAt: T0,
    freshness: "live",
    ...extra,
  };
}

/** The fresh-install response: five service-side rows, all setup-needed (D-34). */
function freshInstall() {
  return {
    generatedAt: T0,
    service: { version: "0.1.0", startedAt: T0, storeSchemaVersion: 12 },
    rows: [
      row("vault", "vault-not-set-up"),
      row("hooks", "hooks-not-installed"),
      row("collectors", "analysis-off"),
      row("scheduler", "never-run"),
      row("launchers", "launcher-not-set-up"),
    ],
    keychain: { installSecret: "present", researchKey: "absent" },
    paths: {
      vault: null,
      runtimeDir: "~/.claude-command-center",
      socket: "~/.claude-command-center/svc.sock",
    },
    vaultFingerprint: null,
    counts: { projects: 0, scanFolders: 0, openTasks: null, reports: 0 },
  };
}

describe("Task 1 (tracer): a fresh-install health response", () => {
  it("Test 1: parses through the strict contract", () => {
    const parsed = DiagnosticsHealthResponseSchema.safeParse(freshInstall());
    expect(parsed.success).toBe(true);
  });

  it("Test 2: summarises to zero failing and zero degraded", () => {
    const service = { id: "service", status: "ok" as const, reasonCode: "service-live" };
    const rows = [service, ...freshInstall().rows];
    expect(summariseRows(rows)).toEqual({
      failing: 0,
      degraded: 0,
      unknown: 0,
      setupNeeded: 5,
      ok: 1,
    });
  });

  it("Test 3: the health path is its own route, not the Phase 1 health path", () => {
    expect(DIAGNOSTICS_HEALTH_PATH).toBe("/api/v1/diagnostics/health");
    expect(DIAGNOSTICS_HEALTH_PATH).not.toBe(HEALTH_PATH);
  });

  it("Test 4: a row with an extra key, or a status that differs from its reason's, is refused", () => {
    const extraKey = freshInstall();
    extraKey.rows[0] = { ...extraKey.rows[0], message: "boom" } as never;
    expect(DiagnosticsHealthResponseSchema.safeParse(extraKey).success).toBe(false);

    const wrongStatus = freshInstall();
    wrongStatus.rows[1] = { ...wrongStatus.rows[1], status: "ok" } as never;
    expect(DiagnosticsHealthResponseSchema.safeParse(wrongStatus).success).toBe(false);

    const extraTop = { ...freshInstall(), error: "x" };
    expect(DiagnosticsHealthResponseSchema.safeParse(extraTop).success).toBe(false);
  });
});
