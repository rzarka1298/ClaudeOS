import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { RESEARCH_JOB_ID } from "@ccc/domain";
import { listJobRuns } from "@ccc/operational-store";
import { afterEach, describe, expect, it } from "vitest";
import { createFixtureFetcher } from "./fixture-fetcher.js";
import { sourceIdFor } from "./hash.js";
import { ResearchOverrideError } from "./override-error.js";
import { FIFO_DEADLINE_MS, makeFifo, timed, timedAsync } from "./test-support/fifo.js";
import { createReportVault, type ReportVault } from "./test-support/report-vault.js";
import { createKit, type Kit, URL_ONE } from "./test-support/research-kit.js";
import { buildReportItemsPage, buildReportList, findReport } from "./view-model.js";

/**
 * Wave 5 fix round (opus M1): a FIFO (or any special file) where a report, a raw note or the
 * fixture manifest should be is refused at once. It never blocks the process: every read here is
 * released late by a helper process if it waits, and the elapsed time fails the test.
 */

let vault: ReportVault | undefined;
let kit: Kit | undefined;
let scratch: string | undefined;
afterEach(() => {
  vault?.cleanup();
  vault = undefined;
  kit?.close();
  kit = undefined;
  if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

const FIFO_REPORT = "research-2026-10-16-r0000000special0000000000.md";

describe("the view model", () => {
  it("lists a FIFO named like a report as an unreadable row without waiting", () => {
    vault = createReportVault();
    vault.addReport();
    const fifo = join(vault.root, "global", "output", FIFO_REPORT);
    makeFifo(fifo);
    const { value, elapsedMs } = timed(fifo, () => buildReportList(vault?.root ?? "", {}));
    expect(elapsedMs).toBeLessThan(FIFO_DEADLINE_MS);
    if (!value.ok) throw new Error("list refused");
    expect(value.value.rows.some((row) => !row.readable && row.fileName === FIFO_REPORT)).toBe(
      true,
    );
    expect(value.value.rows.some((row) => row.readable)).toBe(true);
  });

  it("finds a real report past a FIFO without waiting", () => {
    vault = createReportVault();
    const built = vault.addReport();
    const fifo = join(vault.root, "global", "output", FIFO_REPORT);
    makeFifo(fifo);
    const { value, elapsedMs } = timed(fifo, () => findReport(vault?.root ?? "", built.noteId));
    expect(elapsedMs).toBeLessThan(FIFO_DEADLINE_MS);
    expect(value.kind).toBe("found");
  });

  it("serves a finding as inference when its raw note was replaced by a FIFO, without waiting", () => {
    vault = createReportVault();
    const built = vault.addReport();
    const raw = join(vault.root, built.rawPaths[0] ?? "");
    rmSync(raw);
    makeFifo(raw);
    const lookup = findReport(vault.root, built.noteId);
    if (lookup.kind !== "found") throw new Error("expected the report");
    const { value, elapsedMs } = timed(raw, () =>
      buildReportItemsPage(vault?.root ?? "", vault?.store.db as never, lookup.entry),
    );
    expect(elapsedMs).toBeLessThan(FIFO_DEADLINE_MS);
    if (!value.ok) throw new Error("items refused");
    expect(value.value.items[0]?.kind).toBe("inference");
    expect(value.value.items[0]?.quote).toBeNull();
  });
});

describe("the pipeline raw-note reuse path", () => {
  it("fails one source whose raw note became a FIFO and carries on, without waiting", async () => {
    kit = createKit();
    const first = kit.services.runNow();
    if (!first.ok) throw new Error("refused");
    await kit.services.idle();
    const id = sourceIdFor(URL_ONE);
    const name = readdirSync(join(kit.vaultRoot, "global", "raw")).find((file) =>
      file.startsWith(`${id}.`),
    );
    if (name === undefined) throw new Error("raw note missing");
    const target = join(kit.vaultRoot, "global", "raw", name);
    rmSync(target);
    makeFifo(target);

    const { value, elapsedMs } = await timedAsync(target, async () => {
      const second = kit?.services.runNow();
      if (second === undefined || !second.ok) throw new Error("refused");
      await kit?.services.idle();
      return second.value.runId;
    });
    expect(elapsedMs).toBeLessThan(FIFO_DEADLINE_MS);
    const row = listJobRuns(kit.store.db, RESEARCH_JOB_ID, 1)[0];
    expect(row?.jobRunId).toBe(value);
    expect(row?.outcome).toBe("partial");
    expect(row?.unavailableSources).toEqual([{ sourceId: id, code: "parse-failure" }]);
  });
});

describe("the fixture manifest", () => {
  it("refuses a FIFO manifest as invalid without waiting", () => {
    mkdirSync(join(homedir(), ".ccc-test"), { recursive: true });
    scratch = mkdtempSync(join(homedir(), ".ccc-test", "fifom-"));
    const manifest = join(scratch, "manifest.json");
    makeFifo(manifest);
    const { value, elapsedMs } = timed(manifest, () => {
      try {
        createFixtureFetcher({ dir: scratch ?? "" });
        return "created";
      } catch (error) {
        return error instanceof ResearchOverrideError ? error.code : "other";
      }
    });
    expect(elapsedMs).toBeLessThan(FIFO_DEADLINE_MS);
    expect(value).toBe("invalid-fixture-manifest");
  });

  it("still reads a regular manifest", () => {
    mkdirSync(join(homedir(), ".ccc-test"), { recursive: true });
    scratch = mkdtempSync(join(homedir(), ".ccc-test", "fifom-"));
    writeFileSync(join(scratch, "manifest.json"), JSON.stringify({ entries: [] }));
    expect(() => createFixtureFetcher({ dir: scratch ?? "" })).not.toThrow();
  });
});
