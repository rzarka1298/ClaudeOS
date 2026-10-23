import type { ProjectsSnapshot, ProjectView } from "@ccc/domain";
import {
  BUNDLE_MAX_BYTES,
  buildDiagnosticBundle,
  serialiseBundle,
} from "@ccc/domain/diagnostic-bundle.js";
import { describe, expect, it, vi } from "vitest";
import { allOkHealth, healthResponse } from "../test-support/health-fixtures.js";
import {
  assembleBundleInput,
  assembleDenylistInput,
  type BundleSources,
  buildBundle,
  type DenylistSources,
  readRuntimeFacts,
} from "./bundle-input.js";

/**
 * The bundle input assembly (plan 08-16 Task 1, D-10, D-11): the plugin's facts go in by explicit
 * picks, the owner's private names go only into the denylist, and a plugin version the closed
 * shape refuses makes the export unavailable instead of inventing one.
 */

const NOW = Date.parse("2026-10-22T10:00:00.000Z");

// Canaries: invented, harmless, and impossible to confuse with anything a real bundle contains.
const CANARY_PROJECT = "Plumcellar Ledger";
const CANARY_FOLDER = "plumcellar-ledger";
const CANARY_OWNER = "quillowner";
const CANARY_REPO = "quillrepo";
const CANARY_VAULT = "Marrowvault";
const CANARY_USER = "zinnia-example";
const CANARY_MESSAGE = "Skipped the Plumcellar layout entry for zinnia-example";
const CANARY_REASON = "ECONNREFUSED quillsocket-canary";

function project(overrides: Partial<ProjectView> = {}): ProjectView {
  return {
    projectId: "project-1",
    displayName: CANARY_PROJECT,
    displayPath: `~/code/${CANARY_FOLDER}`,
    pinned: false,
    lastOpenedAt: null,
    observedAt: null,
    gitReadFailed: false,
    git: { kind: "pending" },
    github: {
      kind: "github",
      label: `github.com/${CANARY_OWNER}/${CANARY_REPO}`,
      source: "remote",
    },
    ...overrides,
  } as ProjectView;
}

const LAUNCHERS: ProjectsSnapshot["launchers"] = {
  antigravity: "set-up",
  "claude-code": { status: "tested", terminalLabel: "Terminal" },
  "claude-desktop": "not-set-up",
};

function sources(overrides: Partial<BundleSources> = {}): BundleSources {
  return {
    now: NOW,
    connection: "live",
    health: allOkHealth(),
    vaultCheck: "match",
    runtime: { obsidian: "1.13.1", electron: "37.2.0", node: "24.20.0", arch: "arm64" },
    pluginVersion: "0.1.0",
    settings: { reducedMotion: "auto", notifyApprovals: true },
    transcriptAnalysis: false,
    launchers: LAUNCHERS,
    diagnostics: [
      {
        source: "layout",
        code: "unknown-widget",
        message: CANARY_MESSAGE,
        at: "2026-10-22T09:00:00.000Z",
      },
    ],
    ...overrides,
  };
}

const DENY: DenylistSources = {
  projects: [project()],
  vaultName: CANARY_VAULT,
  userName: CANARY_USER,
};

describe("Task 1, Test 2: assembleBundleInput picks only the documented fields", () => {
  it("has exactly the eight input keys and the documented version, feature and launcher picks", () => {
    const input = assembleBundleInput(sources());
    expect(Object.keys(input).sort()).toEqual(
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
    expect(input.generatedAt).toBe("2026-10-22T10:00:00.000Z");
    expect(input.connection).toBe("live");
    expect(input.vaultCheck).toBe("match");
    expect(input.versions).toEqual({
      plugin: "0.1.0",
      obsidian: "1.13.1",
      electron: "37.2.0",
      node: "24.20.0",
    });
    expect(input.platformArch).toBe("arm64");
    expect(input.features).toEqual({
      reducedMotion: "auto",
      transcriptAnalysis: false,
      notifyApprovals: true,
      launchers: {
        antigravity: "set-up",
        "claude-code": "tested",
        "claude-desktop": "not-set-up",
        codex: null,
      },
    });
  });

  it("reads the notify-approvals default as on when the setting is absent, and unknown launchers as null", () => {
    const input = assembleBundleInput(
      sources({
        settings: { reducedMotion: "reduced", notifyApprovals: undefined },
        launchers: null,
      }),
    );
    expect(input.features.notifyApprovals).toBe(true);
    expect(input.features.reducedMotion).toBe("reduced");
    expect(input.features.launchers).toEqual({
      antigravity: null,
      "claude-code": null,
      "claude-desktop": null,
      codex: null,
    });
  });

  it("the projects, vault name, user name, connection reason and diagnostic messages never reach the bundle input", () => {
    // The connection reason is not a field of BundleSources at all; the rest are present and must not leak.
    const input = assembleBundleInput(sources());
    const text = JSON.stringify(input);
    for (const canary of [
      CANARY_PROJECT,
      CANARY_FOLDER,
      CANARY_OWNER,
      CANARY_REPO,
      CANARY_VAULT,
      CANARY_USER,
      CANARY_MESSAGE,
      CANARY_REASON,
      "Skipped",
    ]) {
      expect(text, canary).not.toContain(canary);
    }
    // The diagnostic record is reduced to source, code and time; the message slot is empty.
    expect(input.pluginDiagnostics).toEqual([
      { source: "layout", code: "unknown-widget", message: "", at: "2026-10-22T09:00:00.000Z" },
    ]);
  });

  it("the same canaries are absent from the built, verified text", () => {
    const outcome = buildBundle(sources(), DENY);
    expect(outcome.kind).toBe("offered");
    if (outcome.kind !== "offered") return;
    for (const canary of [CANARY_PROJECT, CANARY_FOLDER, CANARY_OWNER, CANARY_VAULT, CANARY_USER]) {
      expect(outcome.text.toLowerCase(), canary).not.toContain(canary.toLowerCase());
    }
  });

  it("the offered text is exactly the serialised domain bundle", () => {
    const s = sources();
    const outcome = buildBundle(s, DENY);
    expect(outcome.kind).toBe("offered");
    if (outcome.kind !== "offered") return;
    expect(outcome.text).toBe(serialiseBundle(buildDiagnosticBundle(assembleBundleInput(s))));
    expect(new TextEncoder().encode(outcome.text).length).toBeLessThanOrEqual(BUNDLE_MAX_BYTES);
  });
});

describe("assembleDenylistInput feeds only the owner's names", () => {
  it("collects display names, folder basenames, GitHub owner and repo, the vault name and the user name", () => {
    const input = assembleDenylistInput(DENY);
    expect(input.projectNames).toEqual([CANARY_PROJECT]);
    expect(input.folderBasenames).toEqual([CANARY_FOLDER]);
    expect(input.github).toEqual([{ owner: CANARY_OWNER, repo: CANARY_REPO }]);
    expect(input.vaultName).toBe(CANARY_VAULT);
    expect(input.userName).toBe(CANARY_USER);
  });

  it("takes the basename of a trailing-slash or bare path, and skips a project with no GitHub target", () => {
    const input = assembleDenylistInput({
      projects: [
        project({ displayPath: "~/code/trailing-dir/", github: { kind: "none" } }),
        project({ displayPath: "bare-folder", github: { kind: "none" } }),
      ],
      vaultName: null,
      userName: null,
    });
    expect(input.folderBasenames).toEqual(["trailing-dir", "bare-folder"]);
    expect(input.github).toEqual([]);
    expect(input.vaultName).toBeNull();
    expect(input.userName).toBeNull();
  });

  it("reads an override GitHub label the same way and ignores a label it cannot split", () => {
    const input = assembleDenylistInput({
      projects: [
        project({
          github: { kind: "github", label: "github.com/ovr-owner/ovr-repo", source: "override" },
        }),
        project({ github: { kind: "github", label: "no-slash-label", source: "remote" } }),
      ],
      vaultName: null,
      userName: null,
    });
    expect(input.github).toEqual([{ owner: "ovr-owner", repo: "ovr-repo" }]);
  });
});

describe("buildBundle outcomes", () => {
  it("is unavailable, never an invented version, when the plugin version is unknown or outside the closed shape", () => {
    expect(buildBundle(sources({ pluginVersion: null }), DENY)).toEqual({ kind: "unavailable" });
    expect(buildBundle(sources({ pluginVersion: "0.1.0-Plumcellar" }), DENY)).toEqual({
      kind: "unavailable",
    });
    expect(buildBundle(sources({ pluginVersion: "not a version" }), DENY)).toEqual({
      kind: "unavailable",
    });
  });

  it("a version the closed shape refuses reads null in the bundle rather than carrying the text", () => {
    const outcome = buildBundle(
      sources({
        runtime: { obsidian: "1.13.1-Plumcellar", electron: "x", node: null, arch: "ia32" },
      }),
      DENY,
    );
    expect(outcome.kind).toBe("offered");
    if (outcome.kind !== "offered") return;
    expect(outcome.text).not.toContain("Plumcellar");
    expect(outcome.text).not.toContain("ia32");
  });

  it("with the service away the health response is ignored and the bundle is still offered (D-03, R-16)", () => {
    const outcome = buildBundle(sources({ connection: "disconnected" }), DENY);
    expect(outcome.kind).toBe("offered");
    if (outcome.kind !== "offered") return;
    const parsed = JSON.parse(outcome.text) as { subsystems: { id: string; status: string }[] };
    const service = parsed.subsystems.find((row) => row.id === "service");
    expect(service?.status).toBe("failing");
    expect(
      parsed.subsystems
        .filter((row) => row.id !== "service")
        .every((row) => row.status === "unknown"),
    ).toBe(true);
  });

  it("reports the rule, never the value, when the verifier refuses", () => {
    const verify = vi.fn(() => ({ ok: false as const, rule: "denylist-project" as const }));
    const outcome = buildBundle(sources(), DENY, verify);
    expect(outcome).toEqual({ kind: "refused", rule: "denylist-project" });
    expect(JSON.stringify(outcome)).not.toContain(CANARY_PROJECT);
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it("offers only the text the verifier returned, never a second serialisation", () => {
    const verify = vi.fn(() => ({ ok: true as const, text: '{"verified":true}' }));
    expect(buildBundle(sources(), DENY, verify)).toEqual({
      kind: "offered",
      text: '{"verified":true}',
    });
  });

  it("works with a fresh-install health response too", () => {
    const outcome = buildBundle(sources({ health: healthResponse() }), DENY);
    expect(outcome.kind).toBe("offered");
  });
});

describe("readRuntimeFacts", () => {
  it("reads the Electron, Node and architecture facts from a process-like scope", () => {
    expect(
      readRuntimeFacts(
        { process: { versions: { electron: "37.2.0", node: "24.20.0" }, arch: "x64" } },
        "1.13.1",
      ),
    ).toEqual({ obsidian: "1.13.1", electron: "37.2.0", node: "24.20.0", arch: "x64" });
  });

  it("reads nulls where there is no process, an unknown architecture or a non-string version", () => {
    expect(readRuntimeFacts({}, null)).toEqual({
      obsidian: null,
      electron: null,
      node: null,
      arch: null,
    });
    expect(readRuntimeFacts({ process: { versions: { node: 24 }, arch: "ppc64" } }, null)).toEqual({
      obsidian: null,
      electron: null,
      node: null,
      arch: null,
    });
  });
});
