import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as domain from "@ccc/domain";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

/**
 * Plan 05.1-29 Task 3: the cross-package wiring of the Codex surface, audited by TABLE. Every
 * table below is derived from a live export or the live source of the package that owns it (the
 * client module's export list, the served route tables, the classification table, the plugin's
 * handler map, the domain event list), never hand-listed, so a later addition without its
 * counterpart fails here. No process or network is involved except the named re-runs of existing
 * parity tests and the browser bundling check.
 *
 * The served route tables and the hook constants are read from the BUILT packages (`dist`), the
 * form the real service and hook run in: this package may not import service internals, and
 * `pnpm exec turbo run build` is part of the plan's verify command.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requireFromHere = createRequire(import.meta.url);

async function importBuilt(relative: string): Promise<Record<string, unknown>> {
  const file = join(REPO_ROOT, relative);
  expect(existsSync(file), `${relative} is built (run the turbo build first)`).toBe(true);
  return (await import(pathToFileURL(file).href)) as Record<string, unknown>;
}

function sourceFilesUnder(root: string, accept: (name: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules" && entry.name !== "dist") {
        out.push(...sourceFilesUnder(full, accept));
      }
    } else if (accept(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const isProductionSource = (name: string): boolean =>
  /\.(ts|tsx)$/.test(name) && !/\.(test|audit\.test|d)\.(ts|tsx)$/.test(name);

type RouteTable = Record<string, Record<string, unknown>>;

describe("Test 5 (audit): every Codex client function maps to a served route, and every route has a caller", () => {
  interface Call {
    readonly method: string;
    readonly path: string;
  }

  /** Inputs tried, in order, for a client function that needs a request object. */
  const SAMPLE_REQUESTS: readonly unknown[] = [
    undefined,
    { threadId: "thread-audit-0001", via: "reveal" },
    { runId: "20261010T120000123Z" },
    { projectId: "abcdefghi0123456789abcdef" },
  ];

  async function clientCalls(): Promise<Map<string, Call>> {
    const codexClient = await importBuilt("packages/service-api-client/dist/codex-client.js");
    const barrel = (await import("@ccc/service-api-client")) as Record<string, unknown>;
    const calls: Call[] = [];
    const recorder = {
      request: async (options: { method: string; path: string }) => {
        calls.push({ method: options.method, path: options.path });
        return { status: 500, body: {} };
      },
    };
    const byFunction = new Map<string, Call>();
    for (const [name, value] of Object.entries(codexClient)) {
      if (typeof value !== "function") continue;
      if (/^class\b/.test(Function.prototype.toString.call(value))) continue;
      // The package barrel is what the plugin imports: every client function is exported from it.
      expect(typeof barrel[name], `${name} is exported from the package entry`).toBe("function");
      calls.length = 0;
      for (const sample of SAMPLE_REQUESTS) {
        try {
          await (value as (client: unknown, request?: unknown) => Promise<unknown>)(
            recorder,
            sample,
          );
        } catch {
          // The recorder answers a 500: the call is expected to throw after recording.
        }
        if (calls.length > 0) break;
      }
      const first = calls[0];
      if (first === undefined) throw new Error(`cannot drive client function ${name}`);
      byFunction.set(name, first);
    }
    return byFunction;
  }

  it("sends every client function to a path and verb that the composed tables serve", async () => {
    const byFunction = await clientCalls();
    expect(byFunction.size).toBeGreaterThanOrEqual(9);
    const codexTable = (await importBuilt("packages/service/dist/codex/routes.js"))
      .codexRouteTable as RouteTable;
    const launchTable = (await importBuilt("packages/service/dist/projects/launch-routes.js"))
      .launchRoutes as RouteTable;
    const served = { ...codexTable, ...launchTable };
    for (const [name, call] of byFunction) {
      expect(
        Object.keys(served[call.path] ?? {}),
        `${name} -> ${call.method} ${call.path}`,
      ).toContain(call.method);
    }
  });

  it("reaches every Codex route with some client function, except the hook-events route the hook calls", async () => {
    const byFunction = await clientCalls();
    const reached = new Set([...byFunction.values()].map((call) => `${call.method} ${call.path}`));
    const codexTable = (await importBuilt("packages/service/dist/codex/routes.js"))
      .codexRouteTable as RouteTable;
    const paths = Object.keys(codexTable);
    expect(paths.length).toBe(9);
    for (const [path, verbs] of Object.entries(codexTable)) {
      for (const method of Object.keys(verbs)) {
        if (path === domain.CODEX_HOOK_EVENTS_PATH) continue;
        expect(
          reached.has(`${method} ${path}`),
          `no client function reaches ${method} ${path}`,
        ).toBe(true);
      }
    }
    // The hook route is not reachable from the plugin client at all (the hook is its only caller).
    expect([...reached].some((entry) => entry.endsWith(domain.CODEX_HOOK_EVENTS_PATH))).toBe(false);
  });

  it("serves exactly the paths the domain constants name (and every constant is served)", async () => {
    const constants = Object.entries(domain)
      .filter(([name, value]) => /^CODEX_[A-Z_]+_PATH$/.test(name) && typeof value === "string")
      .map(([, value]) => value as string)
      .sort();
    const codexTable = (await importBuilt("packages/service/dist/codex/routes.js"))
      .codexRouteTable as RouteTable;
    expect(Object.keys(codexTable).sort()).toEqual(constants);
  });
});

describe("Test 6 (audit): every capability the Codex UI can emit is classified, and the reserved row is the hook install one", () => {
  const PLUGIN_SRC = join(REPO_ROOT, "packages", "plugin", "src");

  /** Capability-shaped string literals in production plugin source that name Codex. */
  function emittedCodexCapabilities(): Set<string> {
    const found = new Set<string>();
    for (const file of sourceFilesUnder(PLUGIN_SRC, isProductionSource)) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(
        /["'`]((?:launch|codex|connect|hooks?):[a-z0-9-]+)["'`]/g,
      )) {
        const capability = match[1] ?? "";
        if (/codex/i.test(capability)) found.add(capability);
      }
    }
    return found;
  }

  it("finds the Codex capabilities the plugin emits (the scan is not vacuous)", () => {
    const emitted = emittedCodexCapabilities();
    for (const expected of [
      "codex:open-transcript",
      "codex:follow-log",
      "launch:claude-codex-pair",
    ]) {
      expect(emitted.has(expected), expected).toBe(true);
    }
  });

  it("classifies each emitted capability and maps it to an operation row", () => {
    for (const capability of emittedCodexCapabilities()) {
      const classified = domain.classifyCapability(capability);
      expect(classified, `${capability} has a classification`).toBeDefined();
      if (capability.startsWith("connect:")) {
        expect(domain.CAPABILITY_FAMILY_OPERATION["connect:"]).toBe(classified?.operation);
      } else {
        expect(
          domain.CAPABILITY_OPERATION[capability],
          `${capability} has an operation entry`,
        ).toBe(classified?.operation);
      }
      // Nothing the Codex UI emits is approval-required except through the reserved install row.
      expect(classified?.row.class).not.toBe("approval-required");
    }
    // The Codex launch id has an operation entry even though the plugin has no arm for it (UI-SPEC R-12).
    expect(domain.CAPABILITY_OPERATION["launch:codex"]).toBe("launch.codex");
  });

  it("reserves exactly one Codex row, the hook install, and no plugin descriptor emits it", () => {
    const reserved = Object.entries(domain.CLASSIFICATION)
      .filter(([name, row]) => /codex/i.test(name) && "status" in row && row.status === "reserved")
      .map(([name]) => name);
    expect(reserved).toEqual(["codex.hooks.install"]);
    expect(domain.CLASSIFICATION["codex.hooks.install"]).toMatchObject({
      class: "approval-required",
      status: "reserved",
    });
    // Installing is the owner-run script: no descriptor names an install capability. If one is ever
    // added it must map to the reserved row, which this check then demands.
    const installCapabilities = [...emittedCodexCapabilities()].filter((c) => /install/.test(c));
    for (const capability of installCapabilities) {
      expect(domain.CAPABILITY_OPERATION[capability]).toBe("codex.hooks.install");
    }
  });
});

describe("Test 7 (audit): every Codex event has a plugin handler and a strict schema, and the duplicated constants agree", () => {
  const codexEventTypes = domain.SERVICE_EVENT_TYPES.filter((type) => type.startsWith("codex."));

  it("routes every Codex event type to a plugin handler", () => {
    const router = readFileSync(
      join(REPO_ROOT, "packages", "plugin", "src", "service-event-router.ts"),
      "utf8",
    );
    const handled = new Set([...router.matchAll(/["'](codex\.[a-z.]+)["']\s*:/g)].map((m) => m[1]));
    expect(codexEventTypes.length).toBe(4);
    for (const type of codexEventTypes) expect(handled.has(type), type).toBe(true);
    expect([...handled].sort()).toEqual([...codexEventTypes].sort());
  });

  it("has a payload schema per event type, and the snapshot member is exactly those parts", () => {
    const schemaName = (type: string): string =>
      type
        .split(".")
        .map((part) => part[0]?.toUpperCase() + part.slice(1))
        .join("")
        .concat("PayloadSchema");
    const parts = new Set<string>();
    for (const type of codexEventTypes) {
      const schema = (domain as Record<string, unknown>)[schemaName(type)] as
        | { safeParse(input: unknown): { success: boolean } }
        | undefined;
      expect(schema, `${schemaName(type)} for ${type}`).toBeDefined();
      // Strict: the schema refuses an unknown member and an empty payload.
      expect(
        schema?.safeParse({ unknownMember: true }).success,
        `${type} refuses an unknown member`,
      ).toBe(false);
      expect(schema?.safeParse({}).success, `${type} refuses an empty payload`).toBe(false);
    }
    // The usage event carries two parts (the usage snapshot and the headroom signal); the others one.
    parts.add("sessions").add("tokens").add("integration");
    for (const key of Object.keys(domain.CodexUsageUpdatedPayloadSchema.shape)) parts.add(key);
    expect(Object.keys(domain.CodexSnapshotStateSchema.shape).sort()).toEqual([...parts].sort());
    // The three single-part events reuse the snapshot part's own schema, so they cannot drift.
    expect(domain.CodexSessionsUpdatedPayloadSchema).toBe(
      domain.CodexSnapshotStateSchema.shape.sessions.unwrap(),
    );
    expect(domain.CodexTokensUpdatedPayloadSchema).toBe(
      domain.CodexSnapshotStateSchema.shape.tokens.unwrap(),
    );
    expect(domain.CodexIntegrationUpdatedPayloadSchema).toBe(
      domain.CodexSnapshotStateSchema.shape.integration.unwrap(),
    );
  });

  it("keeps the hook's duplicated wire constants equal to their sources", async () => {
    const codexHook = await importBuilt("packages/collectors/dist/codex-hook/limits.js");
    const claudeHook = await importBuilt("packages/collectors/dist/hook/limits.js");
    const spool = await importBuilt("packages/service/dist/codex/hook-spool.js");
    expect(codexHook.CODEX_HOOK_EVENTS_PATH).toBe(domain.CODEX_HOOK_EVENTS_PATH);
    expect(codexHook.CODEX_SPOOL_FILE_NAME).toBe(spool.CODEX_HOOK_SPOOL_FILE_NAME);
    expect(codexHook.CODEX_SPOOL_DROP_FILE_NAME).toBe(spool.CODEX_HOOK_DROP_FILE_NAME);
    expect(codexHook.CODEX_SPOOL_FILES).toEqual({
      file: spool.CODEX_HOOK_SPOOL_FILE_NAME,
      dropFile: spool.CODEX_HOOK_DROP_FILE_NAME,
    });
    expect(claudeHook.HANDSHAKE_PATH).toBe(domain.HANDSHAKE_PATH);
    // Every other constant the Codex hook module shares by name with the domain agrees too.
    for (const [name, value] of Object.entries(codexHook)) {
      if (
        typeof value === "string" &&
        typeof (domain as Record<string, unknown>)[name] === "string"
      ) {
        expect(value, name).toBe((domain as Record<string, unknown>)[name]);
      }
    }
  });
});

describe("Test 7b (audit): the existing parity tests, re-run by name", () => {
  function runNamed(
    packageDir: string,
    file: string,
  ): Promise<{ status: number | null; output: string }> {
    return new Promise((done) => {
      const child = spawn("pnpm", ["exec", "vitest", "run", file], {
        cwd: join(REPO_ROOT, "packages", packageDir),
        env: { ...process.env, CI: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
      });
      child.on("close", (status) => done({ status, output }));
    });
  }

  const NAMED: ReadonlyArray<readonly [string, string, string]> = [
    ["domain", "src/classification.test.ts", "the Phase 6 classification exhaustiveness tests"],
    [
      "plugin",
      "src/widgets/quick-actions.test.ts",
      "the dispatcher outcome and Codex prefix tests",
    ],
    ["collectors", "src/codex-hook/limits.test.ts", "the hook constants parity test"],
    [
      "test-fixtures",
      "src/bridge-protocol-parity.test.ts",
      "the launchers and bridge-core parity test",
    ],
    ["test-fixtures", "src/codex-guard-parity.test.ts", "the guard parity test"],
  ];

  for (const [packageDir, file, label] of NAMED) {
    it(`${label} (${packageDir}/${file}) still passes`, async () => {
      const result = await runNamed(packageDir, file);
      expect(result.status, result.output.slice(-1500)).toBe(0);
    }, 180_000);
  }
});

describe("Test 8 (audit): every package entry the plugin uses resolves, and the plugin graph bundles for a browser", () => {
  it("resolves each @ccc import specifier of the production plugin source, including deep paths", () => {
    const specifiers = new Set<string>();
    for (const file of sourceFilesUnder(
      join(REPO_ROOT, "packages", "plugin", "src"),
      isProductionSource,
    )) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/from\s+["'](@ccc\/[a-z-]+(?:\/[A-Za-z0-9./*-]+)?)["']/g)) {
        specifiers.add(match[1] ?? "");
      }
    }
    expect(specifiers.size).toBeGreaterThan(2);
    for (const specifier of specifiers) {
      let resolved: string | undefined;
      try {
        resolved = requireFromHere.resolve(specifier);
      } catch {
        resolved = undefined;
      }
      expect(resolved, `${specifier} resolves from the harness graph`).toBeDefined();
      expect(statSync(resolved ?? "").isFile(), specifier).toBe(true);
    }
  });

  it("bundles the harness entry for a browser: no Node built-in is reachable from the plugin barrel", async () => {
    const result = await build({
      absWorkingDir: PACKAGE_DIR,
      entryPoints: ["harness/main.tsx"],
      bundle: true,
      format: "iife",
      platform: "browser",
      target: "es2022",
      jsx: "automatic",
      jsxImportSource: "preact",
      write: false,
      logLevel: "silent",
    });
    expect(result.errors).toEqual([]);
    const text = result.outputFiles.map((file) => file.text).join("\n");
    expect(text.length).toBeGreaterThan(10_000);
    expect(
      /\brequire\(["']node:|from ["']node:|require\(["'](fs|path|child_process|http|net)["']\)/.test(
        text,
      ),
    ).toBe(false);
  }, 120_000);
});
