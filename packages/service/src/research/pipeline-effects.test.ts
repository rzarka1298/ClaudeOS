import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CLASSIFICATION, classifyOperation, RESEARCH_PIPELINE_OPERATIONS } from "@ccc/domain";
import { afterEach, describe, expect, it } from "vitest";
import { PIPELINE_EFFECTS } from "./pipeline-effects.js";
import {
  createKit,
  defaultResponses,
  type Kit,
  URL_ONE,
  URL_THREE,
  URL_TWO,
} from "./test-support/research-kit.js";

describe("Test 5 (effects classified): every effect step of the pipeline names an operation", () => {
  it("maps fetch, summarise, note writes, run record and the trigger, and nothing else", () => {
    expect(Object.keys(PIPELINE_EFFECTS).sort()).toEqual([
      "fetch",
      "recordRun",
      "summarise",
      "trigger",
      "writeNotes",
    ]);
  });

  it("has a value set equal to RESEARCH_PIPELINE_OPERATIONS", () => {
    expect([...Object.values(PIPELINE_EFFECTS)].sort()).toEqual(
      [...RESEARCH_PIPELINE_OPERATIONS].sort(),
    );
    expect(new Set(Object.values(PIPELINE_EFFECTS)).size).toBe(
      Object.values(PIPELINE_EFFECTS).length,
    );
  });

  it("classifies every effect as no-approval or direct-gesture, the trigger as the owner's gesture", () => {
    for (const [step, operation] of Object.entries(PIPELINE_EFFECTS)) {
      const hit = classifyOperation(operation);
      expect(hit, step).toBeDefined();
      expect(["no-approval", "direct-gesture"], step).toContain(hit?.row.class);
      expect(CLASSIFICATION[operation].class).not.toBe("approval-required");
    }
    expect(classifyOperation(PIPELINE_EFFECTS.trigger)?.row.class).toBe("direct-gesture");
    expect(classifyOperation(PIPELINE_EFFECTS.fetch)?.row.class).toBe("no-approval");
  });
});

let kit: Kit | undefined;
afterEach(() => {
  kit?.close();
  kit = undefined;
});

describe("the pipeline names each effect where it happens", () => {
  it("performs exactly the classified effects in a successful run, in the order of the run", async () => {
    kit = createKit();
    const started = kit.services.runNow();
    if (!started.ok) throw new Error("refused");
    await kit.services.idle();
    const performed = [...new Set(kit.effects)];
    expect(performed).toEqual([
      PIPELINE_EFFECTS.trigger,
      PIPELINE_EFFECTS.recordRun,
      PIPELINE_EFFECTS.fetch,
      PIPELINE_EFFECTS.writeNotes,
      PIPELINE_EFFECTS.summarise,
    ]);
    expect([...performed].sort()).toEqual([...RESEARCH_PIPELINE_OPERATIONS].sort());
  });

  it("names a fetch and a record but no note write and no summarise in a run that fetched nothing", async () => {
    kit = createKit({
      responses: {
        ...defaultResponses(),
        [URL_ONE]: { ok: false, code: "timeout" },
        [URL_TWO]: { ok: false, code: "timeout" },
        [URL_THREE]: { ok: false, code: "timeout" },
      },
    });
    const started = kit.services.runNow();
    if (!started.ok) throw new Error("refused");
    await kit.services.idle();
    const performed = new Set(kit.effects);
    expect(performed.has(PIPELINE_EFFECTS.fetch)).toBe(true);
    expect(performed.has(PIPELINE_EFFECTS.writeNotes)).toBe(false);
    expect(performed.has(PIPELINE_EFFECTS.summarise)).toBe(false);
  });

  it("never reports an operation outside the classified set", async () => {
    kit = createKit();
    kit.services.runNow();
    await kit.services.idle();
    for (const operation of kit.effects) {
      expect(Object.values(PIPELINE_EFFECTS)).toContain(operation);
    }
  });

  it("references PIPELINE_EFFECTS at every effect step in the source", () => {
    const pipeline = readFileSync(fileURLToPath(new URL("./pipeline.ts", import.meta.url)), "utf8");
    const services = readFileSync(fileURLToPath(new URL("./services.ts", import.meta.url)), "utf8");
    for (const key of ["fetch", "summarise", "writeNotes", "recordRun"]) {
      expect(pipeline, key).toContain(`PIPELINE_EFFECTS.${key}`);
    }
    expect(services).toContain("PIPELINE_EFFECTS.trigger");
  });
});
