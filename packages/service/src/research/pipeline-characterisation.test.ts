// D-12 / D-18 Wave 0: the research pipeline's whole observable behaviour, frozen BEFORE 09-12 splits
// pipeline.ts. Each scenario drives the real stages (real temp vault, file-backed store, scripted
// fetcher, the extractive summariser double, a fixed clock) through `runResearchPipeline` and records
// the PipelineResult, the live RunTrace, the ordered audit effect names and the log events. The
// normalised records are compared with `test-support/pipeline-characterisation.expected.json`, which
// the 09-12 split must keep byte-identical. The test imports only the pipeline's public barrel and the
// kit, so the split can leave it unchanged.
//
// Regenerating the expected file is a deliberate act: `CCC_WRITE_CHARACTERISATION=1 pnpm --filter
// @ccc/service exec vitest run src/research/pipeline-characterisation.test.ts`. It is off by default and
// never set in CI; a normal run only reads the file.
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { newRunId, RESEARCH_JOB_ID } from "@ccc/domain";
import { startJobRun } from "@ccc/operational-store";
import { manualJobRunKey } from "@ccc/scheduler";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createExtractiveTransport } from "./extractive-transport.js";
import type { FetchSourceInput, FetchSourceResult } from "./fetch/index.js";
import {
  createRunTrace,
  type PipelineLog,
  type ResearchPipelineDeps,
  runResearchPipeline,
  type SummariserChoice,
} from "./index.js";
import { createKit, defaultResponses, type Kit } from "./test-support/research-kit.js";

const EXPECTED_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "test-support",
  "pipeline-characterisation.expected.json",
);
const WRITE_MODE = process.env.CCC_WRITE_CHARACTERISATION === "1";

const SCENARIOS = [
  "success",
  "all-sources-failed at capture",
  "all-sources-failed at fetch",
  "all-sources-failed at prepare",
  "all-sources-failed at raw write",
  "summariser-failed",
  "summariser-invalid-output",
  "vault-write-failed",
  "interrupted",
] as const;
type ScenarioName = (typeof SCENARIOS)[number];

const FIXED_NONCE = "0123456789abcdef0123456789abcdef";
const FIXED_NOW = "2026-10-15T09:00:00.000Z";

interface Observed {
  readonly kit: Kit;
  readonly record: unknown;
}

interface DriveOptions {
  /** Replaces the scripted fetcher (receives the run's trace so a scenario can cut the run off). */
  readonly fetch?: (
    inputs: readonly FetchSourceInput[],
    trace: ReturnType<typeof createRunTrace>,
  ) => FetchSourceResult[] | Promise<FetchSourceResult[]>;
  readonly choose?: ResearchPipelineDeps["chooseSummariser"];
}

/** Starts a run row the way `runNow` does, then drives the pipeline on it. */
async function drive(kit: Kit, options: DriveOptions = {}): Promise<{ raw: unknown }> {
  const runId = newRunId();
  startJobRun(kit.store.db, {
    jobRunId: runId,
    jobKey: RESEARCH_JOB_ID,
    idempotencyKey: manualJobRunKey(RESEARCH_JOB_ID, runId),
    trigger: "manual",
    startedAt: FIXED_NOW,
  });
  const trace = createRunTrace(runId, FIXED_NOW);
  const audit: string[] = [];
  const logs: Record<string, unknown>[] = [];
  const responses = defaultResponses();
  const log: PipelineLog = {
    warn: (fields) => logs.push({ level: "warn", ...fields }),
    error: (fields) => logs.push({ level: "error", ...fields }),
  };
  const choice: SummariserChoice = { transport: createExtractiveTransport(), id: "extractive" };
  const result = await runResearchPipeline(
    {
      db: kit.store.db,
      vaultRoot: kit.vaultRoot,
      runtimeDir: kit.runtimeDir,
      fetcher: {
        async fetchSources(inputs) {
          if (options.fetch !== undefined) return options.fetch(inputs, trace);
          return inputs.map(
            (input) => responses[input.url] ?? { ok: false, code: "network-error" },
          );
        },
      },
      chooseSummariser: options.choose ?? (() => choice),
      now: () => new Date(FIXED_NOW),
      newNonce: () => FIXED_NONCE,
      log,
      publish: () => {},
      audit: (operation) => audit.push(operation),
    },
    trace,
  );
  return {
    raw: {
      result,
      trace: {
        stages: trace.stages,
        sources: trace.sources,
        unavailable: trace.unavailable,
        sourceTotal: trace.sourceTotal,
        sourceCount: trace.sourceCount,
        reportNoteId: trace.reportNoteId,
        reportPath: trace.reportPath,
        phase: trace.phase,
      },
      audit,
      logs,
    },
  };
}

// ---------------------------------------------------------------------------
// Normalisation. Random identifiers (the 25-character run and note ids) map to `<id:N>` in
// first-seen order, so a swapped or merged id changes the record; instants map to `<time:N>` in
// first-seen order; the temporary directory prefix maps to `<vault>`. Source ids and the nonce are
// deterministic here (a hash of an example address, an injected constant), so they stay literal: a
// change in how they are derived must fail the comparison, not be absorbed by it.

const ID_PATTERN = /(?<![0-9a-z])[0-9a-z]{25}(?![0-9a-z])/g;
const INSTANT_PATTERN = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;

function normalise(kit: Kit, value: unknown): unknown {
  const ids = new Map<string, number>();
  const times = new Map<string, number>();
  const number = (table: Map<string, number>, key: string): number => {
    const existing = table.get(key);
    if (existing !== undefined) return existing;
    const next = table.size + 1;
    table.set(key, next);
    return next;
  };
  const text = JSON.stringify(value)
    .split(kit.vaultRoot)
    .join("<vault>")
    .split(kit.dir)
    .join("<vault>")
    .replace(INSTANT_PATTERN, (instant) => `<time:${number(times, instant)}>`)
    .replace(ID_PATTERN, (id) => `<id:${number(ids, id)}>`);
  return JSON.parse(text) as unknown;
}

// ---------------------------------------------------------------------------

function rawNoteFiles(kit: Kit): string[] {
  const out: string[] = [];
  const walk = (folder: string): void => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".md") && entry.name !== "index.md") out.push(path);
    }
  };
  walk(join(kit.vaultRoot, "global", "raw"));
  return out;
}

const SCENARIO_RUNNERS: Record<ScenarioName, () => Promise<Observed>> = {
  success: async () => {
    const kit = createKit();
    return { kit, record: (await drive(kit)).raw };
  },

  // The allowlist file is unreadable: the run fails in its first phase, before any stage is recorded.
  "all-sources-failed at capture": async () => {
    const kit = createKit({ writeConfig: false });
    writeFileSync(kit.sourcesPath, "{ this is not json", { mode: 0o600 });
    return { kit, record: (await drive(kit)).raw };
  },

  // The run is ended under the pipeline while its fetch is in flight (the watchdog's flag): the
  // unexpected stop is attributed to the phase it happened in, which is `fetch`.
  "all-sources-failed at fetch": async () => {
    const kit = createKit();
    const responses = defaultResponses();
    return {
      kit,
      record: (
        await drive(kit, {
          fetch: (inputs, trace) => {
            trace.cancelled = true;
            return inputs.map((input) => responses[input.url] as FetchSourceResult);
          },
        })
      ).raw,
    };
  },

  // Every source fails to fetch: nothing is left to prepare.
  "all-sources-failed at prepare": async () => {
    const kit = createKit();
    return {
      kit,
      record: (
        await drive(kit, {
          fetch: (inputs) =>
            inputs.map((): FetchSourceResult => ({ ok: false, code: "network-error" })),
        })
      ).raw,
    };
  },

  // A first complete run leaves the raw notes in the vault; they are then damaged, so every source
  // in the second run is refused alone and none is left to summarise.
  "all-sources-failed at raw write": async () => {
    const kit = createKit();
    const first = kit.services.runNow();
    if (!first.ok) throw new Error(`refused: ${first.code}`);
    await kit.services.idle();
    const files = rawNoteFiles(kit);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) writeFileSync(file, "damaged by hand\n");
    return { kit, record: (await drive(kit)).raw };
  },

  "summariser-failed": async () => {
    const kit = createKit();
    return {
      kit,
      record: (
        await drive(kit, {
          choose: () => ({
            transport: {
              complete: async () => {
                throw new Error("model unreachable");
              },
            },
            id: "extractive",
          }),
        })
      ).raw,
    };
  },

  "summariser-invalid-output": async () => {
    const kit = createKit();
    return {
      kit,
      record: (
        await drive(kit, {
          choose: () => ({
            transport: { complete: async () => "this is not a report" },
            id: "extractive",
          }),
        })
      ).raw,
    };
  },

  // The output folder is a file: the report cannot be written, after raw notes and the synthesis stage.
  "vault-write-failed": async () => {
    const kit = createKit();
    rmSync(join(kit.vaultRoot, "global", "output"), { recursive: true });
    writeFileSync(join(kit.vaultRoot, "global", "output"), "a file where a folder belongs");
    return { kit, record: (await drive(kit)).raw };
  },

  // The fetcher itself breaks: a fault of this process, no source is blamed.
  interrupted: async () => {
    const kit = createKit();
    return {
      kit,
      record: (
        await drive(kit, {
          fetch: () => {
            throw new Error("fetcher broke");
          },
        })
      ).raw,
    };
  },
};

const observed = new Map<ScenarioName, unknown>();
let kit: Kit | undefined;

afterEach(() => {
  kit?.close();
  kit = undefined;
});

afterAll(() => {
  if (!WRITE_MODE) return;
  const records = SCENARIOS.map((scenario) => ({
    scenario,
    ...(observed.get(scenario) as object),
  }));
  mkdirSync(dirname(EXPECTED_PATH), { recursive: true });
  writeFileSync(EXPECTED_PATH, `${JSON.stringify(records, null, 2)}\n`);
});

function expectedRecords(): { scenario: string }[] {
  return JSON.parse(readFileSync(EXPECTED_PATH, "utf8")) as { scenario: string }[];
}

describe("D-12 research pipeline characterisation (frozen before the 09-12 split)", () => {
  for (const scenario of SCENARIOS) {
    it(scenario, async () => {
      const run = await SCENARIO_RUNNERS[scenario]();
      kit = run.kit;
      const record = { scenario, ...(normalise(run.kit, run.record) as object) };
      observed.set(scenario, normalise(run.kit, run.record));
      if (WRITE_MODE) return;
      const expected = expectedRecords().find((entry) => entry.scenario === scenario);
      expect(expected, `no expected record for "${scenario}"`).toBeDefined();
      expect(record).toEqual(expected);
    });
  }

  it("the expected file holds exactly these scenarios, in this order", () => {
    if (WRITE_MODE) return;
    expect(expectedRecords().map((entry) => entry.scenario)).toEqual([...SCENARIOS]);
  });
});
