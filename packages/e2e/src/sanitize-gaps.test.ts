import { describe, expect, it } from "vitest";
import { sanitizeText } from "./sanitize.js";

/** Wave 2 review LOW-3: home with spaces, markdown image path, short hex and lowercase tokens. */
const USERS = ["", "Users"].join("/");

describe("sanitizeText gaps (LOW-3)", () => {
  it("replaces a home path whose user name contains a space", () => {
    expect(sanitizeText(`${USERS}/Jane Smith/Documents/notes.md`)).toBe(
      "/Users/USERNAME/Documents/notes.md",
    );
  });

  it("still ends a plain user name at the next space when no slash follows", () => {
    expect(sanitizeText(`cd ${USERS}/jane now`)).toBe("cd /Users/USERNAME now");
  });

  it("leaves no image path behind for a markdown image", () => {
    const out = sanitizeText("![shot](/tmp/ccc-uat-shots-1/01-x.png) done");
    expect(out).not.toContain(".png");
    expect(out).not.toContain("ccc-uat-shots");
    expect(out).toContain("done");
  });

  it("masks a 32 to 39 character hex string", () => {
    expect(sanitizeText(`id ${"ab12".repeat(8)} ok`)).toBe("id [hash] ok");
    expect(sanitizeText(`id ${"ab12".repeat(9)}`.slice(0, 41))).toBe("id [hash]");
  });

  it("masks a long all-lowercase alphanumeric token that holds a digit", () => {
    const token = `${"qrstuvwxyz".repeat(4)}12`;
    expect(token).toHaveLength(42);
    expect(sanitizeText(`key ${token} sent`)).toBe("key [token] sent");
  });

  it("keeps a long kebab-case path without being fooled by the digit rule", () => {
    const path = "packages/e2e/src/a-very-long-descriptive-file-name-v2.test.ts";
    expect(sanitizeText(path)).toBe(path);
  });

  it("is idempotent on the new rules", () => {
    const once = sanitizeText(`${USERS}/Jane Smith/x ![a](/tmp/z.png) ${"ab12".repeat(8)}`);
    expect(sanitizeText(once)).toBe(once);
  });
});
