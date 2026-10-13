import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../repo-paths.js";
import * as copy from "./cross-copy.js";

describe("the literal mirror (Test 4)", () => {
  it("fills the synthetic markers, the notification title and the decision labels", () => {
    expect(copy.SYNTHETIC_MARKERS).toEqual(["Test approval", "Live check"]);
    expect(copy.NOTIFICATION_TITLE).toBe("Approval needed");
    expect(copy.DENY_LABEL).toBe("Deny");
    expect(copy.APPROVE_LABEL).toBe("Approve once");
  });

  it("lists the always-allow phrases the walk scans for", () => {
    expect([...copy.ALWAYS_ALLOW_PHRASES].sort()).toEqual(
      ["allow all", "always", "remember", "skip", "trust"].sort(),
    );
  });

  it("finds every product-owned literal, quoted, in the file that owns it", () => {
    expect(copy.OWNED_LITERALS.length).toBeGreaterThan(5);
    for (const entry of copy.OWNED_LITERALS) {
      const source = readFileSync(join(REPO_ROOT, entry.file), "utf8");
      expect(source, `${entry.name} in ${entry.file}`).toContain(
        entry.prefix === true
          ? JSON.stringify(entry.value).slice(0, -1)
          : JSON.stringify(entry.value),
      );
    }
  });

  it("keeps each plain export equal to its table entry", () => {
    const table = new Map(copy.OWNED_LITERALS.map((entry) => [entry.name, entry.value]));
    const exported: Record<string, unknown> = { ...copy };
    for (const name of [
      "NOTIFICATION_TITLE",
      "DENY_LABEL",
      "APPROVE_LABEL",
      "DECISION_GROUP_LABEL",
      "FILTER_GROUP_LABEL",
      "AWAITING_EXIT_SENTENCE",
      "SEND_TEST_APPROVAL_NAME",
      "APPROVALS_GROUP_HEADING",
      "TASKS_GROUP_HEADING",
      "MARK_DONE_LABEL",
      "TASK_FILTERS_LABEL",
      "SETUP_CONFIRM_LABEL",
    ]) {
      expect(exported[name], name).toBe(table.get(name));
    }
    expect(copy.FAILED_REASON_LABELS).toEqual([
      table.get("FAILED_REASON_ENDED"),
      table.get("FAILED_REASON_UNLISTED"),
      table.get("FAILED_REASON_MISMATCH"),
      table.get("FAILED_REASON_OTHER"),
    ]);
    expect(copy.SYNTHETIC_MARKERS).toEqual([
      table.get("MARKER_TEST_APPROVAL"),
      table.get("MARKER_LIVE_CHECK"),
    ]);
  });

  it("owns the mirrored names it claims, once each, and names the spec-owned ones", () => {
    const names = copy.OWNED_LITERALS.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
    for (const required of ["NOTIFICATION_TITLE", "DENY_LABEL", "APPROVE_LABEL"]) {
      expect(names).toContain(required);
    }
    expect(copy.SPEC_OWNED_NAMES).toContain("SYNTHETIC_MARKERS");
    expect(copy.SPEC_OWNED_NAMES).toContain("ALWAYS_ALLOW_PHRASES");
  });
});
