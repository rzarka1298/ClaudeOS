import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * FIX3B Q7 structural guard: a Claude session's state word is decided in exactly one place,
 * `presentRunState` (D-05, SESS-19). A render site that reads `RUN_STATE_DISPLAY` directly would
 * show a quiet session as plain Running again, so only the users that never present a Claude
 * session may read it: research runs (their own run rows) and, in the domain package, Codex rows.
 */
const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Research-run users; none of them reads a Claude `SessionView`. */
const RESEARCH_ALLOWLIST: readonly string[] = [
  "view/report-reader.tsx",
  "view/research-status.tsx",
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name))
      out.push(path);
  }
  return out;
}

describe("no Claude session render site reads RUN_STATE_DISPLAY directly (FIX3B Q7)", () => {
  const files = sourceFiles(SRC).map((path) => ({
    rel: relative(SRC, path).split("\\").join("/"),
    text: readFileSync(path, "utf8"),
  }));

  it("only the research users reference RUN_STATE_DISPLAY in plugin source", () => {
    const users = files.filter((file) => file.text.includes("RUN_STATE_DISPLAY")).map((f) => f.rel);
    expect(users.sort()).toEqual([...RESEARCH_ALLOWLIST].sort());
  });

  it("the allowlisted research users never touch a Claude session", () => {
    for (const rel of RESEARCH_ALLOWLIST) {
      const text = files.find((file) => file.rel === rel)?.text ?? "";
      expect(text, rel).not.toMatch(/\bSessionView\b|sessionsById|session-signals/);
    }
  });

  it("every Claude session surface goes through presentRunState", () => {
    for (const rel of [
      "view/agent-runs.tsx",
      "view/agent-runs-detail.tsx",
      "widgets/active-sessions.tsx",
      "view/session-modals.ts",
    ]) {
      const text = files.find((file) => file.rel === rel)?.text ?? "";
      expect(text, rel).toContain("presentRunState(");
    }
  });
});
