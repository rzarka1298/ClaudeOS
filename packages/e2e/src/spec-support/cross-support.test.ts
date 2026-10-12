import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkPluginDataKeys,
  countOccurrences,
  readLookPending,
  recordLookPending,
} from "./cross-support.js";

describe("countOccurrences (Test 1)", () => {
  it("counts non-overlapping, case-sensitive occurrences", () => {
    expect(countOccurrences("aaaa", "aa")).toBe(2);
    expect(countOccurrences("Test approval and test approval", "Test approval")).toBe(1);
    expect(countOccurrences("nothing here", "Live check")).toBe(0);
  });

  it("returns 0 for an empty haystack and throws for an empty needle", () => {
    expect(countOccurrences("", "x")).toBe(0);
    expect(() => countOccurrences("abc", "")).toThrow();
  });
});

describe("checkPluginDataKeys (Test 2)", () => {
  const socketPath = "/tmp/ccc-uat.abc123/rt/svc.sock";
  const good = {
    socketPathOverride: socketPath,
    lastOpenedDestination: "overview",
    reducedMotion: "auto",
    notifyApprovals: true,
  };

  it("accepts exactly the four settings keys", () => {
    expect(checkPluginDataKeys(good, { socketPath })).toEqual([]);
    expect(checkPluginDataKeys({ ...good, reducedMotion: "reduced" }, { socketPath })).toEqual([]);
  });

  it("rejects an extra key and a missing key", () => {
    expect(checkPluginDataKeys({ ...good, note: "x" }, { socketPath })).toContain("extra-key");
    const { notifyApprovals: _drop, ...rest } = good;
    expect(checkPluginDataKeys(rest, { socketPath })).toContain("missing-key");
  });

  it("rejects request or task text hiding in a value, and never echoes it", () => {
    const hidden = "Test approval: remove the whole project folder please";
    const problems = checkPluginDataKeys({ ...good, lastOpenedDestination: hidden }, { socketPath });
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join(" ")).not.toContain("Test approval");
    expect(
      checkPluginDataKeys({ ...good, socketPathOverride: `${hidden} ${hidden}` }, { socketPath }),
    ).not.toEqual([]);
  });

  it("rejects a non-object and a wrong-typed value", () => {
    expect(checkPluginDataKeys(null, { socketPath })).not.toEqual([]);
    expect(checkPluginDataKeys([], { socketPath })).not.toEqual([]);
    expect(checkPluginDataKeys({ ...good, notifyApprovals: "yes" }, { socketPath })).not.toEqual(
      [],
    );
  });
});

describe("recordLookPending / readLookPending (Test 3)", () => {
  let runRoot: string;
  beforeEach(() => {
    runRoot = mkdtempSync(join(tmpdir(), "cross-look-"));
  });
  afterEach(() => {
    rmSync(runRoot, { recursive: true, force: true });
  });

  it("appends one record per item with labels and a count, in order", () => {
    recordLookPending({ runRoot, item: 12, labels: ["approvals-pane", "settings-approvals"] });
    recordLookPending({ runRoot, item: 20, labels: ["task-detail"] });
    expect(readLookPending(runRoot)).toEqual([
      { item: 12, labels: ["approvals-pane", "settings-approvals"], count: 2 },
      { item: 20, labels: ["task-detail"], count: 1 },
    ]);
  });

  it("is idempotent per item and label and merges new labels", () => {
    recordLookPending({ runRoot, item: 12, labels: ["a-one"] });
    recordLookPending({ runRoot, item: 12, labels: ["a-one"] });
    expect(readLookPending(runRoot)).toEqual([{ item: 12, labels: ["a-one"], count: 1 }]);
    recordLookPending({ runRoot, item: 12, labels: ["a-one", "a-two"] });
    expect(readLookPending(runRoot)).toEqual([{ item: 12, labels: ["a-one", "a-two"], count: 2 }]);
  });

  it("holds labels and counts only, in a private file", () => {
    recordLookPending({ runRoot, item: 22, labels: ["focus-deny"] });
    const file = join(runRoot, "look-pending.jsonl");
    expect(statSync(file).mode & 0o077).toBe(0);
    const text = readFileSync(file, "utf8");
    expect(text).not.toContain("/");
    expect(text).not.toContain(".png");
  });

  it("rejects an item outside 1 to 99, a bad label and an empty label set", () => {
    expect(() => recordLookPending({ runRoot, item: 0, labels: ["ok"] })).toThrow();
    expect(() => recordLookPending({ runRoot, item: 100, labels: ["ok"] })).toThrow();
    expect(() => recordLookPending({ runRoot, item: 1.5, labels: ["ok"] })).toThrow();
    expect(() => recordLookPending({ runRoot, item: 12, labels: ["Bad Label"] })).toThrow();
    expect(() => recordLookPending({ runRoot, item: 12, labels: ["../escape"] })).toThrow();
    expect(() => recordLookPending({ runRoot, item: 12, labels: [] })).toThrow();
  });

  it("reads an absent file as no records and ignores a torn last line", () => {
    expect(readLookPending(runRoot)).toEqual([]);
    writeFileSync(
      join(runRoot, "look-pending.jsonl"),
      `${JSON.stringify({ item: 1, labels: ["x"], count: 1 })}\n{"item":2,`,
    );
    expect(readLookPending(runRoot)).toEqual([{ item: 1, labels: ["x"], count: 1 }]);
  });
});
