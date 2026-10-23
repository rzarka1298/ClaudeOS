import type { ProjectsSnapshot, ProjectView } from "@ccc/domain";
import {
  type BundleRefusalCode,
  buildDenylist,
  buildDiagnosticBundle,
  type DenylistInput,
  type DiagnosticBundleInput,
  verifyAndSerialise,
} from "@ccc/domain/diagnostic-bundle.js";
import type { DiagnosticsHealthResponse } from "@ccc/domain/diagnostics.js";
import type { ConnectionState } from "../connection-state.js";
import type { DiagnosticRecord } from "../diagnostics.js";
import type { MotionPreference } from "../motion.js";
import type { VaultCheck } from "./state.js";

/**
 * Assembles the diagnostic bundle's input and the owner's denylist in the plugin (plan 08-16,
 * D-10, D-11, D-13; ADR 0031 section 4 to 6). Pure: no DOM, no signal, no clock, no file.
 *
 * There are two separate doors and they never share a value. {@link assembleBundleInput} maps the
 * plugin's facts into the domain's narrow `DiagnosticBundleInput` by explicit picks: connection
 * KIND (never its reason text), versions, the setting flags, launcher status words, the service's
 * own health answer and the plugin diagnostic records reduced to source, code and time (the
 * message slot is left empty, so no sentence the plugin wrote can travel). {@link
 * assembleDenylistInput} collects the owner's private names (project display names, folder
 * basenames, GitHub owner and repository, the vault name, the macOS user name) for the verifier
 * ONLY; none of them is an input of the bundle.
 *
 * {@link buildBundle} then asks the domain for the one string that may be previewed, copied or
 * saved: `verifyAndSerialise(...).text`. Nothing else in the plugin serialises the bundle, so what
 * is shown is what was checked. A plugin version the closed shape refuses (the builder throws)
 * makes the export `unavailable`: a version is never invented.
 */

/** The Electron, Node, Obsidian and architecture facts the bundle reads; `null` when unknown. */
export interface RuntimeFacts {
  readonly obsidian: string | null;
  readonly electron: string | null;
  readonly node: string | null;
  readonly arch: string | null;
}

/** The shape of the global scope this module reads, kept structural so a test can pass a double. */
export interface RuntimeScope {
  readonly process?:
    | {
        readonly versions?: Readonly<Record<string, unknown>> | undefined;
        readonly arch?: unknown;
      }
    | undefined;
}

const SUPPORTED_ARCHITECTURES = ["arm64", "x64"] as const;
type Architecture = (typeof SUPPORTED_ARCHITECTURES)[number];

function architectureOf(value: unknown): Architecture | null {
  return SUPPORTED_ARCHITECTURES.find((arch) => arch === value) ?? null;
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Reads the runtime facts from `scope`. A missing `process`, or a value of the wrong type, is `null`. */
export function readRuntimeFacts(
  scope: RuntimeScope,
  obsidianVersion: string | null,
): RuntimeFacts {
  const proc = scope.process;
  return {
    obsidian: obsidianVersion,
    electron: textOrNull(proc?.versions?.electron),
    node: textOrNull(proc?.versions?.node),
    arch: architectureOf(proc?.arch),
  };
}

/**
 * {@link readRuntimeFacts} over this window's scope (Obsidian's renderer has `process`; the browser
 * harness does not, and every fact is then `null`). `window`, not `globalThis`, for popout windows.
 */
export function currentRuntimeFacts(obsidianVersion: string | null): RuntimeFacts {
  return readRuntimeFacts(window, obsidianVersion);
}

/** Everything the bundle is built from. Each field maps to a documented bundle field or to nothing. */
export interface BundleSources {
  /** The shared clock's "now" in epoch milliseconds: the bundle's `generatedAt`. */
  readonly now: number;
  /** The connection KIND only; its reason text is not a field here on purpose (D-43). */
  readonly connection: ConnectionState["kind"];
  /** The service's own answer, or `null` when there is none. Ignored by the builder unless live. */
  readonly health: DiagnosticsHealthResponse | null;
  readonly vaultCheck: VaultCheck;
  readonly runtime: RuntimeFacts;
  /** The plugin's manifest version, or `null` when unknown (the export is then unavailable). */
  readonly pluginVersion: string | null;
  readonly settings: {
    readonly reducedMotion: MotionPreference;
    readonly notifyApprovals: boolean | undefined;
  };
  readonly transcriptAnalysis: boolean | null;
  /** The projects snapshot's launcher summary, or `null` before one has arrived. */
  readonly launchers: ProjectsSnapshot["launchers"] | null;
  readonly diagnostics: readonly DiagnosticRecord[];
}

/** The owner's private names, for the verifier only. */
export interface DenylistSources {
  readonly projects: readonly ProjectView[];
  readonly vaultName: string | null;
  readonly userName: string | null;
}

/** The domain's input by explicit picks (D-10): nothing the schema does not name can come through. */
export function assembleBundleInput(src: BundleSources): DiagnosticBundleInput {
  return {
    generatedAt: new Date(src.now).toISOString(),
    health: src.health,
    connection: src.connection,
    vaultCheck: src.vaultCheck,
    versions: {
      plugin: src.pluginVersion ?? "",
      obsidian: src.runtime.obsidian,
      electron: src.runtime.electron,
      node: src.runtime.node,
    },
    platformArch: architectureOf(src.runtime.arch),
    features: {
      reducedMotion: src.settings.reducedMotion,
      transcriptAnalysis: src.transcriptAnalysis,
      notifyApprovals: src.settings.notifyApprovals ?? true,
      launchers: {
        antigravity: src.launchers?.antigravity ?? null,
        "claude-code": src.launchers?.["claude-code"].status ?? null,
        "claude-desktop": src.launchers?.["claude-desktop"] ?? null,
        // The projects snapshot carries no Codex launcher state; the bundle reads it as unknown.
        codex: null,
      },
    },
    // Source, code and time only: the plugin's own sentence is dropped here, before the domain.
    pluginDiagnostics: src.diagnostics.map((record) => ({
      source: record.source,
      code: record.code,
      message: "",
      at: record.at,
    })),
  };
}

/** The last non-empty path segment: `~/code/example/` and `example` both give `example`. */
function basenameOf(path: string): string | null {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  return segments[segments.length - 1] ?? null;
}

/** `github.com/owner/repo` or `owner/repo` to its two names; anything else is skipped. */
function githubNamesOf(label: string): { owner: string; repo: string } | null {
  const parts = label.split("/").filter((part) => part.length > 0);
  if (parts.length === 3 && parts[0] === "github.com") {
    return { owner: parts[1] as string, repo: parts[2] as string };
  }
  if (parts.length === 2) return { owner: parts[0] as string, repo: parts[1] as string };
  return null;
}

/** The names the verifier must refuse. These never enter the bundle input. */
export function assembleDenylistInput(src: DenylistSources): DenylistInput {
  const projectNames: string[] = [];
  const folderBasenames: string[] = [];
  const github: { owner: string; repo: string }[] = [];
  for (const project of src.projects) {
    projectNames.push(project.displayName);
    const folder = basenameOf(project.displayPath);
    if (folder !== null) folderBasenames.push(folder);
    if (project.github.kind === "github") {
      const names = githubNamesOf(project.github.label);
      if (names !== null) github.push(names);
    }
  }
  return {
    projectNames,
    folderBasenames,
    github,
    vaultName: src.vaultName,
    userName: src.userName,
  };
}

/** What building the bundle came to. */
export type BundleOutcome =
  | { readonly kind: "offered"; readonly text: string }
  | { readonly kind: "refused"; readonly rule: BundleRefusalCode }
  | { readonly kind: "unavailable" };

/** The domain's single verified serialisation entry point; a parameter so a test can force a refusal. */
export type VerifyAndSerialise = typeof verifyAndSerialise;

/**
 * Builds, verifies and serialises once. `offered.text` is the only string the preview, Copy and
 * Save may use. A refusal carries the rule's code and never a value.
 */
export function buildBundle(
  src: BundleSources,
  deny: DenylistSources,
  verify: VerifyAndSerialise = verifyAndSerialise,
): BundleOutcome {
  if (src.pluginVersion === null) return { kind: "unavailable" };
  let bundle: ReturnType<typeof buildDiagnosticBundle>;
  try {
    bundle = buildDiagnosticBundle(assembleBundleInput(src));
  } catch {
    // The builder refuses a plugin version outside the closed shape (and a time that does not
    // parse): the export is unavailable rather than carrying an invented value.
    return { kind: "unavailable" };
  }
  const result = verify(bundle, buildDenylist(assembleDenylistInput(deny)));
  return result.ok
    ? { kind: "offered", text: result.text }
    : { kind: "refused", rule: result.rule };
}
