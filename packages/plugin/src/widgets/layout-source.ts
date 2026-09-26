import { type LayoutOverride, layoutOverrideSchema } from "@ccc/domain";
import { normalizePath } from "obsidian";
import { recordDiagnostic } from "../diagnostics.js";
import type { HostRegistry } from "../host-registry.js";
import { setLayoutOverride } from "./layout.js";

/**
 * The layout override file, watched live (UI-07, D-11; research Pattern 5 and
 * Pitfall 4).
 *
 * **Why polling.** The public Obsidian API has no file-watch capability, and
 * the vault's `create`/`modify`/`delete`/`rename` events fire for vault files
 * only -- the plugin data folder under `vault.configDir` is not vault content,
 * so they never fire for it. What IS public and sufficient is
 * `DataAdapter.stat()`, so the poller stats the file once per interval and
 * re-reads it only when `(mtime, size)` changed. That is inherently debounced
 * (two saves inside one interval produce one reload) and immune to an editor
 * that saves by atomic rename, because it compares whatever currently occupies
 * the path rather than following a file handle.
 *
 * **Why never a literal config-directory name.** Obsidian lets the owner
 * rename the config directory, so the path is built from `vault.configDir`
 * through `normalizePath` (`obsidianmd/hardcoded-config-path` is at `error`).
 *
 * **Why a bad edit costs nothing (D-13).** The file is hand-edited, so it is
 * routinely malformed mid-typing. A file that fails to parse or validate is
 * ignored: the previous resolution (or the typed default) keeps rendering, the
 * Overview is never blanked or given a placeholder, and the reason goes to
 * diagnostics instead -- naming the parser position or the schema issue's
 * location and kind, never the file's content: not a value, not an unknown
 * key's name (T-03-15).
 */

export const LAYOUT_FILENAME = "layout.json";
export const LAYOUT_POLL_MS = 1000;

/** The two numbers change detection compares. */
export interface LayoutFileStat {
  readonly mtime: number;
  readonly size: number;
}

/**
 * The layout file behind one typed seam: production adapts the Obsidian
 * `DataAdapter` through {@link createAdapterLayoutSource}; tests may pass a
 * plain object. `stat()` resolves `null` when there is no file at the path.
 */
export interface LayoutFileSource {
  stat(): Promise<LayoutFileStat | null>;
  read(): Promise<string>;
}

/**
 * The subset of Obsidian's `Vault` the source needs. The real `Vault`
 * satisfies it structurally, so production passes `this.app.vault` and a test
 * passes a plain object -- neither needs a cast.
 */
export interface LayoutVaultLike {
  readonly configDir: string;
  readonly adapter: {
    stat(normalizedPath: string): Promise<{ type: string; mtime: number; size: number } | null>;
    read(normalizedPath: string): Promise<string>;
  };
}

/** `<configDir>/plugins/<plugin id>/layout.json`, normalized. */
export function layoutFilePath(configDir: string, pluginId: string): string {
  return normalizePath(`${configDir}/plugins/${pluginId}/${LAYOUT_FILENAME}`);
}

/**
 * The production source: the override file in this plugin's own data folder,
 * read through the vault's public `DataAdapter`. The path is computed once. A
 * folder occupying the path is treated as no file.
 */
export function createAdapterLayoutSource(
  vault: LayoutVaultLike,
  pluginId: string,
): LayoutFileSource {
  const path = layoutFilePath(vault.configDir, pluginId);
  return {
    async stat() {
      const stat = await vault.adapter.stat(path);
      if (stat === null || stat.type !== "file") return null;
      return { mtime: stat.mtime, size: stat.size };
    },
    read() {
      return vault.adapter.read(path);
    },
  };
}

export interface LayoutPollingOptions {
  /** Where the poll interval is registered, so unload releases it. */
  readonly registry: Pick<HostRegistry, "interval">;
  readonly source: LayoutFileSource;
  /** Applies a validated override, or `undefined` for the default. */
  readonly apply?: (next: LayoutOverride | undefined) => unknown;
  readonly pollMs?: number;
}

export interface LayoutPoller {
  /**
   * One poll: stat, and re-read, validate and apply only on change. Always
   * resolves -- a failure is recorded in diagnostics, never thrown, because
   * the interval callback that drives it has nowhere to send a rejection.
   */
  tick(): Promise<void>;
}

/** The result of validating the file's text: an override, or why not. */
export type LayoutParseResult =
  | { readonly ok: true; readonly override: LayoutOverride }
  | { readonly ok: false; readonly detail: string };

/**
 * The longest parser/schema detail a diagnostic carries. Every detail is built
 * from fixed phrases, schema-known keys and numbers, so this bound is a
 * backstop rather than the privacy control (T-03-15).
 */
const MAX_DETAIL_LENGTH = 160;

/**
 * Every key the schema itself defines. A path segment is echoed only when it
 * is one of these (or an array index); anything else could only have come
 * from the file, so it is replaced by `?` (T-03-15).
 */
const SCHEMA_KEYS: ReadonlySet<string> = new Set([
  ...Object.keys(layoutOverrideSchema.shape),
  ...Object.keys(layoutOverrideSchema.shape.entries.element.shape),
]);

/** One schema issue, typed from the schema's own parse result (no direct zod import). */
type LayoutIssue = NonNullable<
  ReturnType<typeof layoutOverrideSchema.safeParse>["error"]
>["issues"][number];

/**
 * JSON.parse's own message can quote a slice of the input it failed on, and
 * the file's content must never reach a diagnostic (T-03-15). Keep only the
 * position, which is what the owner needs to find the typo.
 */
function describeJsonError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const where = /at position \d+(?: \(line \d+ column \d+\))?/.exec(message);
  return where === null ? "it is not valid JSON" : `it is not valid JSON (${where[0]})`;
}

/** An issue's location, from schema-known keys and array indices only. */
function describePath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return "(document)";
  return path
    .map((segment) =>
      typeof segment === "number" || (typeof segment === "string" && SCHEMA_KEYS.has(segment))
        ? String(segment)
        : "?",
    )
    .join(".");
}

/**
 * What went wrong, as a fixed phrase. Zod's own `message` is never used: for
 * an unrecognized key it quotes the key, which is file content (T-03-15). The
 * only variable parts are a count and a bound the schema itself declares.
 */
function describeProblem(issue: LayoutIssue): string {
  switch (issue.code) {
    case "unrecognized_keys": {
      const count = issue.keys.length;
      return `${count} unknown field${count === 1 ? "" : "s"}`;
    }
    case "invalid_type":
      return "wrong type";
    case "invalid_value":
      return "not an allowed value";
    case "too_big":
      return issue.origin === "array"
        ? `too many items (maximum ${String(issue.maximum)})`
        : `too long (maximum ${String(issue.maximum)})`;
    case "too_small":
      return issue.origin === "array"
        ? `too few items (minimum ${String(issue.minimum)})`
        : `too short (minimum ${String(issue.minimum)})`;
    default:
      return "does not match the layout schema";
  }
}

/**
 * Parses and validates the file's text against the `@ccc/domain` schema
 * (strict, bounded, `schemaVersion` literal -- T-03-02). The detail names the
 * first problem -- a JSON syntax position, or the first schema issue's
 * location and kind -- plus how many more there are. It is built only from
 * fixed phrases, schema-known keys and numbers, so no text the file supplied
 * (a value, an unknown key's name) can reach it (T-03-15).
 */
export function parseLayoutOverride(text: string): LayoutParseResult {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return { ok: false, detail: describeJsonError(error) };
  }
  const parsed = layoutOverrideSchema.safeParse(json);
  if (parsed.success) return { ok: true, override: parsed.data };
  const [first, ...rest] = parsed.error.issues;
  const head =
    first === undefined
      ? "(document): does not match the layout schema"
      : `${describePath(first.path)}: ${describeProblem(first)}`;
  const more =
    rest.length === 0 ? "" : ` (and ${rest.length} more problem${rest.length === 1 ? "" : "s"})`;
  const detail = `${head}${more}`;
  return {
    ok: false,
    detail:
      detail.length > MAX_DETAIL_LENGTH ? `${detail.slice(0, MAX_DETAIL_LENGTH - 1)}…` : detail,
  };
}

function recordLayoutProblem(
  code: "override-invalid" | "override-unreadable",
  message: string,
): void {
  recordDiagnostic({ source: "layout", code, message, at: new Date().toISOString() });
}

/**
 * Starts watching the layout file: registers the poll interval through the
 * host registry and runs one tick immediately, so an override applies at load
 * without waiting a whole interval.
 *
 * **What a tick does with each state of the file.**
 * - Absent: apply the typed default -- once, on the first tick that finds it
 *   absent (at load, or after a removal), not every second.
 * - Present and `(mtime, size)` unchanged since the last tick: nothing; one
 *   stat is the whole cost.
 * - Present and changed: read, parse, validate. Valid → apply. Invalid →
 *   the previous resolution keeps rendering and ONE diagnostic names the
 *   problem (D-13); the new `(mtime, size)` is remembered, so a bad file is
 *   read once rather than every second while the owner is mid-edit, and the
 *   next save is picked up on the next tick.
 * - Present, changed, and the read itself fails: the previous resolution
 *   keeps rendering, ONE diagnostic is recorded for the run of failures, and
 *   the `(mtime, size)` is NOT remembered -- an I/O failure is transient, so
 *   the read is retried on the next tick until it succeeds.
 *
 * Overlapping ticks never stack: a tick that finds another still in flight
 * returns at once, so a slow disk cannot pile reads up behind the interval.
 */
export function startLayoutPolling({
  registry,
  source,
  apply = setLayoutOverride,
  pollMs = LAYOUT_POLL_MS,
}: LayoutPollingOptions): LayoutPoller {
  /** The last stat acted on; `"absent"` once the default is applied; `undefined` before the first tick. */
  let seen: LayoutFileStat | "absent" | undefined;
  let inFlight = false;
  let statFailing = false;
  let readFailing = false;

  async function poll(): Promise<void> {
    let stat: LayoutFileStat | null;
    try {
      stat = await source.stat();
      statFailing = false;
    } catch {
      // Recorded once per run of failures, not once per second.
      if (!statFailing) {
        statFailing = true;
        recordLayoutProblem(
          "override-unreadable",
          `${LAYOUT_FILENAME} could not be checked; the current layout stays.`,
        );
      }
      return;
    }

    if (stat === null) {
      if (seen !== "absent") {
        seen = "absent";
        apply(undefined);
      }
      return;
    }
    if (
      seen !== undefined &&
      seen !== "absent" &&
      seen.mtime === stat.mtime &&
      seen.size === stat.size
    ) {
      return;
    }
    const previous = seen;
    seen = { mtime: stat.mtime, size: stat.size };

    let text: string;
    try {
      text = await source.read();
      readFailing = false;
    } catch {
      // An I/O failure says nothing about the file's content (a lock, a sync
      // mid-write), so forget this stat and read again on the next tick --
      // otherwise a valid save could stay unapplied until the owner saves
      // again. Recorded once per run of failures, not once per retry.
      seen = previous;
      if (!readFailing) {
        readFailing = true;
        recordLayoutProblem(
          "override-unreadable",
          `${LAYOUT_FILENAME} could not be read; the current layout stays.`,
        );
      }
      return;
    }

    const result = parseLayoutOverride(text);
    if (result.ok) {
      apply(result.override);
    } else {
      recordLayoutProblem(
        "override-invalid",
        `${LAYOUT_FILENAME} could not be applied: ${result.detail}`,
      );
    }
  }

  async function tick(): Promise<void> {
    if (inFlight) return;
    inFlight = true;
    try {
      await poll();
    } finally {
      inFlight = false;
    }
  }

  registry.interval(() => {
    void tick();
  }, pollMs);
  void tick();

  return { tick };
}
