import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LIFECYCLE_STAGES } from "@ccc/domain";
import {
  applyMigrations,
  countVaultNotes,
  openStore,
  queryVaultNotes,
  rebuildVaultNotes,
} from "@ccc/operational-store";
import { parseNote } from "@ccc/vault-repo";
import { describe, expect, it } from "vitest";
import { generateSyntheticNotes, writeSyntheticVault } from "./synthetic-notes.js";
import { withTempVaultDir } from "./vault-fixture.js";

/**
 * PERF-06's numeric bar, adopted in plan 02-04: the PRD says "responsive"
 * without a number. Filter queries against the cache are expected to land
 * near 100ms or below in practice (the actual timings are logged by the
 * tests below); 250ms is the hard CI assertion — generous against a loaded
 * CI box, still two orders of magnitude tighter than re-parsing 10,000
 * files' frontmatter. If the owner sets a different bar, this constant is
 * the only thing that changes.
 */
const QUERY_CEILING_MS = 250;

const NOTE_COUNT = 10_000;
/** Enough on-disk notes to measure a real per-note parse cost without spending minutes writing files. */
const NAIVE_SCAN_SAMPLE = 200;

describe("synthetic note fixture", () => {
  it("is deterministic: the same seed produces deep-equal first and last records", () => {
    const first = generateSyntheticNotes(500);
    const second = generateSyntheticNotes(500);

    expect(first).toHaveLength(500);
    expect(second[0]).toEqual(first[0]);
    expect(second[499]).toEqual(first[499]);
  });

  it("produces a different fixture for a different seed", () => {
    expect(generateSyntheticNotes(50, 1)[0]).not.toEqual(generateSyntheticNotes(50, 2)[0]);
  });

  it("spreads notes across roughly twenty workspaces and every lifecycle stage", () => {
    const records = generateSyntheticNotes(2_000);
    const scopes = new Set(records.map((r) => r.scope));
    const stages = new Set(records.map((r) => r.stage));

    // Twenty workspaces plus the global scope.
    expect(scopes.size).toBeGreaterThanOrEqual(20);
    expect(scopes.size).toBeLessThanOrEqual(21);
    expect(scopes).toContain("global");
    for (const stage of LIFECYCLE_STAGES) {
      expect(stages).toContain(stage);
    }
  });
});

describe("PERF-06: filter responsiveness at 10,000 cached notes", () => {
  it("answers scope, stage, and combined filters over a 10,000-row cache inside the ceiling", async () => {
    await withTempVaultDir(async ({ vaultRoot }) => {
      // A file-backed database opened through the production entry
      // point — not `:memory:`, and not a bare better-sqlite3 handle —
      // so the measured number includes the WAL settings and the I/O a
      // real install actually pays.
      const store = openStore(join(vaultRoot, "operational.db"));
      const db = store.db;
      try {
        applyMigrations(db);
        const records = generateSyntheticNotes(NOTE_COUNT);

        const rebuildStart = performance.now();
        rebuildVaultNotes(db, records);
        const rebuildMs = performance.now() - rebuildStart;

        expect(countVaultNotes(db)).toBe(NOTE_COUNT);

        const scope = records[0]?.scope as string;
        const stage = records[0]?.stage as (typeof LIFECYCLE_STAGES)[number];
        const measure = (label: string, run: () => unknown): number => {
          const started = performance.now();
          const rows = run() as unknown[];
          const elapsed = performance.now() - started;
          console.log(
            `[PERF-06] ${label}: ${elapsed.toFixed(2)}ms (${rows.length} rows of ${NOTE_COUNT})`,
          );
          return elapsed;
        };

        console.log(
          `[PERF-06] rebuild of ${NOTE_COUNT} rows in one transaction: ${rebuildMs.toFixed(2)}ms`,
        );

        const byScope = measure("queryVaultNotes({scope})", () => queryVaultNotes(db, { scope }));
        const byStage = measure("queryVaultNotes({stage})", () => queryVaultNotes(db, { stage }));
        const byBoth = measure("queryVaultNotes({scope,stage})", () =>
          queryVaultNotes(db, { scope, stage }),
        );

        expect(byScope).toBeLessThan(QUERY_CEILING_MS);
        expect(byStage).toBeLessThan(QUERY_CEILING_MS);
        expect(byBoth).toBeLessThan(QUERY_CEILING_MS);
      } finally {
        store.close();
      }
    });
  }, 120_000);

  it("records why the cache is load-bearing: a naive frontmatter scan of the same vault, extrapolated", async () => {
    await withTempVaultDir(async ({ vaultRoot }) => {
      const written = writeSyntheticVault(vaultRoot, NAIVE_SCAN_SAMPLE);
      expect(written).toHaveLength(NAIVE_SCAN_SAMPLE);

      // The synthetic notes must be REAL notes, not approximations:
      // every one parses back through the production parser.
      const scanStart = performance.now();
      for (const path of written) {
        parseNote(readFileSync(path, "utf8"));
      }
      const scanMs = performance.now() - scanStart;

      const perNoteMs = scanMs / NAIVE_SCAN_SAMPLE;
      const extrapolatedMs = perNoteMs * NOTE_COUNT;
      console.log(
        `[PERF-06] naive frontmatter scan: ${scanMs.toFixed(2)}ms for ${NAIVE_SCAN_SAMPLE} notes ` +
          `(${perNoteMs.toFixed(3)}ms/note) -> ~${extrapolatedMs.toFixed(0)}ms extrapolated to ${NOTE_COUNT} notes, ` +
          `versus a cache query asserted under ${QUERY_CEILING_MS}ms`,
      );

      // Not asserted as a performance bound — the point of this test is
      // the logged comparison. What IS asserted is that the extrapolation
      // was computed from real parses of real files.
      expect(scanMs).toBeGreaterThan(0);
      expect(parseNote(readFileSync(written[0] as string, "utf8")).frontmatter.id).toBeTruthy();
    });
  }, 120_000);
});
