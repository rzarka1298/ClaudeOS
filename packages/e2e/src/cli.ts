import type { RunOptions, RunOutcome, RunPorts } from "./run-uat.js";

export interface CliDeps {
  write?: (line: string) => void;
  runUat?: (options: RunOptions, ports: RunPorts) => Promise<RunOutcome>;
  createRunPorts?: () => RunPorts;
}

export type CommandHandler = (argv: readonly string[], deps: CliDeps) => Promise<number>;

export const COMMANDS: Readonly<Record<string, CommandHandler>> = {};

export function createRunPorts(): RunPorts {
  throw new Error("createRunPorts is not implemented yet (typed skeleton)");
}

export async function main(_argv: readonly string[], _deps?: CliDeps): Promise<number> {
  throw new Error("main is not implemented yet (typed skeleton)");
}
