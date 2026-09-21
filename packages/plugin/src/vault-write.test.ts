import { beforeEach, describe, expect, it } from "vitest";
import { FakeVault } from "./test-support/fake-obsidian-host.js";
import { applyConflictSafeUpdate } from "./vault-write.js";

const NOTE_PATH = "workspaces/mfz0a1b2c3d4e5f6g7h8i9j0k/wiki/note.md";

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
