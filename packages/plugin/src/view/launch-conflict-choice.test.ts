import type { LaunchConflictResult, ProjectId } from "@ccc/domain";
import type { RunId } from "@ccc/domain/ids.js";
import { SESSION_QUIET_AFTER_MS } from "@ccc/domain/session.js";
import type { SocketApiClient } from "@ccc/service-api-client";
import type { App } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionQuietAfterMs } from "../widgets/session-signals.js";
import { createLaunchConflictChooser } from "./launch-conflict-choice.js";
import type { ConcurrentChoiceViewModel } from "./session-modals.js";

const openConcurrentChoice = vi.fn();

vi.mock("./session-modals.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-modals.js")>();
  return { ...actual, createObsidianSessionActionUi: () => ({ openConcurrentChoice }) };
});

/**
 * FIX3B Q6: the launch-conflict modal presents its sessions under the plugin's quiet-threshold
 * signal (D-07), not the compiled default.
 */
const NOW = Date.parse("2026-09-25T12:00:00.000Z");

function conflictResult(): LaunchConflictResult["conflict"] {
  return {
    projectName: "alpha",
    conflicts: [
      {
        runId: "0mfk1a2b3c4d5e6f7a8b9c0d1" as RunId,
        sessionName: "beta",
        state: "running",
        lastActivityAt: new Date(NOW - 3 * 60_000).toISOString(),
      },
    ],
  };
}

async function openedItemText(): Promise<string> {
  openConcurrentChoice.mockResolvedValue({ kind: "cancel" });
  const choose = createLaunchConflictChooser({} as App, {} as SocketApiClient);
  await choose(conflictResult(), "proj-alpha" as ProjectId);
  const model = openConcurrentChoice.mock.calls[0]?.[0] as ConcurrentChoiceViewModel;
  return model.items[0]?.text ?? "";
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  openConcurrentChoice.mockReset();
  sessionQuietAfterMs.value = SESSION_QUIET_AFTER_MS;
});
afterEach(() => {
  vi.useRealTimers();
  sessionQuietAfterMs.value = SESSION_QUIET_AFTER_MS;
});

describe("the launch-conflict chooser reads the quiet-threshold signal (FIX3B Q6)", () => {
  it("at the 30-minute default a 3-minute-old session reads as its plain state", async () => {
    expect(await openedItemText()).toBe("beta — Running, active 3 minutes ago");
  });

  it("with the signal at 2 minutes the same session reads quiet", async () => {
    sessionQuietAfterMs.value = 120_000;
    expect(await openedItemText()).toBe("beta — Idle — last event 3 min ago");
  });
});
