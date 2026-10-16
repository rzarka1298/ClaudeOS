import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ResearchReportItemsPageSchema } from "@ccc/domain";
import { getResearchSourceRecord } from "@ccc/operational-store";
import { readReportNote } from "@ccc/vault-repo";
import { afterEach, describe, expect, it } from "vitest";
import { sourceIdFor } from "./hash.js";
import {
  createKit,
  defaultResponses,
  type Kit,
  URL_ONE,
  URL_THREE,
  URL_TWO,
} from "./test-support/research-kit.js";
import { buildReportItemsPage, findReport } from "./view-model.js";

/**
 * 07-FIX6 (decision D-A, ADR-0030): the pipeline records, in the operational store, each source
 * whose raw note it wrote and read back, and nothing else. The reader's "verified" rests on that
 * row, so a source that failed any stage before the read-back must have none.
 */

let kit: Kit | undefined;
afterEach(() => {
  kit?.close();
  kit = undefined;
});

async function runToEnd(k: Kit): Promise<string> {
  const started = k.services.runNow();
  if (!started.ok) throw new Error(`refused: ${started.code}`);
  await k.services.idle();
  return started.value.runId;
}

function rawFileFor(k: Kit, url: string): string {
  const id = sourceIdFor(url);
  const name = readdirSync(join(k.vaultRoot, "global/raw")).find((n) => n.startsWith(`${id}.`));
  if (name === undefined) throw new Error("raw note missing");
  return join(k.vaultRoot, "global/raw", name);
}

function recordsOf(k: Kit, runId: string): string[] {
  return [URL_ONE, URL_TWO, URL_THREE].filter(
    (url) => getResearchSourceRecord(k.store.db, runId, sourceIdFor(url)) !== null,
  );
}

describe("the pipeline records each source it wrote and read back", () => {
  it("leaves one record per source with the hash, address, path and label the report cites", async () => {
    kit = createKit();
    const runId = await runToEnd(kit);
    expect(recordsOf(kit, runId)).toEqual([URL_ONE, URL_TWO, URL_THREE]);
    const reports = readdirSync(join(kit.vaultRoot, "global/output")).filter((n) =>
      n.startsWith("research-"),
    );
    const read = readReportNote(kit.vaultRoot, `global/output/${reports[0]}`);
    if (!read.readable) throw new Error("report must be readable");
    for (const ref of read.frontmatter.sourceRefs) {
      const record = getResearchSourceRecord(kit.store.db, runId, ref.id);
      expect(record).toMatchObject({
        jobRunId: runId,
        sourceId: ref.id,
        canonicalUrl: ref.canonicalUrl,
        contentHash: ref.contentHash,
        snapshotPath: ref.snapshotPath,
        label: ref.title,
      });
    }
  });

  it("serves a real run's quotes as evidence, end to end", async () => {
    kit = createKit();
    await runToEnd(kit);
    const reports = readdirSync(join(kit.vaultRoot, "global/output")).filter((n) =>
      n.startsWith("research-"),
    );
    const read = readReportNote(kit.vaultRoot, `global/output/${reports[0]}`);
    if (!read.readable) throw new Error("report must be readable");
    const quoted = read.frontmatter.items.filter((item) => item.quote !== undefined);
    expect(quoted.length).toBeGreaterThan(0);
    const found = findReport(kit.vaultRoot, read.frontmatter.id);
    if (found.kind !== "found") throw new Error("expected the report");
    const page = buildReportItemsPage(kit.vaultRoot, kit.store.db, found.entry);
    if (!page.ok) throw new Error("refused");
    const served = ResearchReportItemsPageSchema.parse(page.value).items;
    expect(served.filter((item) => item.quote !== null)).toHaveLength(quoted.length);
    expect(served.some((item) => item.quoteUnverified === true)).toBe(false);
  });

  it("records no row for a source that failed to fetch", async () => {
    kit = createKit({
      responses: { ...defaultResponses(), [URL_TWO]: { ok: false, code: "timeout" } },
    });
    const runId = await runToEnd(kit);
    expect(recordsOf(kit, runId)).toEqual([URL_ONE, URL_THREE]);
  });

  it("records no row for a source whose stored raw note was edited, and records the others", async () => {
    kit = createKit();
    await runToEnd(kit);
    const target = rawFileFor(kit, URL_ONE);
    writeFileSync(target, readFileSync(target, "utf8").replace("twice as fast", "twice as slow"));
    const second = await runToEnd(kit);
    expect(recordsOf(kit, second)).toEqual([URL_TWO, URL_THREE]);
  });

  it("records nothing when every source fails", async () => {
    kit = createKit({
      responses: {
        [URL_ONE]: { ok: false, code: "timeout" },
        [URL_TWO]: { ok: false, code: "timeout" },
        [URL_THREE]: { ok: false, code: "timeout" },
      },
    });
    const runId = await runToEnd(kit);
    expect(recordsOf(kit, runId)).toEqual([]);
    expect(kit.store.db.prepare("SELECT COUNT(*) AS n FROM research_source_records").get()).toEqual(
      { n: 0 },
    );
  });

  it("records a reused, unchanged raw note again for the new run", async () => {
    kit = createKit();
    const first = await runToEnd(kit);
    const second = await runToEnd(kit);
    expect(second).not.toBe(first);
    expect(recordsOf(kit, first)).toEqual([URL_ONE, URL_TWO, URL_THREE]);
    expect(recordsOf(kit, second)).toEqual([URL_ONE, URL_TWO, URL_THREE]);
  });
});
