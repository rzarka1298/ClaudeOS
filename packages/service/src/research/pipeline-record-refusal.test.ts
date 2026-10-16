import { readdirSync } from "node:fs";
import { join } from "node:path";
import { RESEARCH_JOB_ID } from "@ccc/domain";
import {
  getResearchSourceRecord,
  listJobRuns,
  ResearchSourceRecordConflictError,
  ResearchSourceRecordError,
} from "@ccc/operational-store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sourceIdFor } from "./hash.js";
import { createKit, type Kit, URL_ONE, URL_THREE, URL_TWO } from "./test-support/research-kit.js";

/**
 * 07-FIX6b: a provenance record that is refused for one source's own content ends THAT source, not
 * the run. The allowlist loader rejects the same address twice, so the refusals the record writer
 * can raise for one source (a value outside its closed shapes, a different record already made for
 * the address) cannot be reached through the configuration; they are injected at the store call,
 * the one stub in this file. Any other store failure is the run's and is covered in
 * pipeline-provenance.test.ts.
 */

const controls = vi.hoisted(() => ({
  refuse: null as { sourceId: string; kind: "shape" | "conflict" } | null,
}));

vi.mock("@ccc/operational-store", async (importOriginal) => {
  const real = await importOriginal<typeof import("@ccc/operational-store")>();
  return {
    ...real,
    recordResearchSource: (
      db: Parameters<typeof real.recordResearchSource>[0],
      input: Parameters<typeof real.recordResearchSource>[1],
    ) => {
      if (controls.refuse !== null && controls.refuse.sourceId === input.sourceId) {
        throw controls.refuse.kind === "shape"
          ? new real.ResearchSourceRecordError("label is not a short plain line")
          : new real.ResearchSourceRecordConflictError();
      }
      return real.recordResearchSource(db, input);
    },
  };
});

let kit: Kit | undefined;
afterEach(() => {
  controls.refuse = null;
  kit?.close();
  kit = undefined;
});

async function runToEnd(k: Kit): Promise<string> {
  const started = k.services.runNow();
  if (!started.ok) throw new Error(`refused: ${started.code}`);
  await k.services.idle();
  return started.value.runId;
}

function reportCount(k: Kit): number {
  return readdirSync(join(k.vaultRoot, "global/output")).filter((n) => n.startsWith("research-"))
    .length;
}

describe("a source whose record is refused fails alone", () => {
  for (const kind of ["shape", "conflict"] as const) {
    it(`a ${kind} refusal for one source leaves the run partial, the others recorded, one report`, async () => {
      kit = createKit();
      controls.refuse = { sourceId: sourceIdFor(URL_TWO), kind };
      const runId = await runToEnd(kit);
      const row = listJobRuns(kit.store.db, RESEARCH_JOB_ID, 1)[0];
      expect(row?.state).toBe("completed");
      expect(row?.outcome).toBe("partial");
      expect(row?.errorCode).toBeNull();
      expect(row?.unavailableSources).toEqual([
        { sourceId: sourceIdFor(URL_TWO), code: "parse-failure" },
      ]);
      expect(getResearchSourceRecord(kit.store.db, runId, sourceIdFor(URL_ONE))).not.toBeNull();
      expect(getResearchSourceRecord(kit.store.db, runId, sourceIdFor(URL_TWO))).toBeNull();
      expect(getResearchSourceRecord(kit.store.db, runId, sourceIdFor(URL_THREE))).not.toBeNull();
      expect(reportCount(kit)).toBe(1);
      expect(kit.logs.some((entry) => entry.event === "research-raw-snapshot-refused")).toBe(true);
    });
  }

  it("the refusal errors are the typed ones the store raises", () => {
    expect(new ResearchSourceRecordError("x").name).toBe("ResearchSourceRecordError");
    expect(new ResearchSourceRecordConflictError().name).toBe("ResearchSourceRecordConflictError");
  });
});
