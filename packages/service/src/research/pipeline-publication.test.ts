// 07-FIX4 b and c: a failed run leaves no exposed report and no dangling wiki note, whichever step
// after the report write breaks (the report write itself, its index, the finalise, a store write,
// the final job run write); and a wiki note keeps earlier citations when a later run does not
// cite its source. Real vault, real file-backed store; the only stub is one throwing finalise.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RESEARCH_JOB_ID } from "@ccc/domain";
import { listJobRuns } from "@ccc/operational-store";
import { extractiveSummary } from "@ccc/research";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sourceIdFor } from "./hash.js";
import { createKit, type Kit, URL_ONE } from "./test-support/research-kit.js";

const controls = vi.hoisted(() => ({ finaliseThrows: false }));

vi.mock("@ccc/vault-repo", async (importOriginal) => {
  const real = await importOriginal<typeof import("@ccc/vault-repo")>();
  return {
    ...real,
    finaliseReportNote: (options: Parameters<typeof real.finaliseReportNote>[0]) => {
      if (controls.finaliseThrows) throw new Error("disk full");
      return real.finaliseReportNote(options);
    },
  };
});

let kit: Kit | undefined;
afterEach(() => {
  controls.finaliseThrows = false;
  kit?.close();
  kit = undefined;
});

function names(k: Kit, folder: string): string[] {
  try {
    return readdirSync(join(k.vaultRoot, folder)).filter((name) => name !== "index.md");
  } catch {
    return [];
  }
}

function reportFiles(k: Kit): string[] {
  return names(k, "global/output").filter((name) => name.startsWith("research-"));
}

function wikiBytes(k: Kit): Record<string, string> {
  return Object.fromEntries(
    names(k, "global/wiki").map((name) => [
      name,
      readFileSync(join(k.vaultRoot, "global/wiki", name), "utf8"),
    ]),
  );
}

async function runToEnd(k: Kit): Promise<string> {
  const started = k.services.runNow();
  if (!started.ok) throw new Error(`refused: ${started.code}`);
  await k.services.idle();
  return started.value.runId;
}

function lastRow(k: Kit) {
  const row = listJobRuns(k.store.db, RESEARCH_JOB_ID, 1)[0];
  if (row === undefined) throw new Error("no job run");
  return row;
}

/** What a failed run must look like on disk, whatever broke. */
function expectNothingPublished(k: Kit, runId: string): void {
  expect(reportFiles(k), "no report may stay in the output folder").toEqual([]);
  const row = lastRow(k);
  expect(row.outcome).toBe("failure");
  expect(row.state).toBe("failed");
  expect(row.reportNoteId).toBeNull();
  const note = readFileSync(join(k.vaultRoot, "automation-runs", `${runId}.md`), "utf8");
  expect(note).not.toContain("- Report:");
}

/** Replaces `global/output/index.md` with a folder: rebuilding the index then throws. */
function breakOutputIndex(k: Kit): void {
  const index = join(k.vaultRoot, "global", "output", "index.md");
  rmSync(index, { force: true });
  mkdirSync(index);
}

describe("07-FIX4 b: publication is all or nothing", () => {
  it("a report that cannot be written leaves no wiki note either", async () => {
    kit = createKit();
    rmSync(join(kit.vaultRoot, "global", "output"), { recursive: true });
    writeFileSync(join(kit.vaultRoot, "global", "output"), "a file where a folder belongs");
    await runToEnd(kit);
    const row = lastRow(kit);
    expect(row.errorCode).toBe("vault-write-failed");
    expect(row.outcome).toBe("failure");
    expect(
      names(kit, "global/wiki"),
      "no wiki note may cite a report that was never written",
    ).toEqual([]);
  });

  it("a report that cannot be written leaves the wiki notes of an earlier run exactly as they were", async () => {
    kit = createKit();
    await runToEnd(kit);
    const before = wikiBytes(kit);
    expect(Object.keys(before)).toHaveLength(3);
    rmSync(join(kit.vaultRoot, "global", "output"), { recursive: true });
    writeFileSync(join(kit.vaultRoot, "global", "output"), "a file where a folder belongs");
    await runToEnd(kit);
    expect(lastRow(kit).errorCode).toBe("vault-write-failed");
    expect(wikiBytes(kit)).toEqual(before);
  });

  it("an index that cannot be rebuilt after the report write takes the report back", async () => {
    kit = createKit();
    breakOutputIndex(kit);
    const runId = await runToEnd(kit);
    expect(lastRow(kit).errorCode).toBe("vault-write-failed");
    expectNothingPublished(kit, runId);
    expect(names(kit, "global/wiki")).toEqual([]);
  });

  it("a finalise that fails takes the report back and restores the wiki notes", async () => {
    kit = createKit();
    await runToEnd(kit);
    const before = wikiBytes(kit);
    const earlier = reportFiles(kit);
    controls.finaliseThrows = true;
    const runId = await runToEnd(kit);
    const row = lastRow(kit);
    expect(row.errorCode).toBe("vault-write-failed");
    expect(row.outcome).toBe("failure");
    expect(row.reportNoteId).toBeNull();
    // Only the earlier, successful run's report is left.
    expect(reportFiles(kit)).toEqual(earlier);
    expect(wikiBytes(kit)).toEqual(before);
    const note = readFileSync(join(kit.vaultRoot, "automation-runs", `${runId}.md`), "utf8");
    expect(note).not.toContain("- Report:");
  });

  it("a finalise that fails on a first run leaves neither a report nor a wiki note", async () => {
    kit = createKit();
    controls.finaliseThrows = true;
    const runId = await runToEnd(kit);
    expect(lastRow(kit).errorCode).toBe("vault-write-failed");
    expectNothingPublished(kit, runId);
    expect(names(kit, "global/wiki")).toEqual([]);
  });

  for (const stage of ["deliverable", "output"] as const) {
    it(`a store write that fails at the ${stage} stage takes the report back, with a code that is not a vault failure`, async () => {
      kit = createKit();
      await runToEnd(kit);
      const before = wikiBytes(kit);
      const earlier = reportFiles(kit);
      kit.store.db.exec(
        `CREATE TRIGGER fail_${stage} BEFORE UPDATE OF stage_log ON job_runs
         WHEN NEW.stage_log LIKE '%"${stage}"%'
         BEGIN SELECT RAISE(ABORT, 'store down'); END;`,
      );
      const runId = await runToEnd(kit);
      const row = lastRow(kit);
      expect(row.outcome).toBe("failure");
      expect(row.state).toBe("failed");
      expect(row.errorCode, "the vault writes all succeeded").toBe("interrupted");
      expect(row.reportNoteId).toBeNull();
      expect(reportFiles(kit)).toEqual(earlier);
      expect(wikiBytes(kit)).toEqual(before);
      const note = readFileSync(join(kit.vaultRoot, "automation-runs", `${runId}.md`), "utf8");
      expect(note).not.toContain("- Report:");
    });
  }

  it("a job run that cannot record success is failed honestly, without claiming a vault failure, and the report is taken back", async () => {
    kit = createKit();
    kit.store.db.exec(
      `CREATE TRIGGER refuse_completed BEFORE UPDATE OF state ON job_runs
       WHEN NEW.state = 'completed'
       BEGIN SELECT RAISE(ABORT, 'store refuses'); END;`,
    );
    const runId = await runToEnd(kit);
    const row = lastRow(kit);
    expect(row.state).toBe("failed");
    expect(row.outcome).toBe("failure");
    expect(row.errorCode).not.toBe("vault-write-failed");
    expect(row.errorCode).toBe("interrupted");
    expectNothingPublished(kit, runId);
    expect(names(kit, "global/wiki")).toEqual([]);
    expect(kit.events.at(-1)?.payload).toMatchObject({ state: "failed" });
  });

  it("a successful run still publishes exactly one finalised report and one wiki note per source", async () => {
    kit = createKit();
    await runToEnd(kit);
    expect(reportFiles(kit)).toHaveLength(1);
    expect(names(kit, "global/wiki")).toHaveLength(3);
    expect(lastRow(kit).outcome).toBe("success");
    expect(existsSync(join(kit.vaultRoot, "global/output", reportFiles(kit)[0] ?? "x"))).toBe(true);
  });
});

describe("07-FIX4 c: a wiki note keeps earlier citations when a later run does not cite its source", () => {
  it("run two cites nothing, and run one's lines are still in every wiki note", async () => {
    let mode: "extractive" | "inference" = "extractive";
    kit = createKit({
      transport: {
        complete: async (request) =>
          mode === "extractive"
            ? extractiveSummary(request.input)
            : JSON.stringify({
                items: [{ kind: "inference", text: "Nothing today", citedSourceIds: [] }],
              }),
      },
    });
    await runToEnd(kit);
    const firstReport = reportFiles(kit)[0] ?? "";
    const alpha = readFileSync(
      join(kit.vaultRoot, "global/wiki", `${sourceIdFor(URL_ONE)}.md`),
      "utf8",
    );
    expect(alpha).toContain(firstReport);
    expect(alpha).toContain("**Reported fact**");

    mode = "inference";
    await runToEnd(kit);
    expect(reportFiles(kit)).toHaveLength(2);
    for (const [name, text] of Object.entries(wikiBytes(kit))) {
      expect(text, name).toContain(firstReport);
      expect(text, name).not.toContain("No report cites this source yet.");
    }
  });

  it("run two cites the source again, and both reports are listed", async () => {
    kit = createKit();
    await runToEnd(kit);
    const first = reportFiles(kit)[0] ?? "";
    await runToEnd(kit);
    const reports = reportFiles(kit);
    expect(reports).toHaveLength(2);
    const second = reports.find((name) => name !== first) ?? "";
    for (const [name, text] of Object.entries(wikiBytes(kit))) {
      expect(text, name).toContain(first);
      expect(text, name).toContain(second);
    }
  });
});
