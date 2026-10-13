import { chmodSync, constants, copyFileSync, lstatSync, mkdtempSync, readdirSync } from "node:fs";
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
}): string | null {
  let names: string[];
  try {
    if (!lstatSync(input.wdioDir).isDirectory()) return null;
    names = readdirSync(input.wdioDir);
  } catch {
    return null;
  }
  const dest = mkdtempSync(join(input.destBase, `ccc-uat-wdio-logs-${input.runId}-`));
  chmodSync(dest, 0o700);
  for (const name of names) {
    if (!name.endsWith(".log")) continue;
    const from = join(input.wdioDir, name);
    if (!lstatSync(from).isFile()) continue;
    copyFileSync(from, join(dest, name), constants.COPYFILE_EXCL);
  }
  return dest;
}
