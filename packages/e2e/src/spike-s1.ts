/**
 * Pure pieces of spike S1 (05.2-01, Codex finding 3): can the runner observe the plugin's own
 * approval notification and its click handler? The first S1 probe waited 2.5 s although the
 * plugin delays a test approval by 5 s, kept Obsidian focused (which suppresses native
 * notifications), and passed on notification permission alone, so it could not fail. The
 * decision and the bounded wait live here, free of wdio, so they are unit-tested.
 */

export interface S1Evidence {
  /** Notification.permission as the renderer reports it. */
  permission: string;
  /** Whether the settings tab's "Send a test approval" button was found and clicked. */
  buttonFound: boolean;
  /** How the window was unfocused before the approval was sent, and whether it worked. */
  blur: { method: string; hasFocusAfter: boolean };
  /** Time spent waiting for the plugin's notification, in milliseconds. */
  waitedMs: number;
  /** True when the bounded wait ended without a plugin notification. */
  timedOut: boolean;
  /** Notifications constructed while the plugin, not the probe, was the source. */
  pluginNotificationsCreated: number;
  /** Whether at least one of them carries an onclick handler. */
  pluginClickHandlerExists: boolean;
}

export interface S1Decision {
  verdict: "pass" | "fail";
  /** Fixed prose, never a path. */
  reason: string;
}

/** Pass only when the plugin itself created a notification and attached a click handler. */
export function decideS1(evidence: S1Evidence): S1Decision {
  if (!evidence.buttonFound) {
    return { verdict: "fail", reason: "the Send a test approval button was not found" };
  }
  if (evidence.permission !== "granted") {
    return { verdict: "fail", reason: `notification permission is ${evidence.permission}` };
  }
  if (evidence.pluginNotificationsCreated < 1) {
    const focus = evidence.blur.hasFocusAfter
      ? `; the window stayed focused (blur method ${evidence.blur.method}), which suppresses native notifications, so this negative is not conclusive`
      : "";
    return {
      verdict: "fail",
      reason: `no plugin notification was created within ${evidence.waitedMs} ms${focus}`,
    };
  }
  if (!evidence.pluginClickHandlerExists) {
    return {
      verdict: "fail",
      reason: "the plugin created a notification but attached no click handler",
    };
  }
  return { verdict: "pass", reason: "the plugin created a notification with a click handler" };
}

export interface PollOptions {
  timeoutMs: number;
  intervalMs: number;
  /** Injected so tests need no real time. */
  sleep(ms: number): Promise<void>;
}

export interface PollResult<T> {
  value: T;
  timedOut: boolean;
  /** Sum of the sleeps taken; it never exceeds timeoutMs. */
  waitedMs: number;
}

/** Probes until `done` holds or `timeoutMs` of sleeping has elapsed. Always probes at least once. */
export async function pollUntil<T>(
  probe: () => Promise<T>,
  done: (value: T) => boolean,
  options: PollOptions,
): Promise<PollResult<T>> {
  if (!(options.intervalMs > 0)) throw new Error("pollUntil needs a positive interval.");
  let waitedMs = 0;
  for (;;) {
    const value = await probe();
    if (done(value)) return { value, timedOut: false, waitedMs };
    if (waitedMs >= options.timeoutMs) return { value, timedOut: true, waitedMs };
    const step = Math.min(options.intervalMs, options.timeoutMs - waitedMs);
    await options.sleep(step);
    waitedMs += step;
  }
}
