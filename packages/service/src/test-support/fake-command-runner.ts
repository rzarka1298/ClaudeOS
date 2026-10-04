import type {
  CommandOutcome,
  CommandRunner,
  CommandRunOptions,
} from "../projects/command-runner.js";

/** One recorded `run` call. */
export interface RecordedCommand {
  readonly file: string;
  readonly args: readonly string[];
  readonly options: CommandRunOptions;
}

/** A scripted reply: a matcher over the call, and the outcome to resolve with. */
export interface ScriptedReply {
  readonly match: (file: string, args: readonly string[]) => boolean;
  readonly outcome: Partial<CommandOutcome>;
}

export interface FakeCommandRunner extends CommandRunner {
  readonly calls: RecordedCommand[];
}

const DEFAULT_OUTCOME: CommandOutcome = {
  exitCode: 0,
  errno: null,
  stdout: "",
  stderr: "",
  truncated: false,
  timedOut: false,
};

/**
 * A call-recording command runner. With `inner` it delegates every call (so
 * a test can count what a real runner was asked to do); otherwise it
 * answers from `script` — the first matching reply wins, and an unmatched
 * call resolves as a spawn failure (`ENOENT`), never a silent success.
 */
export function createFakeCommandRunner(
  options: { script?: readonly ScriptedReply[]; inner?: CommandRunner } = {},
): FakeCommandRunner {
  const calls: RecordedCommand[] = [];
  return {
    calls,
    run(file, args, runOptions) {
      calls.push({ file, args: [...args], options: runOptions });
      if (options.inner !== undefined) return options.inner.run(file, args, runOptions);
      const reply = options.script?.find((candidate) => candidate.match(file, args));
      if (reply === undefined) {
        return Promise.resolve({ ...DEFAULT_OUTCOME, exitCode: null, errno: "ENOENT" });
      }
      return Promise.resolve({ ...DEFAULT_OUTCOME, ...reply.outcome });
    },
  };
}
