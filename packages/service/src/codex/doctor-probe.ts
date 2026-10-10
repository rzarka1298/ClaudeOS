import { type ChildProcess, spawn } from "node:child_process";
import { homedir } from "node:os";
import { parseDoctorJson } from "@ccc/collectors";
import { CODEX_DOCTOR_CAP_MS, type CodexDoctorSummary } from "@ccc/domain";
import type { SpawnFn, SpawnOptionsLite } from "./rate-limits-client.js";

/**
 * The owner-triggered `codex doctor --json` run (plan 05.1-21, CODEX-03,
 * RESEARCH R4 and Pitfall 11, D-17).
 *
 * `run()` is called only by the doctor route, once per owner request. Nothing
 * in the service calls it on a timer, at start, during detection or on a poll:
 * a doctor run costs a few seconds of Codex's time and the report is the
 * owner's to ask for.
 *
 * The child is the user's own Codex binary started with the argument array
 * `[doctor, --json]`, `shell: false`, stdin a pipe that is closed at once,
 * stdout a pipe, stderr ignored, and a MINIMAL environment (HOME, a fixed
 * PATH, the C locale, and CODEX_HOME only when the owner configured one),
 * never the service's own. Stdout is read to a byte cap; a report past it, or
 * a run past the time cap, ends the child with the default termination signal
 * and waits for its exit, forcing it only if it ignores that signal. The
 * report is parsed through the allowlist (`parseDoctorJson`) before anything
 * leaves this function: schema version, overall status, a dotted version and
 * per check an id, category and status. Detail, summary, remediation and notes
 * text, which can carry local paths and account facts, is never retained.
 *
 * This module reads no file: Codex inspects its own credentials inside its
 * own process, and only its stdout comes back (CODEX-09). A failure is logged
 * as a reason code and nothing else; `run()` never throws.
 */

/** The result of one owner-triggered run. */
export type DoctorRunResult =
  | { readonly kind: "ok"; readonly summary: CodexDoctorSummary; readonly checkedAt: string }
  /** No Codex executable is configured; nothing was started. */
  | { readonly kind: "unavailable" }
  /** The run could not start, hit a cap, crashed or printed something that is not a report. */
  | { readonly kind: "failed" };

export interface DoctorProbeLogger {
  /** Reason codes only. Nothing from the report is ever passed. */
  warn(fields: { readonly reason: string }, message: string): void;
}

export interface DoctorProbeDeps {
  /** The saved Codex executable path, or null when none is configured. */
  readonly executablePath: () => string | null;
  /** CODEX_HOME for the child, only when the owner configured one. */
  readonly codexHome?: () => string | null;
  /** The home directory the child sees. Defaults to the service user's. */
  readonly homeDir?: () => string;
  readonly spawn?: SpawnFn;
  /** The clock for `checkedAt` (epoch milliseconds). */
  readonly now?: () => number;
  /** The run cap; defaults to the domain's 60 second constant. */
  readonly capMs?: number;
  /** How long the child gets to exit after the default termination signal before it is forced. */
  readonly killWaitMs?: number;
  /** The most stdout read before the run is judged hostile. */
  readonly maxOutputBytes?: number;
  readonly logger?: DoctorProbeLogger;
}

export interface DoctorProbe {
  /** Never rejects. Overlapping calls share one child. */
  run(): Promise<DoctorRunResult>;
}

/** How long the child gets to exit after the default termination signal before it is forced. */
export const DOCTOR_KILL_WAIT_MS = 2_000;

/** A real report is a few kilobytes; this is generous and still bounded. */
export const DOCTOR_MAX_OUTPUT_BYTES = 1024 * 1024;

/** Fixed child PATH; it holds no Node, so tests use an absolute interpreter. */
const CHILD_PATH = "/usr/bin:/bin";

function defaultSpawn(
  file: string,
  args: readonly string[],
  options: SpawnOptionsLite,
): ChildProcess {
  return spawn(file, [...args], { ...options, env: { ...options.env } });
}

export function createDoctorProbe(deps: DoctorProbeDeps): DoctorProbe {
  const now = deps.now ?? Date.now;
  const spawnChild = deps.spawn ?? defaultSpawn;
  const capMs = deps.capMs ?? CODEX_DOCTOR_CAP_MS;
  const killWaitMs = deps.killWaitMs ?? DOCTOR_KILL_WAIT_MS;
  const maxOutputBytes = deps.maxOutputBytes ?? DOCTOR_MAX_OUTPUT_BYTES;

  let inFlight: Promise<DoctorRunResult> | null = null;

  function childEnv(): Record<string, string> {
    const env: Record<string, string> = {
      HOME: (deps.homeDir ?? homedir)(),
      PATH: CHILD_PATH,
      LC_ALL: "C",
    };
    const codexHome = deps.codexHome?.() ?? null;
    if (codexHome !== null && codexHome.length > 0) env.CODEX_HOME = codexHome;
    return env;
  }

  function failed(code: string): DoctorRunResult {
    deps.logger?.warn({ reason: code }, "codex doctor run failed");
    return { kind: "failed" };
  }

  function runOnce(): Promise<DoctorRunResult> {
    const path = deps.executablePath();
    if (path === null) return Promise.resolve({ kind: "unavailable" });
    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = spawnChild(path, ["doctor", "--json"], {
          shell: false,
          stdio: ["pipe", "pipe", "ignore"],
          env: childEnv(),
          windowsHide: true,
        });
      } catch {
        resolve(failed("spawn-failed"));
        return;
      }
      let result: DoctorRunResult | null = null;
      let exited = false;
      let total = 0;
      const chunks: Buffer[] = [];
      let escalateTimer: ReturnType<typeof setTimeout> | undefined;
      let backstopTimer: ReturnType<typeof setTimeout> | undefined;

      const done = (): void => {
        clearTimeout(capTimer);
        clearTimeout(escalateTimer);
        clearTimeout(backstopTimer);
        if (result !== null) resolve(result);
      };
      /** Records the outcome, then ends the child: default signal, wait, escalate. */
      const settle = (outcome: DoctorRunResult): void => {
        if (result !== null) return;
        result = outcome;
        clearTimeout(capTimer);
        if (exited) {
          done();
          return;
        }
        try {
          child.kill();
        } catch {
          // Already gone; the exit event follows.
        }
        escalateTimer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // Already gone.
          }
          backstopTimer = setTimeout(done, killWaitMs);
        }, killWaitMs);
      };
      const fail = (code: string): void => {
        if (result === null) settle(failed(code));
      };

      const capTimer = setTimeout(() => fail("timeout"), capMs);

      child.on("error", () => {
        if (child.pid === undefined) {
          exited = true;
          fail("spawn-error");
          done();
        } else {
          fail("child-error");
        }
      });
      child.on("exit", () => {
        exited = true;
        // A run already decided (a cap, a hostile stream) is complete once the child is gone.
        if (result !== null) done();
      });
      // All stdio is closed: the whole report has been read, whatever the exit status.
      child.on("close", () => {
        exited = true;
        if (result === null) {
          const summary = parseDoctorJson(Buffer.concat(chunks).toString("utf8"));
          settle(
            summary === null
              ? failed("unparseable-output")
              : { kind: "ok", summary, checkedAt: new Date(now()).toISOString() },
          );
        }
        done();
      });
      child.stdin?.on("error", () => undefined);
      try {
        child.stdin?.end();
      } catch {
        // The child may already be gone.
      }
      child.stdout?.on("data", (chunk: Buffer) => {
        if (result !== null) return;
        total += chunk.length;
        if (total > maxOutputBytes) {
          fail("output-cap");
          return;
        }
        chunks.push(chunk);
      });
    });
  }

  return {
    run() {
      if (inFlight !== null) return inFlight;
      let started: Promise<DoctorRunResult>;
      try {
        started = runOnce();
      } catch {
        // A throwing dependency (the executable lookup) is a failed run, never a rejection.
        return Promise.resolve(failed("run-threw"));
      }
      const attempt = started.finally(() => {
        if (inFlight === attempt) inFlight = null;
      });
      inFlight = attempt;
      return attempt;
    },
  };
}
