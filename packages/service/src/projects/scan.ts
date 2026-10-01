import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import type {
  ProjectId,
  RegisterProjectResponse,
  ScanRootId,
  ScanRootView,
  ScanStateResponse,
  SuggestionView,
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

export interface ScanServiceDeps {
  readonly store: OperationalStore;
  /** The resolved home directory display paths are abbreviated against (D-43). */
  readonly homeDir: string;
  /** The registration policy as it stands NOW (vault root read from the store each call). */
  readonly readPolicy: () => RegistrationPolicyContext;
  readonly projects?: ScanProjectsPort | undefined;
  readonly log?: ScanLogger | undefined;
}

export type ScanStateOutcome =
  | { readonly kind: "state"; readonly state: ScanStateResponse }
  | { readonly kind: "refused" }
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

type ScanStatus = "complete" | "partial" | "failed" | "access-denied";

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

  async function walk(root: ScanRootRecord): Promise<WalkResult> {
    let entries: Dirent[];
    try {
      entries = await readdir(root.path, { withFileTypes: true });
    } catch (err: unknown) {
      return { found: [], status: isAccessError(err) ? "access-denied" : "failed" };
    }
    const found: string[] = [];
    let partial = false;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const child = path.join(root.path, entry.name);
      try {
        const childEntries = await readdir(child, { withFileTypes: true });
        if (hasGitEntry(childEntries)) found.push(child);
      } catch {
        partial = true;
      }
    }
    return { found, status: partial ? "partial" : "complete" };
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
    if (result.status === "complete" || result.status === "partial") {
      touchScanned(store.db, scanRootId);
    }
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
      if (getScanRoot(store.db, scanRootId) === null) return { kind: "unknown" };
      if (depth !== undefined) setScanRootDepth(store.db, scanRootId, depth);
      await scan(scanRootId);
      return { kind: "state", state: state() };
    },

    state,

    async registerSuggestion(suggestionId) {
      const suggestion = findSuggestion(suggestionId);
      if (suggestion === null) return { kind: "unknown" };
      if (getScanRoot(store.db, suggestion.scanRootId) === null) return { kind: "unknown" };
      const policy = deps.readPolicy();
      let resolved: string;
      try {
        resolved = await validateAgainstSettledPolicy(suggestion.realPath, policy, deps.readPolicy);
      } catch (err: unknown) {
        if (!(err instanceof ProjectRefusedError)) throw err;
        log.warn({ reason: err.reason, scanRootId: suggestion.scanRootId }, "suggestion refused");
        return { kind: "refused" };
      }
      // Nothing below awaits until the row is inserted (codex review 2).
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
