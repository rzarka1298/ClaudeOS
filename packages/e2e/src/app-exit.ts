import type { ProcessEntry } from "./ledger.js";

/**
 * Waits (bounded) until no installed-Obsidian process names the run root, so the next spec's app
 * never starts while the previous one is still quitting (two live instances of one app can hand
 * the window to one and close the other). It only reads the process table and never signals.
 */
export async function waitForAppExit(input: {
  readTable: () => Promise<readonly ProcessEntry[]>;
  appBinary: string;
  runRoot: string;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  timeoutMs: number;
  intervalMs: number;
}): Promise<{ exited: boolean; polls: number }> {
  const deadline = input.now() + input.timeoutMs;
  let polls = 0;
  for (;;) {
    polls += 1;
    const table = await input.readTable();
    const alive = table.some(
      (row) => row.command.startsWith(input.appBinary) && row.command.includes(input.runRoot),
    );
    if (!alive) return { exited: true, polls };
    if (input.now() >= deadline) return { exited: false, polls };
    await input.sleep(input.intervalMs);
  }
}
