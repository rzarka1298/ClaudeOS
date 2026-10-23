import { describe, expect, it } from "vitest";
import {
  assertNoCredentialFields,
  assertNoPrivatePathValues,
  DEFAULT_SETTINGS,
  mergeSettings,
  PATH_VALUED_KEYS,
} from "./settings.js";

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

describe("mergeSettings drops unknown keys at load (FIX2B, D-16)", () => {
  it("returns exactly the four known keys, even when the data file carries more", () => {
    const merged = mergeSettings({
      reducedMotion: "reduced",
      homeDir: "/Users/username",
      hostName: "example",
      nested: { projects: [] },
    });
    expect(Object.keys(merged).sort()).toEqual([
      "lastOpenedDestination",
      "notifyApprovals",
      "reducedMotion",
      "socketPathOverride",
    ]);
    expect(merged.reducedMotion).toBe("reduced");
    expect(JSON.stringify(merged)).not.toContain("username");
  });

  it("keeps a stored value for each known key", () => {
    expect(
      mergeSettings({
        socketPathOverride: "/run/x.sock",
        lastOpenedDestination: "projects",
        reducedMotion: "reduced",
        notifyApprovals: false,
      }),
    ).toEqual({
      socketPathOverride: "/run/x.sock",
      lastOpenedDestination: "projects",
      reducedMotion: "reduced",
      notifyApprovals: false,
    });
  });

  it("is not fooled by a __proto__ key in the stored data", () => {
    const merged = mergeSettings(
      JSON.parse('{"__proto__":{"polluted":true},"reducedMotion":"auto"}'),
    );
    expect(Object.keys(merged)).not.toContain("polluted");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("mergeSettings validates each key's type and falls back per key (FIX4B m10)", () => {
  it("replaces a hand-edited value of the wrong type with that key's default only", () => {
    const merged = mergeSettings({
      socketPathOverride: 42,
      lastOpenedDestination: { evil: true },
      reducedMotion: "sometimes",
      notifyApprovals: "yes",
    });
    expect(merged).toEqual(DEFAULT_SETTINGS);
  });

  it("keeps the good keys when only one is bad", () => {
    expect(
      mergeSettings({
        socketPathOverride: "/run/x.sock",
        lastOpenedDestination: 7,
        reducedMotion: "reduced",
        notifyApprovals: false,
      }),
    ).toEqual({
      socketPathOverride: "/run/x.sock",
      lastOpenedDestination: DEFAULT_SETTINGS.lastOpenedDestination,
      reducedMotion: "reduced",
      notifyApprovals: false,
    });
  });

  for (const bad of [undefined, 0, false, [], {}, "x"]) {
    it(`falls back to null for a socketPathOverride of ${JSON.stringify(bad)} unless it is a string`, () => {
      const merged = mergeSettings({ socketPathOverride: bad });
      expect(merged.socketPathOverride).toBe(typeof bad === "string" ? bad : null);
    });
  }

  it("accepts an explicit null socketPathOverride", () => {
    expect(mergeSettings({ socketPathOverride: null }).socketPathOverride).toBeNull();
  });
});

describe("the notifyApprovals setting (plan 06-09, D-26, PLUG-07)", () => {
  it("defaults on in a fresh settings object and for a data file written before the key existed", () => {
    expect(DEFAULT_SETTINGS.notifyApprovals).toBe(true);
    expect(mergeSettings(null).notifyApprovals).toBe(true);
    expect(mergeSettings({ lastOpenedDestination: "projects" }).notifyApprovals).toBe(true);
  });

  it("round-trips a saved false and a saved true", () => {
    expect(mergeSettings({ notifyApprovals: false }).notifyApprovals).toBe(false);
    expect(mergeSettings({ notifyApprovals: true }).notifyApprovals).toBe(true);
  });

  for (const bad of ["false", "no", 0, 1, null, {}, [], "true"]) {
    it(`coerces the persisted non-boolean ${JSON.stringify(bad)} to the default`, () => {
      expect(mergeSettings({ notifyApprovals: bad }).notifyApprovals).toBe(true);
    });
  }

  it("is plugin-owned data that passes both save guards", () => {
    const saved = mergeSettings({ notifyApprovals: false });
    expect(() => assertNoCredentialFields(saved)).not.toThrow();
    expect(() => assertNoPrivatePathValues(saved)).not.toThrow();
  });

  it("leaves the existing keys and defaults unchanged, and still rejects a credential-shaped key", () => {
    expect(DEFAULT_SETTINGS).toEqual({
      socketPathOverride: null,
      lastOpenedDestination: "overview",
      reducedMotion: "auto",
      notifyApprovals: true,
    });
    expect(
      mergeSettings({ socketPathOverride: "/run/x.sock", reducedMotion: "reduced" }),
    ).toMatchObject({ socketPathOverride: "/run/x.sock", reducedMotion: "reduced" });
    expect(() => assertNoCredentialFields({ approvalToken: "x" })).toThrow(/approvalToken/);
  });

  it("persists no key in the always-allow wording family (APPR-05)", () => {
    const FAMILY = /always.?allow|don.?t.?ask|remember|auto.?approve|trust|never.?ask/i;
    for (const key of Object.keys(DEFAULT_SETTINGS)) expect(key).not.toMatch(FAMILY);
    for (const key of Object.keys(mergeSettings({ notifyApprovals: false }))) {
      expect(key).not.toMatch(FAMILY);
    }
  });
});
