// RED skeleton (plan 04-04 Task 3): the process port, not implemented yet.

export interface CommandRunOptions {
  readonly timeoutMs: number;
  readonly env: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly maxBufferBytes?: number;
}

export interface CommandOutcome {
  readonly exitCode: number | null;
  readonly errno: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
  readonly timedOut: boolean;
}

export interface CommandRunner {
  run(file: string, args: readonly string[], options: CommandRunOptions): Promise<CommandOutcome>;
}

export function createExecFileCommandRunner(): CommandRunner {
  return {
    run: () =>
      Promise.resolve({
        exitCode: null,
        errno: "ENOSYS",
        stdout: "",
        stderr: "",
        truncated: false,
        timedOut: false,
      }),
  };
}
