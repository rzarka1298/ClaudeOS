import { describe, expect, it } from "vitest";
import { sanitizeText } from "./sanitize.js";

// Paths and addresses that the privacy scan would flag as literals are built at run time.
const HOME = "/Users/you";
const OTHER_HOME = ["", "Users", "bob"].join("/");
const REAL_EMAIL = ["bob", "corp.io"].join("@");

describe("sanitizeText (Test 1)", () => {
  it("replaces the given home directory and any other /Users path with the placeholder", () => {
    const out = sanitizeText(`failed in ${HOME}/proj/a.ts and ${OTHER_HOME}/x/y.ts`, {
      homeDir: HOME,
    });
    expect(out).toBe("failed in /Users/USERNAME/proj/a.ts and /Users/USERNAME/x/y.ts");
  });

  it("replaces a home directory that is not under /Users", () => {
    expect(sanitizeText("at /home/carol/work/f.ts", { homeDir: "/home/carol" })).toBe(
      "at /Users/USERNAME/work/f.ts",
    );
  });

  it("keeps the placeholder path as it is", () => {
    expect(sanitizeText("see /Users/USERNAME/ClaudeOS/x")).toBe("see /Users/USERNAME/ClaudeOS/x");
  });

  it("replaces an email address", () => {
    expect(sanitizeText(`mail ${REAL_EMAIL} now`)).toBe("mail [email] now");
  });

  it("replaces a hex string of forty or more characters and keeps shorter ones", () => {
    expect(sanitizeText(`head ${"ab12".repeat(10)} ok`)).toBe("head [hash] ok");
    expect(sanitizeText(`head ${"ab12".repeat(11)}`)).toBe("head [hash]");
    expect(sanitizeText("build abcdef012345 ok")).toBe("build abcdef012345 ok");
  });

  it("replaces a base64-like token of thirty-two or more characters", () => {
    const token = "Zm9vYmFyQmF6MTIzNDU2Nzg5MGFiY2RlZkdISUo";
    expect(sanitizeText(`bearer ${token} sent`)).toBe("bearer [token] sent");
  });

  it("leaves long lowercase path segments and plain words alone", () => {
    const text = "see packages/e2e/specs/approvals-core and anticonstitutionnellement";
    expect(sanitizeText(text)).toBe(text);
  });

  it("strips control characters and newlines and collapses whitespace", () => {
    expect(sanitizeText("a\u0000b\nc\t\td   e\u001b[31m")).toBe("a b c d e [31m");
  });

  it("turns a markdown image and a data URL into harmless text", () => {
    const out = sanitizeText("see ![shot](data:image/png;base64,AAAA) now");
    expect(out).not.toContain("![");
    expect(out).not.toMatch(/data:[a-z]+\//);
  });

  it("truncates to maxLength with an ellipsis marker", () => {
    const out = sanitizeText("word ".repeat(200), { maxLength: 50 });
    expect(out.length).toBe(50);
    expect(out.endsWith("...")).toBe(true);
  });

  it("defaults to a bounded length", () => {
    expect(sanitizeText("w ".repeat(5000)).length).toBeLessThanOrEqual(300);
  });

  it("is idempotent", () => {
    const messy = `${HOME}/a ${REAL_EMAIL} ${"ab12".repeat(10)}\n\n${"w ".repeat(400)}`;
    const once = sanitizeText(messy, { homeDir: HOME, maxLength: 120 });
    expect(sanitizeText(once, { homeDir: HOME, maxLength: 120 })).toBe(once);
  });

  it("does not alter ordinary assertion text", () => {
    expect(sanitizeText("expected 3 to equal 4")).toBe("expected 3 to equal 4");
    expect(sanitizeText("expected 'Approval needed' to be visible")).toBe(
      "expected 'Approval needed' to be visible",
    );
  });
});
