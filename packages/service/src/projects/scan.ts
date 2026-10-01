import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { readdir, realpath } from "node:fs/promises";
import path from "node:path";
import {
  checkPathContainmentResolved,
  hasControlCharacter,
  type ProjectId,
  type RegisterProjectResponse,
  ScanDepthSchema,
  type ScanRootId,
  type ScanRootView,
  type ScanStateResponse,
  type ScanStatus,
  type SuggestionView,
} from "@ccc/domain";
import {
  getScanRoot,
  insertProject,
  insertScanRoot,
  listProjects,
  listScanRoots,
  type OperationalStore,
  removeScanRoot,
  type ScanRootRecord,
  setScanRootDepth,
  touchScanned,
} from "@ccc/operational-store";
import { logger as serviceLogger } from "../logging.js";
import { recomputeApprovedRoots } from "./approved-roots.js";
import { defaultDisplayName } from "./project-routes.js";
import { toDisplayPath } from "./project-views.js";
import {
  detectProtectedLocation,
  ProjectRefusedError,
  type RegistrationPolicyContext,
  validateScanRootCandidate,
} from "./registration.js";
import { validateAgainstSettledPolicy } from "./settled-policy.js";

/**
 * Scan folders and suggestions (plan 04-13, PROJ-02, PROJ-03, D-07).
 *
 * The owner nominates a parent folder; the service lists the Git folders
 * inside it as suggestions; a suggestion becomes a project only when the
 * owner chooses Register, through the same registration policy as a manual
 * registration. Suggestions live in this module's memory only.
 *
 * D-07, and why each rule is here:
 * - **Nominated folders only.** A walk starts from a stored scan root,
 *   addressed by its ScanRootId; no request names a path after the add,
 *   and the add itself passes the registration policy (PR-06).
 * - **On request only.** A walk runs when a folder is added and on Rescan
 *   folder. This module creates no watcher, no interval and no timer — a
 *   test spies on all four — so nothing is ever scanned in the background.
 * - **Never out of the root.** Symlinked entries are never followed (a
 *   `Dirent` that is a link is not a directory), and every directory that is
 *   followed must have a realpath strictly inside the scan root's realpath
 *   (`checkPathContainmentResolved`), so a folder swapped for a link between
 *   the listing and the step is dropped too. Realpath containment, not a
 *   string prefix: `/a/b2` starts with `/a/b`, and letter case or a symlinked
 *   ancestor makes two spellings of one folder (Don't Hand-Roll). The root
 *   itself must still realpath to the stored path, or the walk reads nothing.
 *   Registering a suggestion runs the containment check again, after the
 *   full registration policy.
 * - **Never into what the owner did not choose.** Hidden folders,
 *   `node_modules`, names with control characters and protected locations
 *   (Documents, CloudStorage, …) below a root that is not itself in one are
 *   skipped without being listed, so a scan never opens a Files & Folders
 *   prompt the owner did not ask for.
 * - **Bounded.** A folder holding `.git` (directory or worktree file) is a
 *   candidate and is not descended into; the walk stops at the configured
 *   depth (1..3), after {@link SCAN_ENTRY_CAP} entries or after
 *   {@link SCAN_TIME_CAP_MS}, and then answers what it found, partial
 *   (T-04-13). The clock is read between steps, never by a timer, so a single
 *   stalled listing is bounded by the request, not by this module. Every
 *   filesystem call is asynchronous: a listing waiting on macOS never blocks
 *   the service's event loop.
 * - **Path-free logs.** A scan logs `{ scanRootId, found, partial }` (D-46).
 */

/** The narrow slice of the project services a registered suggestion notifies. */
export interface ScanProjectsPort {
  onRegistryChanged(): void;
  refresh(projectId?: ProjectId): void;
}

/** What the scan log lines need; the service's redacting logger by default. */
export interface ScanLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

/** How many directory entries one scan may visit before it stops, partial (T-04-13). */
export const SCAN_ENTRY_CAP = 5000;
/** How long one scan may run before it stops, partial (T-04-13). */
export const SCAN_TIME_CAP_MS = 2000;

/** The two filesystem calls the walker makes; injectable so tests can record and fail them. */
export interface ScanFs {
  readdir(path: string): Promise<Dirent[]>;
  realpath(path: string): Promise<string>;
}

export interface ScanServiceDeps {
  readonly store: OperationalStore;
  /** The resolved home directory display paths are abbreviated against (D-43). */
  readonly homeDir: string;
  /** The registration policy as it stands NOW (vault root read from the store each call). */
  readonly readPolicy: () => RegistrationPolicyContext;
  readonly projects?: ScanProjectsPort | undefined;
  readonly log?: ScanLogger | undefined;
  readonly fs?: ScanFs | undefined;
  readonly entryCap?: number | undefined;
  readonly timeCapMs?: number | undefined;
  /** Milliseconds clock for the wall-clock cap; `Date.now` by default. */
  readonly now?: (() => number) | undefined;
}

export type ScanStateOutcome =
  | { readonly kind: "state"; readonly state: ScanStateResponse }
  | { readonly kind: "refused" }
  | { readonly kind: "invalid" }
  | { readonly kind: "unknown" };

export type SuggestionRegisterOutcome =
  | { readonly kind: "response"; readonly body: RegisterProjectResponse }
  | { readonly kind: "refused" }
  | { readonly kind: "unknown" };

export interface ScanService {
  /** Nominates a folder (validated like a registration), persists it, and scans it once. */
  add(
    path: string,
    options: { readonly depth?: number | undefined; readonly acknowledged: boolean },
  ): Promise<ScanStateOutcome>;
  /** Stops scanning: the row and its suggestions go; registered projects and the disk stay. */
  remove(scanRootId: ScanRootId): ScanStateOutcome;
  /** Scans one nominated folder again, optionally at a new depth. */
  rescan(scanRootId: ScanRootId, depth?: number): Promise<ScanStateOutcome>;
  /** Every scan folder and every current suggestion. */
  state(): ScanStateResponse;
  /** Registers one suggestion through the registration policy. */
  registerSuggestion(suggestionId: string): Promise<SuggestionRegisterOutcome>;
  /** Hides one suggestion until the next scan of its folder. `false` when unknown. */
  dismiss(suggestionId: string): boolean;
}

/** One suggestion, with the realpath the plugin never sees. */
interface Suggestion {
  readonly suggestionId: string;
  readonly scanRootId: ScanRootId;
  readonly realPath: string;
  readonly folderName: string;
}

interface RootMemory {
  readonly suggestions: Suggestion[];
  readonly status: ScanStatus;
}

interface WalkResult {
  readonly found: string[];
  readonly status: ScanStatus;
}

function isAccessError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "EPERM" || code === "EACCES";
}

function hasGitEntry(entries: readonly Dirent[]): boolean {
  return entries.some((e) => e.name === ".git" && (e.isDirectory() || e.isFile()));
}

export function createScanService(deps: ScanServiceDeps): ScanService {
  const { store } = deps;
  const log: ScanLogger = deps.log ?? serviceLogger;
  const memory = new Map<ScanRootId, RootMemory>();
  /** One scan per folder at a time; a second request waits for the first. */
  const inFlight = new Map<ScanRootId, Promise<void>>();
  const fs: ScanFs = deps.fs ?? {
    readdir: (dir) => readdir(dir, { withFileTypes: true }),
    realpath: (target) => realpath(target),
  };
  const entryCap = deps.entryCap ?? SCAN_ENTRY_CAP;
  const timeCapMs = deps.timeCapMs ?? SCAN_TIME_CAP_MS;
  const now = deps.now ?? Date.now;

  async function walk(root: ScanRootRecord): Promise<WalkResult> {
    const startedAt = now();
    let rootReal: string;
    let rootEntries: Dirent[];
    try {
      rootReal = await fs.realpath(root.path);
      // A root that moved, or was replaced by a symlink, is not followed.
      if (rootReal !== root.path) return { found: [], status: "failed" };
      rootEntries = await fs.readdir(rootReal);
    } catch (err: unknown) {
      return { found: [], status: isAccessError(err) ? "access-denied" : "failed" };
    }
    const homeDir = deps.readPolicy().homeDir;
    const rootIsProtected = detectProtectedLocation(rootReal, homeDir) !== null;
    const found = new Set<string>();
    let partial = false;
    let visited = 0;
    // Breadth first, one level at a time; `level` is the listed folder's
    // distance below the root (the root is 0, its children 1).
    const queue: Array<{
      readonly dir: string;
      readonly entries: Dirent[];
      readonly level: number;
    }> = [{ dir: rootReal, entries: rootEntries, level: 0 }];
    walking: for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      for (const entry of next.entries) {
        visited += 1;
        if (visited > entryCap || now() - startedAt > timeCapMs) {
          partial = true;
          break walking;
        }
        // Files, and symlinks even to folders, are never followed.
        if (!entry.isDirectory()) continue;
        const name = entry.name;
        if (name.startsWith(".") || name === "node_modules" || hasControlCharacter(name)) continue;
        const child = path.join(next.dir, name);
        if (!rootIsProtected && detectProtectedLocation(child, homeDir) !== null) continue;
        let childReal: string;
        let childEntries: Dirent[];
        try {
          childReal = await fs.realpath(child);
          if (!checkPathContainmentResolved(childReal, rootReal).contained) continue;
          childEntries = await fs.readdir(childReal);
        } catch {
          partial = true;
          continue;
        }
        if (hasGitEntry(childEntries)) {
          found.add(childReal);
          continue;
        }
        if (next.level + 1 < root.depth) {
          queue.push({ dir: childReal, entries: childEntries, level: next.level + 1 });
        }
      }
    }
    return { found: [...found].sort(), status: partial ? "partial" : "complete" };
  }

  async function scanOnce(scanRootId: ScanRootId): Promise<void> {
    const root = getScanRoot(store.db, scanRootId);
    if (root === null) return;
    const result = await walk(root);
    // Stop scanning may have removed the folder while the walk ran.
    if (getScanRoot(store.db, scanRootId) === null) return;
    const registered = new Set(listProjects(store.db).map((p) => p.path));
    const suggestions = result.found
      .filter((realPath) => !registered.has(realPath))
      .map((realPath) => ({
        suggestionId: randomUUID().replace(/-/g, ""),
        scanRootId,
        realPath,
        folderName: path.basename(realPath),
      }));
    memory.set(scanRootId, { suggestions, status: result.status });
    if (result.status === "failed" || result.status === "access-denied") {
      log.warn({ scanRootId, status: result.status }, "scan could not read the folder");
      return;
    }
    touchScanned(store.db, scanRootId);
    log.info(
      { scanRootId, found: suggestions.length, partial: result.status === "partial" },
      "scan finished",
    );
  }

  function scan(scanRootId: ScanRootId): Promise<void> {
    // A failed earlier scan must not fail this one: the chain only orders them.
    const previous = (inFlight.get(scanRootId) ?? Promise.resolve()).catch(() => undefined);
    const next = previous.then(() => scanOnce(scanRootId));
    inFlight.set(scanRootId, next);
    const settle = (): void => {
      if (inFlight.get(scanRootId) === next) inFlight.delete(scanRootId);
    };
    next.then(settle, settle);
    return next;
  }

  function state(): ScanStateResponse {
    const registered = new Set(listProjects(store.db).map((p) => p.path));
    const scanRoots: ScanRootView[] = [];
    const suggestions: SuggestionView[] = [];
    let partial = false;
    for (const root of listScanRoots(store.db)) {
      const remembered = memory.get(root.scanRootId);
      if (remembered?.status === "partial") partial = true;
      scanRoots.push({
        scanRootId: root.scanRootId,
        displayPath: toDisplayPath(root.path, deps.homeDir),
        depth: root.depth,
        addedAt: root.addedAt,
        lastScannedAt: root.lastScannedAt,
        ...(remembered === undefined ? {} : { scanStatus: remembered.status }),
      });
      for (const suggestion of remembered?.suggestions ?? []) {
        if (registered.has(suggestion.realPath)) continue;
        suggestions.push({
          suggestionId: suggestion.suggestionId,
          scanRootId: suggestion.scanRootId,
          folderName: suggestion.folderName,
          displayPath: toDisplayPath(suggestion.realPath, deps.homeDir),
        });
      }
    }
    return { scanRoots, suggestions, partial };
  }

  function findSuggestion(suggestionId: string): Suggestion | null {
    for (const remembered of memory.values()) {
      const match = remembered.suggestions.find((s) => s.suggestionId === suggestionId);
      if (match !== undefined) return match;
    }
    return null;
  }

  function forget(suggestion: Suggestion): void {
    const remembered = memory.get(suggestion.scanRootId);
    if (remembered === undefined) return;
    memory.set(suggestion.scanRootId, {
      status: remembered.status,
      suggestions: remembered.suggestions.filter((s) => s.suggestionId !== suggestion.suggestionId),
    });
  }

  return {
    async add(candidate, options) {
      if (options.depth !== undefined && !ScanDepthSchema.safeParse(options.depth).success) {
        return { kind: "invalid" };
      }
      const policy = deps.readPolicy();
      const lexical = options.acknowledged
        ? null
        : detectProtectedLocation(candidate, policy.homeDir);
      if (lexical !== null) {
        return { kind: "state", state: { ...state(), protectedLocation: lexical } };
      }
      let resolved: string;
      try {
        resolved = await validateAgainstSettledPolicy(
          candidate,
          policy,
          deps.readPolicy,
          validateScanRootCandidate,
        );
      } catch (err: unknown) {
        if (!(err instanceof ProjectRefusedError)) throw err;
        if (err.protectedLocation !== null && !options.acknowledged) {
          return { kind: "state", state: { ...state(), protectedLocation: err.protectedLocation } };
        }
        log.warn({ reason: err.reason }, "scan folder refused");
        return { kind: "refused" };
      }
      const resolvedLocation = options.acknowledged
        ? null
        : detectProtectedLocation(resolved, policy.homeDir);
      if (resolvedLocation !== null) {
        return { kind: "state", state: { ...state(), protectedLocation: resolvedLocation } };
      }
      const { created, record } = insertScanRoot(store.db, {
        path: resolved,
        depth: options.depth ?? 1,
      });
      if (!created && options.depth !== undefined) {
        setScanRootDepth(store.db, record.scanRootId, options.depth);
      }
      log.info({ scanRootId: record.scanRootId, created }, "scan folder added");
      await scan(record.scanRootId);
      return { kind: "state", state: state() };
    },

    remove(scanRootId) {
      if (!removeScanRoot(store.db, scanRootId)) return { kind: "unknown" };
      memory.delete(scanRootId);
      log.info({ scanRootId }, "scan folder removed");
      return { kind: "state", state: state() };
    },

    async rescan(scanRootId, depth) {
      if (depth !== undefined && !ScanDepthSchema.safeParse(depth).success) {
        return { kind: "invalid" };
      }
      if (getScanRoot(store.db, scanRootId) === null) return { kind: "unknown" };
      if (depth !== undefined) setScanRootDepth(store.db, scanRootId, depth);
      await scan(scanRootId);
      return { kind: "state", state: state() };
    },

    state,

    async registerSuggestion(suggestionId) {
      const suggestion = findSuggestion(suggestionId);
      if (suggestion === null) return { kind: "unknown" };
      const root = getScanRoot(store.db, suggestion.scanRootId);
      if (root === null) return { kind: "unknown" };
      const refuse = (reason: string): SuggestionRegisterOutcome => {
        log.warn({ reason, scanRootId: suggestion.scanRootId }, "suggestion refused");
        return { kind: "refused" };
      };
      const policy = deps.readPolicy();
      let rootReal: string;
      let resolved: string;
      try {
        // The root must still be the nominated folder (it may have been
        // swapped for a link since the scan) …
        rootReal = await fs.realpath(root.path);
        if (rootReal !== root.path) return refuse("scan-root-moved");
        // … and the suggestion must pass the full registration policy.
        resolved = await validateAgainstSettledPolicy(suggestion.realPath, policy, deps.readPolicy);
      } catch (err: unknown) {
        if (err instanceof ProjectRefusedError) return refuse(err.reason);
        return refuse("scan-root-unreadable");
      }
      // Nothing below awaits until the row is inserted (codex review 2).
      // Re-containment (PROJ-03): the folder the policy resolved — after any
      // symlink swapped in since the scan — must still sit strictly inside
      // the scan root, and must not lead into a protected location the root
      // is not itself in.
      if (!checkPathContainmentResolved(resolved, rootReal).contained) {
        return refuse("outside-scan-root");
      }
      if (
        detectProtectedLocation(resolved, policy.homeDir) !== null &&
        detectProtectedLocation(rootReal, policy.homeDir) === null
      ) {
        return refuse("protected-location");
      }
      const { created, record } = insertProject(store.db, {
        path: resolved,
        displayName: defaultDisplayName(resolved),
      });
      if (created) {
        recomputeApprovedRoots(store);
        deps.projects?.onRegistryChanged();
        deps.projects?.refresh(record.projectId);
      }
      forget(suggestion);
      log.info(
        { projectId: record.projectId, scanRootId: suggestion.scanRootId, created },
        "suggestion registered",
      );
      return {
        kind: "response",
        body: created
          ? { kind: "registered", projectId: record.projectId }
          : { kind: "already-registered", projectId: record.projectId },
      };
    },

    dismiss(suggestionId) {
      const suggestion = findSuggestion(suggestionId);
      if (suggestion === null) return false;
      forget(suggestion);
      return true;
    },
  };
}
