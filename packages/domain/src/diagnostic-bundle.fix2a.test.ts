import { describe, expect, it } from "vitest";
import {
  buildDenylist,
  buildDiagnosticBundle,
  type DiagnosticBundleInput,
  DiagnosticBundleSchema,
  KNOWN_PLUGIN_DIAGNOSTIC_CODES,
  serialiseBundle,
  verifyAndSerialise,
  verifyBundle,
} from "./diagnostic-bundle.js";
import {
  CORPUS_DENYLIST_INPUT,
  cleanBundleInput,
  freshInstallHealth,
  richHealth,
} from "./diagnostic-corpus.js";
import { DiagnosticsHealthResponseSchema } from "./diagnostics.js";

/**
 * Wave 2 lane A fix round FIX2A (plan 08-09 findings F2, F3, F4): the version shape is closed, the
 * plugin diagnostic code is a closed enum, and one entry point verifies and serialises.
 */

const DENYLIST = buildDenylist(CORPUS_DENYLIST_INPUT);
/** The review's canary: free text riding on a well-formed dotted version. */
const HOSTILE_VERSION = "0.1.0-OrchardLedger";

type Plain = Record<string, unknown>;

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("F2: a dotted-version suffix carries no free text", () => {
  it("builder: the obsidian, electron and node inputs read null when the suffix is free text", () => {
    for (const field of ["obsidian", "electron", "node"] as const) {
      const input = cleanBundleInput();
      const bundle = buildDiagnosticBundle({
        ...input,
        versions: { ...input.versions, [field]: HOSTILE_VERSION },
      });
      expect(bundle.versions[field], field).toBeNull();
      expect(serialiseBundle(bundle).toLowerCase(), field).not.toContain("orchard");
    }
  });

  it("builder: the plugin version is never copied through either (the bundle cannot be built from it)", () => {
    const input = cleanBundleInput();
    expect(() =>
      buildDiagnosticBundle({
        ...input,
        versions: { ...input.versions, plugin: HOSTILE_VERSION },
      }),
    ).toThrow();
  });

  it("builder: the service version reads null when the health response (forged past its schema) carries free text", () => {
    const base = cleanBundleInput();
    const health = copy(richHealth());
    health.service.version = HOSTILE_VERSION;
    const bundle = buildDiagnosticBundle({ ...base, health });
    expect(bundle.versions.service).toBeNull();
    expect(serialiseBundle(bundle).toLowerCase()).not.toContain("orchard");
  });

  it("the health contract refuses the same service version", () => {
    const health = copy(richHealth()) as Plain;
    (health.service as Plain).version = HOSTILE_VERSION;
    expect(DiagnosticsHealthResponseSchema.safeParse(health).success).toBe(false);
  });

  it("the bundle schema refuses the same text in every version field", () => {
    const clean = buildDiagnosticBundle(cleanBundleInput());
    for (const field of ["plugin", "service", "obsidian", "electron", "node"] as const) {
      const bundle = copy(clean) as unknown as { versions: Plain };
      bundle.versions[field] = HOSTILE_VERSION;
      expect(DiagnosticBundleSchema.safeParse(bundle).success, field).toBe(false);
    }
  });

  it("verifier: the denylist runs on a version leaf, so the name is refused as the project (not merely as invalid)", () => {
    const clean = buildDiagnosticBundle(cleanBundleInput());
    for (const field of ["plugin", "service", "obsidian", "electron", "node"] as const) {
      const bundle = copy(clean) as unknown as { versions: Plain };
      bundle.versions[field] = HOSTILE_VERSION;
      expect(verifyBundle(bundle, DENYLIST), field).toEqual({
        ok: false,
        rule: "denylist-project",
      });
    }
  });

  it("accepts the closed shapes and nothing else", () => {
    const ok = ["2.1.5", "1.13", "0.1.0-beta", "1.0.0-rc.2", "24.20.0-alpha.1", "1.2.3.4"];
    const bad = [
      "1.0.0-foo",
      "1.0.0-beta.x",
      "1.0.0-beta.1.2",
      "1.0.0-rc-1",
      "1.0.0-BETA",
      "1.0.0-",
      "1",
      "v1.0.0",
      "1.0.0+build",
      "1.0.0-alpha.",
    ];
    const input = cleanBundleInput();
    for (const value of ok) {
      const bundle = buildDiagnosticBundle({
        ...input,
        versions: { ...input.versions, node: value },
      });
      expect(bundle.versions.node, value).toBe(value);
    }
    for (const value of bad) {
      const bundle = buildDiagnosticBundle({
        ...input,
        versions: { ...input.versions, node: value },
      });
      expect(bundle.versions.node, value).toBeNull();
    }
  });

  it("numeric components never match a name incidentally, and the pre-release words are not names", () => {
    const list = buildDenylist({
      projectNames: ["2026", "1.13", "24.20", "alpha", "beta", "0.1"],
      folderBasenames: ["arm6"],
      github: [],
      vaultName: null,
      userName: null,
    });
    const input = cleanBundleInput();
    const bundle = buildDiagnosticBundle({
      ...input,
      versions: {
        plugin: "0.1.0-beta",
        obsidian: "1.13.7",
        electron: "37.2.1-rc.1",
        node: "24.20.0-alpha.2",
      },
    });
    expect(verifyBundle(bundle, list)).toEqual({ ok: true });
  });
});

describe("F3: the plugin diagnostic code is a closed enum", () => {
  const input = (code: string): DiagnosticBundleInput =>
    cleanBundleInput({
      pluginDiagnostics: [
        { source: "layout", code, message: "x", at: "2026-10-22T09:00:00.000Z" },
        { source: "layout", code: "unknown-widget", message: "x", at: "2026-10-22T09:00:00.000Z" },
      ],
    });

  it("drops a well-formed code that is not one the plugin writes", () => {
    const bundle = buildDiagnosticBundle(input("acme-corp-merger-deck"));
    expect(bundle.pluginDiagnostics.map((record) => record.code)).toEqual(["unknown-widget"]);
    expect(bundle.counts.pluginDiagnostics).toBe(1);
    expect(serialiseBundle(bundle)).not.toContain("acme-corp-merger-deck");
  });

  it("keeps every known code", () => {
    for (const code of KNOWN_PLUGIN_DIAGNOSTIC_CODES) {
      const bundle = buildDiagnosticBundle(input(code));
      expect(bundle.pluginDiagnostics.map((record) => record.code)).toEqual([
        code,
        "unknown-widget",
      ]);
    }
  });

  it("the schema refuses an unknown code, and the verifier says schema-invalid for it", () => {
    const bundle = copy(buildDiagnosticBundle(input("duplicate"))) as unknown as {
      pluginDiagnostics: Plain[];
    };
    (bundle.pluginDiagnostics[0] as Plain).code = "acme-corp-merger-deck";
    expect(DiagnosticBundleSchema.safeParse(bundle).success).toBe(false);
    expect(verifyBundle(bundle, DENYLIST)).toEqual({ ok: false, rule: "schema-invalid" });
  });
});

describe("F4: one entry point verifies and serialises", () => {
  it("answers the exact text the schema re-parsed", () => {
    const bundle = buildDiagnosticBundle(cleanBundleInput());
    const result = verifyAndSerialise(bundle, DENYLIST);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toBe(serialiseBundle(bundle));
    expect(DiagnosticBundleSchema.safeParse(JSON.parse(result.text)).success).toBe(true);
  });

  it("names the rule and never the value when it refuses", () => {
    const bundle = copy(buildDiagnosticBundle(cleanBundleInput())) as unknown as {
      versions: Plain;
    };
    bundle.versions.node = HOSTILE_VERSION;
    const result = verifyAndSerialise(bundle, DENYLIST);
    expect(result).toEqual({ ok: false, rule: "denylist-project" });
  });

  it("a toJSON or getter that changes between calls cannot change the offered text", () => {
    const clean = buildDiagnosticBundle(cleanBundleInput());
    let calls = 0;
    // The first read is clean; any later read would hand out a hostile value.
    const hostile = {
      ...copy(clean),
      toJSON() {
        calls += 1;
        const out = copy(clean) as unknown as { versions: Plain };
        if (calls > 1) out.versions.node = HOSTILE_VERSION;
        return out;
      },
    };
    const result = verifyAndSerialise(hostile, DENYLIST);
    expect(calls).toBe(1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text.toLowerCase()).not.toContain("orchard");

    let reads = 0;
    const getter = copy(clean) as unknown as { versions: Plain };
    Object.defineProperty(getter.versions, "node", {
      enumerable: true,
      get() {
        reads += 1;
        return reads === 1 ? "24.20.0" : HOSTILE_VERSION;
      },
    });
    const second = verifyAndSerialise(getter, DENYLIST);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.text).not.toContain("Orchard");
    expect(JSON.parse(second.text).versions.node).toBe("24.20.0");
  });

  it("refuses a value that is not a bundle without throwing", () => {
    expect(verifyAndSerialise(null, DENYLIST).ok).toBe(false);
    const cyclic: Plain = {};
    cyclic.self = cyclic;
    expect(verifyAndSerialise(cyclic, DENYLIST)).toEqual({ ok: false, rule: "schema-invalid" });
  });

  it("a fresh-install bundle verifies too", () => {
    const bundle = buildDiagnosticBundle(cleanBundleInput({ health: freshInstallHealth() }));
    expect(verifyAndSerialise(bundle, DENYLIST).ok).toBe(true);
  });
});
