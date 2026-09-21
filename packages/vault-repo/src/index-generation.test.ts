// VAULT-03's determinism contract, proven rather than asserted: the same
// folder state must produce BYTE-identical `index.md` on every run, the
// sort order must be a property of the notes' own metadata and never of
// filesystem enumeration order, and a crafted frontmatter value must not
// be able to forge a row.
//
// These tests use a local ephemeral vault root rather than
// `@ccc/test-fixtures`' `withTempVaultDir`: `@ccc/vault-repo` sits BELOW
// test-fixtures in the import-boundary map, so importing it here would
// invert that edge. The base directory is the same `~/.ccc-test` every
// other package's temp-dir test uses, so a killed run leaves its debris
// somewhere a human can find.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type NoteFrontmatter,
  NoteFrontmatterSchema,
  newWorkspaceId,
  workspaceScope,
} from "@ccc/domain";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { stringifyNote } from "./frontmatter.js";
import { regenerateIndex, WorkspaceIdentityUnreadableError } from "./index-generation.js";
import { writeNote } from "./write-note.js";

const TEST_BASE = join(homedir(), ".ccc-test");

/** Set by any frontmatter gray-matter was tricked into EVALUATING. Asserted
 * on rather than on a thrown error alone: "rejected" is not the property
 * that matters, "never executed" is (the same discipline
 * `frontmatter.test.ts` establishes). */
const SENTINEL = "__cccIndexEvalSentinel";

type Sentinel = Record<string, unknown>;

function evaluated(): unknown {
  return (globalThis as Sentinel)[SENTINEL];
}

let vaultRoot: string;
let folder: string;

beforeEach(() => {
  (globalThis as Sentinel)[SENTINEL] = false;
  mkdirSync(TEST_BASE, { recursive: true });
  vaultRoot = mkdtempSync(join(TEST_BASE, "vidx-"));
  folder = join(vaultRoot, "global", "wiki");
  mkdirSync(folder, { recursive: true });
});

afterEach(() => {
  delete (globalThis as Sentinel)[SENTINEL];
  rmSync(vaultRoot, { recursive: true, force: true });
});

interface SeedFields {
  readonly id: string;
  readonly created: string;
  readonly updated?: string;
  readonly stage?: NoteFrontmatter["stage"];
}

/** Writes one schema-valid note directly, bypassing `writeNote` so the
 * test controls `id`/`created` exactly (the tie-break proof needs two
 * notes whose `created` values are identical by construction, which a
 * clock-stamped write path cannot produce). */
function seedNote(dir: string, filename: string, fields: SeedFields): void {
  const frontmatter = NoteFrontmatterSchema.parse({
    id: fields.id,
    scope: "global",
    stage: fields.stage ?? "wiki",
    created: fields.created,
    updated: fields.updated ?? fields.created,
    generatedBy: {},
    aiGenerated: false,
    sources: [],
    confidence: "unverified",
    lastReviewed: null,
  });
  writeFileSync(join(dir, filename), stringifyNote(frontmatter, `# ${filename}\n`), "utf8");
}

function indexBytes(dir: string): Buffer {
  return readFileSync(join(dir, "index.md"));
}

/** Every generated note row starts with this marker; counting it is how
 * the injection test proves no extra row was forged. */
const ROW_MARKER = "- [[";

function rowCount(content: string): number {
  return content.split("\n").filter((line) => line.startsWith(ROW_MARKER)).length;
}

describe("regenerateIndex", () => {
  test("running twice over an unchanged folder produces byte-identical output", () => {
    seedNote(folder, "alpha.md", { id: "id-alpha", created: "2026-01-01T00:00:00.000Z" });
    seedNote(folder, "beta.md", { id: "id-beta", created: "2026-01-02T00:00:00.000Z" });

    regenerateIndex(folder, { vaultRoot });
    const first = indexBytes(folder);
    regenerateIndex(folder, { vaultRoot });
    const second = indexBytes(folder);

    // Byte comparison, not a parsed comparison: "deterministic" here means
    // the FILE is identical, which a structural equality check would not
    // catch when only key order or spacing drifted.
    expect(Buffer.compare(first, second)).toBe(0);
    // And nothing timestamp-like leaked into the generated frontmatter,
    // which is what makes the byte-identity possible at all.
    expect(first.toString("utf8")).not.toMatch(/^generated(At|On):/m);
  });

  test("two notes with identical created values are ordered by id, not by creation order", () => {
    const created = "2026-01-01T00:00:00.000Z";
    // Written zulu-first so filesystem enumeration order and the expected
    // output order genuinely disagree.
    seedNote(folder, "zulu.md", { id: "id-zzz", created });
    seedNote(folder, "alpha.md", { id: "id-aaa", created });

    const result = regenerateIndex(folder, { vaultRoot });

    const zuluRow = result.content.indexOf("id-zzz");
    const alphaRow = result.content.indexOf("id-aaa");
    expect(alphaRow).toBeGreaterThan(-1);
    expect(zuluRow).toBeGreaterThan(alphaRow);
  });

  test("shuffling the order files are created in does not change the bytes", () => {
    const created = "2026-01-01T00:00:00.000Z";
    const other = mkdtempSync(join(TEST_BASE, "vidx-"));
    try {
      const otherFolder = join(other, "global", "wiki");
      mkdirSync(otherFolder, { recursive: true });

      seedNote(folder, "alpha.md", { id: "id-aaa", created });
      seedNote(folder, "mike.md", { id: "id-mmm", created });
      seedNote(folder, "zulu.md", { id: "id-zzz", created });

      // Same three notes, created in the opposite order.
      seedNote(otherFolder, "zulu.md", { id: "id-zzz", created });
      seedNote(otherFolder, "mike.md", { id: "id-mmm", created });
      seedNote(otherFolder, "alpha.md", { id: "id-aaa", created });

      regenerateIndex(folder, { vaultRoot });
      regenerateIndex(otherFolder, { vaultRoot: other });

      expect(Buffer.compare(indexBytes(folder), indexBytes(otherFolder))).toBe(0);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  test("a folder with zero notes still gets a deterministic empty-state index", () => {
    const result = regenerateIndex(folder, { vaultRoot });

    expect(result.noteCount).toBe(0);
    const first = indexBytes(folder);
    expect(first.toString("utf8")).toContain("_No notes yet._");
    expect(rowCount(first.toString("utf8"))).toBe(0);

    regenerateIndex(folder, { vaultRoot });
    expect(Buffer.compare(first, indexBytes(folder))).toBe(0);
  });

  test("a schema-invalid child is listed as unreadable and its valid siblings are unaffected", () => {
    seedNote(folder, "valid.md", { id: "id-valid", created: "2026-01-01T00:00:00.000Z" });
    writeFileSync(
      join(folder, "broken.md"),
      "---\nid: id-broken\nstage: not-a-stage\n---\n\n# Broken\n",
      "utf8",
    );

    const result = regenerateIndex(folder, { vaultRoot });

    expect(result.unreadable).toEqual(["broken.md"]);
    expect(result.noteCount).toBe(1);
    expect(result.content).toContain("## Unreadable");
    expect(result.content).toContain("broken.md");
    // The valid sibling is still listed — an unreadable neighbour must not
    // silently swallow notes that parse fine.
    expect(result.content).toContain("id-valid");
    expect(rowCount(result.content)).toBe(1);
  });

  test("a frontmatter value containing a newline cannot forge an extra row", () => {
    seedNote(folder, "honest.md", { id: "id-honest", created: "2026-01-01T00:00:00.000Z" });
    seedNote(folder, "crafted.md", {
      id: "id-crafted",
      created: "2026-01-02T00:00:00.000Z",
      // `updated` is a free-form string in the schema, so this passes
      // validation and reaches the row template — exactly the tampering
      // path T-02-04 describes.
      updated: "2026-01-02T00:00:00.000Z\n- [[forged]] — id `id-forged` · stage `wiki` · updated x",
    });

    const result = regenerateIndex(folder, { vaultRoot });

    expect(rowCount(result.content)).toBe(2);
    // The contract is that a crafted value cannot occupy a ROW POSITION.
    // Its characters still appear as inline text of the note's own
    // `updated` field — that is the honest rendering of what is actually
    // in that note's frontmatter, and pretending otherwise would make the
    // index lie. What must not exist is a line the reader parses as a
    // separate note.
    const forgedRow = result.content
      .split("\n")
      .some((line) => line.startsWith(`${ROW_MARKER}forged]]`));
    expect(forgedRow).toBe(false);
    expect(result.content.split("\n").filter((line) => line.includes("id-forged"))).toHaveLength(1);
  });

  test("workspace identity keys are re-emitted unchanged while the listing is rebuilt", () => {
    const identity = { workspaceId: "ws-0123456789abcdefghijklm", displayName: "Research" };

    regenerateIndex(folder, { vaultRoot, identity });
    const seeded = readFileSync(join(folder, "index.md"), "utf8");
    expect(seeded).toContain("ws-0123456789abcdefghijklm");
    expect(seeded).toContain("Research");

    // A later regeneration is given no identity — it must recover both
    // keys from the existing index rather than dropping them, and must
    // still rebuild the listing from the folder's current contents.
    seedNote(folder, "added.md", { id: "id-added", created: "2026-01-03T00:00:00.000Z" });
    const second = regenerateIndex(folder, { vaultRoot });

    expect(second.content).toContain("ws-0123456789abcdefghijklm");
    expect(second.content).toContain("Research");
    expect(second.content).toContain("id-added");
    expect(second.noteCount).toBe(1);
  });

  test("index.md, dotfiles and non-Markdown children are never listed as notes", () => {
    seedNote(folder, "real.md", { id: "id-real", created: "2026-01-01T00:00:00.000Z" });
    seedNote(folder, ".hidden.md", { id: "id-hidden", created: "2026-01-01T00:00:00.000Z" });
    writeFileSync(join(folder, "notes.txt"), "not markdown\n", "utf8");
    mkdirSync(join(folder, "subfolder"), { recursive: true });
    seedNote(join(folder, "subfolder"), "nested.md", {
      id: "id-nested",
      created: "2026-01-01T00:00:00.000Z",
    });

    const result = regenerateIndex(folder, { vaultRoot });

    expect(result.noteCount).toBe(1);
    expect(result.content).toContain("id-real");
    expect(result.content).not.toContain("id-hidden");
    expect(result.content).not.toContain("id-nested");
    expect(result.content).not.toContain("[[index]]");

    // Regenerating again now that index.md exists must not list the index
    // itself — the classic self-referential drift.
    const again = regenerateIndex(folder, { vaultRoot });
    expect(again.noteCount).toBe(1);
  });

  test("an index.md whose delimiter is ---js is never evaluated during the identity read-back", () => {
    // The identity read-back is the one place this module parses a file it
    // did not write. `index.md` is ordinary vault content, so a synced or
    // hand-edited one carrying gray-matter's `js` language tag would reach
    // an `eval` inside the companion-service process (threat T-02-03) —
    // the same surface `parseNote` closes, on the path that skipped it.
    writeFileSync(
      join(folder, "index.md"),
      `---js\n{ workspaceId: (globalThis['${SENTINEL}'] = 'index-rce'), displayName: 'x' }\n---\n# Index\n`,
      "utf8",
    );
    seedNote(folder, "alpha.md", { id: "id-alpha", created: "2026-01-01T00:00:00.000Z" });

    const result = regenerateIndex(folder, { vaultRoot });

    // "Never evaluated", not merely "rejected afterwards": a parser that
    // runs the code and then discards the value has already lost.
    expect(evaluated()).toBe(false);
    // Regeneration of a non-workspace folder still succeeds — an unreadable
    // derived artifact is replaced, which is the whole point of one.
    expect(result.noteCount).toBe(1);
    expect(result.content).toContain("id-alpha");
    expect(result.content).not.toContain("index-rce");
  });

  test("a workspace root whose index will not parse is refused, not overwritten", () => {
    const workspaceId = newWorkspaceId();
    const workspaceRoot = join(vaultRoot, "workspaces", workspaceId);
    mkdirSync(workspaceRoot, { recursive: true });

    regenerateIndex(workspaceRoot, {
      vaultRoot,
      identity: { workspaceId, displayName: "My Research Workspace" },
    });

    // A hand-edit with an unbalanced quote — the most ordinary way a user
    // breaks the one file their workspace's name lives in.
    const indexPath = join(workspaceRoot, "index.md");
    const damaged = readFileSync(indexPath, "utf8").replace(
      "displayName: My Research Workspace",
      "displayName: 'My Research Workspace",
    );
    writeFileSync(indexPath, damaged, "utf8");

    expect(() => regenerateIndex(workspaceRoot, { vaultRoot })).toThrow(
      WorkspaceIdentityUnreadableError,
    );
    // The load-bearing assertion: refusing is only worth anything if the
    // file survives. `displayName` is recoverable from nowhere else.
    expect(readFileSync(indexPath, "utf8")).toBe(damaged);
  });

  test("an unreadable index outside a workspace root is still replaced", () => {
    // Same damage, ordinary managed folder: there is no unrecoverable
    // state here, so regeneration is the correct answer rather than a
    // refusal. Without this the fix above would be a denial-of-service on
    // every corrupt derived artifact in the vault.
    writeFileSync(join(folder, "index.md"), "---\ndisplayName: 'unterminated\n---\n", "utf8");
    seedNote(folder, "alpha.md", { id: "id-alpha", created: "2026-01-01T00:00:00.000Z" });

    const result = regenerateIndex(folder, { vaultRoot });

    expect(result.noteCount).toBe(1);
    expect(result.content).toContain("folder: global/wiki");
    expect(result.content).not.toContain("displayName");
  });

  test("an explicit identity always wins, even over an unreadable workspace index", () => {
    // Workspace creation supplies identity directly, so a corrupt leftover
    // index must not be able to block minting a workspace at that path.
    const workspaceId = newWorkspaceId();
    const workspaceRoot = join(vaultRoot, "workspaces", workspaceId);
    mkdirSync(workspaceRoot, { recursive: true });
    writeFileSync(join(workspaceRoot, "index.md"), "---\ndisplayName: 'nope\n---\n", "utf8");

    const result = regenerateIndex(workspaceRoot, {
      vaultRoot,
      identity: { workspaceId, displayName: "Fresh" },
    });

    expect(result.content).toContain("displayName: Fresh");
  });

  test("the generated frontmatter records the folder path relative to the vault root", () => {
    const result = regenerateIndex(folder, { vaultRoot });

    expect(result.content).toContain("type: index");
    expect(result.content).toContain("generated: claude-command-center");
    expect(result.content).toContain("folder: global/wiki");
  });
});

describe("writeNote integration", () => {
  test("a written note is already listed in its own folder's index", () => {
    const workspaceId = newWorkspaceId();
    const wiki = join(vaultRoot, "workspaces", workspaceId, "wiki");
    mkdirSync(wiki, { recursive: true });

    const written = writeNote({
      vaultRoot,
      relativePath: join("workspaces", workspaceId, "wiki", "fresh.md"),
      body: "# Fresh\n\nWritten through the real write path.\n",
      scope: workspaceScope(workspaceId),
      stage: "wiki",
      generatedBy: { automation: "index-integration" },
      aiGenerated: false,
      confidence: "unverified",
    });

    // No explicit regenerateIndex call here on purpose: the point is that
    // the WRITE PATH leaves the index fresh, not that a caller can
    // remember to refresh it.
    const content = readFileSync(join(wiki, "index.md"), "utf8");
    const rows = content.split("\n").filter((line) => line.startsWith(ROW_MARKER));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain(written.noteId);
    expect(rows[0]).toContain("[[fresh]]");
    // The returned shape is unchanged by the wiring — plan 02-04's cache
    // consumer depends on it.
    expect(written.path).toBe(join(wiki, "fresh.md"));
    expect(written.frontmatter.id).toBe(written.noteId);
  });
});
