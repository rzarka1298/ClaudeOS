import { SNAPSHOT_PATH, SnapshotResponseSchema } from "@ccc/domain";
import { afterEach, describe, expect, it } from "vitest";
import { type CodexComposition, startCodexComposition } from "./test-support/codex-composition.js";

/**
 * Audit (plan 05.1-28, D-25): the one snapshot route answers the optional `codex` member when the
 * Codex services are composed and is byte-identical to today's answer when they are not. The Phase
 * 5 merge audit (`snapshot-merge.audit.test.ts`) stays untouched and keeps passing.
 */

let composition: CodexComposition | null = null;

afterEach(async () => {
  await composition?.close();
  composition = null;
});

describe("GET snapshot with and without the Codex services", () => {
  it("omits the codex member entirely when the context has none, inventing nothing", async () => {
    composition = await startCodexComposition({ codex: false });
    const reply = await composition.get(SNAPSHOT_PATH);
    expect(reply.status).toBe(200);
    const snapshot = SnapshotResponseSchema.parse(reply.body);
    expect(Object.keys(snapshot.state).sort()).toEqual(["projects", "serviceStartedAt"].sort());
    expect(JSON.stringify(reply.body)).not.toContain('"codex"');
  });

  it("answers the same Phase 4 and Phase 5 members beside the codex member when it is composed", async () => {
    composition = await startCodexComposition({ usage: "real" });
    const reply = await composition.get(SNAPSHOT_PATH);
    const snapshot = SnapshotResponseSchema.parse(reply.body);
    expect(snapshot.state.usage).toBeDefined();
    expect(snapshot.state.claudeIntegration).toBeDefined();
    expect(snapshot.state.sessions).toEqual([]);
    expect(snapshot.state.codex).toBeDefined();
    expect(snapshot.state.codex?.integration).toBeDefined();
  });
});
