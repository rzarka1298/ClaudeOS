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

  it("adds exactly Gmail and Google Calendar in Phase 8 (UI-SPEC R-11, R-F1) and nothing else new", () => {
    const brands = brandList();
    // Phase 05.1's Codex was the last entry before Phase 8; the two product
    // names follow it and nothing does after them. `Google` is a default, so
    // `Google Calendar` is not redundant: the rule matches whole phrases.
    expect(brands.slice(brands.indexOf("Codex") + 1)).toEqual(["Gmail", "Google Calendar"]);
    expect(new Set(brands).size).toBe(brands.length);
  });

  it("lists no section name or other common noun the Phase 8 copy uses mid-sentence", () => {
    // R-F1: section references are lower case in running copy ("Go to the
    // projects section"), so none of these may be licensed as a brand.
    for (const noun of ["Projects", "Launchers", "Integrations", "Security", "Schedules"]) {
      expect(brandList(), noun).not.toContain(noun);
    }
    for (const common of ["Diagnostics", "Settings", "Research", "Tasks", "Keychain", "Socket"]) {
      expect(brandList(), common).not.toContain(common);
    }
  });

  it.each(["Terminal", "Desktop", "Documents", "Downloads", "Automation"])(
    "does not list the bare common word %s",
    (word) => {
      expect(brandList()).not.toContain(word);
    },
  );
});
