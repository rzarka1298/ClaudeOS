import { describe, expect, it } from "vitest";
import { parseProfile } from "./profile.js";

const MESSAGE = "Unknown --profile value; expected standard or full.";

describe("parseProfile", () => {
  it("accepts standard and full", () => {
    expect(parseProfile("standard")).toBe("standard");
    expect(parseProfile("full")).toBe("full");
  });

  it("defaults to standard when no profile is given", () => {
    expect(parseProfile(undefined)).toBe("standard");
  });

  it("throws a fixed message naming the argument for anything else", () => {
    expect(() => parseProfile("nightly")).toThrowError(MESSAGE);
    expect(() => parseProfile("")).toThrowError(MESSAGE);
    expect(() => parseProfile("FULL")).toThrowError(MESSAGE);
  });

  it("never echoes the rejected value", () => {
    try {
      parseProfile("secret-looking-value");
      expect.unreachable("parseProfile should have thrown");
    } catch (error) {
      expect(String((error as Error).message)).not.toContain("secret-looking-value");
    }
  });
});
