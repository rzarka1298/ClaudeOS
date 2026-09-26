import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  classifyHookRecord,
  HOOK_RECORD_SCHEMAS,
  HookRecordEnvelopeSchema,
  KNOWN_HOOK_EVENTS,
  type KnownHookEvent,
  SESSION_END_REASONS,
  SESSION_START_SOURCES,
  STOP_FAILURE_ERRORS,
  UNKNOWN_HOOK_EVENT_NAME_PLACEHOLDER,
} from "./claude-hook-events.js";

/**
 * The one field each known event needs beyond the shared envelope and
 * `session_id` (D-12). Every other event needs nothing extra.
 */
const NEEDED_FIELDS: Record<KnownHookEvent, Record<string, unknown>> = {
  SessionStart: { source: "startup" },
  SessionEnd: {},
  Stop: {},
  StopFailure: { stop_error: "rate_limit" },
  Notification: {},
  SubagentStart: {},
  SubagentStop: {},
  TaskCreated: {},
  TaskCompleted: {},
  UserPromptSubmit: {},
  PermissionRequest: {},
  PermissionDenied: {},
  PostModelSwitch: {},
  PostToolUse: {},
  PostToolUseFailure: {},
};

/** A builder-made minimal record: envelope, session id, and the event's needed fields. */
function minimalRecord(
  event: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const needed = (NEEDED_FIELDS as Record<string, Record<string, unknown>>)[event] ?? {};
  return {
    eventId: randomUUID(),
    observedAt: new Date().toISOString(),
    hook_event_name: event,
    session_id: "0f3c2a8e-5b1d-4c7e-9a2f-1e6d8b4c3a90",
    ...needed,
    ...overrides,
  };
}

const SENTINEL = "SENTINEL-VALUE-7f3a";

describe("KNOWN_HOOK_EVENTS (D-11 + D-04)", () => {
  it("lists exactly the fifteen subscribed events", () => {
    expect([...KNOWN_HOOK_EVENTS]).toEqual([
      "SessionStart",
      "SessionEnd",
      "Stop",
      "StopFailure",
      "Notification",
      "SubagentStart",
      "SubagentStop",
      "TaskCreated",
      "TaskCompleted",
      "UserPromptSubmit",
      "PermissionRequest",
      "PermissionDenied",
      "PostModelSwitch",
      "PostToolUse",
      "PostToolUseFailure",
    ]);
  });

  it("has one per-event schema for every known event and no others", () => {
    expect(Object.keys(HOOK_RECORD_SCHEMAS).sort()).toEqual([...KNOWN_HOOK_EVENTS].sort());
  });

  it("quotes the documented enums verbatim", () => {
    expect([...SESSION_START_SOURCES]).toEqual(["startup", "resume", "clear", "compact", "fork"]);
    expect([...SESSION_END_REASONS]).toEqual([
      "clear",
      "resume",
      "logout",
      "prompt_input_exit",
      "other",
    ]);
    expect(STOP_FAILURE_ERRORS).toHaveLength(12);
    expect(STOP_FAILURE_ERRORS).toContain("rate_limit");
    expect(STOP_FAILURE_ERRORS).toContain("unknown");
  });
});

describe("classifyHookRecord — known events (Test 1)", () => {
  it.each(KNOWN_HOOK_EVENTS.map((event) => [event]))(
    "classifies a minimal %s record as known",
    (event) => {
      const result = classifyHookRecord(minimalRecord(event));
      expect(result.kind).toBe("known");
      if (result.kind === "known") {
        expect(result.event).toBe(event);
        expect(result.record.hook_event_name).toBe(event);
      }
    },
  );

  it("accepts a fully populated SessionStart record", () => {
    const result = classifyHookRecord(
      minimalRecord("SessionStart", {
        source: "resume",
        cwd: "/Users/USERNAME/code/alpha",
        transcript_path: "/Users/USERNAME/.claude/projects/alpha/abc.jsonl",
        permission_mode: "plan",
        model: "claude-opus-4-5",
        session_title: "Fix the parser",
        effort_level: "high",
        env: {
          CLAUDE_PID: "4242",
          TERM_PROGRAM: "Apple_Terminal",
          CLAUDE_CODE_CHILD_SESSION: "1",
          CCC_RUN_ID: "0mfk1a2b3c4d5e6f7a8b9c0d1",
          CCC_LAUNCH_SOURCE: "dashboard",
        },
      }),
    );
    expect(result.kind).toBe("known");
  });

  it("accepts a SessionEnd reason outside the documented set (removed values still parse)", () => {
    const result = classifyHookRecord(
      minimalRecord("SessionEnd", { reason: "bypass_permissions_disabled" }),
    );
    expect(result.kind).toBe("known");
  });
});

describe("classifyHookRecord — unknown and envelope-invalid (Test 2)", () => {
  it("classifies an event name outside the subscription set as unknown, never an error", () => {
    const result = classifyHookRecord(minimalRecord("SomeFutureEvent"));
    expect(result).toEqual({ kind: "unknown", eventName: "SomeFutureEvent" });
  });

  it("echoes an unknown event name only when it is letters-only, else a fixed placeholder", () => {
    expect(classifyHookRecord(minimalRecord("E".repeat(64)))).toEqual({
      kind: "unknown",
      eventName: "E".repeat(64),
    });
    for (const name of [
      "Some Future Event",
      "/Users/USERNAME/secret",
      `${SENTINEL}`,
      "Event_2",
      "<script>",
    ]) {
      const result = classifyHookRecord(minimalRecord(name));
      expect(result).toEqual({ kind: "unknown", eventName: UNKNOWN_HOOK_EVENT_NAME_PLACEHOLDER });
      expect(JSON.stringify(result)).not.toContain(name);
    }
  });

  it.each([[null], ["a string"], [42], [[1, 2, 3]], [undefined]])(
    "classifies the non-object input %j as envelope-invalid",
    (input) => {
      expect(classifyHookRecord(input)).toEqual({ kind: "envelope-invalid" });
    },
  );

  it("classifies a record without eventId as envelope-invalid", () => {
    const record = minimalRecord("Stop");
    delete record.eventId;
    expect(classifyHookRecord(record)).toEqual({ kind: "envelope-invalid" });
  });

  it("classifies a record with a non-ISO observedAt as envelope-invalid", () => {
    expect(classifyHookRecord(minimalRecord("Stop", { observedAt: "yesterday" }))).toEqual({
      kind: "envelope-invalid",
    });
  });

  it("classifies an over-long event name as envelope-invalid", () => {
    expect(classifyHookRecord(minimalRecord("E".repeat(65)))).toEqual({
      kind: "envelope-invalid",
    });
  });

  it("parses the envelope permissively so a record with unknown keys still classifies", () => {
    const parsed = HookRecordEnvelopeSchema.safeParse(minimalRecord("Stop", { extra: 1 }));
    expect(parsed.success).toBe(true);
  });
});

describe("classifyHookRecord — shape-invalid lists paths, never values (Test 3, T-05-01)", () => {
  it("reports a SessionStart without source as shape-invalid at path 'source'", () => {
    const record = minimalRecord("SessionStart");
    delete record.source;
    const result = classifyHookRecord(record);
    expect(result).toEqual({
      kind: "shape-invalid",
      event: "SessionStart",
      issuePaths: ["source"],
    });
  });

  it("reports a StopFailure whose stop_error is outside the enum at path 'stop_error'", () => {
    const result = classifyHookRecord(minimalRecord("StopFailure", { stop_error: SENTINEL }));
    expect(result).toEqual({
      kind: "shape-invalid",
      event: "StopFailure",
      issuePaths: ["stop_error"],
    });
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });

  it("reports a numeric session_id at path 'session_id'", () => {
    const result = classifyHookRecord(minimalRecord("Stop", { session_id: 12345 }));
    expect(result).toEqual({ kind: "shape-invalid", event: "Stop", issuePaths: ["session_id"] });
  });

  it("reports nested paths joined with a dot", () => {
    const result = classifyHookRecord(minimalRecord("Stop", { env: { CLAUDE_PID: SENTINEL } }));
    expect(result).toEqual({
      kind: "shape-invalid",
      event: "Stop",
      issuePaths: ["env.CLAUDE_PID"],
    });
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });

  it("never echoes a sentinel value from any invalid field", () => {
    const result = classifyHookRecord(
      minimalRecord("SessionStart", {
        source: SENTINEL,
        cwd: `relative/${SENTINEL}`,
        permission_mode: `${SENTINEL} with spaces`,
        effort_level: SENTINEL,
      }),
    );
    expect(result.kind).toBe("shape-invalid");
    if (result.kind === "shape-invalid") {
      expect([...result.issuePaths].sort()).toEqual(
        ["cwd", "effort_level", "permission_mode", "source"].sort(),
      );
    }
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });

  it("rejects a cwd carrying a NUL byte", () => {
    const result = classifyHookRecord(minimalRecord("Stop", { cwd: "/Users/USERNAME/a\0b" }));
    expect(result).toEqual({ kind: "shape-invalid", event: "Stop", issuePaths: ["cwd"] });
  });

  it("rejects a SessionEnd reason that is not identifier-shaped or is too long", () => {
    for (const reason of ["has spaces", "r".repeat(65)]) {
      const result = classifyHookRecord(minimalRecord("SessionEnd", { reason }));
      expect(result).toEqual({
        kind: "shape-invalid",
        event: "SessionEnd",
        issuePaths: ["reason"],
      });
    }
  });
});

describe("classifyHookRecord — passthrough and no defaults (Test 4, D-12)", () => {
  it("tolerates unknown extra keys on a known event and drops them", () => {
    const result = classifyHookRecord(minimalRecord("PostToolUse", { some_new_field: "x" }));
    expect(result.kind).toBe("known");
    if (result.kind === "known") {
      expect("some_new_field" in result.record).toBe(false);
    }
  });

  it("never carries a prompt, tool_input or unknown env key on a known record (PR-04)", () => {
    for (const event of KNOWN_HOOK_EVENTS) {
      const result = classifyHookRecord(
        minimalRecord(event, {
          prompt: SENTINEL,
          tool_input: { command: SENTINEL },
          tool_response: SENTINEL,
          env: { CLAUDE_PID: "4242", ANTHROPIC_API_KEY: SENTINEL, HOME: SENTINEL },
        }),
      );
      expect(result.kind).toBe("known");
      if (result.kind === "known") {
        const record = result.record as Record<string, unknown>;
        expect("prompt" in record).toBe(false);
        expect("tool_input" in record).toBe(false);
        expect("tool_response" in record).toBe(false);
        expect(record.env).toEqual({ CLAUDE_PID: "4242" });
        expect(JSON.stringify(record)).not.toContain(SENTINEL);
      }
    }
  });

  it("leaves omitted optional fields undefined rather than filling them in", () => {
    const result = classifyHookRecord(minimalRecord("SessionEnd"));
    expect(result.kind).toBe("known");
    if (result.kind === "known") {
      const record = result.record as Record<string, unknown>;
      for (const field of ["cwd", "transcript_path", "reason", "model", "env", "permission_mode"]) {
        expect(field in record).toBe(false);
        expect(record[field]).toBeUndefined();
      }
    }
  });

  it("never supplies a session id, source or stop error that was not sent", () => {
    for (const [event, missing] of [
      ["Stop", "session_id"],
      ["SessionStart", "source"],
      ["StopFailure", "stop_error"],
    ] as const) {
      const record = minimalRecord(event);
      delete record[missing];
      const result = classifyHookRecord(record);
      expect(result).toEqual({ kind: "shape-invalid", event, issuePaths: [missing] });
    }
  });

  it("declares no defaulting or catch-fallback modifier in the schema source", () => {
    const source = readFileSync(new URL("./claude-hook-events.ts", import.meta.url), "utf8");
    // Built as RegExp objects, not call-shaped literals, so this test file
    // itself never contains the forbidden shape it scans for.
    const forbidden = ["default", "catch", "prefault"].map(
      (name) => new RegExp(`\\.\\s*${name}\\s*\\u0028`),
    );
    for (const pattern of forbidden) {
      expect(pattern.test(source)).toBe(false);
    }
  });
});
