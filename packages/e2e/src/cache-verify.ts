import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CacheVerdict } from "./run-uat.js";
import type { SpikeDecisions } from "./spike-decisions.js";

/**
 * The pinned Obsidian download check (05.2-09, Q2, D-08): the cached app archive must hash to the
 * checksum recorded with the spike decisions. It reads the cache and nothing else; the wdio
 * service downloads on a first run, and the orchestrator records the checksum afterwards. Notes
 * are fixed sentences, never a hash or a path.
 */

export interface CacheFiles {
  cacheDir: string;
  exists: (path: string) => boolean;
  sha256: (path: string) => string;
}

type Decided = Pick<SpikeDecisions, "appVersion" | "obsidianCacheSha256">;

/** `<cache>/obsidian-app/obsidian-<version>.asar`, where wdio-obsidian-service keeps the app. */
export function cacheArchivePath(cacheDir: string, appVersion: string): string {
  return join(cacheDir, "obsidian-app", `obsidian-${appVersion}.asar`);
}

export function verifyObsidianCache(decisions: Decided, files: CacheFiles): CacheVerdict {
  const recorded = decisions.obsidianCacheSha256;
  if (recorded === null) return { ok: true, note: "no checksum is recorded yet (not recorded)" };
  const archive = cacheArchivePath(files.cacheDir, decisions.appVersion);
  if (!files.exists(archive)) return { ok: false, note: "the cached app archive is missing" };
  if (files.sha256(archive) !== recorded) {
    return { ok: false, note: "the cached app archive does not match the recorded checksum" };
  }
  return { ok: true, note: "the cached app archive matches the recorded checksum" };
}

export function realCacheFiles(cacheDir: string): CacheFiles {
  return {
    cacheDir,
    exists: (path) => existsSync(path),
    sha256: (path) => createHash("sha256").update(readFileSync(path)).digest("hex"),
  };
}
