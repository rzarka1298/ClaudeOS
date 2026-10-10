import { type ApprovalLog, ApprovalUpsertedPayloadSchema } from "@ccc/domain";
import { describe, expect, it, vi } from "vitest";
import { createEventBus } from "../events/event-bus.js";
import { summary } from "../test-support/approval-fixtures.js";
import { createApprovalPublisher } from "./publisher.js";

function recordingLog() {
  const lines: { level: string; fields: Readonly<Record<string, unknown>> }[] = [];
  const log: ApprovalLog = {
    info: (fields) => lines.push({ level: "info", fields }),
    warn: (fields) => lines.push({ level: "warn", fields }),
    error: (fields) => lines.push({ level: "error", fields }),
  };
  return { log, lines };
}

describe("createApprovalPublisher (test 2)", () => {
  it("publishes exactly one approval.upserted event per summary with the summary as its payload", () => {
    const bus = createEventBus();
    const publisher = createApprovalPublisher(bus);
    const before = bus.buffer.latestId();
    publisher.publish("approval.upserted", { approval: summary(1) });
    publisher.publish("approval.upserted", { approval: summary(2, "approved") });
    expect(bus.buffer.latestId()).toBe(before + 2);
    const events = bus.buffer.since(before);
    expect(events.mode).toBe("replay");
    if (events.mode !== "replay") throw new Error("unreachable");
    expect(events.events.map((e) => e.type)).toEqual(["approval.upserted", "approval.upserted"]);
    const first = ApprovalUpsertedPayloadSchema.parse(events.events[0]?.payload);
    expect(first.approval.proposalId).toBe(summary(1).proposalId);
    expect(Object.keys(events.events[0]?.payload as object)).toEqual(["approval"]);
  });

  it("never lets a payload, diff, reason or target ride along on the event", () => {
    const bus = createEventBus();
    const publisher = createApprovalPublisher(bus);
    const hostile = {
      ...summary(1),
      payload: { path: "/Users/USERNAME/x" },
      diff: "secret diff",
      reason: "secret reason",
      target: [{ label: "Path", value: "/Users/USERNAME/x" }],
    };
    publisher.publish("approval.upserted", { approval: hostile as never });
    const replay = bus.buffer.since(0);
    if (replay.mode !== "replay") throw new Error("unreachable");
    expect(replay.events).toHaveLength(1);
    // The event's own payload member only: the envelope key is named payload too.
    const sent = JSON.stringify(replay.events[0]?.payload);
    for (const word of ["secret diff", "secret reason", "/Users/", "payload", "target"]) {
      expect(sent).not.toContain(word);
    }
    expect(sent).toContain(summary(1).proposalId);
  });

  it("catches a throwing bus and logs only the class name", () => {
    const { log, lines } = recordingLog();
    const publish = vi.fn(() => {
      throw new RangeError("boom /Users/USERNAME/private");
    });
    const publisher = createApprovalPublisher({ publish }, log);
    expect(() => publisher.publish("approval.upserted", { approval: summary(1) })).not.toThrow();
    expect(publish).toHaveBeenCalledTimes(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.level).toBe("error");
    expect(lines[0]?.fields).toEqual({ errorName: "RangeError" });
    expect(JSON.stringify(lines)).not.toContain("private");
  });

  it("drops a summary that does not fit the schema instead of publishing it", () => {
    const { log, lines } = recordingLog();
    const publish = vi.fn();
    const publisher = createApprovalPublisher({ publish }, log);
    publisher.publish("approval.upserted", {
      approval: { ...summary(1), state: "nonsense" } as never,
    });
    expect(publish).not.toHaveBeenCalled();
    expect(lines).toHaveLength(1);
    expect(lines[0]?.level).toBe("warn");
    expect(JSON.stringify(lines[0]?.fields)).not.toContain("nonsense");
  });
});
