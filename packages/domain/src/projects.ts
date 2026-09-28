import path from "node:path";
import { z } from "zod";
import { API_BASE } from "./api.js";
import type { ProjectId, ScanRootId } from "./ids.js";

/**
 * Project, scan-root and projects-snapshot contracts (Phase 4, ADR-0003).
 *
 * The one invariant every schema here serves (D-01, D-43): **the
 * plugin-facing view carries a ProjectId, a display name and a
 * home-abbreviated displayPath only; the absolute path never leaves the
 * service.** A project's absolute path is private configuration that lives
 * in the `0700` operational store and nowhere else. Launch and management
 * requests therefore address a project by its {@link ProjectId}, never by a
 * path (D-06): a path in a request body would let any caller name any
 * directory on disk.
 *
 * Event payloads are deltas, not snapshots (D-50, RESEARCH Pattern 4): the
 * `projects.updated` event carries what changed, and `GET /snapshot`'s
 * `state.projects` carries the whole picture. The payload schemas live here,
 * not in `events.ts`, so the parallel Phase 5 branch appends its own lines to
 * that shared file without touching these.
 *
 * Rejected alternative: sending the absolute path to the plugin and letting
 * it abbreviate for display. That puts the path in plugin memory, in any
 * Notice or log line that stringifies a view, and in every screenshot of a
 * debug panel; abbreviating in the service means there is nothing to leak.
 */

/** The longest path the service will accept (macOS `PATH_MAX`). */
export const MAX_PATH_LENGTH = 4096;

/**
 * True when `value` contains a C0 control character (U+0000–U+001F) or DEL
 * (U+007F). Checked by code point rather than with a regular expression so
 * the source stays free of control-character escapes the linter rejects.
 * A newline in a path, a display name or an argv element is how one value
 * becomes two lines in a generated script or a log (D-04, D-22, T-04-01).
 */
export function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/**
 * An absolute filesystem path arriving from an untrusted request body.
 * Existence is deliberately NOT checked here — that is the service's
 * registration policy (realpath, protected locations, vault root), which
 * needs the filesystem this package may not touch.
 */
export const AbsolutePathSchema = z
  .string()
  .min(1)
  .max(MAX_PATH_LENGTH)
  .refine((value) => !value.includes("\0"), { message: "path must not contain a NUL byte" })
  .refine((value) => !hasControlCharacter(value), {
    message: "path must not contain a control character",
  })
  .refine((value) => path.isAbsolute(value), { message: "path must be an absolute path" });

/**
 * Folders macOS guards with TCC or that are rarely a project's real home;
 * registering one needs an explicit acknowledgement (D-03). A location is
 * named by this enum, never by its path, when it crosses the wire.
 * `cloud-storage` is `~/Library/CloudStorage`, where File Provider clients
 * (third-party cloud drives) mount — a TCC category of its own (RESEARCH
 * D-29 list).
 */
export const PROTECTED_LOCATIONS = [
  "documents",
  "desktop",
  "downloads",
  "icloud-drive",
  "cloud-storage",
] as const;
export type ProtectedLocation = (typeof PROTECTED_LOCATIONS)[number];
export const ProtectedLocationSchema = z.enum(PROTECTED_LOCATIONS);

/**
 * A ProjectId on the wire: the {@link newProjectId} shape exactly, branded
 * on the way in so a parsed view's `projectId` is usable as a `ProjectId`.
 */
export const ProjectIdSchema = z
  .string()
  .regex(/^[0-9a-z]{9}[0-9a-f]{16}$/)
  .transform((value) => value as ProjectId);

/** `POST /api/v1/projects/register` — register one folder as a project (PROJ-01). */
export const PROJECT_REGISTER_PATH = `${API_BASE}/projects/register`;

/**
 * The register body. `.strict()` so a caller cannot smuggle a display name,
 * a workspace binding or anything else through this route; the service
 * derives the display name from the folder itself.
 */
export const RegisterProjectRequestSchema = z
  .object({
    path: AbsolutePathSchema,
    acknowledgeProtectedLocation: z.boolean().optional(),
  })
  .strict();
export type RegisterProjectRequest = z.infer<typeof RegisterProjectRequestSchema>;

/**
 * The three register outcomes. `already-registered` is a success, not an
 * error — registering the same realpath twice is idempotent (PROJ-01).
 * `protected-location` asks the plugin to confirm and resend with
 * `acknowledgeProtectedLocation: true`.
 */
export const RegisterProjectResponseSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("registered"), projectId: ProjectIdSchema }),
  z.object({ kind: z.literal("already-registered"), projectId: ProjectIdSchema }),
  z.object({ kind: z.literal("protected-location"), location: ProtectedLocationSchema }),
]);
export type RegisterProjectResponse = z.infer<typeof RegisterProjectResponseSchema>;

/** One recent commit. The subject is display text only and is never persisted (D-46). */
export const GitCommitSchema = z.object({
  hash: z.string().regex(/^[0-9a-f]{7,40}$/),
  subject: z.string().max(1000),
  committedAt: z.string(),
});
export type GitCommit = z.infer<typeof GitCommitSchema>;

/**
 * A remote reduced to host plus repository path, for display only. Any
 * userinfo (`user:token@`) has already been stripped by the service; no
 * URL string crosses the wire (PROJ-14).
 */
export const GitRemoteSchema = z.object({
  host: z.string().max(253),
  path: z.string().max(512),
});
export type GitRemote = z.infer<typeof GitRemoteSchema>;

/**
 * Every state a project's git read can be in (UI-SPEC Glyph Vocabulary).
 * `pending` is "not read yet" — distinct from every failure, so the UI never
 * invents a clean tree before git has answered. `skipped` records that the
 * repository's local config names commands git would run on read
 * (`core.fsmonitor` and friends), so the service refused to read it.
 */
export const ProjectGitStateSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("repo"),
    branch: z.string().max(255).nullable(),
    detached: z.boolean(),
    dirty: z.boolean(),
    commits: z.array(GitCommitSchema).max(5),
    remote: GitRemoteSchema.nullable(),
  }),
  z.object({ kind: z.literal("not-a-repo") }),
  z.object({ kind: z.literal("git-unavailable") }),
  z.object({ kind: z.literal("skipped"), reason: z.literal("local-config-commands") }),
  z.object({ kind: z.literal("folder-access-denied") }),
  z.object({ kind: z.literal("folder-missing") }),
  z.object({ kind: z.literal("pending") }),
]);
export type ProjectGitState = z.infer<typeof ProjectGitStateSchema>;

/**
 * Where the GitHub action would go, as a display label only (for example
 * `github.com/owner/repo`). The service rebuilds the URL at launch time from
 * its own stored data, so no URL string travels to the plugin (PROJ-14).
 */
export const GithubTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({
    kind: z.literal("github"),
    label: z.string().min(1).max(400),
    source: z.enum(["remote", "override"]),
  }),
]);
export type GithubTarget = z.infer<typeof GithubTargetSchema>;

/**
 * The plugin-facing project. `displayPath` is home-abbreviated by the
 * service (`~/code/example-project`); `observedAt` is when git was last read
 * and `gitReadFailed` marks a last-good `git` value whose latest refresh
 * failed (ADR-0002: freshness is stated, never implied).
 */
export const ProjectViewSchema = z.object({
  projectId: ProjectIdSchema,
  displayName: z.string().min(1).max(64),
  displayPath: z.string().max(MAX_PATH_LENGTH),
  pinned: z.boolean(),
  lastOpenedAt: z.string().nullable(),
  observedAt: z.string().nullable(),
  gitReadFailed: z.boolean(),
  git: ProjectGitStateSchema,
  github: GithubTargetSchema,
});
export type ProjectView = z.infer<typeof ProjectViewSchema>;

/** A launcher's setup state as the plugin shows it (UI-SPEC S6, RR-14). */
export const LAUNCHER_STATUSES = ["not-set-up", "set-up", "tested"] as const;
export type LauncherStatus = (typeof LAUNCHER_STATUSES)[number];
export const LauncherStatusSchema = z.enum(LAUNCHER_STATUSES);

/**
 * Per-launcher setup state. Claude Code also carries the label of the
 * terminal it opens in, so the toolbar can say where a launch will land.
 */
export const LaunchersSummarySchema = z.object({
  antigravity: LauncherStatusSchema,
  "claude-code": z.object({
    status: LauncherStatusSchema,
    terminalLabel: z.string().min(1).max(64),
  }),
  "claude-desktop": LauncherStatusSchema,
});
export type LaunchersSummary = z.infer<typeof LaunchersSummarySchema>;

/** The whole projects picture — `GET /snapshot`'s `state.projects`. */
export const ProjectsSnapshotSchema = z.object({
  projects: z.array(ProjectViewSchema),
  launchers: LaunchersSummarySchema,
});
export type ProjectsSnapshot = z.infer<typeof ProjectsSnapshotSchema>;

/**
 * The snapshot a service with no project services wired answers with, and
 * the plugin's starting value: nothing registered, nothing set up, Terminal
 * as the default Claude Code terminal (PRD §20).
 */
export const EMPTY_PROJECTS_SNAPSHOT: ProjectsSnapshot = Object.freeze({
  projects: [],
  launchers: Object.freeze({
    antigravity: "not-set-up" as const,
    "claude-code": Object.freeze({ status: "not-set-up" as const, terminalLabel: "Terminal" }),
    "claude-desktop": "not-set-up" as const,
  }),
});

/**
 * The `projects.updated` event payload: a delta only. The event ring buffer
 * holds a bounded number of events, so a payload must stay small whatever
 * the project count (RESEARCH Pattern 4); a client that misses events
 * resyncs from the snapshot instead.
 */
export const ProjectsUpdatedPayloadSchema = z.object({
  upserted: z.array(ProjectViewSchema),
  removed: z.array(ProjectIdSchema),
  launchers: LaunchersSummarySchema.optional(),
});
export type ProjectsUpdatedPayload = z.infer<typeof ProjectsUpdatedPayloadSchema>;

/** The fields {@link compareProjectViews} orders by. */
export type ProjectOrderKey = Pick<ProjectView, "pinned" | "lastOpenedAt" | "displayName">;

/**
 * The one project order (PROJ-15, UI-SPEC S1 "Order"): pinned first, then
 * `lastOpenedAt` descending, never-opened last, ties by display name
 * case-insensitively. The operational store's `listProjects` SQL implements
 * the same order; the plugin re-sorts with this comparator after applying a
 * delta, so both ends agree without the plugin trusting arrival order.
 * Timestamps are ISO-8601 strings from one clock, so string order is time
 * order — the same comparison SQLite makes.
 */
export function compareProjectViews(a: ProjectOrderKey, b: ProjectOrderKey): number {
  if (a.pinned !== b.pinned) {
    return a.pinned ? -1 : 1;
  }
  if (a.lastOpenedAt !== b.lastOpenedAt) {
    if (a.lastOpenedAt === null) {
      return 1;
    }
    if (b.lastOpenedAt === null) {
      return -1;
    }
    return a.lastOpenedAt < b.lastOpenedAt ? 1 : -1;
  }
  return a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" });
}

// ---------------------------------------------------------------------------
// Project management (PROJ-11, D-08, RR-11, RR-12)
//
// Every route is a POST with a JSON body: the service's route table is
// exact-match with no path parameters (RESEARCH "Exact Seams"), and an ID in
// a body stays out of access logs the way a path in a URL would not. Every
// body is `.strict()` and addresses a project by ProjectId only.

/** `POST /api/v1/projects/remove` — remove from projects; never touches disk (D-08). */
export const PROJECT_REMOVE_PATH = `${API_BASE}/projects/remove`;
/** `POST /api/v1/projects/rename` — change the display name (RR-11). */
export const PROJECT_RENAME_PATH = `${API_BASE}/projects/rename`;
/** `POST /api/v1/projects/pin` — pin or unpin (PROJ-15). */
export const PROJECT_PIN_PATH = `${API_BASE}/projects/pin`;
/** `POST /api/v1/projects/github-link` — set or clear the GitHub link override (RR-12). */
export const PROJECT_GITHUB_LINK_PATH = `${API_BASE}/projects/github-link`;
/** `POST /api/v1/projects/refresh` — re-read git state now, for one project or all (D-42). */
export const PROJECTS_REFRESH_PATH = `${API_BASE}/projects/refresh`;

/** A project display name (RR-11): trimmed, 1..64 characters, no control characters. */
export const DisplayNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine((value) => !hasControlCharacter(value), {
    message: "display name must not contain a control character",
  });

/**
 * The owner-typed GitHub link (RR-12): exactly `https://github.com/owner/repo`
 * (GitHub's own owner and repository name character sets and lengths), or
 * `null` to clear it. No userinfo, no other host, no deeper path — the
 * service opens exactly this URL (D-19), so the shape is the whole check.
 */
export const GithubLinkSchema = z
  .string()
  .regex(/^https:\/\/github\.com\/[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/)
  .refine((value) => !/\/\.{1,2}$/.test(value), {
    message: "repository name must not be . or ..",
  })
  .nullable();

export const RemoveProjectRequestSchema = z.object({ projectId: ProjectIdSchema }).strict();
export type RemoveProjectRequest = z.infer<typeof RemoveProjectRequestSchema>;

export const RenameProjectRequestSchema = z
  .object({ projectId: ProjectIdSchema, displayName: DisplayNameSchema })
  .strict();
export type RenameProjectRequest = z.infer<typeof RenameProjectRequestSchema>;

export const PinProjectRequestSchema = z
  .object({ projectId: ProjectIdSchema, pinned: z.boolean() })
  .strict();
export type PinProjectRequest = z.infer<typeof PinProjectRequestSchema>;

export const SetGithubLinkRequestSchema = z
  .object({ projectId: ProjectIdSchema, url: GithubLinkSchema })
  .strict();
export type SetGithubLinkRequest = z.infer<typeof SetGithubLinkRequestSchema>;

/** Refresh one project's git state, or every project's when `projectId` is absent. */
export const RefreshProjectsRequestSchema = z
  .object({ projectId: ProjectIdSchema.optional() })
  .strict();
export type RefreshProjectsRequest = z.infer<typeof RefreshProjectsRequestSchema>;

/** Every management route's success body; the new state arrives as a `projects.updated` delta. */
export const ProjectMutationResponseSchema = z.object({ ok: z.literal(true) });
export type ProjectMutationResponse = z.infer<typeof ProjectMutationResponseSchema>;

// ---------------------------------------------------------------------------
// Scan folders and suggestions (PROJ-02, D-07)
//
// A scan root is addressed by its ScanRootId and a suggestion by its
// suggestionId after it is added — never by a path — so a rescan or a
// register-from-suggestion request cannot name an arbitrary directory.

/** `POST /api/v1/scan-roots/add` — nominate a folder and scan it once. */
export const SCAN_ROOTS_ADD_PATH = `${API_BASE}/scan-roots/add`;
/** `POST /api/v1/scan-roots/remove` — stop scanning; registered projects stay. */
export const SCAN_ROOTS_REMOVE_PATH = `${API_BASE}/scan-roots/remove`;
/** `POST /api/v1/scan-roots/rescan` — rescan one root, optionally at a new depth. */
export const SCAN_ROOTS_RESCAN_PATH = `${API_BASE}/scan-roots/rescan`;
/** `POST /api/v1/scan-roots/list` — scan roots plus current suggestions. */
export const SCAN_ROOTS_LIST_PATH = `${API_BASE}/scan-roots/list`;
/** `POST /api/v1/scan-roots/suggestions/register` — register a suggested folder. */
export const SUGGESTION_REGISTER_PATH = `${API_BASE}/scan-roots/suggestions/register`;
/** `POST /api/v1/scan-roots/suggestions/dismiss` — hide a suggestion until the next rescan. */
export const SUGGESTION_DISMISS_PATH = `${API_BASE}/scan-roots/suggestions/dismiss`;

/** How many levels below a scan root to look (D-07): default 1, at most 3. */
export const ScanDepthSchema = z.number().int().min(1).max(3);

/** A ScanRootId on the wire: the {@link newScanRootId} shape, branded on the way in. */
export const ScanRootIdSchema = z
  .string()
  .regex(/^[0-9a-z]{9}[0-9a-f]{16}$/)
  .transform((value) => value as ScanRootId);

/** An in-memory suggestion's opaque identity, minted by the service per scan. */
export const SuggestionIdSchema = z.string().regex(/^[0-9a-z]{1,64}$/);

export const AddScanRootRequestSchema = z
  .object({
    path: AbsolutePathSchema,
    depth: ScanDepthSchema.optional(),
    acknowledgeProtectedLocation: z.boolean().optional(),
  })
  .strict();
export type AddScanRootRequest = z.infer<typeof AddScanRootRequestSchema>;

export const RemoveScanRootRequestSchema = z.object({ scanRootId: ScanRootIdSchema }).strict();
export type RemoveScanRootRequest = z.infer<typeof RemoveScanRootRequestSchema>;

export const RescanScanRootRequestSchema = z
  .object({ scanRootId: ScanRootIdSchema, depth: ScanDepthSchema.optional() })
  .strict();
export type RescanScanRootRequest = z.infer<typeof RescanScanRootRequestSchema>;

export const ListScanRootsRequestSchema = z.object({}).strict();

export const SuggestionActionRequestSchema = z
  .object({ suggestionId: SuggestionIdSchema })
  .strict();
export type SuggestionActionRequest = z.infer<typeof SuggestionActionRequestSchema>;

/** A scan root as the plugin sees it: home-abbreviated display path only. */
export const ScanRootViewSchema = z.object({
  scanRootId: ScanRootIdSchema,
  displayPath: z.string().max(MAX_PATH_LENGTH),
  depth: ScanDepthSchema,
  addedAt: z.string(),
  lastScannedAt: z.string().nullable(),
});
export type ScanRootView = z.infer<typeof ScanRootViewSchema>;

/** A Git folder a scan found that is not yet registered. */
export const SuggestionViewSchema = z.object({
  suggestionId: SuggestionIdSchema,
  scanRootId: ScanRootIdSchema,
  folderName: z.string().min(1).max(255),
  displayPath: z.string().max(MAX_PATH_LENGTH),
});
export type SuggestionView = z.infer<typeof SuggestionViewSchema>;

/**
 * Every scan route's response. `partial` is ADR-0002's orthogonal flag: a
 * scan that could not read some child folders still returns what it found.
 * `protectedLocation` asks the plugin to confirm adding a protected folder.
 */
export const ScanStateResponseSchema = z.object({
  scanRoots: z.array(ScanRootViewSchema),
  suggestions: z.array(SuggestionViewSchema),
  partial: z.boolean(),
  protectedLocation: ProtectedLocationSchema.optional(),
});
export type ScanStateResponse = z.infer<typeof ScanStateResponseSchema>;
