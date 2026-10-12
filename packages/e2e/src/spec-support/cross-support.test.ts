import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  allMotionOff,
  anyMotionOn,
  checkFocusOrder,
  checkPluginDataKeys,
  countOccurrences,
  diffFileHashes,
  diffNewDescendants,
  firstFocusInRequestIsDeny,
  focusRingVisible,
  motionAnnouncementPresent,
  readLookPending,
  recordLookPending,
  scanForAlwaysAllow,
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
    const problems = checkPluginDataKeys(
      { ...good, lastOpenedDestination: hidden },
      { socketPath },
    );
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

describe("scanForAlwaysAllow (Task 2, Test 1)", () => {
  it("returns the offending phrase and its source for each whole-word hit, in any case", () => {
    const hits = scanForAlwaysAllow([
      { label: "pane", text: "Deny. Approve once." },
      { label: "settings", text: "REMEMBER my choice and Always allow it" },
      { label: "mirror", text: "Please allow all requests, then skip the rest and Trust them" },
    ]);
    expect(hits.map((hit) => `${hit.source}:${hit.phrase}`).sort()).toEqual([
      "mirror:allow all",
      "mirror:skip",
      "mirror:trust",
      "settings:always",
      "settings:remember",
    ]);
  });

  it("returns nothing for the plugin's real approval wording", () => {
    const real = [
      "Nothing needs your decision right now.",
      "When a skill, automation or the dashboard asks to do something consequential, it appears here first.",
      "Show a macOS notification when a new approval request arrives while Obsidian isn't focused. It shows a generic message and can't approve anything.",
      "Creates a request that does nothing when approved. It arrives after 5 seconds.",
      "If you don't decide, it's denied automatically.",
      "Approved. Carrying out the action…",
      "Provided by Skill: Diagnostics",
    ];
    expect(scanForAlwaysAllow(real.map((text, i) => ({ label: `t${i}`, text })))).toEqual([]);
  });

  it("does not flag a word that merely contains a phrase", () => {
    const text = "untrusted input, a skipper, remembered, alwaysOn";
    expect(scanForAlwaysAllow([{ label: "x", text }])).toEqual([]);
  });
});

describe("motion verdict helpers (Task 2, Test 2)", () => {
  const off = { transitionDuration: "0s", animationDuration: "0s", animationName: "none" };

  it("allMotionOff is true only when every duration computes to zero", () => {
    expect(allMotionOff([off, { ...off, transitionDuration: "0s, 0s, 0ms" }])).toBe(true);
    expect(allMotionOff([off, { ...off, transitionDuration: "0.12s" }])).toBe(false);
    expect(allMotionOff([off, { ...off, transitionDuration: "0s, 120ms" }])).toBe(false);
    expect(allMotionOff([off, { ...off, animationDuration: "4s", animationName: "twinkle" }])).toBe(
      false,
    );
  });

  it("treats a positive animation duration with the name none as off", () => {
    expect(allMotionOff([{ ...off, animationDuration: "4s", animationName: "none" }])).toBe(true);
  });

  it("refuses an empty sample (a vacuous pass)", () => {
    expect(allMotionOff([])).toBe(false);
    expect(anyMotionOn([])).toBe(false);
  });

  it("anyMotionOn detects a positive transition or a named animation", () => {
    expect(anyMotionOn([off])).toBe(false);
    expect(anyMotionOn([off, { ...off, transitionDuration: "400ms" }])).toBe(true);
    expect(anyMotionOn([{ ...off, animationDuration: "4s", animationName: "twinkle" }])).toBe(true);
  });

  it("motionAnnouncementPresent requires non-empty polite text", () => {
    expect(motionAnnouncementPresent("A new request needs your decision.")).toBe(true);
    expect(motionAnnouncementPresent("   ")).toBe(false);
    expect(motionAnnouncementPresent("")).toBe(false);
  });
});

describe("focus helpers (Task 2, Test 3)", () => {
  it("passes when the expected names occur in order in the recorded sequence", () => {
    const recorded = [
      "Pending, 1",
      "Show Decided",
      "Scrim",
      "Deny: A title",
      "Approve once: Do it",
    ];
    expect(checkFocusOrder(recorded, ["Pending", "Deny", "Approve once"]).ok).toBe(true);
  });

  it("fails when a name is missing or out of order, with a reason that names the expected one", () => {
    const recorded = ["Approve once: x", "Deny: x"];
    const outcome = checkFocusOrder(recorded, ["Deny", "Approve once"]);
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain("Approve once");
    expect(checkFocusOrder(["a"], ["b"]).ok).toBe(false);
    expect(checkFocusOrder([], ["b"]).ok).toBe(false);
  });

  it("requires the first focused decision control of an opened request to be Deny", () => {
    expect(firstFocusInRequestIsDeny(["Request heading", "Deny: x", "Approve once: x"])).toBe(true);
    expect(firstFocusInRequestIsDeny(["Approve once: x", "Deny: x"])).toBe(false);
    expect(firstFocusInRequestIsDeny(["Request heading"])).toBe(false);
  });

  it("focusRingVisible needs a drawn outline or a box shadow", () => {
    expect(
      focusRingVisible({ outlineStyle: "solid", outlineWidth: "2px", boxShadow: "none" }),
    ).toBe(true);
    expect(
      focusRingVisible({
        outlineStyle: "none",
        outlineWidth: "0px",
        boxShadow: "rgb(1, 2, 3) 0px 0px 0px 2px",
      }),
    ).toBe(true);
    expect(focusRingVisible({ outlineStyle: "none", outlineWidth: "3px", boxShadow: "none" })).toBe(
      false,
    );
    expect(
      focusRingVisible({ outlineStyle: "solid", outlineWidth: "0px", boxShadow: "none" }),
    ).toBe(false);
  });
});

describe("diff helpers (Task 2, Test 4)", () => {
  it("diffFileHashes reports changed, added and removed paths and ignores .obsidian", () => {
    const before = { "a.md": "1", "b.md": "2", ".obsidian/workspace.json": "x", "c.md": "3" };
    const after = { "a.md": "1", "b.md": "9", ".obsidian/workspace.json": "y", "d.md": "4" };
    expect(diffFileHashes(before, after)).toEqual({
      changed: ["b.md"],
      added: ["d.md"],
      removed: ["c.md"],
    });
    expect(diffFileHashes(before, before)).toEqual({ changed: [], added: [], removed: [] });
  });

  const node = (pid: number, ppid: number, command: string) => ({ pid, ppid, command });

  it("diffNewDescendants finds only new processes under the given ancestors", () => {
    const before = [node(10, 1, "svc"), node(20, 1, "obsidian")];
    const after = [
      ...before,
      node(11, 10, "osascript -e x"),
      node(12, 11, "grandchild"),
      node(30, 1, "unrelated new"),
    ];
    expect(diffNewDescendants(before, after, [10]).map((n) => n.pid)).toEqual([11, 12]);
    expect(diffNewDescendants(before, after, [20])).toEqual([]);
  });

  it("ignores Electron helper processes of the sandbox Obsidian", () => {
    const before = [node(20, 1, "Obsidian")];
    const after = [
      ...before,
      node(21, 20, "Obsidian Helper (Renderer) --type=renderer"),
      node(22, 20, "Obsidian Helper --type=utility"),
      node(23, 20, "/usr/bin/open -a Terminal"),
    ];
    expect(diffNewDescendants(before, after, [20]).map((n) => n.pid)).toEqual([23]);
  });
});
