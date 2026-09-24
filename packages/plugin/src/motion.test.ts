import { describe, expect, it } from "vitest";
import { resolveMotionMode } from "./motion.js";

/**
 * The full 2x2 of the only decision reduced motion has (A11Y-03 boundary
 * edge). Both inputs are enumerated rather than sampled, because the whole
 * point of resolving once is that there is exactly one table and it is small
 * enough to state completely.
 */
describe("resolveMotionMode", () => {
  it("resolves full when the setting is auto and the OS states no preference", () => {
    expect(resolveMotionMode("auto", false)).toBe("full");
  });

  it("resolves reduced when the setting is auto and the OS asks to reduce", () => {
    expect(resolveMotionMode("auto", true)).toBe("reduced");
  });

  it("resolves reduced when the setting overrides an OS that states no preference", () => {
    expect(resolveMotionMode("reduced", false)).toBe("reduced");
  });

  it("resolves reduced when the setting and the OS agree to reduce", () => {
    expect(resolveMotionMode("reduced", true)).toBe("reduced");
  });
});
