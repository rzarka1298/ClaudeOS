import type { Logger } from "pino";

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "non-error";
}

/**
 * Runs one `stop()` step with a deadline and a try/catch of its own, so a hung or failing step never
 * prevents the later steps. Logs reason codes and the step name only (no raw errors).
 */
export async function runBoundedStopStep(input: {
  readonly name: string;
  readonly run: () => void | Promise<void>;
  readonly deadlineMs: number;
  readonly logger: Pick<Logger, "warn">;
}): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const running = Promise.resolve().then(input.run);
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), input.deadlineMs);
    });
    const outcome = await Promise.race([running.then(() => "done" as const), timedOut]);
    if (outcome === "timeout") {
      running.catch(() => undefined);
      input.logger.warn(
        { reason: "stop-step-timeout", step: input.name },
        "codex service did not stop in time",
      );
    }
  } catch (error: unknown) {
    input.logger.warn(
      { reason: "stop-step-failed", step: input.name, errorName: errorName(error) },
      "codex service did not stop cleanly",
    );
  } finally {
    clearTimeout(timer);
  }
}

/** How long `stop()` waits for one step before it moves on to the next (milliseconds). */
export const CODEX_STOP_STEP_DEADLINE_MS = 1_000;
