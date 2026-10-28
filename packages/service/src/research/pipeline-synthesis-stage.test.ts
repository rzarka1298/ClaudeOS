// 09-12 D-12 / roadmap criterion 4: the synthesis stage is one exported function with an explicit
// input and output, so Phase 10 can replace the summariser without touching the fetch or the write
// stages. This file calls it ALONE with a stub summariser: no fetcher, no vault, no other stage.
import { newRunId, RESEARCH_JOB_ID } from "@ccc/domain";
import { startJobRun } from "@ccc/operational-store";
import { evidenceText } from "@ccc/research";
import { manualJobRunKey } from "@ccc/scheduler";
import { afterEach, describe, expect, it } from "vitest";
import type { TextTransport } from "../untrusted/index.js";
import { createExtractiveTransport } from "./extractive-transport.js";
import { sourceIdFor } from "./hash.js";
import {
  createRunTrace,
  type PreparedSource,
  type ResearchPipelineDeps,
  runSynthesisStage,
  type SynthesisInput,
} from "./pipeline.js";
import { createKit, type Kit, URL_ONE, URL_TWO } from "./test-support/research-kit.js";

const NONCE = "0123456789abcdef0123456789abcdef";
const NOW = "2026-10-15T09:00:00.000Z";

let kit: Kit | undefined;
afterEach(() => {
  kit?.close();
  kit = undefined;
});

function prepared(index: number, url: string, text: string): PreparedSource {
  const evidence = evidenceText(text, NONCE);
  // The synthesis stage reads only the id and the evidence text of a prepared source.
  return { index, sourceId: sourceIdFor(url), evidence } as unknown as PreparedSource;
}

interface Harness {
  readonly deps: ResearchPipelineDeps;
  readonly trace: ReturnType<typeof createRunTrace>;
  readonly audit: string[];
  readonly input: (transport: TextTransport) => SynthesisInput;
}

function harness(): Harness {
  kit = createKit();
  const runId = newRunId();
  startJobRun(kit.store.db, {
    jobRunId: runId,
    jobKey: RESEARCH_JOB_ID,
    idempotencyKey: manualJobRunKey(RESEARCH_JOB_ID, runId),
    trigger: "manual",
    startedAt: NOW,
  });
  const trace = createRunTrace(runId, NOW);
  const audit: string[] = [];
  const usable = [
    prepared(
      0,
      URL_ONE,
      "The maintainers confirmed that the alpha parser is now twice as fast in this release.",
    ),
    prepared(
      1,
      URL_TWO,
      "The beta command line tool now reports progress while it downloads packages.",
    ),
  ];
  const deps: ResearchPipelineDeps = {
    db: kit.store.db,
    vaultRoot: kit.vaultRoot,
    runtimeDir: kit.runtimeDir,
    fetcher: {
      async fetchSources() {
        throw new Error("the synthesis stage must not fetch");
      },
    },
    chooseSummariser: () => {
      throw new Error("the synthesis stage must not choose a summariser");
    },
    now: () => new Date(NOW),
    newNonce: () => NONCE,
    log: { warn: () => {}, error: () => {} },
    publish: () => {},
    audit: (operation) => audit.push(operation),
  };
  return {
    deps,
    trace,
    audit,
    input: (transport) => ({
      usable,
      nonce: NONCE,
      choice: { transport, id: "extractive" },
      stored: new Map(usable.map((source) => [source.sourceId, source.evidence])),
    }),
  };
}

describe("09-12 runSynthesisStage: the Phase 10 seam, called alone", () => {
  it("returns the items of a stub summariser, bound to the stored ids, and records one synthesis stage", async () => {
    const h = harness();
    const input = h.input(createExtractiveTransport());
    const output = await runSynthesisStage(h.deps, h.trace, input);

    expect(output.items.length).toBeGreaterThan(0);
    for (const item of output.items) {
      expect(item.citedSourceIds.length).toBeGreaterThan(0);
      for (const id of item.citedSourceIds) expect(input.stored.has(id)).toBe(true);
    }
    expect(h.trace.stages.filter((stage) => stage.stage === "synthesis")).toHaveLength(1);
    expect(h.trace.stages).toHaveLength(1);
    expect(h.audit).toEqual(["research.summarise", "automation-run.record"]);
    expect(h.trace.phase).toBe("summarise");
  });

  it("a summariser that answers garbage is a summariser-invalid-output failure", async () => {
    const h = harness();
    const garbage: TextTransport = { complete: async () => "this is not a report" };
    await expect(runSynthesisStage(h.deps, h.trace, h.input(garbage))).rejects.toMatchObject({
      name: "StageFailure",
      code: "summariser-invalid-output",
    });
    expect(h.trace.stages).toEqual([]);
  });

  it("a summariser that throws is a summariser-failed failure", async () => {
    const h = harness();
    const broken: TextTransport = {
      complete: async () => {
        throw new Error("model unreachable");
      },
    };
    await expect(runSynthesisStage(h.deps, h.trace, h.input(broken))).rejects.toMatchObject({
      name: "StageFailure",
      code: "summariser-failed",
    });
    expect(h.trace.stages).toEqual([]);
  });
});
