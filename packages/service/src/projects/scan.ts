import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { readdir, realpath } from "node:fs/promises";
import path from "node:path";
import {
  checkPathContainmentResolved,
  hasControlCharacter,
  MAX_SCAN_ROOT_PATH_LENGTH,
  MAX_SCAN_ROOTS,
  type ProjectId,
  type RegisterProjectResponse,
  ScanDepthSchema,
  type ScanRootId,
  type ScanRootView,
  type ScanStateResponse,
  type ScanStatus,
  SUGGESTIONS_RELOAD,
  type SuggestionsPageResponse,
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
import { defaultDisplayName, takenDisplayNames } from "./project-routes.js";
import { toDisplayPath } from "./project-views.js";
import {
  detectProtectedLocation,
  ProjectRefusedError,
  type RegistrationPolicyContext,
  validateScanRootCandidate,
} from "./registration.js";
import { fitScanState, fitSuggestionsPage } from "./scan-page.js";
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
 *   folder. This module creates no watcher and no interval; its only timer
 *   is the per-operation deadline below, cleared before the request answers
 *   (a test spies on all of them), so nothing is ever scanned in the
 *   background.
 * - **Still allowed on rescan.** Rescan judges the stored folder against
 *   the scan-folder policy as it stands NOW, exactly as Add did: a managed
 *   vault set up inside or around it since (vault setup does not consult
 *   scan folders — keeping the vault inside a scanned tree is the owner's
 *   call) makes every rescan answer the same constant refusal, list nothing,
 *   and leave the folder `refused` with no suggestions.
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
 * - **Never into the vault.** The walk resolves the managed vault root and
 *   neither lists it nor anything below it, and never suggests a Git folder
 *   holding it (a vault set up while a walk runs); the listed state drops
 *   any remembered suggestion that is or holds the vault.
 * - **Never into what the owner did not choose.** Hidden folders,
 *   `node_modules`, names with control characters and protected locations
 *   (Documents, CloudStorage, …) below a root that is not itself in one are
 *   skipped without being listed, so a scan never opens a Files & Folders
 *   prompt the owner did not ask for.
 * - **Bounded.** A folder holding `.git` (directory or worktree file) is a
 *   candidate and is not descended into; the walk stops at the configured
 *   depth (1..3), after {@link SCAN_ENTRY_CAP} entries or after
 *   {@link SCAN_TIME_CAP_MS}, and then answers what it found, partial
 *   (T-04-13). The cap holds even for one stalled call: every `readdir` and
 *   `realpath` races a deadline of the time left (wave-6 review). A stalled
 *   call below the root ends the walk partial; a stalled call on the root
 *   itself reads `failed`. The stalled call is abandoned, not cancelled —
 *   Node cannot cancel it — but the scan answers and the folder's queue
 *   moves on. Every filesystem call is asynchronous: a listing waiting on
 *   macOS never blocks the service's event loop.
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
  /** Already {@link MAX_SCAN_ROOTS} scan folders, and this is not one of them. */
  | { readonly kind: "limit" }
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
  /**
   * Every scan folder, with each one's suggestion count and the first page
   * of its suggestions — as many as fit `SCAN_RESPONSE_BUDGET_BYTES`
   * (codex review 3, finding 2).
   */
  state(): ScanStateResponse;
  /**
   * One scan folder's suggestions after `afterSuggestionId` (from its first
   * when absent): at most one page, fitted to the byte budget. The constant
   * `reload` when `scanGeneration` is not the folder's current scan or the
   * cursor is not a suggestion that scan minted (codex review 3b, finding 2).
   * `null` for a ScanRootId the store does not hold.
   */
  suggestionsPage(
    scanRootId: ScanRootId,
    scanGeneration: string,
    afterSuggestionId: string | undefined,
  ): SuggestionsPageResponse | null;
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
  /** Every suggestion the scan minted, in scan order — the cursor's frame. */
  readonly suggestions: Suggestion[];
  /** Registered or dismissed since: never listed or found again, still a valid cursor. */
  readonly gone: ReadonlySet<string>;
  readonly status: ScanStatus;
  /** Minted each time the suggestions are replaced (codex review 3b, finding 1). */
  readonly generation: string;
}

/** A fresh opaque token: suggestion IDs and scan generations alike. */
function mintToken(): string {
  return randomUUID().replace(/-/g, "");
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

/** What {@link withDeadline} answers when the deadline passed first. */
const DEADLINE: unique symbol = Symbol("scan deadline");

/**
 * `op`'s result, or {@link DEADLINE} once `ms` has passed, whichever comes
 * first. The timer is cleared either way, so none outlives the call, and a
 * late rejection of an abandoned `op` is absorbed rather than left unhandled.
 */
async function withDeadline<T>(op: Promise<T>, ms: number): Promise<T | typeof DEADLINE> {
  op.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof DEADLINE>((resolve) => {
    timer = setTimeout(() => resolve(DEADLINE), Math.max(0, ms));
  });
  try {
    return await Promise.race([op, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** True when `child` is `parent` or lies below it. Both resolved; lexical. */
function sameOrInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

/** True when `folder` is the vault, lies inside it, or holds it. */
function touchesVault(folder: string, vault: string | null): boolean {
  return vault !== null && (sameOrInside(folder, vault) || sameOrInside(vault, folder));
}

/**
 * A scan folder's display path as the wire allows it (at most
 * {@link MAX_SCAN_ROOT_PATH_LENGTH}). Add refuses longer folders, so only a
 * row stored before that rule can be cut — kept to its tail, which names the
 * folder, so the owner can still recognise and remove it.
 */
function boundedDisplayPath(displayPath: string): string {
  if (displayPath.length <= MAX_SCAN_ROOT_PATH_LENGTH) return displayPath;
  let tail = displayPath.slice(displayPath.length - (MAX_SCAN_ROOT_PATH_LENGTH - 1));
  // Never start on the second half of a surrogate pair.
  const first = tail.charCodeAt(0);
  if (first >= 0xdc00 && first <= 0xdfff) tail = tail.slice(1);
  return `…${tail}`;
}

/** Policy refusals a rescan answers with the constant refusal; the rest are the walk's to report. */
const READ_FAILURES: ReadonlySet<string> = new Set(["missing", "not-a-directory", "access-denied"]);

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
    const timeLeft = (): number => timeCapMs - (now() - startedAt);
    let rootReal: string;
    let rootEntries: Dirent[];
    try {
      const resolvedRoot = await withDeadline(fs.realpath(root.path), timeLeft());
      // A root that moved, or was replaced by a symlink, is not followed.
      if (resolvedRoot === DEADLINE || resolvedRoot !== root.path) {
        return { found: [], status: "failed" };
      }
      rootReal = resolvedRoot;
      const listing = await withDeadline(fs.readdir(rootReal), timeLeft());
      if (listing === DEADLINE) return { found: [], status: "failed" };
      rootEntries = listing;
    } catch (err: unknown) {
      return { found: [], status: isAccessError(err) ? "access-denied" : "failed" };
    }
    const policy = deps.readPolicy();
    const homeDir = policy.homeDir;
    const vaultReal = await resolveVault(policy.vaultRoot, timeLeft());
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
        if (vaultReal !== null && sameOrInside(child, vaultReal)) continue;
        let childReal: string;
        let childEntries: Dirent[];
        try {
          const resolvedChild = await withDeadline(fs.realpath(child), timeLeft());
          if (resolvedChild === DEADLINE) {
            partial = true;
            break walking;
          }
          childReal = resolvedChild;
          if (!checkPathContainmentResolved(childReal, rootReal).contained) continue;
          if (vaultReal !== null && sameOrInside(childReal, vaultReal)) continue;
          const listing = await withDeadline(fs.readdir(childReal), timeLeft());
          if (listing === DEADLINE) {
            partial = true;
            break walking;
          }
          childEntries = listing;
        } catch {
          partial = true;
          continue;
        }
        if (hasGitEntry(childEntries)) {
          // A repository holding the vault would be refused on Register.
          if (!touchesVault(childReal, vaultReal)) found.add(childReal);
          continue;
        }
        if (next.level + 1 < root.depth) {
          queue.push({ dir: childReal, entries: childEntries, level: next.level + 1 });
        }
      }
    }
    // Vault setup may have landed while the walk ran: judge against it too.
    const latestVault = deps.readPolicy().vaultRoot;
    const finalVault =
      latestVault === policy.vaultRoot ? vaultReal : await resolveVault(latestVault, timeLeft());
    return {
      found: [...found].filter((folder) => !touchesVault(folder, finalVault)).sort(),
      status: partial ? "partial" : "complete",
    };
  }

  /** The vault root's realpath (its lexical form when it cannot be resolved in time), or `null`. */
  async function resolveVault(vaultRoot: string | null, ms: number): Promise<string | null> {
    if (vaultRoot === null || vaultRoot.length === 0) return null;
    try {
      const resolved = await withDeadline(fs.realpath(vaultRoot), ms);
      return resolved === DEADLINE ? path.resolve(vaultRoot) : resolved;
    } catch {
      return path.resolve(vaultRoot);
    }
  }

  /**
   * Whether the stored folder still passes the scan-folder policy (wave-6
   * review). A folder that is gone, not a folder, or unreadable is not a
   * policy answer: the walk reports it as `failed` / `access-denied`.
   */
  async function stillAllowed(root: ScanRootRecord): Promise<boolean> {
    try {
      await validateAgainstSettledPolicy(
        root.path,
        deps.readPolicy(),
        deps.readPolicy,
        validateScanRootCandidate,
      );
      return true;
    } catch (err: unknown) {
      if (!(err instanceof ProjectRefusedError)) throw err;
      if (READ_FAILURES.has(err.reason)) return true;
      log.warn(
        { scanRootId: root.scanRootId, reason: err.reason },
        "scan folder refused on rescan",
      );
      return false;
    }
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
        suggestionId: mintToken(),
        scanRootId,
        realPath,
        folderName: path.basename(realPath),
      }));
    memory.set(scanRootId, {
      suggestions,
      gone: new Set(),
      status: result.status,
      generation: mintToken(),
    });
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

  /** The lexical vault root the visible suggestions are filtered against. */
  function currentVault(): string | null {
    // Lexical, so this stays synchronous; Register re-checks with realpaths.
    const vaultRoot = deps.readPolicy().vaultRoot;
    return vaultRoot === null || vaultRoot.length === 0 ? null : path.resolve(vaultRoot);
  }

  /** Suggestions as the plugin may see them, in scan order. */
  function visibleViews(
    remembered: RootMemory | undefined,
    candidates: readonly Suggestion[],
    registered: ReadonlySet<string>,
    vault: string | null,
  ): SuggestionView[] {
    const views: SuggestionView[] = [];
    for (const suggestion of candidates) {
      if (remembered?.gone.has(suggestion.suggestionId) === true) continue;
      if (registered.has(suggestion.realPath)) continue;
      if (touchesVault(suggestion.realPath, vault)) continue;
      views.push({
        suggestionId: suggestion.suggestionId,
        scanRootId: suggestion.scanRootId,
        folderName: suggestion.folderName,
        displayPath: toDisplayPath(suggestion.realPath, deps.homeDir),
      });
    }
    return views;
  }

  /** A folder's suggestions as the plugin may see them, in scan order. */
  function visibleSuggestions(
    scanRootId: ScanRootId,
    registered: ReadonlySet<string>,
    vault: string | null,
  ): SuggestionView[] {
    const remembered = memory.get(scanRootId);
    return visibleViews(remembered, remembered?.suggestions ?? [], registered, vault);
  }

  function state(): ScanStateResponse {
    const registered = new Set(listProjects(store.db).map((p) => p.path));
    const vault = currentVault();
    const scanRoots: ScanRootView[] = [];
    const byRoot: SuggestionView[][] = [];
    let partial = false;
    for (const root of listScanRoots(store.db)) {
      const remembered = memory.get(root.scanRootId);
      if (remembered?.status === "partial") partial = true;
      const visible = visibleSuggestions(root.scanRootId, registered, vault);
      byRoot.push(visible);
      scanRoots.push({
        scanRootId: root.scanRootId,
        displayPath: boundedDisplayPath(toDisplayPath(root.path, deps.homeDir)),
        depth: root.depth,
        addedAt: root.addedAt,
        lastScannedAt: root.lastScannedAt,
        ...(remembered === undefined
          ? {}
          : { scanStatus: remembered.status, scanGeneration: remembered.generation }),
        suggestionCount: visible.length,
      });
    }
    return fitScanState(scanRoots, byRoot, partial);
  }

  function suggestionsPage(
    scanRootId: ScanRootId,
    scanGeneration: string,
    afterSuggestionId: string | undefined,
  ): SuggestionsPageResponse | null {
    if (getScanRoot(store.db, scanRootId) === null) return null;
    const remembered = memory.get(scanRootId);
    if (remembered === undefined || remembered.generation !== scanGeneration) {
      return SUGGESTIONS_RELOAD;
    }
    // The cursor is placed among every suggestion the scan minted, gone or
    // hidden ones included, so what changed ahead of it never moves it.
    const start =
      afterSuggestionId === undefined
        ? 0
        : remembered.suggestions.findIndex((s) => s.suggestionId === afterSuggestionId) + 1;
    if (start === 0 && afterSuggestionId !== undefined) return SUGGESTIONS_RELOAD;
    const registered = new Set(listProjects(store.db).map((p) => p.path));
    const vault = currentVault();
    const all = remembered.suggestions;
    return fitSuggestionsPage(
      visibleViews(remembered, all.slice(start), registered, vault),
      visibleViews(remembered, all, registered, vault).length,
    );
  }

  function findSuggestion(suggestionId: string): Suggestion | null {
    for (const remembered of memory.values()) {
      if (remembered.gone.has(suggestionId)) continue;
      const match = remembered.suggestions.find((s) => s.suggestionId === suggestionId);
      if (match !== undefined) return match;
    }
    return null;
  }

  /** Marks one suggestion gone; it stays in scan order as a cursor (codex review 3b, finding 2). */
  function forget(suggestion: Suggestion): void {
    const remembered = memory.get(suggestion.scanRootId);
    if (remembered === undefined) return;
    memory.set(suggestion.scanRootId, {
      ...remembered,
      gone: new Set([...remembered.gone, suggestion.suggestionId]),
    });
  }

  /**
   * True when {@link MAX_SCAN_ROOTS} folders are stored and `folder` is not
   * one of them (codex review 3b, finding 3): adding a folder again, to
   * change its depth, is never refused by the cap.
   */
  function atLimit(folder: string): boolean {
    const roots = listScanRoots(store.db);
    return roots.length >= MAX_SCAN_ROOTS && !roots.some((root) => root.path === folder);
  }

  function refuseAtLimit(): ScanStateOutcome {
    log.warn({ reason: "scan-root-limit" }, "scan folder refused");
    return { kind: "limit" };
  }

  return {
    async add(candidate, options) {
      if (options.depth !== undefined && !ScanDepthSchema.safeParse(options.depth).success) {
        return { kind: "invalid" };
      }
      // Before any prompt: a full list answers the limit, not a question.
      if (atLimit(path.resolve(candidate))) return refuseAtLimit();
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
      // The full list of display paths must fit one response (finding 3).
      if (resolved.length > MAX_SCAN_ROOT_PATH_LENGTH) {
        log.warn({ reason: "path-too-long" }, "scan folder refused");
        return { kind: "refused" };
      }
      if (atLimit(resolved)) return refuseAtLimit();
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
      const root = getScanRoot(store.db, scanRootId);
      if (root === null) return { kind: "unknown" };
      if (!(await stillAllowed(root))) {
        // Constant: the same refusal every time, nothing listed, nothing kept.
        if (getScanRoot(store.db, scanRootId) !== null) {
          memory.set(scanRootId, {
            suggestions: [],
            gone: new Set(),
            status: "refused",
            generation: mintToken(),
          });
        }
        return { kind: "refused" };
      }
      if (depth !== undefined) setScanRootDepth(store.db, scanRootId, depth);
      await scan(scanRootId);
      return { kind: "state", state: state() };
    },

    state,
    suggestionsPage,

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
        displayName: defaultDisplayName(resolved, takenDisplayNames(store.db)),
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
