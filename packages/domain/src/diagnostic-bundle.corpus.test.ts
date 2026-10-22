import { describe, expect, it } from "vitest";
import {
  BUNDLE_KEY_VOCABULARY,
  BUNDLE_REFUSAL_CODES,
  BUNDLE_VOCABULARY,
  buildDenylist,
  buildDiagnosticBundle,
  checkLeaf,
  type DenylistInput,
  type DiagnosticBundle,
  type DiagnosticBundleInput,
  DiagnosticBundleSchema,
  PRIVACY_RULES,
  serialiseBundle,
  verifyBundle,
} from "./diagnostic-bundle.js";
import {
  CORPUS_CANARY,
  CORPUS_DENYLIST_INPUT,
  cleanBundleInput,
  freshInstallHealth,
  HOSTILE_NAME_SAMPLES,
  HOSTILE_SHAPE_SAMPLES,
  PASS_THROUGH_SAMPLES,
  richHealth,
} from "./diagnostic-corpus.js";

/**
 * Plan 08-09 Task 2 (D-11, D-14, UI-SPEC unresolved item 3; threats T-08-23 to T-08-25): the
 * hostile corpus against the builder and the verifier. The builder never copies a canary; the
 * verifier refuses every known leak shape in every string leaf, by the rule's name and never the
 * value; it passes what the privacy script allows; and, as a tested property, it never refuses the
 * builder's own output.
 */

const DENYLIST = buildDenylist(CORPUS_DENYLIST_INPUT);

type Plain = Record<string, unknown>;

function cleanBundle(): DiagnosticBundle {
  return buildDiagnosticBundle(cleanBundleInput());
}

/** Every path to a string inside a plain JSON value. */
function stringLeafPaths(value: unknown, path: (string | number)[] = []): (string | number)[][] {
  if (typeof value === "string") return [path];
  if (Array.isArray(value)) return value.flatMap((item, i) => stringLeafPaths(item, [...path, i]));
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, item]) => stringLeafPaths(item, [...path, key]));
  }
  return [];
}

/** A deep copy of the bundle with the string at `path` replaced. */
function withLeaf(bundle: unknown, path: readonly (string | number)[], value: string): Plain {
  const copy = JSON.parse(JSON.stringify(bundle)) as Plain;
  let node: any = copy;
  for (const key of path.slice(0, -1)) node = node[key];
  node[path.at(-1) as string | number] = value;
  return copy;
}

describe("Test 1 (canary, D-14): no free-text source field reaches the bundle", () => {
  it("never copies a canary placed in every free-text field of the input, and the bundle still parses", () => {
    const base = cleanBundleInput();
    const canary = CORPUS_CANARY;
    const hostile = {
      ...base,
      health: {
        ...base.health,
        paths: { vault: `~/${canary}`, runtimeDir: `~/${canary}`, socket: `~/${canary}/svc.sock` },
        // FIX2A F2: the canary rides on every version the builder is given (the service's own and the
        // three the plugin reads from the host); none of them may reach the bundle.
        service: { ...base.health?.service, version: `0.1.0-${canary}` },
      },
      versions: {
        plugin: "0.1.0",
        obsidian: `1.13.7-${canary}`,
        electron: `37.2.1-${canary}`,
        node: `24.20.0-${canary}`,
      },
      pluginDiagnostics: [
        {
          source: "layout",
          code: "override-invalid",
          message: `${canary} message`,
          at: base.generatedAt,
        },
      ],
      // Fields no part of the input type names: they must not reach the output by any route.
      projects: [
        { displayName: canary, path: `/${canary}`, github: { owner: canary, repo: canary } },
      ],
      vaultName: canary,
      launchers: { "claude-code": { executableDisplay: canary, terminalArgv: [canary, canary] } },
      connectionReason: canary,
      connection: base.connection,
      error: { message: canary, stack: canary },
      logLines: [canary],
    } as unknown as DiagnosticBundleInput;

    const bundle = buildDiagnosticBundle(hostile);
    const text = serialiseBundle(bundle);
    expect(text.toLowerCase()).not.toContain(canary.toLowerCase());
    expect(text).not.toContain("9f2c1e");
    expect(DiagnosticBundleSchema.safeParse(bundle).success).toBe(true);
    expect(verifyBundle(bundle, DENYLIST)).toEqual({ ok: true });
  });

  it("holds none of the dropped health members: no fingerprint, display path, keychain value, fact or action", () => {
    const text = serialiseBundle(cleanBundle());
    const health = richHealth();
    expect(text).not.toContain(health.vaultFingerprint?.salt ?? "no-salt");
    for (const dropped of [
      "~/",
      "keychain",
      "installSecret",
      "setupAction",
      "facts",
      "dropCount",
      "socket",
    ]) {
      expect(text, dropped).not.toContain(dropped);
    }
  });
});

describe("Test 2 (refusal matrix): every hostile sample in every string leaf is refused by its rule", () => {
  const bundle = cleanBundle();
  const leaves = stringLeafPaths(bundle);

  it("has a clean bundle to start from, with many leaves", () => {
    expect(verifyBundle(bundle, DENYLIST)).toEqual({ ok: true });
    expect(leaves.length).toBeGreaterThan(60);
  });

  for (const sample of [...HOSTILE_SHAPE_SAMPLES, ...HOSTILE_NAME_SAMPLES]) {
    it(`${sample.name} is refused as ${sample.rule} in every leaf, and the result names no value`, () => {
      for (const path of leaves) {
        const result = verifyBundle(withLeaf(bundle, path, sample.value), DENYLIST);
        expect(result, `${path.join(".")} <- ${sample.name}`).toEqual({
          ok: false,
          rule: sample.rule,
        });
      }
      const refusal = verifyBundle(
        withLeaf(bundle, leaves[0] as (string | number)[], sample.value),
        DENYLIST,
      );
      expect(JSON.stringify(refusal)).not.toContain(sample.value);
      expect(Object.keys(refusal).sort()).toEqual(["ok", "rule"]);
    });
  }

  it("also refuses a hostile object key, which the strict schema alone would only call invalid", () => {
    const keyed = JSON.parse(JSON.stringify(bundle)) as Plain;
    const sample = HOSTILE_SHAPE_SAMPLES[0];
    (keyed.versions as Plain)[sample?.value ?? "x"] = 1;
    expect(verifyBundle(keyed, DENYLIST)).toEqual({ ok: false, rule: "home-path" });
  });

  it("refuses a hostile value placed where the schema has no string at all (an unknown key's value)", () => {
    const extra = JSON.parse(JSON.stringify(bundle)) as Plain;
    extra.note = HOSTILE_SHAPE_SAMPLES[0]?.value;
    expect(verifyBundle(extra, DENYLIST)).toEqual({ ok: false, rule: "home-path" });
  });

  it("only ever answers a code from the closed list", () => {
    for (const sample of [...HOSTILE_SHAPE_SAMPLES, ...HOSTILE_NAME_SAMPLES]) {
      expect(BUNDLE_REFUSAL_CODES).toContain(sample.rule);
    }
    expect([...BUNDLE_REFUSAL_CODES].sort()).toEqual(
      [
        "denylist-folder",
        "denylist-github",
        "denylist-project",
        "denylist-user",
        "denylist-vault",
        "email",
        "home-path",
        "schema-invalid",
        "token-shaped",
        "tilde-path",
        "too-large",
      ].sort(),
    );
  });
});

describe("Test 3 (pass-through): forms the privacy script allows are not refused by a shape rule", () => {
  for (const sample of PASS_THROUGH_SAMPLES) {
    it(`${sample.name} passes the shape rules and the denylist`, () => {
      expect(checkLeaf(sample.value, DENYLIST)).toBeNull();
    });
  }

  it("a bundle carrying one is refused only for its structure, never as a privacy rule", () => {
    const bundle = cleanBundle();
    const leaf = stringLeafPaths(bundle)[0] as (string | number)[];
    for (const sample of PASS_THROUGH_SAMPLES) {
      expect(verifyBundle(withLeaf(bundle, leaf, sample.value), DENYLIST)).toEqual({
        ok: false,
        rule: "schema-invalid",
      });
    }
  });

  it("a placeholder home path does not mask a real one on the same line", () => {
    const real = HOSTILE_SHAPE_SAMPLES[0]?.value ?? "";
    const placeholder = PASS_THROUGH_SAMPLES[0]?.value ?? "";
    expect(checkLeaf(`${placeholder} and ${real}`, DENYLIST)).toBe("home-path");
    expect(checkLeaf(`${real} and ${placeholder}`, DENYLIST)).toBe("home-path");
  });
});

describe("Test 4 (denylist hygiene)", () => {
  const empty = {
    projectNames: [],
    folderBasenames: [],
    github: [],
    vaultName: null,
    userName: null,
  } satisfies DenylistInput;

  it("skips entries shorter than four characters after folding", () => {
    const list = buildDenylist({
      ...empty,
      projectNames: ["ab", "xyz", "​​ab"],
      folderBasenames: ["x"],
      github: [{ owner: "me", repo: "r" }],
      vaultName: "ok",
      userName: "al",
    });
    expect(list.entries.filter((entry) => entry.folded.length < 4)).toEqual([]);
    expect(list.entries.map((entry) => entry.rule)).toEqual(["denylist-github"]);
    // The owner/repo pair is long enough even though both halves are not.
    expect(list.entries[0]?.folded).toBe("me/r");
  });

  it("drops entries equal to a token of the bundle's own vocabulary, so such a name cannot block export", () => {
    for (const name of [
      "degraded",
      "Live",
      "SETUP-NEEDED",
      "vault",
      "hooks",
      "darwin",
      "layout",
      "duplicate",
    ]) {
      expect(BUNDLE_VOCABULARY.has(name.toLowerCase()), name).toBe(true);
      const list = buildDenylist({
        ...empty,
        projectNames: [name],
        vaultName: name,
        userName: name,
      });
      expect(list.entries, name).toEqual([]);
      expect(verifyBundle(cleanBundle(), list), name).toEqual({ ok: true });
    }
  });

  it("does not let a name that merely occurs inside a vocabulary token, an instant or a version refuse a clean bundle", () => {
    const names = [
      "setup",
      "needed",
      "ride",
      "widget",
      "invalid",
      "2026",
      "1.13",
      "24.20",
      "arm6",
      "darw",
      "Tested",
    ];
    const list = buildDenylist({
      ...empty,
      projectNames: names,
      folderBasenames: names,
      vaultName: "setup",
      userName: "ride",
    });
    expect(list.entries.length).toBeGreaterThan(0);
    expect(verifyBundle(cleanBundle(), list)).toEqual({ ok: true });
    expect(
      verifyBundle(buildDiagnosticBundle(cleanBundleInput({ health: freshInstallHealth() })), list),
    ).toEqual({
      ok: true,
    });
  });

  it("does not let a name equal to one of the bundle's own key names refuse a clean bundle (keys are fixed by the schema)", () => {
    const keys = [
      "plugin",
      "status",
      "parts",
      "versions",
      "features",
      "counts",
      "connection",
      "source",
    ];
    const list = buildDenylist({ ...empty, projectNames: keys, folderBasenames: keys });
    expect(list.entries.length).toBeGreaterThan(0);
    expect(verifyBundle(cleanBundle(), list)).toEqual({ ok: true });
  });

  it("knows every key the schema can emit (so the key exemption cannot hide a free-text key)", () => {
    const seen = new Set<string>();
    const collect = (value: unknown): void => {
      if (Array.isArray(value)) for (const item of value) collect(item);
      else if (value !== null && typeof value === "object") {
        for (const [key, item] of Object.entries(value)) {
          seen.add(key);
          collect(item);
        }
      }
    };
    for (const health of [richHealth(), freshInstallHealth(), null]) {
      collect(buildDiagnosticBundle(cleanBundleInput({ health })));
    }
    expect([...seen].filter((key) => !BUNDLE_KEY_VOCABULARY.has(key))).toEqual([]);
    expect(BUNDLE_KEY_VOCABULARY.has("Orchard Ledger")).toBe(false);
  });

  it("still refuses such a name in a leaf that is not vocabulary, an instant or a version", () => {
    const list = buildDenylist({ ...empty, projectNames: ["widgetron"] });
    const bundle = cleanBundle();
    // An unknown, well-formed diagnostic code is checked like text.
    const smuggled = JSON.parse(JSON.stringify(bundle)) as Plain;
    ((smuggled.pluginDiagnostics as Plain[])[0] as Plain).code = "widgetron";
    expect(verifyBundle(smuggled, list)).toEqual({ ok: false, rule: "denylist-project" });
  });

  it("folds entries with NFKC, case, format characters and diacritics, and strips none of an entry's real letters", () => {
    const list = buildDenylist({
      ...empty,
      projectNames: ["Ｏｒｃｈａｒｄ"],
      folderBasenames: ["Café Plum"],
    });
    expect(list.entries.map((entry) => entry.folded)).toEqual(["orchard", "cafe plum"]);
  });

  it("the refusal holds only the rule code", () => {
    const refusal = verifyBundle(
      withLeaf(
        cleanBundle(),
        stringLeafPaths(cleanBundle())[0] as (string | number)[],
        "Orchard Ledger",
      ),
      DENYLIST,
    );
    expect(refusal).toEqual({ ok: false, rule: "denylist-project" });
  });
});

// ---------------------------------------------------------------------------
// Test 5: the property

/** A small seeded generator, so the sweep is the same on every run. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CONSONANTS = "bdfgkmnprstvz";
const VOWELS = "aeiou";

function generated(next: () => number) {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
  const word = (min: number, max: number): string => {
    const syllables = min + Math.floor(next() * (max - min + 1));
    let out = "";
    for (let i = 0; i < syllables; i += 1) out += pick([...CONSONANTS]) + pick([...VOWELS]);
    return out;
  };
  const title = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1);
  const many = <T>(count: number, make: () => T): T[] => Array.from({ length: count }, make);

  const names: DenylistInput = {
    projectNames: many(Math.floor(next() * 4), () =>
      next() < 0.4 ? `${title(word(2, 3))} ${title(word(2, 3))}` : title(word(2, 4)),
    ),
    folderBasenames: many(Math.floor(next() * 4), () => `${word(2, 3)}-${word(2, 3)}`),
    github: many(Math.floor(next() * 3), () => ({
      owner: word(2, 4),
      repo: `${word(2, 3)}-${word(1, 2)}`,
    })),
    vaultName: next() < 0.7 ? `${title(word(2, 3))} ${title(word(1, 2))}` : null,
    userName: next() < 0.7 ? `${word(2, 3)}${Math.floor(next() * 90 + 10)}` : null,
  };

  const codes = [
    "override-invalid",
    "override-unreadable",
    "override-apply-failed",
    "unknown-widget",
    "feature-off",
    "duplicate",
  ];
  const instant = `2026-${String(1 + Math.floor(next() * 12)).padStart(2, "0")}-${String(1 + Math.floor(next() * 28)).padStart(2, "0")}T09:00:00.000Z`;
  const versionOf = (): string =>
    `${Math.floor(next() * 40)}.${Math.floor(next() * 40)}.${Math.floor(next() * 40)}`;
  const launcherStatuses = ["not-set-up", "set-up", "tested"] as const;
  const healthChoice = next();
  const connection = next() < 0.75 ? "live" : pick(["connecting", "disconnected"] as const);
  const input: DiagnosticBundleInput = cleanBundleInput({
    generatedAt: instant,
    health: healthChoice < 0.25 ? null : healthChoice < 0.6 ? freshInstallHealth() : richHealth(),
    connection,
    vaultCheck: pick(["match", "mismatch", "unavailable"] as const),
    versions: {
      plugin: versionOf(),
      obsidian: next() < 0.8 ? versionOf() : null,
      electron: next() < 0.8 ? versionOf() : null,
      node: next() < 0.8 ? versionOf() : null,
    },
    platformArch: pick(["arm64", "x64", null] as const),
    features: {
      reducedMotion: pick(["auto", "reduced"] as const),
      transcriptAnalysis: pick([true, false, null] as const),
      notifyApprovals: next() < 0.5,
      launchers: {
        antigravity: pick([...launcherStatuses, null]),
        "claude-code": pick([...launcherStatuses, null]),
        "claude-desktop": pick([...launcherStatuses, null]),
        codex: pick([...launcherStatuses, null]),
      },
    },
    pluginDiagnostics: many(Math.floor(next() * 7), () => ({
      source: "layout",
      code: pick(codes),
      // The message is free text the bundle drops; it may well hold the owner's names.
      message: `Layout entry ${word(2, 3)} skipped for ${names.projectNames[0] ?? word(2, 3)}.`,
      at: instant,
    })),
  });
  return { input, names };
}

describe("Test 5 (property): the verifier never refuses the builder's own output", () => {
  it("accepts 500 generated clean inputs with random synthetic owner names", () => {
    const next = mulberry32(0x08090809);
    let withEntries = 0;
    let entryTotal = 0;
    let withoutHealth = 0;
    let withParts = 0;
    let withDiagnostics = 0;
    for (let run = 0; run < 500; run += 1) {
      const { input, names } = generated(next);
      const bundle = buildDiagnosticBundle(input);
      const denylist = buildDenylist(names);
      expect(verifyBundle(bundle, denylist), `run ${run}`).toEqual({ ok: true });
      if (denylist.entries.length > 0) withEntries += 1;
      entryTotal += denylist.entries.length;
      if (bundle.subsystems[1]?.reasonCode === "service-not-running") withoutHealth += 1;
      if (
        bundle.subsystems.some((subsystem) => "parts" in subsystem && subsystem.parts !== undefined)
      )
        withParts += 1;
      if (bundle.pluginDiagnostics.length > 0) withDiagnostics += 1;
    }
    // Not vacuous: the sweep exercises names, missing health, parts and diagnostics.
    expect(withEntries).toBeGreaterThan(400);
    expect(entryTotal).toBeGreaterThan(1000);
    expect(withoutHealth).toBeGreaterThan(80);
    expect(withParts).toBeGreaterThan(200);
    expect(withDiagnostics).toBeGreaterThan(300);
  });

  it("and the same verifier does refuse every one of those names once it is placed in a diagnostic code", () => {
    const next = mulberry32(0x0809cafe);
    let refused = 0;
    let tried = 0;
    for (let run = 0; run < 100; run += 1) {
      const { input, names } = generated(next);
      const denylist = buildDenylist(names);
      const first = denylist.entries.find((entry) => /^[a-z]+$/.test(entry.folded));
      if (first === undefined) continue;
      const bundle = JSON.parse(JSON.stringify(buildDiagnosticBundle(input))) as Plain;
      bundle.pluginDiagnostics = [
        { source: "layout", code: first.folded, at: "2026-10-22T09:00:00.000Z" },
      ];
      tried += 1;
      if (
        JSON.stringify(verifyBundle(bundle, denylist)) ===
        JSON.stringify({ ok: false, rule: first.rule })
      )
        refused += 1;
    }
    expect(tried).toBeGreaterThan(30);
    expect(refused).toBe(tried);
  });
});

describe("the privacy rules are exported as data", () => {
  it("names the two ported script rules and the placeholder list", () => {
    expect(PRIVACY_RULES.homePath.placeholderSegments).toEqual([
      "USERNAME",
      "username",
      "<username>",
      "$USER",
      "you",
    ]);
    expect(PRIVACY_RULES.homePath.source.length).toBeGreaterThan(10);
    expect(PRIVACY_RULES.email.exemptSource).toContain("example");
  });
});
