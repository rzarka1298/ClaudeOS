import { type LayoutOverride, layoutOverrideSchema } from "@ccc/domain";
import { normalizePath } from "obsidian";
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
  /** One poll: stat, and re-read, validate and apply only on change. */
  tick(): Promise<void>;
}

/**
 * Starts watching the layout file: registers the poll interval through the
 * host registry and runs one tick immediately, so an override applies at load
 * without waiting a whole interval.
 */
export function startLayoutPolling({
  registry,
  source,
  apply = setLayoutOverride,
  pollMs = LAYOUT_POLL_MS,
}: LayoutPollingOptions): LayoutPoller {
  let last: LayoutFileStat | null = null;

  async function tick(): Promise<void> {
    const stat = await source.stat();
    if (stat === null) return;
    if (last !== null && last.mtime === stat.mtime && last.size === stat.size) return;
    last = { mtime: stat.mtime, size: stat.size };

    const text = await source.read();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return;
    }
    const parsed = layoutOverrideSchema.safeParse(json);
    if (parsed.success) apply(parsed.data);
  }

  registry.interval(() => {
    void tick();
  }, pollMs);
  void tick();

  return { tick };
}
