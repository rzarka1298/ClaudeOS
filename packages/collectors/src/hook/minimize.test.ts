import {
  CLAUDE_HOOK_EVENTS_PATH,
  CLAUDE_STATUSLINE_PATH,
  classifyHookRecord,
  HANDSHAKE_PATH as DOMAIN_HANDSHAKE_PATH,
  KNOWN_HOOK_EVENTS,
  STOP_FAILURE_ERRORS,
} from "@ccc/domain";
import { describe, expect, it } from "vitest";
import {
  buildHookPayload,
  buildHookStdin,
  ENV_SENTINEL,
  SENTINEL,
} from "../test-support/hook-stdin.js";
import {
  HANDSHAKE_PATH,
  HOOK_EVENTS_PATH,
  MAX_RECORD_BYTES,
  STATUSLINE_PATH,
  STDIN_RETAIN_BYTES,
} from "./limits.js";
import {
  ENV_KEPT,
  HOOK_KNOWN_EVENTS,
  HOOK_STOP_FAILURE_ERRORS,
  KEPT_FIELDS,
  type MinimizedHookRecord,
  minimizeHookInput,
} from "./minimize.js";

const META = {
  eventId: "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b",
  observedAt: "2026-09-28T10:00:00.000Z",
};

/** A Claude-like environment: kept keys plus secret-shaped ones that must never cross. */
const ENV = {
  CLAUDE_PID: "4242",
  TERM_PROGRAM: "Apple_Terminal",
  CLAUDE_CODE_CHILD_SESSION: "1",
  CCC_RUN_ID: "0mfk2x9ab3c4d5e6f7g8h9j0k",
  CCC_LAUNCH_SOURCE: "dashboard",
  ANTHROPIC_API_KEY: ENV_SENTINEL,
  GITHUB_TOKEN: ENV_SENTINEL,
  HOME: "/Users/USERNAME",
};

const EIGHT_MIB = 8 * 1024 * 1024;

function minimize(raw: string, overrides: { overflowed?: boolean } = {}): MinimizedHookRecord {
  const record = minimizeHookInput(raw, ENV, META, overrides);
  if (record === null) throw new Error("expected a record");
  return record;
}

function byteLength(record: unknown): number {
  return Buffer.byteLength(JSON.stringify(record));
}

describe("mirrors of domain values stay equal (the hook cannot import them)", () => {
  it("the known-event list equals KNOWN_HOOK_EVENTS", () => {
    expect([...HOOK_KNOWN_EVENTS]).toEqual([...KNOWN_HOOK_EVENTS]);
    expect(Object.keys(KEPT_FIELDS).sort()).toEqual([...KNOWN_HOOK_EVENTS].sort());
  });

  it("the StopFailure error list equals STOP_FAILURE_ERRORS", () => {
    expect([...HOOK_STOP_FAILURE_ERRORS]).toEqual([...STOP_FAILURE_ERRORS]);
  });

  it("the route literals equal the domain route constants", () => {
    expect(HOOK_EVENTS_PATH).toBe(CLAUDE_HOOK_EVENTS_PATH);
    expect(STATUSLINE_PATH).toBe(CLAUDE_STATUSLINE_PATH);
    expect(HANDSHAKE_PATH).toBe(DOMAIN_HANDSHAKE_PATH);
  });
});

describe("every known event minimizes to a record the service classifies as known", () => {
  it.each([...KNOWN_HOOK_EVENTS])("%s", (event) => {
    const record = minimize(buildHookStdin(event));
    expect(classifyHookRecord(record)).toMatchObject({ kind: "known", event });
    expect(JSON.stringify(record)).not.toContain(SENTINEL);
  });
});

describe("Test 5: an 8 MiB tool payload minimizes to a small record with no payload text", () => {
  const stdin = buildHookStdin("PostToolUse", { toolPayloadBytes: EIGHT_MIB / 2 });

  it("the full payload parses to at most 4096 bytes carrying tool_name only", () => {
    expect(Buffer.byteLength(stdin)).toBeGreaterThanOrEqual(EIGHT_MIB);
    const record = minimize(stdin);
    const json = JSON.stringify(record);
    expect(byteLength(record)).toBeLessThanOrEqual(MAX_RECORD_BYTES);
    expect(record.tool_name).toBe("Bash");
    expect(json).not.toContain(SENTINEL);
    for (const key of ["tool_input", "tool_response", "error", "tool_use_id", "duration_ms"]) {
      expect(record).not.toHaveProperty(key);
    }
  });
});

describe("Test 6: per-event allowlists", () => {
  it("PostToolUseFailure keeps tool_name and is_interrupt, never the failure output", () => {
    const record = minimize(buildHookStdin("PostToolUseFailure"));
    expect(record.tool_name).toBe("Bash");
    expect(record.is_interrupt).toBe(false);
    for (const key of ["error", "tool_input", "tool_use_id", "duration_ms"]) {
      expect(record).not.toHaveProperty(key);
    }
  });

  it("Notification drops message and title but keeps notification_type", () => {
    const record = minimize(buildHookStdin("Notification"));
    expect(record.notification_type).toBe("permission_prompt");
    expect(record).not.toHaveProperty("message");
    expect(record).not.toHaveProperty("title");
  });

  it("UserPromptSubmit drops the prompt", () => {
    const record = minimize(buildHookStdin("UserPromptSubmit"));
    expect(record).not.toHaveProperty("prompt");
    expect(record).not.toHaveProperty("source");
  });

  it("SubagentStop drops last_assistant_message, background tasks and the agent transcript", () => {
    const record = minimize(buildHookStdin("SubagentStop"));
    expect(record.agent_type).toBe("general-purpose");
    for (const key of ["last_assistant_message", "background_tasks", "agent_transcript_path"]) {
      expect(record).not.toHaveProperty(key);
    }
  });

  it("TaskCreated drops task_subject and task_description", () => {
    const record = minimize(buildHookStdin("TaskCreated"));
    expect(record).not.toHaveProperty("task_subject");
    expect(record).not.toHaveProperty("task_description");
  });

  it("StopFailure forwards a documented error as stop_error and nothing else of the failure", () => {
    const record = minimize(buildHookStdin("StopFailure"));
    expect(record.stop_error).toBe("rate_limit");
    for (const key of ["error", "error_details", "last_assistant_message"]) {
      expect(record).not.toHaveProperty(key);
    }
  });

  it("StopFailure drops an undocumented error value entirely", () => {
    const record = minimize(
      buildHookStdin("StopFailure", { overrides: { error: `${SENTINEL} raw provider error` } }),
    );
    expect(record).not.toHaveProperty("stop_error");
    expect(JSON.stringify(record)).not.toContain(SENTINEL);
  });

  it("PostModelSwitch maps its model fields and renames source to switch_source", () => {
    const record = minimize(buildHookStdin("PostModelSwitch"));
    expect(record).toMatchObject({
      from_model: "claude-sonnet-5",
      to_model: "claude-opus-5-5",
      switch_source: "command",
    });
    expect(record).not.toHaveProperty("source");
    expect(record).not.toHaveProperty("requested_model");
  });

  it("the common effort object crosses as effort_level only", () => {
    const record = minimize(buildHookStdin("Stop"));
    expect(record.effort_level).toBe("high");
    expect(record).not.toHaveProperty("effort");
  });

  it("an object under an allowlisted key is dropped, never forwarded", () => {
    const record = minimize(
      buildHookStdin("PostToolUse", { overrides: { tool_name: { nested: SENTINEL } } }),
    );
    expect(record).not.toHaveProperty("tool_name");
  });

  it("an unknown event yields only the envelope and session_id", () => {
    const payload = buildHookPayload("PostToolUse");
    const record = minimize(JSON.stringify({ ...payload, hook_event_name: "PreCompact" }));
    expect(Object.keys(record).sort()).toEqual(
      ["eventId", "hook_event_name", "observedAt", "session_id"].sort(),
    );
    expect(classifyHookRecord(record)).toEqual({ kind: "unknown", eventName: "PreCompact" });
  });

  it("returns null when no hook_event_name can be found", () => {
    expect(minimizeHookInput("{not json", ENV, META)).toBeNull();
    expect(minimizeHookInput(JSON.stringify({ session_id: "abc" }), ENV, META)).toBeNull();
    expect(minimizeHookInput("[1,2,3]", ENV, META)).toBeNull();
  });
});

describe("Test 7: environment and overflow", () => {
  it("only ENV_KEPT variables cross, and no secret-shaped value does", () => {
    const record = minimize(buildHookStdin("SessionStart"));
    expect(Object.keys(record.env as object).sort()).toEqual([...ENV_KEPT].sort());
    expect(JSON.stringify(record)).not.toContain(ENV_SENTINEL);
    expect(JSON.stringify(record)).not.toContain('/Users/USERNAME"');
  });

  it("an overflowed stdin recovers hook_event_name and session_id from the retained prefix only", () => {
    const stdin = buildHookStdin("PostToolUse", { toolPayloadBytes: EIGHT_MIB / 2 });
    const prefix = Buffer.from(stdin).subarray(0, STDIN_RETAIN_BYTES).toString("utf8");
    const payload = buildHookPayload("PostToolUse");
    const record = minimize(prefix, { overflowed: true });
    expect(record.hook_event_name).toBe("PostToolUse");
    expect(record.session_id).toBe(payload.session_id);
    expect(Object.keys(record).sort()).toEqual(
      ["env", "eventId", "hook_event_name", "observedAt", "session_id"].sort(),
    );
    expect(JSON.stringify(record)).not.toContain(SENTINEL);
    expect(classifyHookRecord(record)).toMatchObject({ kind: "known", event: "PostToolUse" });
  });

  it("an unparseable stdin is salvaged by the same bounded scan, and nothing else is kept", () => {
    const record = minimizeHookInput(
      `{"session_id":"abc-123","hook_event_name":"Stop","prompt":"${SENTINEL}" <<truncated`,
      ENV,
      META,
    );
    expect(record?.hook_event_name).toBe("Stop");
    expect(record?.session_id).toBe("abc-123");
    expect(JSON.stringify(record)).not.toContain(SENTINEL);
  });

  it("the overflow scan ignores an escaped look-alike key inside a string value", () => {
    const decoy = JSON.stringify({ text: '"hook_event_name":"Stop"' }).slice(1, -1);
    const record = minimizeHookInput(`{${decoy},"hook_event_name":"SessionEnd"`, ENV, META, {
      overflowed: true,
    });
    expect(record?.hook_event_name).toBe("SessionEnd");
  });
});

describe("length caps: an over-long free-text field is truncated, never shape-invalid", () => {
  it("session_title, tool_name, agent_type and model fields are cut to the domain caps", () => {
    const title = minimize(
      buildHookStdin("SessionStart", {
        overrides: { session_title: "t".repeat(1000), model: "m".repeat(400) },
      }),
    );
    expect(title.session_title).toBe("t".repeat(256));
    expect(title.model).toBe("m".repeat(128));
    expect(classifyHookRecord(title).kind).toBe("known");

    const tool = minimize(
      buildHookStdin("PostToolUse", { overrides: { tool_name: "x".repeat(500) } }),
    );
    expect(tool.tool_name).toBe("x".repeat(128));
    expect(classifyHookRecord(tool).kind).toBe("known");

    const agent = minimize(
      buildHookStdin("SubagentStart", {
        overrides: { agent_type: "a".repeat(500), agent_id: "i".repeat(500) },
      }),
    );
    expect(agent.agent_type).toBe("a".repeat(128));
    expect(agent.agent_id).toBe("i".repeat(128));
    expect(classifyHookRecord(agent).kind).toBe("known");

    const swap = minimize(
      buildHookStdin("PostModelSwitch", {
        overrides: { from_model: "f".repeat(300), to_model: "g".repeat(300) },
      }),
    );
    expect(swap.from_model).toBe("f".repeat(128));
    expect(swap.to_model).toBe("g".repeat(128));
    expect(classifyHookRecord(swap).kind).toBe("known");
  });

  it("truncation never splits a surrogate pair", () => {
    const record = minimize(
      buildHookStdin("SessionStart", { overrides: { session_title: `${"t".repeat(255)}😀` } }),
    );
    expect(record.session_title).toBe("t".repeat(255));
  });
});

describe("the 4 KiB record cap drops optional fields in a fixed order", () => {
  it("drops session_title first and keeps the paths when that suffices", () => {
    const record = minimize(
      buildHookStdin("SessionStart", {
        overrides: {
          cwd: `/Users/USERNAME/${"c".repeat(1800)}`,
          transcript_path: `/Users/USERNAME/${"p".repeat(1800)}`,
          session_title: "é".repeat(256),
        },
      }),
    );
    expect(byteLength(record)).toBeLessThanOrEqual(MAX_RECORD_BYTES);
    expect(record).not.toHaveProperty("session_title");
    expect(record).toHaveProperty("cwd");
    expect(record).toHaveProperty("transcript_path");
  });

  it("drops the paths next, always keeping the envelope and session_id", () => {
    const record = minimize(
      buildHookStdin("SessionStart", {
        overrides: {
          cwd: `/Users/USERNAME/${"c".repeat(3000)}`,
          transcript_path: `/Users/USERNAME/${"p".repeat(3000)}`,
        },
      }),
    );
    expect(byteLength(record)).toBeLessThanOrEqual(MAX_RECORD_BYTES);
    expect(record).not.toHaveProperty("transcript_path");
    expect(record).not.toHaveProperty("cwd");
    expect(record.model).toBe("claude-opus-5-5");
    expect(record.session_id).toBe(buildHookPayload("SessionStart").session_id);
    expect(classifyHookRecord(record).kind).toBe("known");
  });

  it("never exceeds the cap even when every unbounded field is huge", () => {
    const huge = "z".repeat(20_000);
    const record = minimize(
      buildHookStdin("SessionEnd", {
        overrides: { reason: huge, permission_mode: huge, session_id: huge },
      }),
    );
    expect(byteLength(record)).toBeLessThanOrEqual(MAX_RECORD_BYTES);
    expect(record.hook_event_name).toBe("SessionEnd");
  });
});
