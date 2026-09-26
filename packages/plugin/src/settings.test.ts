import { describe, expect, it } from "vitest";
import { assertNoPrivatePathValues, DEFAULT_SETTINGS, PATH_VALUED_KEYS } from "./settings.js";

/**
 * D-43 (PROJ-14): project data lives only in the service's operational store,
 * so a settings save refuses a home-absolute or `~/` value under any key but
 * the path-valued allowlist, and refuses any project-, scan-root- or
 * launcher-shaped key outright. Every refusal names the key and never echoes
 * the value -- the error itself must not become the leak.
 */

// Placeholder segments only: the privacy gate refuses a real-looking user.
const HOME_PROJECT = "/Users/USERNAME/code/example-project";
const TILDE_PROJECT = "~/code/example-project";
const NESTED_PATH = "/Users/USERNAME/x";

/** The error the guard throws for `value`; fails the test if it does not throw. */
function refusal(value: unknown): Error {
  let caught: unknown;
  try {
    assertNoPrivatePathValues(value);
  } catch (err) {
    caught = err;
  }
  expect(caught, "assertNoPrivatePathValues should refuse this value").toBeInstanceOf(Error);
  return caught as Error;
}

describe("assertNoPrivatePathValues (D-43)", () => {
  it("accepts the default settings", () => {
    expect(() => assertNoPrivatePathValues(DEFAULT_SETTINGS)).not.toThrow();
  });

  it("allows a home-absolute socket path override (the path-valued allowlist, Pitfall 9)", () => {
    expect(PATH_VALUED_KEYS.has("socketPathOverride")).toBe(true);
    const settings = {
      ...DEFAULT_SETTINGS,
      socketPathOverride: "/Users/USERNAME/.claude-command-center/svc.sock",
    };
    expect(() => assertNoPrivatePathValues(settings)).not.toThrow();
  });

  it("refuses a home-absolute value under any other key, naming the key but not the value", () => {
    const err = refusal({ ...DEFAULT_SETTINGS, lastOpenedDestination: HOME_PROJECT });
    expect(err.message).toContain('"lastOpenedDestination"');
    expect(err.message).not.toContain(HOME_PROJECT);
    expect(err.message).not.toContain("example-project");
  });

  it("refuses a ~/ value, naming the key but not the value", () => {
    const err = refusal({ ...DEFAULT_SETTINGS, lastOpenedDestination: TILDE_PROJECT });
    expect(err.message).toContain('"lastOpenedDestination"');
    expect(err.message).not.toContain(TILDE_PROJECT);
    expect(err.message).not.toContain("example-project");
  });

  it("walks nested plain objects", () => {
    const err = refusal({ ...DEFAULT_SETTINGS, recent: { a: NESTED_PATH } });
    expect(err.message).toContain('"a"');
    expect(err.message).not.toContain(NESTED_PATH);
  });

  it("walks arrays", () => {
    const err = refusal({ ...DEFAULT_SETTINGS, history: ["overview", TILDE_PROJECT] });
    expect(err.message).not.toContain(TILDE_PROJECT);
  });

  it("refuses a path value inside an array of objects", () => {
    const err = refusal({ ...DEFAULT_SETTINGS, recent: [{ note: HOME_PROJECT }] });
    expect(err.message).toContain('"note"');
    expect(err.message).not.toContain(HOME_PROJECT);
  });

  for (const key of ["projects", "projectPaths", "scanRoots", "launcherConfig"]) {
    it(`refuses the project-shaped key "${key}" whatever its value`, () => {
      const err = refusal({ ...DEFAULT_SETTINGS, [key]: ["example-project"] });
      expect(err.message).toContain(`"${key}"`);
      expect(err.message).not.toContain("example-project");
    });
  }

  it("refuses a project-shaped key nested below the top level", () => {
    const err = refusal({ ...DEFAULT_SETTINGS, ui: { recentProjects: [] } });
    expect(err.message).toContain('"recentProjects"');
  });
});
