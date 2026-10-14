import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";

/**
 * Keeps wdio's per-worker logs (hook errors land there, not on the console) before the run root
 * is torn down. The folder is created with a random suffix (mkdtemp, never an existing path),
 * mode 0700; only regular `.log` files are copied, checked with lstat so a symlink or directory is
 * skipped and never followed; the copy refuses to overwrite. Returns the folder, or null when
 * there is nothing to keep.
 */
export function keepWdioLogs(input: {
  wdioDir: string;
  destBase: string;
  runId: string;
  /**
   * The run's service runtime directory: its `logs` folder (the live service log) and `kept-logs`
   * folder (the logs of earlier services in the run, archived by the fixture's reset) are kept
   * too, as `service-*.log` and `service-kept-*.log`. Without it the service's own output is gone
   * with the run root, which left runs 18 and 22 undiagnosable.
   */
  runtimeDir?: string;
}): string | null {
  const sources: Array<{ dir: string; prefix: string }> = [{ dir: input.wdioDir, prefix: "" }];
  if (input.runtimeDir !== undefined) {
    sources.push({ dir: join(input.runtimeDir, "logs"), prefix: "service-" });
    sources.push({ dir: join(input.runtimeDir, "kept-logs"), prefix: "service-kept-" });
  }
  const found: Array<{ from: string; name: string }> = [];
  for (const source of sources) {
    try {
      if (!lstatSync(source.dir).isDirectory()) continue;
      for (const name of readdirSync(source.dir)) {
        if (name.endsWith(".log"))
          found.push({ from: join(source.dir, name), name: source.prefix + name });
      }
    } catch {
      // A source that is missing or unreadable contributes nothing.
    }
  }
  let wdioPresent = false;
  try {
    wdioPresent = lstatSync(input.wdioDir).isDirectory();
  } catch {
    wdioPresent = false;
  }
  if (!wdioPresent && found.length === 0) return null;
  const dest = mkdtempSync(join(input.destBase, `ccc-uat-wdio-logs-${input.runId}-`));
  chmodSync(dest, 0o700);
  for (const { from, name } of found) {
    try {
      if (!lstatSync(from).isFile()) continue;
      copyFileSync(from, join(dest, name), constants.COPYFILE_EXCL);
    } catch {
      // One unreadable or colliding log never stops the others being kept.
    }
  }
  return dest;
}

export const WDIO_LOGS_PREFIX = "ccc-uat-wdio-logs-";

/**
 * Removes kept wdio log folders last modified longer than `maxAgeMs` ago, at the start of a run.
 * Only names with the kept-logs prefix are touched; a link with such a name is unlinked, never
 * followed. Returns the removed names.
 */
export function purgeStaleWdioLogs(input: {
  base: string;
  maxAgeMs: number;
  now?: number;
}): string[] {
  if (!existsSync(input.base)) return [];
  const now = input.now ?? Date.now();
  const removed: string[] = [];
  for (const name of readdirSync(input.base).sort()) {
    if (!name.startsWith(WDIO_LOGS_PREFIX)) continue;
    const path = join(input.base, name);
    const stat = lstatSync(path);
    if (now - stat.mtimeMs < input.maxAgeMs) continue;
    if (stat.isSymbolicLink()) {
      unlinkSync(path);
      removed.push(name);
    } else if (stat.isDirectory()) {
      rmSync(path, { recursive: true, force: true });
      removed.push(name);
    }
  }
  return removed;
}
