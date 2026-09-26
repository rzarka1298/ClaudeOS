/** What a launch script runs: a working directory, an argv, and an optional exported env. */
export interface LaunchScriptInput {
  readonly cwd: string;
  readonly argv: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

export const CD_FAILED_MESSAGE =
  "Claude command center could not open the project folder. It may have moved, or macOS may be blocking access.";

/** RED skeleton (plan 04-02 task 1): renders nothing yet. */
export function renderLaunchScript(_input: LaunchScriptInput): string {
  return "";
}
