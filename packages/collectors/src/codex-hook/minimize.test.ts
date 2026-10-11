import { CodexHookRecordSchema } from "@ccc/domain";
import { describe, expect, it } from "vitest";
import {
  buildCodexPayload,
  buildCodexStdin,
  CODEX_EXPECTED_KEYS,
  CODEX_TEST_CWD,
  CODEX_TEST_EVENTS,
  CODEX_TEST_MODEL,
  CODEX_TEST_SESSION_ID,
  CODEX_TEST_TURN_ID,
} from "../test-support/codex-hook-stdin.js";
import { SENTINEL } from "../test-support/hook-stdin.js";
import { KEPT_FIELDS, minimizeCodexHookInput } from "./minimize.js";

const META = {
  eventId: "6f1d2c3b-4a5e-4f60-8a71-92b3c4d5e6f7",
  observedAt: "2026-10-10T09:00:00.000Z",
} as const;

/** Every payload key that must never reach a record, whatever the event. */
const DROPPED_KEYS = [
  "prompt",
  "last_assistant_message",
  "transcript_path",
  "permission_mode",
  "stop_hook_active",
  "agent_id",
  "agent_type",
  "tool_input",
  "unknown_future_key",
] as const;

function minimize(text: string | null, options: { overflowed?: boolean } = {}) {
  return minimizeCodexHookInput(text, META, options);
}

describe("Test 1: the per-event allowlist, with decoys in every dropped field", () => {
  it.each(CODEX_TEST_EVENTS)("%s keeps exactly its allowlisted keys", (event) => {
    const record = minimize(buildCodexStdin(event));
    expect(record).not.toBeNull();
    expect(Object.keys(record ?? {}).sort()).toEqual([...CODEX_EXPECTED_KEYS[event]].sort());
    expect(JSON.stringify(record)).not.toContain(SENTINEL);
    for (const key of DROPPED_KEYS) expect(record).not.toHaveProperty(key);
  });

  it("keeps the documented values per event", () => {
    expect(minimize(buildCodexStdin("SessionStart"))).toEqual({
      ...META,
      hook_event_name: "SessionStart",
      session_id: CODEX_TEST_SESSION_ID,
      cwd: CODEX_TEST_CWD,
      model: CODEX_TEST_MODEL,
      source: "startup",
    });
    expect(minimize(buildCodexStdin("SessionEnd"))).toEqual({
      ...META,
      hook_event_name: "SessionEnd",
      session_id: CODEX_TEST_SESSION_ID,
      cwd: CODEX_TEST_CWD,
      reason: "other",
    });
    for (const event of ["UserPromptSubmit", "Stop", "Interrupt"] as const) {
      expect(minimize(buildCodexStdin(event))).toEqual({
        ...META,
        hook_event_name: event,
        session_id: CODEX_TEST_SESSION_ID,
        cwd: CODEX_TEST_CWD,
        model: CODEX_TEST_MODEL,
        turn_id: CODEX_TEST_TURN_ID,
      });
    }
  });

  it("does not keep a key from a different event's allowlist", () => {
    // A Stop payload that also carries `source` and `reason` keeps neither.
    const stop = minimize(
      buildCodexStdin("Stop", { overrides: { source: "startup", reason: "other" } }),
    );
    expect(stop).not.toHaveProperty("source");
    expect(stop).not.toHaveProperty("reason");
    // A SessionEnd payload that carries a turn id and a model keeps neither.
    const end = minimize(
      buildCodexStdin("SessionEnd", {
        overrides: { turn_id: CODEX_TEST_TURN_ID, model: CODEX_TEST_MODEL },
      }),
    );
    expect(end).not.toHaveProperty("turn_id");
    expect(end).not.toHaveProperty("model");
  });

  it("the allowlist table names only keys the domain record has, and never a content key", () => {
    const domainKeys = new Set(Object.keys(CodexHookRecordSchema.shape));
    for (const [event, keys] of Object.entries(KEPT_FIELDS)) {
      for (const key of keys) expect(domainKeys.has(key), `${event}.${key}`).toBe(true);
      for (const dropped of DROPPED_KEYS) expect(keys as readonly string[]).not.toContain(dropped);
    }
  });

  it("omits an absent or null kept key and never defaults it", () => {
    const stop = minimize(
      buildCodexStdin("Stop", { overrides: { model: null }, omit: ["turn_id", "cwd"] }),
    );
    expect(Object.keys(stop ?? {}).sort()).toEqual(
      ["eventId", "hook_event_name", "observedAt", "session_id"].sort(),
    );
  });

  it("Test 7: every output validates against the domain record schema", () => {
    for (const event of CODEX_TEST_EVENTS) {
      const record = minimize(buildCodexStdin(event));
      expect(CodexHookRecordSchema.safeParse(record).success, event).toBe(true);
    }
  });
});

describe("Test 2: the 4 KiB record cap and oversized input", () => {
  it("a record is at most 4096 bytes: an over-long cwd is dropped, the event is kept", () => {
    const cwd = `/${"a".repeat(4000)}`;
    const record = minimize(buildCodexStdin("Stop", { overrides: { cwd } }));
    expect(record).not.toBeNull();
    expect(record).not.toHaveProperty("cwd");
    expect(record?.session_id).toBe(CODEX_TEST_SESSION_ID);
    expect(Buffer.byteLength(JSON.stringify(record))).toBeLessThanOrEqual(4096);
    expect(CodexHookRecordSchema.safeParse(record).success).toBe(true);
  });

  it("a cwd over the domain's 4096-character cap is invalid input, so nothing is delivered", () => {
    const record = minimize(
      buildCodexStdin("Stop", { overrides: { cwd: `/${"a".repeat(4096)}` } }),
    );
    expect(record).toBeNull();
  });

  it("an overflowed stdin yields only the identifiers a bounded scan finds, never content", () => {
    const text = buildCodexStdin("Stop", { tail: { last_assistant_message: 262_144 } });
    const record = minimize(text.slice(0, 262_144), { overflowed: true });
    expect(record).not.toBeNull();
    expect(record?.hook_event_name).toBe("Stop");
    expect(record?.session_id).toBe(CODEX_TEST_SESSION_ID);
    expect(record?.turn_id).toBe(CODEX_TEST_TURN_ID);
    expect(Object.keys(record ?? {}).sort()).toEqual(
      ["eventId", "hook_event_name", "observedAt", "session_id", "turn_id"].sort(),
    );
    expect(JSON.stringify(record)).not.toContain(SENTINEL);
  });

  it("an overflowed stdin whose prefix holds no event name delivers nothing", () => {
    const text = buildCodexStdin("Stop", { overrides: { prompt: "x".repeat(300_000) } });
    // Decoy keys come first in the built payload, so the identifiers are past the prefix.
    expect(minimize(text.slice(0, 262_144), { overflowed: true })).toBeNull();
  });

  it("the scan ignores an identifier-looking pair that is inside an escaped string value", () => {
    const hostile = JSON.stringify({
      prompt: '{"hook_event_name":"Stop","session_id":"injected-id"}',
      ...buildCodexPayload("Stop", { decoys: false }),
    });
    const record = minimize(hostile, { overflowed: true });
    expect(record?.session_id).toBe(CODEX_TEST_SESSION_ID);
    expect(JSON.stringify(record)).not.toContain("injected-id");
  });

  it("a truncated, unparseable payload falls back to the same bounded scan", () => {
    const text = buildCodexStdin("Stop", { decoys: false });
    const record = minimize(text.slice(0, text.length - 10));
    expect(record?.hook_event_name).toBe("Stop");
    expect(record?.session_id).toBe(CODEX_TEST_SESSION_ID);
  });
});

describe("Test 3: invalid input delivers nothing", () => {
  it("an unknown event name, including every Claude event name, delivers nothing", () => {
    const claudeNames = [
      "PostToolUse",
      "PreToolUse",
      "StopFailure",
      "Notification",
      "SubagentStart",
      "SubagentStop",
      "PermissionRequest",
      "PostModelSwitch",
      "TaskCompleted",
      "Totally-Unknown",
      "",
      "stop",
    ];
    for (const name of claudeNames) {
      expect(
        minimize(buildCodexStdin("Stop", { overrides: { hook_event_name: name } })),
        name,
      ).toBeNull();
    }
    expect(minimize(buildCodexStdin("Stop", { omit: ["hook_event_name"] }))).toBeNull();
    expect(minimize(buildCodexStdin("Stop", { overrides: { hook_event_name: 7 } }))).toBeNull();
  });

  it("a missing, non-string or malformed session id delivers nothing", () => {
    const bad: unknown[] = [
      undefined,
      null,
      7,
      { id: "x" },
      ["a"],
      "",
      "a b",
      "a/b",
      "x".repeat(129),
      "id\n1",
    ];
    for (const value of bad) {
      const text = JSON.stringify(buildCodexPayload("Stop", { overrides: { session_id: value } }));
      expect(minimize(text), JSON.stringify(value)).toBeNull();
    }
    expect(minimize(buildCodexStdin("Stop", { omit: ["session_id"] }))).toBeNull();
  });

  it("a relative cwd, a cwd with a control character, and a bad model or turn id deliver nothing", () => {
    const cases: Record<string, unknown>[] = [
      { cwd: "relative/path" },
      { cwd: "./here" },
      { cwd: "/a\u0000b" },
      { cwd: "/a\nb" },
      { cwd: 7 },
      { model: "gpt\n5" },
      { model: "gpt\u001b[31m" },
      { model: "a/b" },
      { model: "x".repeat(65) },
      { model: 5 },
      { turn_id: "has space" },
      { turn_id: "x".repeat(129) },
    ];
    for (const overrides of cases) {
      expect(
        minimize(buildCodexStdin("Stop", { overrides })),
        JSON.stringify(overrides),
      ).toBeNull();
    }
  });

  it("an invalid source or reason delivers nothing", () => {
    expect(
      minimize(buildCodexStdin("SessionStart", { overrides: { source: "has space" } })),
    ).toBeNull();
    expect(
      minimize(buildCodexStdin("SessionEnd", { overrides: { reason: "x".repeat(33) } })),
    ).toBeNull();
  });

  it("non-object JSON, arrays, empty and null input deliver nothing", () => {
    for (const text of ["", "null", "[]", '"Stop"', "42", "{", "<<not json>>"]) {
      expect(minimize(text), text).toBeNull();
    }
    expect(minimize(null)).toBeNull();
  });
});
