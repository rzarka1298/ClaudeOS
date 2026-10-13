/**
 * Driver helpers shared by the live-UAT specs (05.2-04, E2E-04, T-05.2-08).
 *
 * Waits are conditions, never fixed sleeps (`pollUntil`, or wdio's own `waitUntil`). The browser
 * is a small structural interface so these helpers are unit-tested with no wdio runtime.
 *
 * Recorded spike decisions (05.2-RESEARCH.md "Spike results"):
 * - S2: activation works (electron-window-focus) but a programmatic focus shows no focus ring
 *   (focusVisible false, outline 0px), so focus-ring checks must drive focus with the keyboard.
 * - S5 failed (reducedMotion setting-only): there is no CDP emulation of prefers-reduced-motion
 *   (`browser.cdp` is missing on the Electron session). Specs toggle the plugin's reduced-motion
 *   setting through its data.json instead; nothing here emulates the OS media query.
 */

/** The sandbox facts read from inside the renderer. */
export interface SandboxProbe {
  /** `process.env.CCC_SOCKET_PATH` as the renderer sees it, or null when unset. */
  envSocketPath: string | null;
  /** The plugin's persisted `socketPathOverride`, or null when none is stored. */
  pluginSocketOverride: string | null;
}

interface LooseObsidianContext {
  app?: {
    commands?: { commands?: Record<string, unknown> };
    plugins?: {
      plugins?: Record<string, { loadData?: () => Promise<unknown> } | undefined>;
    };
  };
}

/** The slice of the wdio-obsidian-service browser these helpers use. */
export interface DriverBrowser {
  executeObsidian<T, A extends unknown[]>(
    fn: (ctx: LooseObsidianContext, ...args: A) => T | Promise<T>,
    ...args: A
  ): Promise<T>;
  executeObsidianCommand(id: string): Promise<void>;
}

export interface PollOptions {
  timeoutMs: number;
  intervalMs: number;
  /** What the wait is for; it appears in the timeout message. */
  describe: string;
  /** Injectable clock and sleeper (real by default) so tests never sleep. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

function show(value: unknown): string {
  try {
    const text = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
    return text.length > 200 ? `${text.slice(0, 200)}...` : text;
  } catch {
    return "(unprintable)";
  }
}

/**
 * Polls `check` until it returns a truthy value and resolves with it. A throwing check counts as
 * "not ready yet". On timeout it rejects with the describe text and the last observed value.
 */
export async function pollUntil<T>(
  check: () => T | Promise<T>,
  options: PollOptions,
): Promise<NonNullable<T>> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? realSleep;
  const start = now();
  let last = "(never checked)";
  for (;;) {
    try {
      const value = await check();
      if (value) return value as NonNullable<T>;
      last = show(value);
    } catch (error) {
      last = `threw: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (now() - start >= options.timeoutMs) {
      throw new Error(
        `Timed out after ${options.timeoutMs}ms waiting for ${options.describe}; last observed: ${last}`,
      );
    }
    await sleep(options.intervalMs);
  }
}

const COUNT_IN_WORDS = /^(.+?),\s*(?:(\d{1,3}(?:,\d{3})+|\d+)|no)\s+tasks?$/;

/** Parses 'Today, 3 tasks', 'Overdue, 1 task' and 'Blocked, no tasks'; null for anything else. */
export function parseCountInWords(text: string): { label: string; count: number } | null {
  const match = COUNT_IN_WORDS.exec(text.trim());
  if (match?.[1] === undefined) return null;
  const label = match[1].trim();
  if (label === "") return null;
  return { label, count: match[2] === undefined ? 0 : Number(match[2].replace(/,/g, "")) };
}

const PLUGIN_ID = "claude-command-center";

/** Runs inside the renderer (self-contained): the socket environment and the plugin's override. */
async function probeSandboxInRenderer(
  ctx: LooseObsidianContext,
  pluginId: string,
): Promise<SandboxProbe> {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  const env = proc?.env?.["CCC_SOCKET_PATH"];
  const plugin = ctx.app?.plugins?.plugins?.[pluginId];
  const data = (await plugin?.loadData?.()) as { socketPathOverride?: unknown } | null | undefined;
  const override = data?.socketPathOverride;
  return {
    envSocketPath: typeof env === "string" && env !== "" ? env : null,
    pluginSocketOverride: typeof override === "string" ? override : null,
  };
}

/**
 * Throws unless the renderer is pointed at the sandbox socket and nothing else: its environment
 * value must equal the expected path exactly and the plugin override must be the same path or
 * unset. The message names only the category, never a path.
 */
export async function assertSandboxConnected(
  browser: DriverBrowser,
  options: { expectedSocketPath: string },
): Promise<void> {
  if (options.expectedSocketPath === "") {
    throw new Error("Sandbox isolation check failed: no expected sandbox socket was given.");
  }
  const probe = await browser.executeObsidian(probeSandboxInRenderer, PLUGIN_ID);
  if (probe === null || typeof probe !== "object") {
    throw new Error("Sandbox isolation check failed: the renderer probe returned nothing usable.");
  }
  if (probe.envSocketPath !== options.expectedSocketPath) {
    throw new Error(
      "Sandbox isolation check failed: the renderer socket environment is not the sandbox socket.",
    );
  }
  if (
    probe.pluginSocketOverride !== null &&
    probe.pluginSocketOverride !== options.expectedSocketPath
  ) {
    throw new Error(
      "Sandbox isolation check failed: the plugin socket override is not the sandbox socket.",
    );
  }
}

/** Runs a plugin command by id; fails naming the id when it is not registered. */
export async function runPluginCommand(browser: DriverBrowser, commandId: string): Promise<void> {
  const registered = await browser.executeObsidian(
    (ctx, id: string) => Boolean(ctx.app?.commands?.commands?.[id]),
    commandId,
  );
  if (!registered) throw new Error(`Plugin command is not registered: ${commandId}`);
  await browser.executeObsidianCommand(commandId);
}
