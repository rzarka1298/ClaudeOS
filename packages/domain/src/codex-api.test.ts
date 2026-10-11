import { describe, expect, it } from "vitest";
import { API_BASE } from "./api.js";
import * as codexApi from "./codex-api.js";
import {
  CODEX_ACTION_ERROR_CODES,
  CODEX_API_BASE,
  CODEX_DOCTOR_CAP_MS,
  CODEX_DOCTOR_CLIENT_TIMEOUT_MS,
  CODEX_DOCTOR_PATH,
  CODEX_FOLLOW_LOG_PATH,
  CODEX_HEADROOM_PATH,
  CODEX_HOOK_EVENTS_PATH,
  CODEX_INTEGRATION_PATH,
  CODEX_OPEN_TRANSCRIPT_PATH,
  CODEX_PAIR_LAUNCH_CAP_MS,
  CODEX_PAIR_LAUNCH_CLIENT_TIMEOUT_MS,
  CODEX_SESSIONS_PATH,
  CODEX_TOKEN_ACTIVITY_PATH,
  CODEX_USAGE_PATH,
  CODEX_WRAPPER_RUN_ID_PATTERN,
  CodexActionErrorBodySchema,
  CodexActionOkSchema,
  CodexDoctorRequestSchema,
  CodexFollowLogRequestSchema,
  CodexHookEventsRequestSchema,
  CodexOpenTranscriptRequestSchema,
} from "./codex-api.js";
import * as browser from "./index.browser.js";
import * as full from "./index.js";

describe("the headroom route contract (CODEX-11, CODEX-12, D-25)", () => {
  it("Test 5: the headroom path sits under the Codex base under the API base", () => {
    expect(CODEX_API_BASE).toBe(`${API_BASE}/codex`);
    expect(CODEX_HEADROOM_PATH).toBe(`${API_BASE}/codex/headroom`);
  });

  it("Test 5: the module exports no request schema or poster for the headroom route", () => {
    const names = Object.keys(codexApi).filter((name) => /headroom/i.test(name));
    for (const name of names) {
      expect(name, name).not.toMatch(/request|body|post|set|write|dispatch|consume/i);
    }
    expect(names).toContain("CODEX_HEADROOM_PATH");
  });

  it("declares the fixed action error vocabulary, in order", () => {
    expect([...CODEX_ACTION_ERROR_CODES]).toEqual([
      "invalid-request",
      "not-found",
      "outside-sessions-folder",
      "run-ended",
      "bridge-not-installed",
      "bridge-outdated",
      "window-not-ready",
      "unavailable",
      "failed",
    ]);
  });

  it("the error body is strict { error } over that vocabulary and refuses free text", () => {
    for (const code of CODEX_ACTION_ERROR_CODES) {
      expect(CodexActionErrorBodySchema.safeParse({ error: code }).success, code).toBe(true);
    }
    expect(
      CodexActionErrorBodySchema.safeParse({ error: "disk on fire at /Users/USERNAME/repo" })
        .success,
    ).toBe(false);
    expect(
      CodexActionErrorBodySchema.safeParse({ error: "unavailable", detail: "x" }).success,
    ).toBe(false);
    expect(CodexActionErrorBodySchema.safeParse({}).success).toBe(false);
  });
});

const FORBIDDEN_KEYS = ["path", "rolloutPath", "rollout", "file", "argv", "shell", "cwd"] as const;
const RUN_ID = "20261006T120000123Z";

describe("Codex route paths (D-25)", () => {
  it("Test 1: every route is a fixed, distinct path under the Codex base with no param segment", () => {
    const paths = [
      CODEX_HEADROOM_PATH,
      CODEX_SESSIONS_PATH,
      CODEX_USAGE_PATH,
      CODEX_TOKEN_ACTIVITY_PATH,
      CODEX_INTEGRATION_PATH,
      CODEX_DOCTOR_PATH,
      CODEX_OPEN_TRANSCRIPT_PATH,
      CODEX_FOLLOW_LOG_PATH,
      CODEX_HOOK_EVENTS_PATH,
    ];
    expect(new Set(paths).size).toBe(paths.length);
    for (const path of paths) {
      expect(path.startsWith(`${CODEX_API_BASE}/`), path).toBe(true);
      expect(path, path).not.toMatch(/[:?{}]/);
    }
    expect(CODEX_HOOK_EVENTS_PATH).toBe("/api/v1/codex/hook-events");
  });
});

describe("Codex request schemas are strict and carry no path (D-29, T-05.1-10)", () => {
  it("Test 3: open transcript names a thread id and a way, and refuses every forbidden key", () => {
    for (const via of ["reveal", "open"]) {
      expect(
        CodexOpenTranscriptRequestSchema.safeParse({ threadId: "thread-1", via }).success,
      ).toBe(true);
    }
    expect(
      CodexOpenTranscriptRequestSchema.safeParse({ threadId: "thread-1", via: "edit" }).success,
    ).toBe(false);
    expect(CodexOpenTranscriptRequestSchema.safeParse({ threadId: "thread-1" }).success).toBe(
      false,
    );
    expect(
      CodexOpenTranscriptRequestSchema.safeParse({ threadId: "../x", via: "open" }).success,
    ).toBe(false);
    expect(
      CodexOpenTranscriptRequestSchema.safeParse({ threadId: "a/b", via: "open" }).success,
    ).toBe(false);
    for (const key of FORBIDDEN_KEYS) {
      const body = { threadId: "thread-1", via: "open", [key]: "/Users/USERNAME/repo/x.jsonl" };
      expect(CodexOpenTranscriptRequestSchema.safeParse(body).success, key).toBe(false);
    }
  });

  it("Test 3: follow log names a wrapper run id (eight digits, T, nine digits, Z) and nothing else", () => {
    expect(CODEX_WRAPPER_RUN_ID_PATTERN.test(RUN_ID)).toBe(true);
    expect(CodexFollowLogRequestSchema.safeParse({ runId: RUN_ID }).success).toBe(true);
    for (const runId of [
      "../x",
      "run-1",
      "20261006T12000012Z",
      "20261006T1200001234Z",
      `${RUN_ID}\n`,
      "",
    ]) {
      expect(CodexFollowLogRequestSchema.safeParse({ runId }).success, runId).toBe(false);
    }
    for (const key of FORBIDDEN_KEYS) {
      expect(
        CodexFollowLogRequestSchema.safeParse({ runId: RUN_ID, [key]: "x" }).success,
        key,
      ).toBe(false);
    }
  });

  it("Test 4: doctor takes the strict empty body", () => {
    expect(CodexDoctorRequestSchema.safeParse({}).success).toBe(true);
    expect(CodexDoctorRequestSchema.safeParse({ all: true }).success).toBe(false);
    expect(CodexDoctorRequestSchema.safeParse({ argv: ["doctor"] }).success).toBe(false);
  });

  it("the hook-events route reuses the strict hook record and answers the constant ok", () => {
    const record = {
      eventId: "0f8fad5b-d9cb-469f-a165-70867728950e",
      observedAt: "2026-10-10T12:00:00.000Z",
      hook_event_name: "Stop",
      session_id: "thread-1",
    };
    expect(CodexHookEventsRequestSchema.safeParse(record).success).toBe(true);
    expect(CodexHookEventsRequestSchema.safeParse({ ...record, prompt: "secret" }).success).toBe(
      false,
    );
    expect(CodexActionOkSchema.safeParse({ ok: true }).success).toBe(true);
    expect(CodexActionOkSchema.safeParse({ ok: false }).success).toBe(false);
    expect(CodexActionOkSchema.safeParse({ ok: true, detail: "x" }).success).toBe(false);
  });
});

describe("Codex client deadlines sit above the service caps (CODEX-02, R4)", () => {
  it("Test 4 and 5: doctor 70 s over a 60 s cap, pair launch 4500 ms over a 4 s cap", () => {
    expect(CODEX_DOCTOR_CAP_MS).toBe(60_000);
    expect(CODEX_DOCTOR_CLIENT_TIMEOUT_MS).toBe(70_000);
    expect(CODEX_PAIR_LAUNCH_CAP_MS).toBe(4_000);
    expect(CODEX_PAIR_LAUNCH_CLIENT_TIMEOUT_MS).toBe(4_500);
    expect(CODEX_DOCTOR_CLIENT_TIMEOUT_MS).toBeGreaterThan(CODEX_DOCTOR_CAP_MS);
    expect(CODEX_PAIR_LAUNCH_CLIENT_TIMEOUT_MS).toBeGreaterThan(CODEX_PAIR_LAUNCH_CAP_MS);
  });
});

describe("barrel exports (R-EXPORTS, Test 4)", () => {
  it("the Node barrel and the browser barrel both expose every runtime export of codex-api", () => {
    const names = Object.keys(codexApi);
    expect(names.length).toBeGreaterThan(20);
    for (const name of names) {
      expect(Object.keys(full), name).toContain(name);
      expect(Object.keys(browser), name).toContain(name);
    }
  });
});
