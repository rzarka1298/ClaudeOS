import type { CacheVerdict } from "./run-uat.js";
import type { SpikeDecisions } from "./spike-decisions.js";

export interface CacheFiles {
  cacheDir: string;
  exists: (path: string) => boolean;
  sha256: (path: string) => string;
}

type Decided = Pick<SpikeDecisions, "appVersion" | "obsidianCacheSha256">;

export function cacheArchivePath(_cacheDir: string, _appVersion: string): string {
  throw new Error("cacheArchivePath is not implemented yet (typed skeleton)");
}

export function verifyObsidianCache(_decisions: Decided, _files: CacheFiles): CacheVerdict {
  throw new Error("verifyObsidianCache is not implemented yet (typed skeleton)");
}

export function realCacheFiles(_cacheDir: string): CacheFiles {
  throw new Error("realCacheFiles is not implemented yet (typed skeleton)");
}
