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
      expect(source, `${entry.name} in ${entry.file}`).toContain(JSON.stringify(entry.value));
    }
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
