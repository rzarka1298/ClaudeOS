import { isTaskNotePath, TASKS_FOLDER_NAME } from "@ccc/domain/task-schema.js";
import type { TaskChangedRequest } from "@ccc/domain/tasks.js";
import type { HostRegistry } from "../host-registry.js";
import { tasksApi } from "./api.js";
import { type CoalescedBatch, createPathCoalescer } from "./coalescer.js";

/**
 * The vault change watcher for task notes (plan 06-18; D-35, A-10, research
 * Pattern 13, Pitfall 7, T-06-23). Its own module on purpose: `vault-write.ts`
 * forbids event code, and this module never writes.
 *
 * - Registered through the host registry, whose vault-event kind defers the
 *   subscription until the workspace layout is ready, so a vault of existing
 *   files does not replay as `create` events at startup.
 * - The handler is O(1): it normalises the payload's path, tests it against the
 *   task-note path shape and hands it to the coalescer. It performs no read,
 *   write, stat or network call and returns at once; the flush runs from the
 *   registry's timer slot.
 * - A modify event for a path the plugin itself just wrote is dropped for a short
 *   window (the write already told the service), which keeps a note edit from
 *   echoing back as a second `changed` call.
 * - The service's `changed` route re-reads frontmatter and never writes the
 *   note, so a modify-changed-write loop is unreachable.
 */

/** How long the plugin's own write suppresses the echo of its modify event. */
export const OWN_WRITE_WINDOW_MS = 2000;

export interface OwnWriteLedger {
  /** Marks a path as written by this plugin just now. */
  record(path: string): void;
  /** Un-marks a path (a write that did not happen, so a later external edit is not dropped). */
  forget(path: string): void;
  /** Matches a modify event to a recorded write ONCE: true (and the mark is consumed) while one is younger than the window. */
  consumeEcho(path: string): boolean;
  /** True while a recorded write is younger than the window. */
  isRecent(path: string): boolean;
}

export function createOwnWriteLedger(
  now: () => number,
  windowMs: number = OWN_WRITE_WINDOW_MS,
): OwnWriteLedger {
  const writes = new Map<string, number>();
  return {
    record(path) {
      const at = now();
      // Expired entries are swept on every record, so the map stays as small as the window.
      for (const [other, when] of writes) if (at - when > windowMs) writes.delete(other);
      writes.set(path, at);
    },
    forget(path) {
      writes.delete(path);
    },
    consumeEcho(path) {
      const when = writes.get(path);
      if (when === undefined) return false;
      writes.delete(path);
      return now() - when <= windowMs;
    },
    isRecent(path) {
      const when = writes.get(path);
      return when !== undefined && now() - when <= windowMs;
    },
  };
}

export interface TaskWatchDeps {
  readonly now: () => number;
  /** Sends one batch to the service. Defaults to the task API holder's `changed`. */
  readonly changed?: (batch: CoalescedBatch) => Promise<unknown>;
  /** Receives the class name of a failed flush, once. Never the message. */
  readonly log?: (className: string) => void;
}

/** A tasks folder or anything under it, directly under a managed scope root. */
const TASKS_FOLDER_PATH = new RegExp(
  `^(?:global|workspaces/[0-9a-z]{25})/${TASKS_FOLDER_NAME}(?:/.*)?$`,
);

const VAULT_EVENTS = ["create", "modify", "delete", "rename"] as const;

function pathOf(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const path = (payload as { path?: unknown }).path;
  return typeof path === "string" ? path : null;
}

function defaultChanged(batch: CoalescedBatch): Promise<unknown> {
  const request: TaskChangedRequest =
    "rescan" in batch ? { rescan: true } : { paths: [...batch.paths] };
  return tasksApi().changed(request);
}

function classNameOf(error: unknown): string {
  const name = typeof error === "object" && error !== null ? error.constructor?.name : undefined;
  return typeof name === "string" && name !== "" ? name : "UnknownError";
}

/**
 * Registers the create, modify, delete and rename subscriptions, the flush timer
 * and the pending-flush cancel, all through the registry. Returns the own-write
 * ledger the task actions record into.
 */
export function registerTaskVaultWatch(
  registry: Pick<HostRegistry, "vaultEvent" | "timer" | "cleanup">,
  deps: TaskWatchDeps,
): { readonly ownWrites: OwnWriteLedger } {
  const ownWrites = createOwnWriteLedger(deps.now);
  const slot = registry.timer();
  const send = deps.changed ?? defaultChanged;

  const coalescer = createPathCoalescer({
    schedule(callback, ms) {
      slot.schedule(callback, ms);
      return () => slot.cancel();
    },
    now: deps.now,
    flush(batch) {
      // One call per flush; a failure is logged by class and dropped. The next
      // change, the startup walk or "Rebuild task index" catches the index up,
      // so nothing is retried here.
      send(batch).catch((error: unknown) => deps.log?.(classNameOf(error)));
    },
  });
  registry.cleanup(() => coalescer.cancel());

  // Obsidian's `rename` event passes the old path second; the registry types a
  // handler with one parameter, and a function with an extra optional one fits.
  const handlerFor =
    (name: (typeof VAULT_EVENTS)[number]) =>
    (payload?: unknown, previous?: unknown): void => {
      const path = pathOf(payload);
      if (path === null) return;
      const old = typeof previous === "string" ? previous : null;
      if (typeof payload === "object" && payload !== null && "children" in payload) {
        if (TASKS_FOLDER_PATH.test(path) || (old !== null && TASKS_FOLDER_PATH.test(old))) {
          coalescer.addRescan();
        }
        return;
      }
      // Only the modify event that echoes our own write is dropped; a create,
      // delete or rename inside the window is somebody else's change and always passes.
      const echo = name === "modify" && ownWrites.consumeEcho(path);
      if (isTaskNotePath(path) && !echo) coalescer.add(path);
      if (old !== null && isTaskNotePath(old)) coalescer.add(old);
    };

  for (const name of VAULT_EVENTS) registry.vaultEvent(name, handlerFor(name));
  return { ownWrites };
}
