// Plan 06-18, Task 2, Test 7: tasks.changed advances a generation signal.
import type { ServiceEvent } from "@ccc/domain";
import { afterEach, describe, expect, it } from "vitest";
import { EVENT_HANDLERS, routeServiceEvent } from "../service-event-router.js";
import { applyTasksChanged, resetTasksGeneration, tasksGeneration } from "./events.js";

afterEach(resetTasksGeneration);

function changed(payload: unknown): ServiceEvent {
  return { id: 9, type: "tasks.changed", occurredAt: "2026-10-06T00:00:00.000Z", payload };
}

describe("Test 7: tasks.changed", () => {
  it("advances the generation signal for a higher generation", () => {
    applyTasksChanged(changed({ generation: 3 }));
    expect(tasksGeneration.value).toBe(3);
  });

  it("does nothing for an equal or lower generation, a malformed payload or another event type", () => {
    applyTasksChanged(changed({ generation: 5 }));
    for (const payload of [
      { generation: 5 },
      { generation: 2 },
      { generation: -1 },
      { generation: "7" },
      null,
      {},
    ]) {
      applyTasksChanged(changed(payload));
      expect(tasksGeneration.value).toBe(5);
    }
    applyTasksChanged({ ...changed({ generation: 9 }), type: "service.heartbeat" });
    expect(tasksGeneration.value).toBe(5);
  });

  it("is routed from the router table beside every earlier entry", () => {
    expect(EVENT_HANDLERS["tasks.changed"]).toBeDefined();
    routeServiceEvent(changed({ generation: 12 }));
    expect(tasksGeneration.value).toBe(12);
    for (const earlier of [
      "projects.updated",
      "session.upserted",
      "usage.updated",
      "claude-integration.updated",
      "approval.upserted",
    ] as const) {
      expect(EVENT_HANDLERS[earlier]).toBeDefined();
    }
  });
});
