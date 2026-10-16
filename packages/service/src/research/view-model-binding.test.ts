import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ResearchReportItemsPage,
  ResearchReportItemsPageSchema,
  ResearchReportSourcesPageSchema,
  rawSnapshotPathFor,
  type SourceReference,
} from "@ccc/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sourceIdFor } from "./hash.js";
import {
  type BuiltReport,
  createReportVault,
  type ReportSpec,
  type ReportVault,
} from "./test-support/report-vault.js";
import { buildReportItemsPage, buildReportSourcesPage, findReport } from "./view-model.js";

/**
 * Wave 5 fix round (opus M2, Codex 1): a cited reference is bound to its snapshot. The report's
 * own copy of a reference is only a pointer; what makes a quote evidence is that the raw note it
 * points at is the note written for THAT source: the id is the hash of the address, the snapshot
 * path is the one derived from the id and the hash, and the raw note's own reference agrees with
 * the report's on id, kind, address, hash, path and access class. The title and the address that
 * are shown come from the raw note's reference, never from the report's editable copy.
 *
 * (A reader with write access to the vault can still forge both files; recording bindings in the
 * operational store at raw-write time is an owner decision, recorded in 07-FIX5-SUMMARY.md.)
 */

let vault: ReportVault;
beforeEach(() => {
  vault = createReportVault();
});
afterEach(() => vault.cleanup());

const URL_A = "https://one.example.invalid/a";
const URL_B = "https://two.example.invalid/b";
const SOURCE_A =
  "The maintainers confirmed that the alpha parser is now twice as fast in this release.";
const SOURCE_B = "Version 1.9 fixes a crash when reading empty archives from the cache.";
const QUOTE_A = "the alpha parser is now twice as fast";
const QUOTE_B = "fixes a crash when reading empty archives";

function spec(extra: Partial<ReportSpec> = {}): ReportSpec {
  return {
    sources: [
      { url: URL_A, title: "Outlet A", text: SOURCE_A },
      { url: URL_B, title: "Outlet B", text: SOURCE_B },
    ],
    items: [
      { kind: "source-fact", text: "Parser is faster.", quote: QUOTE_A, cites: [0] },
      { kind: "source-fact", text: "A crash is fixed.", quote: QUOTE_B, cites: [1] },
    ],
    ...extra,
  };
}

function lookup(built: BuiltReport) {
  const found = findReport(vault.root, built.noteId);
  if (found.kind !== "found") throw new Error("expected the report");
  return found.entry;
}

function items(built: BuiltReport): ResearchReportItemsPage {
  const result = buildReportItemsPage(vault.root, vault.store.db, lookup(built));
  if (!result.ok) throw new Error(`refused: ${result.code}`);
  return ResearchReportItemsPageSchema.parse(result.value);
}

function sources(built: BuiltReport) {
  const result = buildReportSourcesPage(vault.root, lookup(built));
  if (!result.ok) throw new Error(`refused: ${result.code}`);
  return ResearchReportSourcesPageSchema.parse(result.value);
}

function editRaw(built: BuiltReport, index: number, edit: (text: string) => string): void {
  const path = join(vault.root, built.rawPaths[index] ?? "");
  const before = readFileSync(path, "utf8");
  const after = edit(before);
  if (after === before) throw new Error("the edit changed nothing");
  writeFileSync(path, after);
}

const withheld = { kind: "inference", quote: null, quoteUnverified: true } as const;

describe("a genuine report", () => {
  it("keeps both quotes and serves the raw note's title and address", () => {
    const built = vault.addReport(spec());
    const page = items(built);
    expect(page.items[0]).toMatchObject({ kind: "source-fact", quote: QUOTE_A });
    expect(page.items[1]).toMatchObject({ kind: "source-fact", quote: QUOTE_B });
    expect(page.items[0]?.citations).toEqual([{ number: 1, title: "Outlet A" }]);
    expect(sources(built).sources.map((s) => [s.title, s.canonicalUrl])).toEqual([
      ["Outlet A", URL_A],
      ["Outlet B", URL_B],
    ]);
  });
});

describe("a report that points at another source's snapshot", () => {
  it("serves report A's finding citing source B's snapshot as an inference", () => {
    // Source A keeps its identity and address but takes B's hash and snapshot path; the finding
    // that cites A carries B's sentence.
    const built = vault.addReport(
      spec({
        items: [{ kind: "source-fact", text: "Attributed to A.", quote: QUOTE_B, cites: [0] }],
        editCitedRefs: (refs) => {
          const [a, b] = refs;
          if (a === undefined || b === undefined) throw new Error("two refs");
          return [{ ...a, contentHash: b.contentHash, snapshotPath: b.snapshotPath }, b];
        },
      }),
    );
    expect(items(built).items[0]).toMatchObject(withheld);
  });

  it("serves a finding as an inference when the id is not the hash of the address", () => {
    const built = vault.addReport(
      spec({
        editCitedRefs: (refs) =>
          refs.map((ref, index) =>
            index === 0 ? { ...ref, canonicalUrl: "https://trusted.example.invalid/outlet" } : ref,
          ),
      }),
    );
    const page = items(built);
    expect(page.items[0]).toMatchObject(withheld);
    expect(page.items[1]).toMatchObject({ kind: "source-fact", quote: QUOTE_B });
  });

  it("serves a finding as an inference when the snapshot path is not the one derived from id and hash", () => {
    const built = vault.addReport(
      spec({
        editCitedRefs: (refs) =>
          refs.map((ref, index) => {
            if (index !== 0) return ref;
            const other = refs[1];
            if (other === undefined) throw new Error("two refs");
            return { ...ref, snapshotPath: other.snapshotPath };
          }),
      }),
    );
    expect(items(built).items[0]).toMatchObject(withheld);
  });
});

describe("a raw note whose own reference disagrees with the report's", () => {
  it("withholds the quote when the raw note names another address", () => {
    const built = vault.addReport(spec());
    editRaw(built, 0, (text) =>
      text.replace(/^ {2}canonicalUrl: .*$/m, "  canonicalUrl: https://evil.example.invalid/x"),
    );
    const page = items(built);
    expect(page.items[0]).toMatchObject(withheld);
    expect(page.items[1]).toMatchObject({ kind: "source-fact", quote: QUOTE_B });
  });

  it("withholds the quote when the raw note names another kind of source", () => {
    const built = vault.addReport(spec());
    editRaw(built, 0, (text) => text.replace(/^ {2}sourceType: .*$/m, "  sourceType: web-page"));
    expect(items(built).items[0]).toMatchObject(withheld);
  });

  it("withholds the quote when the raw note names another access class", () => {
    const built = vault.addReport(spec());
    editRaw(built, 0, (text) => text.replace(/^ {2}accessClass: .*$/m, "  accessClass: private"));
    expect(items(built).items[0]).toMatchObject(withheld);
  });
});

describe("what is shown comes from the raw note, not from the report's edited copy", () => {
  it("shows the raw note's title for a citation and on the sources page", () => {
    const built = vault.addReport(
      spec({
        editCitedRefs: (refs) =>
          refs.map((ref, index) => (index === 0 ? { ...ref, title: "A Trusted Outlet" } : ref)),
      }),
    );
    // The edit changed only the title: the binding still holds, the quote is kept, and the title
    // that is served is the one the raw note was written with.
    const page = items(built);
    expect(page.items[0]).toMatchObject({ kind: "source-fact", quote: QUOTE_A });
    expect(page.items[0]?.citations).toEqual([{ number: 1, title: "Outlet A" }]);
    expect(sources(built).sources[0]?.title).toBe("Outlet A");
  });

  it("shows the raw note's address when the report's copy of it was edited", () => {
    const built = vault.addReport(
      spec({
        editCitedRefs: (refs) =>
          refs.map((ref, index) =>
            index === 0 ? { ...ref, canonicalUrl: "https://trusted.example.invalid/outlet" } : ref,
          ),
      }),
    );
    const served = sources(built).sources[0];
    expect(served?.canonicalUrl).toBe(URL_A);
    expect(served?.title).toBe("Outlet A");
  });

  it("falls back to the report's own copy when there is no raw note to ask", () => {
    const built = vault.addReport(spec());
    writeFileSync(join(vault.root, built.rawPaths[0] ?? ""), "gone\n");
    const served = sources(built).sources[0];
    expect(served?.title).toBe("Outlet A");
    expect(served?.canonicalUrl).toBe(URL_A);
  });
});

describe("the binding rules are the ones the pipeline writes", () => {
  it("builds ids and paths exactly as the writers do", () => {
    const built = vault.addReport(spec());
    const ref = built.sourceRefs[0] as SourceReference;
    expect(ref.id).toBe(sourceIdFor(URL_A));
    expect(ref.snapshotPath).toBe(rawSnapshotPathFor(ref.id, ref.contentHash));
  });
});
