// Plan 07-08, task 3: the generic writer refuses the research note shapes (D-14, research Open
// Question 6, threat T-07-20). The dedicated writers own report, research-source and
// research-wiki notes; writeNote must not rewrite or forge them.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SourceReference } from "@ccc/domain";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { writeReportNote } from "./report-note.js";
import { initializeVault } from "./setup.js";
import { writeRawSourceNote, writeWikiSourceNote } from "./source-note.js";
import {
  ExtendedNoteWriteRefusedError,
  TasksFolderWriteRefusedError,
  writeNote,
} from "./write-note.js";

const TEST_BASE = join(homedir(), ".ccc-test");
const NOW = new Date("2026-10-15T09:00:00.000Z");
const SOURCE_ID = "0123456789abcdef0123456789abcdef";
const TEXT = "A snapshot.\n";
const HASH = "a".repeat(64);
const RUN_ID = "r0123456789abcdefghijklmn";

let vaultRoot: string;

beforeEach(() => {
  mkdirSync(TEST_BASE, { recursive: true });
  vaultRoot = mkdtempSync(join(TEST_BASE, "vwrite-"));
  initializeVault(vaultRoot);
});

afterEach(() => {
  rmSync(vaultRoot, { recursive: true, force: true });
});

function ref(): SourceReference {
  return {
    sourceType: "web-page",
    id: SOURCE_ID,
    title: "A source",
    canonicalUrl: "https://news.example/a",
    author: null,
    publishedAt: null,
    retrievedAt: "2026-10-15T08:59:00.000Z",
    contentHash: HASH,
    snapshotPath: `global/raw/${SOURCE_ID}.${HASH.slice(0, 8)}.md`,
    accessClass: "public",
  };
}

function request(relativePath: string, extra: Record<string, unknown> = {}) {
  return {
    vaultRoot,
    relativePath,
    body: "Replacement body.\n",
    scope: "global",
    stage: "output" as const,
    generatedBy: {},
    aiGenerated: false,
    confidence: "unverified" as const,
    ...extra,
  };
}

function writeReport(): string {
  return writeReportNote({
    vaultRoot,
    topicLabel: "Daily tech",
    generatedAt: "2026-10-15T08:59:30.000Z",
    jobRunId: RUN_ID,
    summariser: "extractive",
    sourceTotal: 0,
    unavailableSources: [],
    sourceRefs: [],
    sourceHandling: [],
    items: [],
    now: NOW,
  }).path;
}

describe("Test 1: refusal", () => {
  test("an existing report is not overwritten", () => {
    const path = writeReport();
    const before = readFileSync(join(vaultRoot, path), "utf8");
    expect(() => writeNote(request(path))).toThrow(ExtendedNoteWriteRefusedError);
    expect(readFileSync(join(vaultRoot, path), "utf8")).toBe(before);
  });

  test("an existing raw snapshot and wiki note are not overwritten", () => {
    const raw = writeRawSourceNote({
      vaultRoot,
      sourceRef: ref(),
      sanitise: {
        scripts: 0,
        styles: 0,
        comments: 0,
        hiddenBlocks: 0,
        mediaDropped: 0,
        linksDropped: 0,
        controlChars: 0,
        commandLikeLines: 0,
      },
      text: TEXT,
      now: NOW,
    });
    // writeRawSourceNote computes no hash itself, so the file name follows the reference.
    const wiki = writeWikiSourceNote({
      vaultRoot,
      sourceId: SOURCE_ID,
      title: "A source",
      canonicalUrl: "https://news.example/a",
      latestSnapshotPath: raw.path,
      lastRetrievedAt: "2026-10-15T08:59:00.000Z",
      citingItems: [],
      now: NOW,
    });
    for (const path of [raw.path, wiki.path]) {
      const before = readFileSync(join(vaultRoot, path), "utf8");
      expect(() =>
        writeNote(request(path, { stage: path.includes("/raw/") ? "raw" : "wiki" })),
      ).toThrow(ExtendedNoteWriteRefusedError);
      expect(readFileSync(join(vaultRoot, path), "utf8")).toBe(before);
    }
  });

  test("a hand-damaged file that still says type: report is refused too", () => {
    const path = writeReport();
    for (const line of [
      "type: report",
      'type: "report"',
      "type: 'research-wiki'",
      "type: research-source # note",
    ]) {
      writeFileSync(join(vaultRoot, path), `---\nkey: [unclosed\n${line}\n---\nbody\n`);
      expect(() => writeNote(request(path))).toThrow(ExtendedNoteWriteRefusedError);
    }
  });

  test("a request whose own passthrough carries one of those types is refused before anything is created", () => {
    for (const type of ["report", "research-source", "research-wiki", " Report "]) {
      expect(() =>
        writeNote(request("global/output/new-folder/forged.md", { passthrough: { type } })),
      ).toThrow(ExtendedNoteWriteRefusedError);
    }
    expect(() => readFileSync(join(vaultRoot, "global/output/new-folder/forged.md"))).toThrow();
    expect(() => readFileSync(join(vaultRoot, "global/output/new-folder"))).toThrow();
  });

  test("ordinary notes in global/output still write, and can be rewritten", () => {
    const first = writeNote(request("global/output/plain.md"));
    expect(first.path.endsWith("global/output/plain.md")).toBe(true);
    const second = writeNote(
      request("global/output/plain.md", {
        id: first.noteId,
        passthrough: { type: "note", tags: ["x"] },
      }),
    );
    expect(second.noteId).toBe(first.noteId);
    const text = readFileSync(join(vaultRoot, "global/output/plain.md"), "utf8");
    expect(text).toContain("type: note");
    expect(text).toContain("Replacement body.");
  });

  test("a note whose frontmatter type is something else is not refused, and nested type keys do not count", () => {
    writeFileSync(
      join(vaultRoot, "global/output/other.md"),
      "---\nid: x\nitems:\n  - type: report\n---\nbody\n",
    );
    expect(() => writeNote(request("global/output/other.md"))).not.toThrow();
  });

  test("every valid YAML spelling of a research type is refused (07-FIX3A F5)", () => {
    const path = writeReport();
    const spellings = [
      '"type": report',
      "'type': report",
      "type : report",
      "type:\treport",
      "type: !!str report",
      "type: !!str 'research-source'",
      "type:\n  report",
      "type: >-\n  research-wiki",
      "type: |-\n  report",
      "type: REPORT",
      '"t\\u0079pe": report',
      "? type\n: report",
      "type: &anchor report",
    ];
    for (const line of spellings) {
      writeFileSync(join(vaultRoot, path), `---\nid: x\n${line}\ntitle: y\n---\nbody\n`);
      expect(() => writeNote(request(path)), line).toThrow(ExtendedNoteWriteRefusedError);
    }
    for (const block of [
      "{type: report, id: x}",
      '{"type": "research-wiki"}',
      "{ id: x, type: !!str report }",
    ]) {
      writeFileSync(join(vaultRoot, path), `---\n${block}\n---\nbody\n`);
      expect(() => writeNote(request(path)), block).toThrow(ExtendedNoteWriteRefusedError);
    }
  });

  test("a damaged frontmatter that mentions a research type anywhere is still refused", () => {
    const path = writeReport();
    for (const block of [
      'key: [unclosed\n"type": report',
      "{type: report",
      "key: [unclosed\ntype : !!str research-source",
      "- not\n- a map\n- report",
    ]) {
      writeFileSync(join(vaultRoot, path), `---\n${block}\n---\nbody\n`);
      expect(() => writeNote(request(path)), block).toThrow(ExtendedNoteWriteRefusedError);
    }
  });

  test("a frontmatter without a research type is not refused, whatever its spelling", () => {
    const path = "global/output/spelled.md";
    for (const block of [
      '"type": note',
      "type : !!str note",
      "type: reports",
      "title: a report on the cache\ntags: [report]",
      "{type: note, id: x}",
      "id: x\nmeta:\n  type: report",
      "id: x\n# type: report",
    ]) {
      writeFileSync(join(vaultRoot, path), `---\n${block}\n---\nbody\n`);
      expect(() => writeNote(request(path)), block).not.toThrow();
    }
  });

  test("the tasks folder refusal is unchanged", () => {
    expect(() => writeNote(request("global/tasks/x.md"))).toThrow(TasksFolderWriteRefusedError);
  });
});
