import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type AuditRowLike,
  type ChipStep,
  checkChipTranscript,
  checkDeniedAudit,
  containsInOrder,
  expiredWithinBound,
  readScheduledPress,
  scheduleDecisionClick,
  findNewestMirrorNote,
  findNewNotification,
  isExactlyOneNavigation,
  parseCountChip,
  parseRebuildStatus,
  settledWithinGrace,
  squashDeep,
} from "./approvals-support.js";

const requested: AuditRowLike = { seq: 1, event: "requested", decided_via: null, detail: null };
const denied: AuditRowLike = { seq: 2, event: "denied", decided_via: "plugin", detail: null };

describe("checkDeniedAudit (Test 2)", () => {
  it("accepts a newest-first denied then requested with decided_via on the denied row only", () => {
    expect(checkDeniedAudit([denied, requested], 0)).toEqual([]);
  });

  it("accepts an older, unrelated row below the two newest ones", () => {
    const older: AuditRowLike = { seq: 0, event: "denied", decided_via: "plugin", detail: null };
    expect(checkDeniedAudit([denied, requested, older], 0)).toEqual([]);
  });

  it("rejects decided_via on the requested row", () => {
    const bad = { ...requested, decided_via: "plugin" };
    expect(checkDeniedAudit([denied, bad], 0).length).toBeGreaterThan(0);
  });

  it("rejects a denied row with decided_via missing or empty", () => {
    expect(checkDeniedAudit([{ ...denied, decided_via: null }, requested], 0).length).toBe(1);
    expect(checkDeniedAudit([{ ...denied, decided_via: "" }, requested], 0).length).toBe(1);
  });

  it("rejects a third row that is an effect", () => {
    const effect: AuditRowLike = { seq: 0, event: "executed", decided_via: null, detail: null };
    expect(checkDeniedAudit([denied, requested, effect], 0).length).toBeGreaterThan(0);
  });

  it("rejects a non-zero effect count", () => {
    expect(checkDeniedAudit([denied, requested], 1).length).toBeGreaterThan(0);
  });

  it("rejects fewer than two rows and a wrong order", () => {
    expect(checkDeniedAudit([denied], 0).length).toBeGreaterThan(0);
    expect(checkDeniedAudit([], 0).length).toBeGreaterThan(0);
    expect(checkDeniedAudit([requested, denied], 0).length).toBeGreaterThan(0);
  });
});

describe("containsInOrder (Test 3)", () => {
  it("is true when the expected strings occur in order, other entries between them allowed", () => {
    expect(containsInOrder(["Requested", "Approved", "Denied"], ["Requested", "Denied"])).toBe(
      true,
    );
    expect(containsInOrder(["a", "b"], ["a", "b"])).toBe(true);
    expect(containsInOrder(["a"], [])).toBe(true);
  });

  it("is false for a missing or reordered entry", () => {
    expect(containsInOrder(["Requested"], ["Requested", "Denied"])).toBe(false);
    expect(containsInOrder(["Denied", "Requested"], ["Requested", "Denied"])).toBe(false);
    expect(containsInOrder([], ["Requested"])).toBe(false);
  });
});

describe("squashDeep (Task 2 Test 2)", () => {
  it("collapses whitespace in every string, keys included, and leaves other values alone", () => {
    expect(
      squashDeep({ " a  b ": ["  x \n y ", 3, true, null], nested: { text: "\t t " } }),
    ).toEqual({ "a b": ["x y", 3, true, null], nested: { text: "t" } });
  });
});

describe("isExactlyOneNavigation (Task 2 Test 2)", () => {
  const view = "claude-command-center-view";

  it("is true for one activation of the command center and one leaf", () => {
    expect(isExactlyOneNavigation([{ viewType: view }], view, 1)).toBe(true);
  });

  it("ignores activations of other views", () => {
    expect(isExactlyOneNavigation([{ viewType: "empty" }, { viewType: view }], view, 1)).toBe(true);
  });

  it("is false for none, for a duplicate, for a second leaf and for another view only", () => {
    expect(isExactlyOneNavigation([], view, 1)).toBe(false);
    expect(isExactlyOneNavigation([{ viewType: view }, { viewType: view }], view, 1)).toBe(false);
    expect(isExactlyOneNavigation([{ viewType: view }], view, 2)).toBe(false);
    expect(isExactlyOneNavigation([{ viewType: "empty" }], view, 1)).toBe(false);
  });
});

describe("checkChipTranscript (Task 2 Test 2)", () => {
  const expected = [
    { key: "Tab", focused: "Pending", pressed: "Pending" },
    { key: "Tab", focused: "Decided", pressed: "Pending" },
    { key: "Enter", focused: "Decided", pressed: "Decided" },
  ];
  const good: ChipStep[] = [
    { key: "Tab", focused: "Pending, 1 request", pressed: "Pending, 1 request" },
    { key: "Tab", focused: "Decided, 0 requests", pressed: "Pending, 1 request" },
    { key: "Enter", focused: "Decided, 0 requests", pressed: "Decided, 0 requests" },
  ];

  it("accepts the expected focus order, pressed chip and announced counts", () => {
    expect(checkChipTranscript(good, expected)).toEqual([]);
  });

  it("rejects a wrong focus order, a wrong pressed chip and a different length", () => {
    const wrongFocus = good.map((step, index) =>
      index === 1 ? { ...step, focused: "Expired, 0 requests" } : step,
    );
    expect(checkChipTranscript(wrongFocus, expected).length).toBeGreaterThan(0);
    const wrongPressed = good.map((step, index) =>
      index === 2 ? { ...step, pressed: "Pending, 1 request" } : step,
    );
    expect(checkChipTranscript(wrongPressed, expected).length).toBeGreaterThan(0);
    expect(checkChipTranscript(good.slice(0, 2), expected).length).toBeGreaterThan(0);
  });

  it("rejects a focused chip whose announced name carries no count", () => {
    const bare = good.map((step, index) => (index === 0 ? { ...step, focused: "Pending" } : step));
    expect(checkChipTranscript(bare, expected).length).toBeGreaterThan(0);
  });
});

describe("findNewestMirrorNote (Task 2 Test 2)", () => {
  const link = (id: string) => `Open it: obsidian://ccc-approval?id=${id}&vault=Name`;
  const files = [
    { name: "old.md", mtimeMs: 1, content: link("AAAAAAAAAAAAAAAAAAAAAAAAA") },
    { name: "new.md", mtimeMs: 5, content: link("AAAAAAAAAAAAAAAAAAAAAAAAA") },
    { name: "other.md", mtimeMs: 9, content: link("BBBBBBBBBBBBBBBBBBBBBBBBB") },
  ];

  it("returns the newest note holding the link for that id", () => {
    expect(findNewestMirrorNote(files, "AAAAAAAAAAAAAAAAAAAAAAAAA")).toBe("new.md");
  });

  it("returns null when no note links that id, and never matches a longer id by prefix", () => {
    expect(findNewestMirrorNote(files, "CCCCCCCCCCCCCCCCCCCCCCCCC")).toBeNull();
    const longer = [{ name: "x.md", mtimeMs: 1, content: link("AAAAAAAAAAAAAAAAAAAAAAAAAB") }];
    expect(findNewestMirrorNote(longer, "AAAAAAAAAAAAAAAAAAAAAAAAA")).toBeNull();
  });
});

describe("parseRebuildStatus (Task 3 Test 2)", () => {
  it("recognises the rebuilding status", () => {
    expect(parseRebuildStatus("Rebuilding the task index…")).toEqual({ phase: "rebuilding" });
  });

  it("reads the rebuilt status with and without the attention suffix", () => {
    expect(parseRebuildStatus("Task index rebuilt. 302 tasks found.")).toEqual({
      phase: "rebuilt",
      tasks: 302,
      attention: 0,
    });
    expect(
      parseRebuildStatus("Task index rebuilt. 302 tasks found. 2 notes need attention."),
    ).toEqual({ phase: "rebuilt", tasks: 302, attention: 2 });
  });

  it("reads the singular forms", () => {
    expect(parseRebuildStatus("Task index rebuilt. 1 task found. 1 note needs attention.")).toEqual(
      {
        phase: "rebuilt",
        tasks: 1,
        attention: 1,
      },
    );
  });

  it("returns null for any other text", () => {
    expect(parseRebuildStatus("Couldn't rebuild the task index.")).toBeNull();
    expect(parseRebuildStatus("Task index rebuilt. many tasks found.")).toBeNull();
    expect(parseRebuildStatus("")).toBeNull();
  });
});

describe("settledWithinGrace (Task 3 Test 2)", () => {
  it("is true when the change was seen after the countdown reached zero and within the grace", () => {
    expect(settledWithinGrace(1_000, 1_000, 3_000)).toBe(true);
    expect(settledWithinGrace(1_000, 3_900, 3_000)).toBe(true);
    expect(settledWithinGrace(1_000, 4_000, 3_000)).toBe(true);
  });

  it("is false when it was seen before zero or after the grace", () => {
    expect(settledWithinGrace(1_000, 999, 3_000)).toBe(false);
    expect(settledWithinGrace(1_000, 4_001, 3_000)).toBe(false);
  });
});

describe("findNewNotification and parseCountChip (Task 2 Test 2)", () => {
  const records = [
    { title: "Approval needed" },
    { title: "Something else" },
    { title: "Approval needed" },
  ];

  it("finds the first matching notification at or after an index", () => {
    expect(findNewNotification(records, 0, "Approval needed")).toBe(0);
    expect(findNewNotification(records, 1, "Approval needed")).toBe(2);
    expect(findNewNotification(records, 3, "Approval needed")).toBe(-1);
  });

  it("reads the visible count chip, including the capped form", () => {
    expect(parseCountChip("1")).toEqual({ count: 1, capped: false });
    expect(parseCountChip("9+")).toEqual({ count: 9, capped: true });
    expect(parseCountChip("")).toBeNull();
    expect(parseCountChip("many")).toBeNull();
  });
});

describe("expiry timing (Wave 3 WR-08)", () => {
  it("expiredWithinBound uses the UAT bound of one second on the audit timestamp", () => {
    const expiresAt = Date.parse("2026-10-12T10:00:15.000Z");
    expect(expiredWithinBound(expiresAt, "2026-10-12T10:00:15.400Z")).toBe(true);
    expect(expiredWithinBound(expiresAt, "2026-10-12T10:00:16.000Z")).toBe(true);
    expect(expiredWithinBound(expiresAt, "2026-10-12T10:00:16.100Z")).toBe(false);
    expect(expiredWithinBound(expiresAt, "2026-10-12T10:00:14.900Z")).toBe(false);
    expect(expiredWithinBound(expiresAt, undefined)).toBe(false);
    expect(expiredWithinBound(expiresAt, "not a date")).toBe(false);
  });

  describe("scheduleDecisionClick reports what the press did", () => {
    afterEach(() => {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    });

    function setup(present: () => boolean) {
      vi.useFakeTimers();
      const clicks: string[] = [];
      vi.stubGlobal("window", {});
      vi.stubGlobal("document", {
        querySelector: () => (present() ? { click: () => clicks.push("click") } : null),
      });
      return clicks;
    }

    it("is 'no-button' when the button disappeared before the timer fired", () => {
      let present = true;
      const clicks = setup(() => present);
      expect(scheduleDecisionClick("deny", Date.now() + 50)).toBe(true);
      present = false;
      vi.advanceTimersByTime(100);
      expect(readScheduledPress()).toBe("no-button");
      expect(clicks).toEqual([]);
    });

    it("is 'clicked' when the button was still there", () => {
      const clicks = setup(() => true);
      scheduleDecisionClick("deny", Date.now() + 50);
      expect(readScheduledPress()).toBe("pending");
      vi.advanceTimersByTime(100);
      expect(readScheduledPress()).toBe("clicked");
      expect(clicks).toEqual(["click"]);
    });
  });
});
