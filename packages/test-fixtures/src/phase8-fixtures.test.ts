// The Phase 8 harness fixtures are synthetic and nothing else (plan 08-21, PRIV-04, threat T-08-52,
// UI-SPEC "Visual regression and fixtures").
//
// Every string in `harness/settings-fixtures.json`, `diagnostics-fixtures.json` and
// `overview-fixtures.json` becomes pixels in a committed baseline, and a pixel cannot be scanned for
// a leaked address, so the TEXT is held to the same discipline as the Research fixtures:
//
//   1. every service-shaped payload parses against the strict domain schema the service sends, so a
//      fixture can never describe a state the service could not produce;
//   2. no string has the shape of an e-mail address, a key, a token or a real home path (the one
//      placeholder user segment the privacy scanner accepts is the only home form allowed), every
//      web address uses a reserved `.invalid` host;
//   3. every health answer builds a diagnostic bundle with the REAL builder and verifies it with
//      the real verifier, and a forced refusal is the only way to get one refused.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeIntegrationStatusSchema } from "@ccc/domain/claude-integration.js";
import { CodexIntegrationStatusSchema } from "@ccc/domain/codex-integration.js";
import {
  buildDenylist,
  buildDiagnosticBundle,
  verifyAndSerialise,
} from "@ccc/domain/diagnostic-bundle.js";
import { DiagnosticsHealthResponseSchema } from "@ccc/domain/diagnostics.js";
import { DetectionResponseSchema } from "@ccc/domain/launch.js";
import { ScanStateResponseSchema } from "@ccc/domain/projects.js";
import { ResearchStatusResponseSchema } from "@ccc/domain/research-routes.js";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const HARNESS_DIR = resolve(HERE, "..", "harness");

function load(name: string): { readonly text: string; readonly value: Record<string, unknown> } {
  const text = readFileSync(join(HARNESS_DIR, name), "utf8");
  return { text, value: JSON.parse(text) as Record<string, unknown> };
}

/** Every string in a document with the path it sits at. */
function collectStrings(
  value: unknown,
  path: string,
  into: { path: string; text: string }[] = [],
): { path: string; text: string }[] {
  if (typeof value === "string") into.push({ path, text: value });
  else if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      collectStrings(entry, `${path}[${index}]`, into);
    });
  } else if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) collectStrings(entry, `${path}.${key}`, into);
  }
  return into;
}

const FIXTURE_FILES = ["settings-fixtures.json", "diagnostics-fixtures.json"] as const;

const settings = load("settings-fixtures.json");
const diagnostics = load("diagnostics-fixtures.json");

/** The synthetic home the fixtures use: the one placeholder segment the privacy scanner accepts. */
const PLACEHOLDER_HOME = "/Users/username/";

describe("Task 1 (schemas): every service-shaped payload parses against the strict domain schema", () => {
  it("parses the Claude and Codex integration statuses, the research status and the scan state", () => {
    expect(ClaudeIntegrationStatusSchema.safeParse(settings.value.claude).success).toBe(true);
    expect(CodexIntegrationStatusSchema.safeParse(settings.value.codex).success).toBe(true);
    expect(ResearchStatusResponseSchema.safeParse(settings.value.research).success).toBe(true);
    expect(ScanStateResponseSchema.safeParse(settings.value.scan).success).toBe(true);
    expect(DetectionResponseSchema.safeParse(settings.value.detection).success).toBe(true);
  });

  it("parses the Settings health answer and every Diagnostics health answer", () => {
    const answers: [string, unknown][] = [
      ["settings", settings.value.health],
      ...Object.entries(diagnostics.value.responses as Record<string, unknown>),
    ];
    expect(answers.length).toBeGreaterThanOrEqual(4);
    for (const [name, answer] of answers) {
      const parsed = DiagnosticsHealthResponseSchema.safeParse(answer);
      expect(parsed.success, `${name}: ${parsed.success ? "" : parsed.error.message}`).toBe(true);
    }
  });

  it("covers every status kind in the mixed answer and a fresh install with no failing or degraded row", () => {
    const responses = diagnostics.value.responses as Record<string, unknown>;
    const mixed = DiagnosticsHealthResponseSchema.parse(responses.mixed);
    const kinds = new Set(mixed.rows.map((row) => row.status));
    for (const kind of ["setup-needed", "degraded", "failing", "unknown"] as const) {
      expect(kinds.has(kind), kind).toBe(true);
    }
    const fresh = DiagnosticsHealthResponseSchema.parse(responses.fresh);
    expect(fresh.rows.some((row) => row.status === "failing" || row.status === "degraded")).toBe(
      false,
    );
  });
});

describe("Task 1 (privacy): synthetic data only (PRIV-04, T-08-52)", () => {
  const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)\]]+/gi;

  it("uses a reserved .invalid host in every web address", () => {
    for (const file of FIXTURE_FILES) {
      const document = load(file).value;
      for (const { path, text } of collectStrings(document, "$")) {
        for (const match of text.matchAll(URL_PATTERN)) {
          const host = (
            match[0].slice(match[0].indexOf("://") + 3).split(/[/?#]/)[0] ?? ""
          ).toLowerCase();
          expect(host.endsWith(".invalid"), `${file} ${path}: ${match[0]}`).toBe(true);
        }
      }
    }
  });

  it("has no e-mail address, key, token, credential header or real home path in any string", () => {
    const FORBIDDEN: readonly [string, RegExp][] = [
      ["an e-mail address", /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/],
      ["an Anthropic or OpenAI key", /\bsk-[A-Za-z0-9_-]{16,}/],
      ["a GitHub token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/],
      ["an AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
      ["a private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
      ["a JSON web token", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./],
      ["a credential header", /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/],
    ];
    for (const file of FIXTURE_FILES) {
      for (const { path, text } of collectStrings(load(file).value, "$")) {
        for (const [what, pattern] of FORBIDDEN) {
          expect(pattern.test(text), `${file} ${path} looks like ${what}`).toBe(false);
        }
        // Home paths: only the scanner's placeholder segment is allowed.
        const withoutPlaceholder = text.replaceAll(PLACEHOLDER_HOME, "");
        expect(
          /\/(?:Users|home)\/[A-Za-z0-9._-]+\/|[A-Za-z]:\\Users\\/.test(withoutPlaceholder),
          `${file} ${path} names a real home path`,
        ).toBe(false);
        // A long unbroken run of base64 characters that is not plain hex is key-shaped.
        for (const run of text.match(/[A-Za-z0-9+=_]{40,}/g) ?? []) {
          expect(/^[0-9a-f]+$/.test(run), `${file} ${path}: key-shaped run`).toBe(true);
        }
      }
    }
  });

  it("shows only display paths (~/…) to the sections, and the placeholder home only in the host inputs", () => {
    const display = settings.value.display as Record<string, string | null>;
    expect(display.homeDir).toBe("/Users/username");
    for (const [key, value] of Object.entries(display)) {
      if (value?.startsWith("/Users/") === true) {
        expect(["homeDir", "socketPath", "vaultBasePath"], key).toContain(key);
        expect(value.startsWith(PLACEHOLDER_HOME.slice(0, -1)), key).toBe(true);
      }
    }
    const answers = [
      settings.value.health,
      ...Object.values(diagnostics.value.responses as Record<string, unknown>),
    ];
    for (const answer of answers) {
      const parsed = DiagnosticsHealthResponseSchema.parse(answer);
      for (const path of [parsed.paths.vault, parsed.paths.runtimeDir, parsed.paths.socket]) {
        if (path !== null) expect(path.startsWith("~/"), path).toBe(true);
      }
    }
  });
});

describe("Task 1 (bundle): every health answer builds a bundle with the real builder, and it verifies", () => {
  const DENY = buildDenylist({
    projectNames: ["sample-app", "demo-library"],
    folderBasenames: ["ExampleProjects"],
    github: [],
    vaultName: "ExampleVault",
    userName: "exampleuser",
  });

  function bundleFor(health: unknown, connection: "live" | "disconnected") {
    return buildDiagnosticBundle({
      generatedAt: "2026-10-22T09:00:30.000Z",
      health: connection === "live" ? DiagnosticsHealthResponseSchema.parse(health) : null,
      connection,
      vaultCheck: "match",
      versions: { plugin: "0.1.0", obsidian: "1.13.1", electron: null, node: null },
      platformArch: null,
      features: {
        reducedMotion: "auto",
        transcriptAnalysis: true,
        notifyApprovals: true,
        launchers: { antigravity: null, "claude-code": null, "claude-desktop": null, codex: null },
      },
      pluginDiagnostics: [],
    });
  }

  it("verifies a bundle built from each answer, and from no answer at all", () => {
    const answers = Object.entries(diagnostics.value.responses as Record<string, unknown>);
    for (const [name, answer] of answers) {
      const result = verifyAndSerialise(bundleFor(answer, "live"), DENY);
      expect(result.ok, `${name} bundle`).toBe(true);
      if (result.ok) expect(result.text).toContain("bundleVersion");
    }
    const away = verifyAndSerialise(bundleFor(null, "disconnected"), DENY);
    expect(away.ok).toBe(true);
  });
});
