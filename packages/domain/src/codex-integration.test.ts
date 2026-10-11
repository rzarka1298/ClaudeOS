import { describe, expect, it } from "vitest";
import * as integration from "./codex-integration.js";
import {
  CodexBridgeStatusSchema,
  CodexDoctorSummarySchema,
  CodexHookStatusSchema,
  CodexIntegrationStatusSchema,
} from "./codex-integration.js";
import * as sessions from "./codex-sessions.js";
import * as usage from "./codex-usage.js";
import * as browser from "./index.browser.js";
import * as full from "./index.js";

const NOW = "2026-10-10T12:00:00.000Z";

describe("CodexBridgeStatusSchema (Settings status line)", () => {
  it("Test 1: parses each bridge state with an ISO last-window time or null", () => {
    for (const state of [
      "installed",
      "installed-idle",
      "not-installed",
      "outdated",
      "different-folder",
    ]) {
      expect(CodexBridgeStatusSchema.safeParse({ state, lastWindowAt: NOW }).success, state).toBe(
        true,
      );
      expect(CodexBridgeStatusSchema.safeParse({ state, lastWindowAt: null }).success, state).toBe(
        true,
      );
    }
  });

  it("refuses an unknown state, a non-ISO time and any path member", () => {
    expect(CodexBridgeStatusSchema.safeParse({ state: "broken", lastWindowAt: null }).success).toBe(
      false,
    );
    expect(
      CodexBridgeStatusSchema.safeParse({ state: "installed", lastWindowAt: "yesterday" }).success,
    ).toBe(false);
    expect(
      CodexBridgeStatusSchema.safeParse({
        state: "installed",
        lastWindowAt: null,
        stateDir: "/Users/USERNAME/.local/state",
      }).success,
    ).toBe(false);
  });
});

describe("CodexHookStatusSchema", () => {
  it("Test 2: parses each hook state with lastEventAt and installedSince each an ISO time or null", () => {
    for (const state of ["installed", "installed-no-events", "not-installed", "unknown"]) {
      expect(
        CodexHookStatusSchema.safeParse({ state, lastEventAt: NOW, installedSince: NOW }).success,
        state,
      ).toBe(true);
      expect(
        CodexHookStatusSchema.safeParse({ state, lastEventAt: null, installedSince: null }).success,
        state,
      ).toBe(true);
    }
    expect(
      CodexHookStatusSchema.safeParse({
        state: "installed",
        lastEventAt: null,
        installedSince: null,
      }).success,
    ).toBe(true);
  });

  it("names no path or config file and refuses an unknown state", () => {
    expect(
      CodexHookStatusSchema.safeParse({ state: "odd", lastEventAt: null, installedSince: null })
        .success,
    ).toBe(false);
    for (const extra of [
      { hooksPath: "/Users/USERNAME/.codex/hooks.json" },
      { configFile: "/Users/USERNAME/.codex/config.toml" },
    ]) {
      expect(
        CodexHookStatusSchema.safeParse({
          state: "installed",
          lastEventAt: null,
          installedSince: null,
          ...extra,
        }).success,
      ).toBe(false);
    }
    expect(Object.keys(CodexHookStatusSchema.shape).sort()).toEqual([
      "installedSince",
      "lastEventAt",
      "state",
    ]);
  });
});

function check(overrides: Record<string, unknown> = {}) {
  return { id: "network.provider_reachability", category: "network", status: "ok", ...overrides };
}

function doctor(overrides: Record<string, unknown> = {}) {
  return { overall: "ok", codexVersion: "0.159.2", checks: [check()], ...overrides };
}

describe("CodexDoctorSummarySchema (RESEARCH R4 allowlist, CODEX-09)", () => {
  it("Test 3: keeps overall status, a version or null and up to 64 id/category/status checks", () => {
    for (const overall of ["ok", "warning", "fail", "unrecognised"]) {
      expect(CodexDoctorSummarySchema.safeParse(doctor({ overall })).success, overall).toBe(true);
    }
    expect(CodexDoctorSummarySchema.safeParse(doctor({ codexVersion: null })).success).toBe(true);
    expect(
      CodexDoctorSummarySchema.safeParse(doctor({ codexVersion: "/Users/USERNAME/codex" })).success,
    ).toBe(false);
    const many = (count: number) =>
      Array.from({ length: count }, (_, i) => check({ id: `check.${i}` }));
    expect(CodexDoctorSummarySchema.safeParse(doctor({ checks: many(64) })).success).toBe(true);
    expect(CodexDoctorSummarySchema.safeParse(doctor({ checks: many(65) })).success).toBe(false);
    expect(
      CodexDoctorSummarySchema.safeParse(doctor({ checks: [check({ id: "has space" })] })).success,
    ).toBe(false);
    expect(
      CodexDoctorSummarySchema.safeParse(doctor({ checks: [check({ status: "skipped" })] }))
        .success,
    ).toBe(false);
  });

  it("refuses a check carrying details, summary, remediation or notes", () => {
    for (const extra of [
      { details: { path: "/Users/USERNAME/.codex" } },
      { summary: "Signed in as someone@example.com" },
      { remediation: "run codex login" },
      { notes: ["a note"] },
    ]) {
      expect(
        CodexDoctorSummarySchema.safeParse(doctor({ checks: [check(extra)] })).success,
        JSON.stringify(extra),
      ).toBe(false);
    }
    expect(CodexDoctorSummarySchema.safeParse(doctor({ details: {} })).success).toBe(false);
  });
});

describe("CodexIntegrationStatusSchema", () => {
  function status(overrides: Record<string, unknown> = {}) {
    return {
      hooks: { state: "installed", lastEventAt: NOW, installedSince: NOW },
      bridge: { state: "installed", lastWindowAt: NOW },
      codex: { installed: true, version: "0.159.2" },
      doctor: doctor(),
      ...overrides,
    };
  }

  it("Test 4: composes hooks, bridge, codex and doctor, with a null doctor allowed", () => {
    expect(CodexIntegrationStatusSchema.safeParse(status()).success).toBe(true);
    expect(CodexIntegrationStatusSchema.safeParse(status({ doctor: null })).success).toBe(true);
    expect(
      CodexIntegrationStatusSchema.safeParse(status({ codex: { installed: false, version: null } }))
        .success,
    ).toBe(true);
    expect(Object.keys(CodexIntegrationStatusSchema.shape).sort()).toEqual([
      "bridge",
      "codex",
      "doctor",
      "hooks",
    ]);
  });

  it("carries no path, config file or account member", () => {
    for (const extra of [
      { codexHome: "/Users/USERNAME/.codex" },
      { configFile: "/Users/USERNAME/.codex/config.toml" },
      { accountId: "acct-1" },
    ]) {
      expect(
        CodexIntegrationStatusSchema.safeParse(status(extra)).success,
        JSON.stringify(extra),
      ).toBe(false);
    }
    expect(
      CodexIntegrationStatusSchema.safeParse(
        status({ codex: { installed: true, version: "0.1.0", path: "/usr/bin/codex" } }),
      ).success,
    ).toBe(false);
  });
});

describe("barrel exports (R-EXPORTS)", () => {
  it("Test 5: the Node barrel and the browser barrel both expose every runtime export of the three Codex modules", () => {
    const names = [...Object.keys(integration), ...Object.keys(sessions), ...Object.keys(usage)];
    expect(names.length).toBeGreaterThan(30);
    for (const name of names) {
      expect(full, `index.ts is missing ${name}`).toHaveProperty(name);
      expect(browser, `index.browser.ts is missing ${name}`).toHaveProperty(name);
    }
  });
});
