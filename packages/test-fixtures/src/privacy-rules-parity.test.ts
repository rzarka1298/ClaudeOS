// Plan 08-09 Task 2 (D-11, T-08-26): the diagnostic bundle verifier ports two rules of
// scripts/check-privacy.sh (a non-placeholder macOS home-directory path and a non-example email
// address). The script scans `git ls-files`, so the verifier cannot call it; instead this gate reads
// the script's own text, extracts the two regular-expression literals and the placeholder list, and
// asserts the verifier's constants are equal to them. If either side changes alone, this fails.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PRIVACY_RULES } from "@ccc/domain/diagnostic-bundle.js";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./gate-repo.js";

const SCRIPT = readFileSync(join(REPO_ROOT, "scripts", "check-privacy.sh"), "utf8");

/** The text between the slashes of every awk `match(rest, /.../)` call, in order. */
function matchLiterals(): string[] {
  return [...SCRIPT.matchAll(/match\(rest, \/(.+?)\/\)\)/g)].map((m) => m[1] ?? "");
}

describe("the verifier's ported privacy rules equal scripts/check-privacy.sh", () => {
  it("finds exactly the two match literals the verifier ports, home path first and email second", () => {
    expect(matchLiterals()).toHaveLength(2);
  });

  it("rule 1: the home-path regex literal is identical", () => {
    expect(PRIVACY_RULES.homePath.source).toBe(matchLiterals()[0]);
  });

  it("rule 1: the placeholder user segments are identical and in the same order", () => {
    const placeholders = [...SCRIPT.matchAll(/seg != "([^"]+)"/g)].map((m) => m[1] ?? "");
    expect(placeholders.length).toBeGreaterThan(0);
    expect([...PRIVACY_RULES.homePath.placeholderSegments]).toEqual(placeholders);
  });

  it("rule 2: the email regex literal is identical", () => {
    expect(PRIVACY_RULES.email.source).toBe(matchLiterals()[1]);
  });

  it("rule 2: the example-domain exemption is identical", () => {
    const exempt = /addr !~ \/(.+?)\//.exec(SCRIPT)?.[1];
    expect(exempt).toBeDefined();
    expect(PRIVACY_RULES.email.exemptSource).toBe(exempt);
  });

  it("the constants are usable as regular expressions with the script's meaning", () => {
    // Assembled at run time so this tracked file holds no path or address the privacy scan would flag.
    const path = ["/Us", "ers/", "someone-example", "/x"].join("");
    const bare = ["/Us", "ers/"].join("");
    const address = ["a", "@", "b", ".co"].join("");
    const home = new RegExp(PRIVACY_RULES.homePath.source, "g");
    expect(path.match(home)).not.toBeNull();
    expect(bare.match(home)).toBeNull();
    const email = new RegExp(PRIVACY_RULES.email.source, "g");
    expect(`write to ${address} now`.match(email)).toEqual([address]);
    expect(
      new RegExp(PRIVACY_RULES.email.exemptSource).test(["p", "@", "example", ".com"].join("")),
    ).toBe(true);
    expect(
      new RegExp(PRIVACY_RULES.email.exemptSource).test(["p", "@", "example", ".io"].join("")),
    ).toBe(false);
  });
});
