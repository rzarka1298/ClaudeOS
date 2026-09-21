import { NOTE_FRONTMATTER_KEY_ORDER, type NoteFrontmatter } from "@ccc/domain";
import { beforeEach, describe, expect, it } from "vitest";
import { FakeVault } from "./test-support/fake-obsidian-host.js";
import { applyConflictSafeUpdate, updateNoteProvenance } from "./vault-write.js";

const NOTE_PATH = "workspaces/mfz0a1b2c3d4e5f6g7h8i9j0k/wiki/note.md";
const INDEX_PATH = "workspaces/mfz0a1b2c3d4e5f6g7h8i9j0k/wiki/index.md";

const ORIGINAL = "---\nid: n1\n---\noriginal body\n";
/** What the user typed into the open editor pane while an update was in flight. */
const EXTERNAL_EDIT = "---\nid: n1\n---\noriginal body plus the user's own sentence\n";

describe("applyConflictSafeUpdate", () => {
  let vault: FakeVault;

  beforeEach(() => {
    vault = new FakeVault({ [NOTE_PATH]: ORIGINAL });
  });

  it("persists the transform's output and reports applied when the file is unchanged since the caller's read", async () => {
    const result = await applyConflictSafeUpdate(
      vault,
      vault.file(NOTE_PATH),
      ORIGINAL,
      (current) => current.replace("original body", "rewritten body"),
    );

    expect(result).toBe("applied");
    expect(vault.read(NOTE_PATH)).toBe("---\nid: n1\n---\nrewritten body\n");
  });

  it("leaves an externally edited file byte-for-byte untouched and reports conflict", async () => {
    vault.setExternally(NOTE_PATH, EXTERNAL_EDIT);

    const result = await applyConflictSafeUpdate(vault, vault.file(NOTE_PATH), ORIGINAL, () => {
      throw new Error("the transform must never run against content the caller did not read");
    });

    expect(result).toBe("conflict");
    expect(
      Buffer.compare(
        Buffer.from(vault.read(NOTE_PATH), "utf8"),
        Buffer.from(EXTERNAL_EDIT, "utf8"),
      ),
    ).toBe(0);
  });

  it("calls process exactly once per invocation, so a conflict is never silently retried", async () => {
    await applyConflictSafeUpdate(vault, vault.file(NOTE_PATH), ORIGINAL, (c) => `${c}x`);
    expect(vault.processCallCount).toBe(1);

    vault.setExternally(NOTE_PATH, EXTERNAL_EDIT);
    await applyConflictSafeUpdate(vault, vault.file(NOTE_PATH), ORIGINAL, (c) => c);
    expect(vault.processCallCount).toBe(2);
  });

  it("types the transform as synchronous, so an async transform is rejected at compile time", () => {
    type Transform = Parameters<typeof applyConflictSafeUpdate>[3];
    // Both aliases resolve to `true` only while the declared transform
    // returns a plain string. Make the parameter async and `tsc -b` fails on
    // the two assignments below -- which is the actual assertion here; the
    // runtime `expect` exists so the proof shows up in the test report too.
    type ReturnsPlainString = ReturnType<Transform> extends string ? true : false;
    type RejectsAsyncTransform = ((current: string) => Promise<string>) extends Transform
      ? false
      : true;

    const returnsPlainString: ReturnsPlainString = true;
    const rejectsAsyncTransform: RejectsAsyncTransform = true;

    expect(returnsPlainString && rejectsAsyncTransform).toBe(true);
  });
});

/**
 * Captured verbatim from `@ccc/vault-repo`'s `stringifyNote()` -- the
 * service-side writer -- run against the frontmatter reconstructed in
 * {@link SERVICE_FRONTMATTER} below. It is a golden fixture rather than a
 * live import because the import-boundary map forbids `@ccc/plugin` from
 * importing `@ccc/vault-repo`: these two writers must agree on bytes
 * precisely BECAUSE they can never share code.
 */
const SERVICE_SERIALIZED_NOTE = [
  "---",
  "id: mfz0a1b2c3d4e5f6g7h8i9j0k",
  "scope: 'workspace:mfz0a1b2c3d4e5f6g7h8i9j0k'",
  "stage: wiki",
  "created: '2026-01-02T03:04:05.000Z'",
  "updated: '2026-01-02T03:04:05.000Z'",
  "generatedBy:",
  "  model: claude-opus-5",
  "  skill: research",
  "  automation: daily-brief",
  "  runId: run-123",
  "aiGenerated: true",
  "claimType: summary",
  "sources:",
  "  - 'note:abc'",
  "  - 'https://example.com/a'",
  "confidence: inferred",
  "lastReviewed: null",
  "contentHash: 9f2c",
  "---",
  "# Heading",
  "",
  "Body line one.",
  "",
  "- bullet",
  "",
].join("\n");

/** The same note's frontmatter as an object, for mutations to rebuild from. */
const SERVICE_FRONTMATTER: NoteFrontmatter = {
  id: "mfz0a1b2c3d4e5f6g7h8i9j0k",
  scope: "workspace:mfz0a1b2c3d4e5f6g7h8i9j0k",
  stage: "wiki",
  created: "2026-01-02T03:04:05.000Z",
  updated: "2026-01-02T03:04:05.000Z",
  generatedBy: {
    model: "claude-opus-5",
    skill: "research",
    automation: "daily-brief",
    runId: "run-123",
  },
  aiGenerated: true,
  claimType: "summary",
  sources: ["note:abc", "https://example.com/a"],
  confidence: "inferred",
  lastReviewed: null,
  contentHash: "9f2c",
};

/** The top-level frontmatter keys of `note`, in the order they appear on disk. */
function frontmatterKeyOrder(note: string): string[] {
  const block = /^---\n([\s\S]*?)\n---\n/.exec(note);
  if (!block?.[1]) return [];
  return [...block[1].matchAll(/^([A-Za-z][A-Za-z0-9]*):/gm)].map((m) => m[1] as string);
}

describe("updateNoteProvenance", () => {
  let vault: FakeVault;

  beforeEach(() => {
    vault = new FakeVault({
      [NOTE_PATH]: SERVICE_SERIALIZED_NOTE,
      [INDEX_PATH]: "---\nkind: index\n---\n| id | updated |\n",
    });
  });

  it("re-serializes a service-written note byte-for-byte under an identity mutation", async () => {
    const result = await updateNoteProvenance(
      vault,
      vault.file(NOTE_PATH),
      SERVICE_SERIALIZED_NOTE,
      (current) => current,
    );

    expect(result).toBe("applied");
    expect(
      Buffer.compare(
        Buffer.from(vault.read(NOTE_PATH), "utf8"),
        Buffer.from(SERVICE_SERIALIZED_NOTE, "utf8"),
      ),
    ).toBe(0);
  });

  it("emits keys in NOTE_FRONTMATTER_KEY_ORDER even when the mutation returns them permuted", async () => {
    // Every key present, rebuilt in reverse -- including the nested
    // generatedBy map. Insertion order here must not survive to disk.
    const permuted: NoteFrontmatter = {
      contentHash: SERVICE_FRONTMATTER.contentHash,
      lastReviewed: SERVICE_FRONTMATTER.lastReviewed,
      confidence: SERVICE_FRONTMATTER.confidence,
      sources: SERVICE_FRONTMATTER.sources,
      claimType: SERVICE_FRONTMATTER.claimType,
      aiGenerated: SERVICE_FRONTMATTER.aiGenerated,
      generatedBy: {
        runId: "run-123",
        automation: "daily-brief",
        skill: "research",
        model: "claude-opus-5",
      },
      updated: SERVICE_FRONTMATTER.updated,
      created: SERVICE_FRONTMATTER.created,
      stage: SERVICE_FRONTMATTER.stage,
      scope: SERVICE_FRONTMATTER.scope,
      id: SERVICE_FRONTMATTER.id,
    };

    const result = await updateNoteProvenance(
      vault,
      vault.file(NOTE_PATH),
      SERVICE_SERIALIZED_NOTE,
      () => permuted,
    );

    expect(result).toBe("applied");
    expect(frontmatterKeyOrder(vault.read(NOTE_PATH))).toEqual([...NOTE_FRONTMATTER_KEY_ORDER]);
    expect(
      Buffer.compare(
        Buffer.from(vault.read(NOTE_PATH), "utf8"),
        Buffer.from(SERVICE_SERIALIZED_NOTE, "utf8"),
      ),
    ).toBe(0);
  });

  it("changes exactly one frontmatter line and no body line when the mutation bumps updated", async () => {
    await updateNoteProvenance(
      vault,
      vault.file(NOTE_PATH),
      SERVICE_SERIALIZED_NOTE,
      (current) => ({
        ...current,
        updated: "2026-03-04T05:06:07.000Z",
      }),
    );

    const before = SERVICE_SERIALIZED_NOTE.split("\n");
    const after = vault.read(NOTE_PATH).split("\n");
    expect(after).toHaveLength(before.length);

    const changed = before.flatMap((line, i) => (line === after[i] ? [] : [i]));
    expect(changed).toHaveLength(1);

    const closingDelimiter = before.indexOf("---", 1);
    expect(changed[0]).toBeLessThan(closingDelimiter);
    expect(after[changed[0] as number]).toBe("updated: '2026-03-04T05:06:07.000Z'");
  });

  it("writes exactly one file, the note itself, and never a folder index", async () => {
    await updateNoteProvenance(
      vault,
      vault.file(NOTE_PATH),
      SERVICE_SERIALIZED_NOTE,
      (current) => ({
        ...current,
        lastReviewed: "2026-03-04T05:06:07.000Z",
      }),
    );

    expect(vault.writtenPaths).toEqual([NOTE_PATH]);
    expect(vault.writtenPaths.some((p) => p.endsWith("index.md"))).toBe(false);
    expect(vault.read(INDEX_PATH)).toBe("---\nkind: index\n---\n| id | updated |\n");
  });

  it("preserves user-authored frontmatter keys the provenance schema does not own", async () => {
    // `NoteFrontmatterSchema` is a plain `z.object`, so zod strips unknown
    // keys -- and rebuilding the block from the stripped value would DELETE
    // them. In an Obsidian vault these are not exotic: `tags`, `aliases`
    // and `cssclasses` drive search, graph and theming, and their loss
    // would be silent, permanent, and invisible until the user went looking.
    const withUserKeys = SERVICE_SERIALIZED_NOTE.replace(
      "contentHash: 9f2c\n---",
      [
        "contentHash: 9f2c",
        "tags:",
        "  - research",
        "  - obsidian",
        "aliases:",
        "  - The Note",
        "cssclasses: wide-table",
        "dataviewField: 42",
        "---",
      ].join("\n"),
    );
    vault.setExternally(NOTE_PATH, withUserKeys);

    const result = await updateNoteProvenance(
      vault,
      vault.file(NOTE_PATH),
      withUserKeys,
      (current) => ({ ...current, updated: "2026-03-04T05:06:07.000Z" }),
    );

    expect(result).toBe("applied");
    const after = vault.read(NOTE_PATH);
    // The managed keys still lead, in canonical order, with the user's own
    // keys following in the order they were read.
    expect(frontmatterKeyOrder(after)).toEqual([
      ...NOTE_FRONTMATTER_KEY_ORDER,
      "tags",
      "aliases",
      "cssclasses",
      "dataviewField",
    ]);
    expect(after).toContain("- research");
    expect(after).toContain("- obsidian");
    expect(after).toContain("- The Note");
    expect(after).toContain("cssclasses: wide-table");
    expect(after).toContain("dataviewField: 42");
    // The one provenance line the mutation asked for is the only managed
    // change, and the body is untouched.
    expect(after).toContain("updated: '2026-03-04T05:06:07.000Z'");
    expect(after.endsWith("# Heading\n\nBody line one.\n\n- bullet\n")).toBe(true);
  });

  it("reports conflict without ever invoking the mutation when the note changed since the caller's read", async () => {
    const edited = SERVICE_SERIALIZED_NOTE.replace("Body line one.", "Body line one, still typing");
    vault.setExternally(NOTE_PATH, edited);

    const result = await updateNoteProvenance(
      vault,
      vault.file(NOTE_PATH),
      SERVICE_SERIALIZED_NOTE,
      () => {
        throw new Error("the mutation must never run against content the caller did not read");
      },
    );

    expect(result).toBe("conflict");
    expect(
      Buffer.compare(Buffer.from(vault.read(NOTE_PATH), "utf8"), Buffer.from(edited, "utf8")),
    ).toBe(0);
  });
});
