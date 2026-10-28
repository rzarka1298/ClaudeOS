// 09-12 D-14: the pipeline's log events are one discriminated union keyed by `event`, so a misspelt
// or invented event name is a compile error, and the names the existing tests and operators read
// stay exactly as they were. The type-level checks are enforced by `tsc` (this file is part of the
// service project); the runtime checks pin the names and one real emission.
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import {
  logError,
  logWarn,
  PIPELINE_LOG_EVENTS,
  type PipelineLogEvent,
  type ResearchPipelineDeps,
} from "./pipeline-trace.js";
import { createKit, type Kit } from "./test-support/research-kit.js";

// The ten events research recorded at planning, plus the five the pipeline also emits from its
// stage recorder, run-note writer, finish path and watchdog. None is renamed.
const EXPECTED_EVENTS = [
  "research-sources-unusable",
  "research-fetch-threw",
  "research-source-record-run-ended",
  "research-raw-snapshot-refused",
  "research-wiki-restore-failed",
  "research-report-removal-failed",
  "research-report-record-removal-failed",
  "research-report-changed-before-finalise",
  "research-report-record-run-ended",
  "research-pipeline-error",
  "research-stage-record-failed",
  "research-run-note-failed",
  "research-finish-failed",
  "research-finish-fallback-failed",
  "research-watchdog-fired",
] as const;

let kit: Kit | undefined;
afterEach(() => {
  kit?.close();
  kit = undefined;
});

describe("09-12 PipelineLogEvent: the closed set of pipeline log events", () => {
  it("names exactly the existing events, and the type and the list agree", () => {
    expect([...PIPELINE_LOG_EVENTS].sort()).toEqual([...EXPECTED_EVENTS].sort());
    expectTypeOf<PipelineLogEvent["event"]>().toEqualTypeOf<(typeof EXPECTED_EVENTS)[number]>();
    expectTypeOf<PipelineLogEvent["event"]>().toEqualTypeOf<(typeof PIPELINE_LOG_EVENTS)[number]>();
  });

  it("logWarn and logError accept only the union: another event name is a compile error", () => {
    const seen: Record<string, unknown>[] = [];
    const deps = {
      log: {
        warn: (fields: Record<string, unknown>) => seen.push(fields),
        error: (fields: Record<string, unknown>) => seen.push(fields),
      },
    } as unknown as ResearchPipelineDeps;
    logWarn(deps, { event: "research-fetch-threw", errorName: "Error" });
    logError(deps, { event: "research-finish-failed", errorName: "Error" });
    // @ts-expect-error an eleventh (unlisted) event name is refused by the type
    logWarn(deps, { event: "research-made-up-event" });
    // @ts-expect-error a field the event does not carry is refused by the type
    logWarn(deps, { event: "research-fetch-threw", errorName: "Error", extra: "no" });
    expect(seen).toHaveLength(4);
  });

  it("a forced fetch throw logs research-fetch-threw with the same fields as before", async () => {
    kit = createKit({
      fetcher: {
        async fetchSources() {
          throw new Error("the fetcher broke");
        },
      },
    });
    const started = kit.services.runNow();
    if (!started.ok) throw new Error(`refused: ${started.code}`);
    await kit.services.idle();
    expect(kit.logs.filter((entry) => entry.event === "research-fetch-threw")).toEqual([
      { level: "warn", event: "research-fetch-threw", errorName: "Error" },
    ]);
  });
});
