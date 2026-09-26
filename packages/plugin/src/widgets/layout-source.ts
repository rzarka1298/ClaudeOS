import type { LayoutOverride } from "@ccc/domain";
import type { HostRegistry } from "../host-registry.js";

/** RED stub (plan 03-08 Task 1): the shapes exist, the behaviour does not yet. */

export const LAYOUT_FILENAME = "layout.json";
export const LAYOUT_POLL_MS = 1000;

export interface LayoutFileStat {
  readonly mtime: number;
  readonly size: number;
}

export interface LayoutFileSource {
  stat(): Promise<LayoutFileStat | null>;
  read(): Promise<string>;
}

export interface LayoutVaultLike {
  readonly configDir: string;
  readonly adapter: {
    stat(normalizedPath: string): Promise<{ type: string; mtime: number; size: number } | null>;
    read(normalizedPath: string): Promise<string>;
  };
}

export interface LayoutPollingOptions {
  readonly registry: Pick<HostRegistry, "interval">;
  readonly source: LayoutFileSource;
  readonly apply?: (next: LayoutOverride | undefined) => unknown;
  readonly pollMs?: number;
}

export interface LayoutPoller {
  tick(): Promise<void>;
}

export function createAdapterLayoutSource(
  _vault: LayoutVaultLike,
  _pluginId: string,
): LayoutFileSource {
  return {
    stat: () => Promise.resolve(null),
    read: () => Promise.reject(new Error("not implemented yet (plan 03-08)")),
  };
}

export function startLayoutPolling(_options: LayoutPollingOptions): LayoutPoller {
  return { tick: () => Promise.resolve() };
}
