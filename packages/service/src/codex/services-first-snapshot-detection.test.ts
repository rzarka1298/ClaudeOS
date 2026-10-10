import { SNAPSHOT_PATH } from "@ccc/domain";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CodexComposition,
  type CodexCompositionOptions,
  startCodexComposition,
  waitFor,
} from "../test-support/codex-composition.js";
import type { CodexDetection } from "./detection.js";

/**
 * Whole-phase finding 3: with no saved Codex launcher the install cache starts not-installed and
 * startup skips detection. The first dashboard snapshot request kicks one fire-and-forget detection
 * (never awaited, at most once per run); a machine without Codex spawns nothing and publishes nothing.
 */

const open: CodexComposition[] = [];

afterEach(async () => {
  for (const composition of open.splice(0)) await composition.close();
});

function countingDetection(installed: boolean): {
  detection: Pick<CodexDetection, "detectCodex" | "candidatePath">;
  calls: () => number;
} {
  let calls = 0;
  return {
    calls: () => calls,
    detection: {
      candidatePath: () => null,
      async detectCodex() {
        calls += 1;
        return {
          executables: installed
            ? [
                {
                  candidateId: "user-install",
                  display: "~/.local/bin/codex",
                  location: "user-install",
                  version: "0.200.0",
                },
              ]
            : [],
          doctor: "unknown",
          bridge: "not-installed",
          suggestedTerminal: "terminal-app",
        } as never;
      },
    },
  };
}

async function compose(options: CodexCompositionOptions): Promise<CodexComposition> {
  const composition = await startCodexComposition(options);
  open.push(composition);
  return composition;
}

describe("first-snapshot install detection", () => {
  it("detects once on the first snapshot and flips the integration to installed by event", async () => {
    const fake = countingDetection(true);
    const c = await compose({ deps: { detection: fake.detection } });
    expect(fake.calls()).toBe(0);
    const first = await c.get(SNAPSHOT_PATH);
    expect(first.status).toBe(200);
    expect(await waitFor(() => c.events("codex.integration.updated").length === 1)).toBe(true);
    expect(fake.calls()).toBe(1);
    const second = await c.get(SNAPSHOT_PATH);
    const codex = (
      second.body as { state: { codex?: { integration?: { codex: { installed: boolean } } } } }
    ).state.codex;
    expect(codex?.integration?.codex.installed).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fake.calls()).toBe(1);
  });

  it("on a machine without Codex the snapshot runs no spawn-capable work beyond one empty detection and publishes nothing", async () => {
    const fake = countingDetection(false);
    const c = await compose({ deps: { detection: fake.detection } });
    await c.get(SNAPSHOT_PATH);
    await c.get(SNAPSHOT_PATH);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fake.calls()).toBe(1);
    expect(c.events("codex.integration.updated")).toHaveLength(0);
  });
});
