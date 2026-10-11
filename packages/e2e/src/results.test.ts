import { describe, expect, it } from "vitest";
import {
  formatResultLine,
  installResultRecorder,
  itemNumberOf,
  type LookVerdict,
  type MochaTestLike,
  parseResultsFile,
  type ResultRecord,
  resolveItemStatus,
  type StatusInput,
} from "./results.js";

function record(title: string, state: ResultRecord["state"], message = ""): ResultRecord {
  return { title, state, durationMs: 12, message };
}

const AUTO: StatusInput = { number: 5, runClass: "auto" };
const LOOK: StatusInput = { number: 1, runClass: "auto+look" };

function resolve(
  item: StatusInput,
  results: ResultRecord[],
  looks: LookVerdict[] = [],
  profile: "standard" | "full" = "standard",
) {
  return resolveItemStatus({ item, results, looks, profile, phasePrefix: "06" });
}

function statusOf(resolution: ReturnType<typeof resolve>): string {
  if (resolution.kind !== "status") throw new Error("expected a status resolution");
  return resolution.status;
}

describe("resolveItemStatus (Test 4)", () => {
  it("is a fail with reason 'no test ran' when no result matches an auto item", () => {
    const resolution = resolve(AUTO, [record("[06-UAT#06] other", "passed")]);
    expect(resolution).toMatchObject({ kind: "status", status: "fail", reason: "no test ran" });
  });

  it("is a pass when every matching test passed", () => {
    const resolution = resolve(AUTO, [
      record("[06-UAT#05] one", "passed"),
      record("[06-UAT#05] two", "passed"),
    ]);
    expect(statusOf(resolution)).toBe("pass");
  });

  it("is a fail when any matching test failed, and carries the message", () => {
    const resolution = resolve(AUTO, [
      record("[06-UAT#05] one", "passed"),
      record("[06-UAT#05] two", "failed", "expected 3 to equal 4"),
    ]);
    expect(resolution).toMatchObject({ status: "fail", message: "expected 3 to equal 4" });
  });

  it("is inconclusive when a matching test was skipped or pending", () => {
    expect(statusOf(resolve(AUTO, [record("[06-UAT#05] one", "skipped")]))).toBe("inconclusive");
    expect(
      statusOf(
        resolve(AUTO, [record("[06-UAT#05] one", "passed"), record("[06-UAT#05] two", "pending")]),
      ),
    ).toBe("inconclusive");
  });

  it("keeps a failure ahead of a skip", () => {
    const resolution = resolve(AUTO, [
      record("[06-UAT#05] one", "skipped"),
      record("[06-UAT#05] two", "failed", "boom"),
    ]);
    expect(statusOf(resolution)).toBe("fail");
  });

  it("holds an auto+look item at 'inconclusive (look pending)' until a verdict exists", () => {
    const passed = [record("[06-UAT#01] banner", "passed")];
    expect(statusOf(resolve(LOOK, passed))).toBe("inconclusive (look pending)");
    expect(statusOf(resolve(LOOK, passed, [{ item: 2, verdict: "pass", images: 1 }]))).toBe(
      "inconclusive (look pending)",
    );
  });

  it("passes an auto+look item only with a pass verdict, and fails on a fail verdict", () => {
    const passed = [record("[06-UAT#01] banner", "passed")];
    expect(statusOf(resolve(LOOK, passed, [{ item: 1, verdict: "pass", images: 2 }]))).toBe("pass");
    expect(statusOf(resolve(LOOK, passed, [{ item: 1, verdict: "fail", images: 2 }]))).toBe("fail");
  });

  it("lets the latest verdict for an item stand", () => {
    const passed = [record("[06-UAT#01] banner", "passed")];
    const looks: LookVerdict[] = [
      { item: 1, verdict: "fail", images: 1 },
      { item: 1, verdict: "pass", images: 1 },
    ];
    expect(statusOf(resolve(LOOK, passed, looks))).toBe("pass");
  });

  it("never lets a pass verdict rescue failed or missing tests", () => {
    const pass: LookVerdict[] = [{ item: 1, verdict: "pass", images: 1 }];
    expect(statusOf(resolve(LOOK, [record("[06-UAT#01] banner", "failed", "x")], pass))).toBe(
      "fail",
    );
    expect(statusOf(resolve(LOOK, [], pass))).toBe("fail");
    expect(statusOf(resolve(LOOK, [record("[06-UAT#01] banner", "skipped")], pass))).toBe(
      "inconclusive",
    );
  });

  it("fails an auto+look item on a fail verdict even when its tests were skipped", () => {
    const looks: LookVerdict[] = [{ item: 1, verdict: "fail", images: 1 }];
    expect(statusOf(resolve(LOOK, [record("[06-UAT#01] banner", "skipped")], looks))).toBe("fail");
  });

  it("is skipped-profile for a full-profile item in the standard profile, and runs in full", () => {
    const item: StatusInput = { number: 21, runClass: "auto", fullProfileOnly: true };
    expect(statusOf(resolve(item, [], [], "standard"))).toBe("skipped-profile");
    expect(statusOf(resolve(item, [], [], "full"))).toBe("fail");
    expect(statusOf(resolve(item, [record("[06-UAT#21] scale", "passed")], [], "full"))).toBe(
      "pass",
    );
  });

  it("gives an owner item no status and returns its matching results as partials", () => {
    const item: StatusInput = { number: 2, runClass: "owner" };
    const resolution = resolve(item, [
      record("[06-UAT#02] handler", "passed"),
      record("[06-UAT#03] other", "failed", "x"),
    ]);
    expect(resolution).toEqual({
      kind: "owner",
      item: 2,
      partials: [record("[06-UAT#02] handler", "passed")],
    });
  });

  it("does not match a longer number by prefix (item 1 is not item 10)", () => {
    const resolution = resolve(LOOK, [record("[06-UAT#10] ten", "passed")]);
    expect(resolution).toMatchObject({ status: "fail", reason: "no test ran" });
  });
});

describe("result file (Test 5)", () => {
  it("round-trips passed, failed and skipped records", () => {
    const records = [
      record("[06-UAT#05] a", "passed"),
      record("[06-UAT#06] b", "failed", "expected 3 to equal 4"),
      record("[06-UAT#07] c", "skipped"),
    ];
    const text = `${records.map(formatResultLine).join("\n")}\n`;
    expect(parseResultsFile(text)).toEqual(records);
  });

  it("writes one JSON object per line with no newline inside", () => {
    const line = formatResultLine(record("[06-UAT#05] a\nb", "failed", "line one\nline two"));
    expect(line).not.toContain("\n");
    expect(JSON.parse(line)).toMatchObject({ state: "failed" });
  });

  it("ignores a torn last line", () => {
    const good = formatResultLine(record("[06-UAT#05] a", "passed"));
    const torn = formatResultLine(record("[06-UAT#06] b", "failed", "x")).slice(0, 20);
    expect(parseResultsFile(`${good}\n${torn}`)).toEqual([record("[06-UAT#05] a", "passed")]);
  });

  it("rejects a torn line that is not last", () => {
    const good = formatResultLine(record("[06-UAT#05] a", "passed"));
    expect(() => parseResultsFile(`{"title":\n${good}\n`)).toThrowError(
      "The results file holds a line that is not a valid test record.",
    );
  });

  it("rejects a line with an unknown state", () => {
    const bad = JSON.stringify({
      title: "[06-UAT#05] a",
      state: "maybe",
      durationMs: 1,
      message: "",
    });
    expect(() => parseResultsFile(`${bad}\n`)).toThrowError(
      "The results file holds a line that is not a valid test record.",
    );
  });

  it("returns nothing for an empty file", () => {
    expect(parseResultsFile("")).toEqual([]);
  });

  it("extracts the item number from a title and returns null without the prefix", () => {
    expect(itemNumberOf("[06-UAT#05] deny", "06")).toBe(5);
    expect(itemNumberOf("[06-UAT#26]", "06")).toBe(26);
    expect(itemNumberOf("[05.2-UAT#07] x", "05.2")).toBe(7);
    expect(itemNumberOf("[06-UAT#5] short", "06")).toBeNull();
    expect(itemNumberOf("deny [06-UAT#05]", "06")).toBeNull();
    expect(itemNumberOf("[07-UAT#05] deny", "06")).toBeNull();
    expect(itemNumberOf("[0X-UAT#05] deny", "06")).toBeNull();
  });
});

describe("installResultRecorder", () => {
  function install(sanitize?: (text: string, options?: { maxLength?: number }) => string) {
    const hooks: Array<(this: { currentTest?: MochaTestLike }) => void> = [];
    const writes: Array<{ path: string; data: string }> = [];
    installResultRecorder({
      afterEach: (hook) => {
        hooks.push(hook);
      },
      resultsPath: "/tmp/results.jsonl",
      append: (path, data) => {
        writes.push({ path, data });
      },
      ...(sanitize === undefined ? {} : { sanitize }),
    });
    return { hooks, writes };
  }

  it("registers one hook and appends a line per finished test", () => {
    const { hooks, writes } = install();
    expect(hooks).toHaveLength(1);
    hooks[0]?.call({ currentTest: { title: "[06-UAT#05] a", state: "passed", duration: 31 } });
    hooks[0]?.call({
      currentTest: { title: "[06-UAT#06] b", state: "failed", err: { message: "boom" } },
    });
    hooks[0]?.call({ currentTest: { title: "[06-UAT#07] c", pending: true } });
    expect(writes.map((write) => write.path)).toEqual(Array(3).fill("/tmp/results.jsonl"));
    const parsed = parseResultsFile(writes.map((write) => write.data).join(""));
    expect(parsed).toEqual([
      { title: "[06-UAT#05] a", state: "passed", durationMs: 31, message: "" },
      { title: "[06-UAT#06] b", state: "failed", durationMs: 0, message: "boom" },
      { title: "[06-UAT#07] c", state: "skipped", durationMs: 0, message: "" },
    ]);
    for (const write of writes) expect(write.data.endsWith("\n")).toBe(true);
  });

  it("records an unknown state as pending, never as passed", () => {
    const { hooks, writes } = install();
    hooks[0]?.call({ currentTest: { title: "[06-UAT#05] a" } });
    expect(parseResultsFile(writes[0]?.data ?? "")[0]?.state).toBe("pending");
  });

  it("does nothing when there is no current test", () => {
    const { hooks, writes } = install();
    hooks[0]?.call({});
    expect(writes).toEqual([]);
  });

  it("passes the failure message through the sanitiser with a length cap", () => {
    const seen: Array<{ text: string; maxLength: number | undefined }> = [];
    const { hooks, writes } = install((text, options) => {
      seen.push({ text, maxLength: options?.maxLength });
      return "[clean]";
    });
    hooks[0]?.call({
      currentTest: { title: "[06-UAT#06] b", state: "failed", err: { message: "raw detail" } },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.text).toBe("raw detail");
    expect(seen[0]?.maxLength).toBeGreaterThan(0);
    expect(parseResultsFile(writes[0]?.data ?? "")[0]?.message).toBe("[clean]");
  });
});
