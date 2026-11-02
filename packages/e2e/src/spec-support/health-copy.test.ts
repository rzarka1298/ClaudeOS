import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../repo-paths.js";
import {
  HEALTH_ATTRS_TABLE,
  HEALTH_CLASSES,
  HEALTH_CLASSES_TABLE,
  HEALTH_REASON_TABLE,
  HEALTH_REASONS,
  HEALTH_TEXT,
  HEALTH_TEXT_TABLE,
  reasonSentence,
} from "./health-copy.js";
import { findCopyDrift } from "./tasks-copy.js";

/**
 * Copy-drift guard for the health specs (plan 08-20, T-05.2-37 carried forward): every string,
 * class name, attribute and reason sentence the health specs assert is mirrored in health-copy.ts
 * with the plugin module that owns it, and these tests read those modules as text, so a reworded
 * label or reason fails here and not in a live run.
 */

function realSource(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

describe("the mirrored health copy", () => {
  it("every mirrored string appears in the plugin module that owns it", () => {
    expect(Object.keys(HEALTH_TEXT_TABLE).length).toBeGreaterThan(30);
    expect(findCopyDrift(HEALTH_TEXT_TABLE, realSource)).toEqual([]);
  });

  it("every mirrored class name appears in the plugin module that owns it", () => {
    expect(Object.keys(HEALTH_CLASSES_TABLE).length).toBeGreaterThan(15);
    expect(findCopyDrift(HEALTH_CLASSES_TABLE, realSource)).toEqual([]);
  });

  it("every mirrored attribute name appears in the plugin module that owns it", () => {
    expect(findCopyDrift(HEALTH_ATTRS_TABLE, realSource)).toEqual([]);
  });

  it("every mirrored reason sentence appears in the diagnostics copy module", () => {
    expect(Object.keys(HEALTH_REASON_TABLE).length).toBeGreaterThan(20);
    expect(findCopyDrift(HEALTH_REASON_TABLE, realSource)).toEqual([]);
  });

  it("10-03: mirrors one literal per claude-cli reason and the sign-in copy", () => {
    for (const reason of [
      "claude-cli-ready",
      "claude-cli-signed-out",
      "claude-cli-missing",
      "claude-cli-check-failed",
      "claude-cli-not-checked",
    ]) {
      expect(HEALTH_REASON_TABLE, reason).toHaveProperty([reason]);
      expect(HEALTH_REASONS[reason], reason).toBeTruthy();
    }
    expect(HEALTH_TEXT.copySignIn).toBe("Copy sign-in command");
    expect(HEALTH_TEXT.signInCommand).toBe("claude auth login");
    expect(HEALTH_TEXT.signInCopied).toBe("Sign-in command copied. Run it in Terminal.");
    expect(HEALTH_TEXT.partClaudeSignIn).toBe("Claude sign-in");
  });

  it("names owner files that exist", () => {
    for (const table of [
      HEALTH_TEXT_TABLE,
      HEALTH_CLASSES_TABLE,
      HEALTH_ATTRS_TABLE,
      HEALTH_REASON_TABLE,
    ]) {
      for (const [, owner] of Object.values(table)) {
        expect(existsSync(join(REPO_ROOT, owner)), owner).toBe(true);
      }
    }
  });

  it("takes the words the item texts quote from the plugin copy", () => {
    expect(HEALTH_TEXT.runChecksLabel).toBe("Run checks again");
    expect(HEALTH_TEXT.checking).toBe("Checking…");
    expect(HEALTH_TEXT.checkedJustNow).toBe("Checked just now.");
    expect(HEALTH_TEXT.nothingFailing).toBe("Nothing is failing.");
    expect(HEALTH_TEXT.schedulerFixedLine).toBe(
      "Manual trigger only in this version. Nothing runs on a timer.",
    );
    expect(HEALTH_TEXT.notInVersionHeading).toBe("Not part of this version");
    expect(reasonSentence("service-unreachable")).toBe(
      "The plugin can't reach the companion service.",
    );
    expect(reasonSentence("service-not-running")).toBe(
      "Can't be checked while the companion service isn't running.",
    );
    expect(reasonSentence("no-events-yet")).toBe(
      "Hooks are installed. No event has arrived since the companion service started.",
    );
  });

  it("builds class names that start with the ccc prefix", () => {
    for (const [key, value] of Object.entries(HEALTH_CLASSES)) {
      expect(value.startsWith("ccc-"), key).toBe(true);
    }
  });

  it("maps every reason code to exactly one sentence, and reasonSentence reads that table", () => {
    for (const [code, sentence] of Object.entries(HEALTH_REASONS)) {
      expect(reasonSentence(code), code).toBe(sentence);
      expect(sentence.endsWith("."), code).toBe(true);
    }
  });

  it("control: the drift check does flag a string, a class and a sentence that no longer exist", () => {
    const stale = {
      text: ["A sentence nobody wrote.", "packages/plugin/src/view/diagnostics-copy.ts", "literal"],
      cls: ["ccc-gone-xyz", "packages/plugin/src/view/diagnostics-row.tsx", "fragment"],
    } as const;
    expect(findCopyDrift(stale, realSource)).toEqual(["text", "cls"]);
  });
});
