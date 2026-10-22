import { describe, expect, expectTypeOf, it } from "vitest";
import {
  BUNDLE_MAX_BYTES,
  buildDenylist,
  buildDiagnosticBundle,
  type DenylistInput,
  type DiagnosticBundleInput,
  DiagnosticBundleSchema,
  serialiseBundle,
  verifyBundle,
} from "./diagnostic-bundle.js";
import { type DiagnosticsHealthResponse, DiagnosticsHealthResponseSchema } from "./diagnostics.js";

/**
 * Plan 08-09 Task 1 (D-10, OD-5; threats T-08-23, T-08-26): the diagnostic bundle is built from an
 * allowlist by explicit field picks and checked by a strict schema, so the only things it can hold
 * are versions, the platform, the connection state (never its reason), the six subsystem rows as
 * status plus reason code plus times plus parts, nullable integer counts, feature flags and the
 * plugin diagnostics reduced to source, code and time.
 */

const T0 = "2026-10-22T09:00:00.000Z";
/** A home-looking path, assembled at run time so this tracked file holds no literal one. */
const HOME_LIKE = ["/Us", "ers/alice-example"].join("");

function part(
  partId: string,
  reasonCode: string,
  status: string,
  extra: Record<string, unknown> = {},
) {
  return { partId, status, reasonCode, ...extra };
}

/**
 * A health response with the extra members the bundle must drop: setup actions, facts, a vault
 * fingerprint, display paths and keychain presence.
 */
function health(overrides: Partial<Record<string, unknown>> = {}): DiagnosticsHealthResponse {
  const row = (
    id: string,
    reasonCode: string,
    status: string,
    extra: Record<string, unknown> = {},
  ) => ({
    id,
    status,
    reasonCode,
    checkedAt: T0,
    freshness: "live",
    ...extra,
  });
  return DiagnosticsHealthResponseSchema.parse({
    generatedAt: T0,
    service: { version: "0.1.0", startedAt: T0, storeSchemaVersion: 12 },
    rows: [
      row("vault", "vault-ready", "ok"),
      row("hooks", "events-silent", "unknown", { facts: { silenceThresholdMs: 600000 } }),
      row("collectors", "spool-dropped-records", "degraded", {
        facts: { dropCount: 4, dropsSince: T0 },
        parts: [
          part("telemetry", "telemetry-ok", "ok"),
          part("status-line", "statusline-reporting", "ok"),
          part("transcript-analysis", "analysis-off", "setup-needed", {
            setupAction: { kind: "go-to-section", section: "security" },
          }),
          part("spool", "spool-dropped-records", "degraded", {
            facts: { dropCount: 4, dropsSince: T0 },
          }),
          part("codex-install", "codex-installed", "ok"),
          part("codex-hooks", "codex-hooks-receiving", "ok"),
          part("codex-bridge", "codex-bridge-ready", "ok"),
          part("codex-doctor", "codex-doctor-not-run", "setup-needed"),
        ],
      }),
      row("scheduler", "never-run", "setup-needed", {
        setupAction: { kind: "go-to-section", section: "research" },
        parts: [
          part("last-run", "never-run", "setup-needed", {
            setupAction: { kind: "go-to-section", section: "research" },
          }),
          part("research-key", "research-key-missing", "setup-needed", {
            setupAction: { kind: "copy-command", command: "research-key-setup" },
          }),
          part("sources", "sources-configured", "ok", { facts: { sourceCount: 3 } }),
        ],
      }),
      row("launchers", "launcher-ready", "ok", {
        parts: [
          part("antigravity", "launcher-ready", "ok"),
          part("claude-code", "launcher-not-set-up", "setup-needed"),
          part("claude-desktop", "launcher-not-set-up", "setup-needed"),
          part("codex", "launcher-not-set-up", "setup-needed"),
        ],
      }),
    ],
    keychain: { installSecret: "present", researchKey: "absent" },
    paths: {
      vault: "~/Notes/vault",
      runtimeDir: "~/.example-runtime",
      socket: "~/.example-runtime/svc.sock",
    },
    vaultFingerprint: { salt: "0123456789abcdef0123456789abcdef", digest: "0123456789abcdef" },
    counts: { projects: 3, scanFolders: 1, openTasks: null, reports: 0 },
    ...overrides,
  });
}

function input(overrides: Partial<DiagnosticBundleInput> = {}): DiagnosticBundleInput {
  return {
    generatedAt: "2026-10-22T09:30:00.000Z",
    health: health(),
    connection: "live",
    vaultCheck: "match",
    versions: { plugin: "0.1.0", obsidian: "1.13.7", electron: "37.2.1", node: "24.20.0" },
    platformArch: "arm64",
    features: {
      reducedMotion: "auto",
      transcriptAnalysis: false,
      notifyApprovals: true,
      launchers: {
        antigravity: "tested",
        "claude-code": "not-set-up",
        "claude-desktop": "not-set-up",
        codex: "not-set-up",
      },
    },
    pluginDiagnostics: [
      {
        source: "layout",
        code: "override-invalid",
        message: "The layout file was ignored.",
        at: T0,
      },
    ],
    ...overrides,
  };
}

const emptyDenylist: DenylistInput = {
  projectNames: [],
  folderBasenames: [],
  github: [],
  vaultName: null,
  userName: null,
};

describe("Test 1 (tracer): a clean input becomes a strict bundle, passes the verifier and serialises once", () => {
  it("builds a bundle the schema parses, with the fixed shape and no message", () => {
    const bundle = buildDiagnosticBundle(input());
    expect(DiagnosticBundleSchema.safeParse(bundle).success).toBe(true);
    expect(bundle.bundleVersion).toBe(1);
    expect(bundle.generatedAt).toBe("2026-10-22T09:30:00.000Z");
    expect(bundle.subsystems.map((subsystem) => subsystem.id)).toEqual([
      "service",
      "vault",
      "hooks",
      "collectors",
      "scheduler",
      "launchers",
    ]);
    expect(bundle.subsystems[0]).toMatchObject({
      id: "service",
      status: "ok",
      reasonCode: "service-live",
    });
    expect(bundle.counts).toEqual({
      projects: 3,
      scanFolders: 1,
      openTasks: null,
      reports: 0,
      pluginDiagnostics: 1,
    });
    expect(bundle.pluginDiagnostics).toEqual([
      { source: "layout", code: "override-invalid", at: T0 },
    ]);
    expect(bundle.versions).toEqual({
      plugin: "0.1.0",
      service: "0.1.0",
      obsidian: "1.13.7",
      electron: "37.2.1",
      node: "24.20.0",
      storeSchema: 12,
    });
    expect(bundle.platform).toEqual({ os: "darwin", arch: "arm64" });
    expect(bundle.connection).toEqual({ state: "live" });
  });

  it("passes the verifier with a denylist built from the same owner data, and serialises to the one string that is offered", () => {
    const bundle = buildDiagnosticBundle(input());
    const denylist = buildDenylist({
      projectNames: ["Orchard Ledger"],
      folderBasenames: ["orchard-ledger"],
      github: [{ owner: "someone-example", repo: "orchard-ledger" }],
      vaultName: "Field Notes",
      userName: "alice-example",
    });
    expect(verifyBundle(bundle, denylist)).toEqual({ ok: true });
    const text = serialiseBundle(bundle);
    expect(text).toBe(JSON.stringify(bundle, null, 2));
    expect(new TextEncoder().encode(text).length).toBeLessThan(BUNDLE_MAX_BYTES);
    expect(BUNDLE_MAX_BYTES).toBe(32 * 1024);
  });

  it("drops everything the response carried beyond status, reason code, times and parts", () => {
    const text = serialiseBundle(buildDiagnosticBundle(input()));
    for (const dropped of [
      "setupAction",
      "facts",
      "silenceThresholdMs",
      "dropCount",
      "vaultFingerprint",
      "0123456789abcdef",
      "~/",
      "keychain",
      "message",
      "layout file",
      "installSecret",
    ]) {
      expect(text, dropped).not.toContain(dropped);
    }
    const parts = buildDiagnosticBundle(input()).subsystems[3]?.parts;
    expect(parts?.[2]).toEqual({
      partId: "transcript-analysis",
      status: "setup-needed",
      reasonCode: "analysis-off",
    });
  });

  it("applies the vault overlay only to a ready vault row", () => {
    const mismatch = buildDiagnosticBundle(input({ vaultCheck: "mismatch" }));
    expect(mismatch.subsystems[1]).toMatchObject({
      id: "vault",
      status: "degraded",
      reasonCode: "vault-mismatch",
    });
    const unavailable = buildDiagnosticBundle(input({ vaultCheck: "unavailable" }));
    expect(unavailable.subsystems[1]).toMatchObject({
      status: "unknown",
      reasonCode: "vault-check-unavailable",
    });
    const broken = health({
      rows: health().rows.map((row) =>
        row.id === "vault" ? { ...row, status: "failing", reasonCode: "vault-root-missing" } : row,
      ),
    });
    const kept = buildDiagnosticBundle(input({ health: broken, vaultCheck: "mismatch" }));
    expect(kept.subsystems[1]).toMatchObject({
      status: "failing",
      reasonCode: "vault-root-missing",
    });
  });

  it("reads the service row from the connection state: connecting is unknown, disconnected is failing", () => {
    const connecting = buildDiagnosticBundle(input({ connection: "connecting" }));
    expect(connecting.subsystems[0]).toMatchObject({
      status: "unknown",
      reasonCode: "service-connecting",
    });
    expect(connecting.connection).toEqual({ state: "connecting" });
    const gone = buildDiagnosticBundle(input({ connection: "disconnected" }));
    expect(gone.subsystems[0]).toMatchObject({
      status: "failing",
      reasonCode: "service-unreachable",
    });
  });
});

describe("Test 2: explicit picks", () => {
  it("does not leak a key the input type does not name, at any depth", () => {
    const base = input();
    const sneaky = {
      ...base,
      projectNames: ["Orchard Ledger"],
      versions: { ...base.versions, path: `${HOME_LIKE}/bin` },
      features: { ...base.features, vaultName: "Field Notes" },
      health: { ...base.health, secret: "sk-ant-abcdefghijklmnopqrstuvwx" },
      pluginDiagnostics: [{ ...base.pluginDiagnostics[0], extra: `${HOME_LIKE}/x` }],
    } as unknown as DiagnosticBundleInput;
    const text = serialiseBundle(buildDiagnosticBundle(sneaky));
    for (const leaked of [
      "Orchard Ledger",
      "alice-example",
      "Field Notes",
      "sk-ant-",
      "extra",
      "secret",
    ]) {
      expect(text, leaked).not.toContain(leaked);
    }
  });

  it("keeps the input type to exactly the documented keys (a new key must be mapped to the schema on purpose)", () => {
    expectTypeOf<keyof DiagnosticBundleInput>().toEqualTypeOf<
      | "generatedAt"
      | "health"
      | "connection"
      | "vaultCheck"
      | "versions"
      | "platformArch"
      | "features"
      | "pluginDiagnostics"
    >();
    expectTypeOf<DiagnosticBundleInput["connection"]>().toEqualTypeOf<
      "live" | "connecting" | "disconnected"
    >();
    expect(Object.keys(input()).sort()).toEqual(
      [
        "connection",
        "features",
        "generatedAt",
        "health",
        "pluginDiagnostics",
        "platformArch",
        "vaultCheck",
        "versions",
      ].sort(),
    );
  });

  it("keeps the denylist input to the owner data it names and nothing else", () => {
    expectTypeOf<keyof DenylistInput>().toEqualTypeOf<
      "projectNames" | "folderBasenames" | "github" | "vaultName" | "userName"
    >();
    expect(Object.keys(emptyDenylist).sort()).toEqual(
      ["folderBasenames", "github", "projectNames", "userName", "vaultName"].sort(),
    );
  });

  it("skips plugin diagnostics the allowlist cannot hold instead of failing the export, and keeps the newest 100", () => {
    const records = [
      { source: "layout", code: "ok-code", message: "m", at: T0 },
      { source: "somewhere-else", code: "ok-code", message: "m", at: T0 },
      { source: "layout", code: "Has Space/Slash", message: "m", at: T0 },
      { source: "layout", code: "fine", message: "m", at: "not a time" },
    ];
    const bundle = buildDiagnosticBundle(input({ pluginDiagnostics: records }));
    expect(bundle.pluginDiagnostics).toEqual([{ source: "layout", code: "ok-code", at: T0 }]);
    expect(bundle.counts.pluginDiagnostics).toBe(1);

    const many = Array.from({ length: 130 }, (_, index) => ({
      source: "layout",
      code: `code-${index}`,
      message: "m",
      at: T0,
    }));
    const capped = buildDiagnosticBundle(input({ pluginDiagnostics: many }));
    expect(capped.pluginDiagnostics).toHaveLength(100);
    expect(capped.pluginDiagnostics[0]?.code).toBe("code-30");
    expect(capped.pluginDiagnostics.at(-1)?.code).toBe("code-129");
  });

  it("turns a version that is not a dotted version into null rather than passing text through", () => {
    const bundle = buildDiagnosticBundle(
      input({
        versions: {
          plugin: "0.1.0",
          obsidian: "latest build",
          electron: `${HOME_LIKE}/x`,
          node: null,
        },
      }),
    );
    expect(bundle.versions).toMatchObject({ obsidian: null, electron: null, node: null });
  });
});

describe("Test 3: the schema is strict at every level", () => {
  const base = () =>
    JSON.parse(JSON.stringify(buildDiagnosticBundle(input()))) as Record<string, any>;

  it("accepts the builder's own output", () => {
    expect(DiagnosticBundleSchema.safeParse(base()).success).toBe(true);
  });

  /** Sets `value` at a path of keys and indexes inside the plain bundle. */
  function setAt(
    bundle: Record<string, any>,
    path: readonly (string | number)[],
    value: unknown,
  ): void {
    let node: any = bundle;
    for (const key of path.slice(0, -1)) node = node[key];
    node[path.at(-1) as string | number] = value;
  }

  const refusals: ReadonlyArray<
    readonly [name: string, mutate: (bundle: Record<string, any>) => void]
  > = [
    ["an unknown top-level key", (b) => setAt(b, ["extra"], 1)],
    ["an unknown nested key", (b) => setAt(b, ["versions", "extra"], "x")],
    ["a wrong bundle version", (b) => setAt(b, ["bundleVersion"], 2)],
    ["a wrong enum for the connection", (b) => setAt(b, ["connection", "state"], "gone")],
    ["a connection.reason key", (b) => setAt(b, ["connection", "reason"], "ECONNREFUSED")],
    [
      "a message key on a plugin diagnostic",
      (b) => setAt(b, ["pluginDiagnostics", 0, "message"], "hello"),
    ],
    [
      "a plugin diagnostic code with a space",
      (b) => setAt(b, ["pluginDiagnostics", 0, "code"], "has space"),
    ],
    [
      "a plugin diagnostic code with a slash",
      (b) => setAt(b, ["pluginDiagnostics", 0, "code"], "has/slash"),
    ],
    [
      "a plugin diagnostic source outside the enum",
      (b) => setAt(b, ["pluginDiagnostics", 0, "source"], "other"),
    ],
    [
      "more than 100 plugin diagnostics",
      (b) =>
        setAt(
          b,
          ["pluginDiagnostics"],
          Array.from({ length: 101 }, () => ({ source: "layout", code: "a", at: T0 })),
        ),
    ],
    ["a path in a version", (b) => setAt(b, ["versions", "plugin"], "~/bin/plugin")],
    [
      "a status that disagrees with its reason",
      (b) => setAt(b, ["subsystems", 1, "status"], "failing"),
    ],
    [
      "a reason of another subsystem",
      (b) => setAt(b, ["subsystems", 2, "reasonCode"], "vault-ready"),
    ],
    ["a free-text reason", (b) => setAt(b, ["subsystems", 1, "reasonCode"], "the vault is fine")],
    [
      "a setupAction on a row",
      (b) => setAt(b, ["subsystems", 1, "setupAction"], { kind: "copy-command" }),
    ],
    ["facts on a part", (b) => setAt(b, ["subsystems", 3, "parts", 0, "facts"], { dropCount: 1 })],
    [
      "a part reason of another part",
      (b) => setAt(b, ["subsystems", 3, "parts", 0, "reasonCode"], "spool-clean"),
    ],
    ["a swapped subsystem order", (b) => b.subsystems.reverse()],
    ["only five subsystems", (b) => b.subsystems.pop()],
    ["a negative count", (b) => setAt(b, ["counts", "projects"], -1)],
    ["a fractional count", (b) => setAt(b, ["counts", "reports"], 1.5)],
    ["a string count", (b) => setAt(b, ["counts", "projects"], "3")],
    ["a non-UTC instant", (b) => setAt(b, ["generatedAt"], "2026-10-22T09:30:00+02:00")],
    [
      "a vault fingerprint member",
      (b) => setAt(b, ["vaultFingerprint"], { salt: "x", digest: "y" }),
    ],
    ["a display paths member", (b) => setAt(b, ["paths"], { vault: "~/x" })],
    ["a keychain member", (b) => setAt(b, ["keychain"], { researchKey: "present" })],
  ];
  for (const [name, mutate] of refusals) {
    it(`refuses ${name}`, () => {
      const bundle = base();
      mutate(bundle);
      expect(DiagnosticBundleSchema.safeParse(bundle).success).toBe(false);
    });
  }
});

describe("Test 4: the service is away", () => {
  it("builds a failing service row, five unknown service-not-running rows and null counts and service version, never zero", () => {
    const bundle = buildDiagnosticBundle(input({ health: null, connection: "disconnected" }));
    expect(bundle.subsystems[0]).toMatchObject({
      id: "service",
      status: "failing",
      reasonCode: "service-unreachable",
    });
    for (const row of bundle.subsystems.slice(1)) {
      expect(row).toMatchObject({
        status: "unknown",
        reasonCode: "service-not-running",
        checkedAt: null,
        freshness: "unavailable",
      });
      expect("parts" in row).toBe(false);
    }
    expect(bundle.counts).toEqual({
      projects: null,
      scanFolders: null,
      openTasks: null,
      reports: null,
      pluginDiagnostics: 1,
    });
    expect(bundle.versions.service).toBeNull();
    expect(bundle.versions.storeSchema).toBeNull();
    expect(DiagnosticBundleSchema.safeParse(bundle).success).toBe(true);
    expect(verifyBundle(bundle, buildDenylist(emptyDenylist))).toEqual({ ok: true });
  });

  it("carries a null store schema version through as null", () => {
    const withNull = health({
      service: { version: "0.1.0", startedAt: T0, storeSchemaVersion: null },
    });
    expect(buildDiagnosticBundle(input({ health: withNull })).versions.storeSchema).toBeNull();
  });
});
