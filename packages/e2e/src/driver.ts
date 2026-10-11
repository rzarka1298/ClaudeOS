export interface SandboxProbe {
  envSocketPath: string | null;
  pluginSocketOverride: string | null;
}
export interface DriverBrowser {
  executeObsidian<T, A extends unknown[]>(
    fn: (ctx: never, ...args: A) => T | Promise<T>,
    ...args: A
  ): Promise<T>;
  executeObsidianCommand(id: string): Promise<void>;
}
export async function pollUntil<T>(
  _check: () => T | Promise<T>,
  _opts: {
    timeoutMs: number;
    intervalMs: number;
    describe: string;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<T> {
  return undefined as T;
}
export function parseCountInWords(_text: string): { label: string; count: number } | null {
  return { label: "", count: -1 };
}
export async function assertSandboxConnected(
  _browser: DriverBrowser,
  _opts: { expectedSocketPath: string },
): Promise<void> {}
export async function runPluginCommand(_browser: DriverBrowser, _id: string): Promise<void> {}
