import { describe, expect, it } from "vitest";
import { assertInstallerVersionMatches, parseInstallerVersion } from "./installed-app.js";

describe("installed app version derivation", () => {
  it("accepts a plain semver with surrounding whitespace", () => {
    expect(parseInstallerVersion("1.13.7\n")).toBe("1.13.7");
  });
  it.each(["", "1.13", "latest", "1.13.7-beta"])("rejects %j", (raw) => {
    expect(() => parseInstallerVersion(raw)).toThrow(/no usable installer version/);
  });
  it("passes when recorded equals installed and fails loud otherwise", () => {
    expect(() => assertInstallerVersionMatches("1.13.7", "1.13.7")).not.toThrow();
    expect(() => assertInstallerVersionMatches("1.13.7", "1.14.0")).toThrow(/1\.14\.0.*1\.13\.7/);
  });
});
