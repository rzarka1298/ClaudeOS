import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ProcessEntry } from "./ledger.js";

/**
 * The process listing behind the leak check and the stale sweep (05.2-03, D-06). The service's
 * identity lives only in its environment, so processes are identified by pid plus the start-time
 * text the listing prints (and a command-line marker), never by a name search.
 */

/** pid, a fixed-format start time (`lstart`), then the command line. */
const ROW =
  /^\s*(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\S.*)$/;

/** Parses `ps -axo pid=,lstart=,command=`; blank and malformed lines are ignored. */
export function parseProcessTable(output: string): ProcessEntry[] {
  const entries: ProcessEntry[] = [];
  for (const line of output.split("\n")) {
    const match = ROW.exec(line);
    if (match === null) continue;
    entries.push({
      pid: Number(match[1]),
      start: match[2] as string,
      command: (match[3] as string).trimEnd(),
    });
  }
  return entries;
}

export type ExecFileFn = (
  file: string,
  args: string[],
  options: { env: Record<string, string | undefined>; maxBuffer: number },
) => Promise<{ stdout: string }>;

const defaultExecFile: ExecFileFn = (file, args, options) =>
  promisify(execFile)(file, args, options) as Promise<{ stdout: string }>;

const MAX_LISTING_BYTES = 64 * 1024 * 1024;

/** Runs the listing as an argv array (no shell) with a fixed locale so start-time text is stable. */
export async function readProcessTable(
  exec: ExecFileFn = defaultExecFile,
): Promise<ProcessEntry[]> {
  const { stdout } = await exec("ps", ["-axo", "pid=,lstart=,command="], {
    env: { ...process.env, LC_ALL: "C" },
    maxBuffer: MAX_LISTING_BYTES,
  });
  return parseProcessTable(stdout);
}
