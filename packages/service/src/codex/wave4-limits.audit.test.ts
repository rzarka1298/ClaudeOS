// Wave 4 test audit (plans 05.1-14 and 05.1-15): constants and wire shapes the
// authoring tests leave implicit.
//   - The usage read is capped at 20 seconds and the headroom refresh runs
//     about every 60 seconds by DEFAULT (the tests inject shorter values).
//   - The service-private thread row carries cwd and the rollout path, and no
//     wire schema can: a session view with either key is refused outright.
import { CodexSessionViewSchema } from "@ccc/domain/codex-sessions.js";
import { describe, expect, it } from "vitest";
import { HEADROOM_REFRESH_INTERVAL_MS } from "./headroom-service.js";
import { RATE_LIMITS_READ_CAP_MS } from "./rate-limits-client.js";

const view = {
  threadId: "thread-a",
  projectId: null,
  projectName: null,
  origin: "interactive",
  state: "completed",
  model: null,
  effort: null,
  startedAt: "2026-10-08T12:00:00.000Z",
  lastActivityAt: "2026-10-08T12:05:00.000Z",
  resumesAfter: null,
  title: null,
  hasTranscript: true,
  liveLogRunId: null,
};

describe("default timings (D-24, Pitfall 15)", () => {
  it("a usage read is capped at 20 seconds by default", () => {
    expect(RATE_LIMITS_READ_CAP_MS).toBe(20_000);
  });

  it("the headroom refresh interval is 60 seconds by default", () => {
    expect(HEADROOM_REFRESH_INTERVAL_MS).toBe(60_000);
  });
});

describe("no wire type can carry cwd or the rollout path (D-17)", () => {
  it("the baseline view is valid, so the refusals below are about the extra key only", () => {
    expect(CodexSessionViewSchema.safeParse(view).success).toBe(true);
  });

  it.each([
    ["cwd", "/Users/USERNAME/repo"],
    ["rolloutPath", "/Users/USERNAME/.codex/sessions/2026/10/08/rollout-a.jsonl"],
    ["rollout_path", "/Users/USERNAME/.codex/sessions/2026/10/08/rollout-a.jsonl"],
    ["gitOriginUrl", "https://example.invalid/x.git"],
    ["firstUserMessage", "synthetic prompt"],
    ["preview", "synthetic preview"],
  ])("a session view carrying %s is refused", (key, value) => {
    expect(CodexSessionViewSchema.safeParse({ ...view, [key]: value }).success).toBe(false);
  });
});
