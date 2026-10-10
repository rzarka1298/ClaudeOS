import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/*
 * Audit (wave-2 review): `obsidianmd/ui/sentence-case` accepts any brand in
 * its `brands` list capitalised ANYWHERE in a UI string. A bare common word
 * there ("Terminal", "Desktop") silently licenses Title Case for that word
 * in every string, which is exactly what the rule exists to catch. Only
 * product names (usually multi-word, or not ordinary English words) belong
 * in the list.
 */
const CONFIG = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "eslint.config.mjs"),
  "utf8",
);

function brandList(): string[] {
  const start = CONFIG.indexOf("const SENTENCE_CASE_BRANDS = [");
  const end = CONFIG.indexOf("];", start);
  expect(start).toBeGreaterThan(-1);
  return [...CONFIG.slice(start, end).matchAll(/^\s*"([^"]+)",/gm)].map((m) => m[1] ?? "");
}

describe("sentence-case brand list", () => {
  it("still restates the rule's defaults and the Phase 4 product names", () => {
    const brands = brandList();
    for (const kept of [
      "macOS",
      "GitHub",
      "Claude Code",
      "Claude Desktop",
      "Privacy & Security",
      "Codex",
    ]) {
      expect(brands).toContain(kept);
    }
  });

  it.each(["Terminal", "Desktop", "Documents", "Downloads", "Automation"])(
    "does not list the bare common word %s",
    (word) => {
      expect(brandList()).not.toContain(word);
    },
  );
});
