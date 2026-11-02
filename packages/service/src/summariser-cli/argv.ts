// RED stub (10-02 task 1): the real builders land in the GREEN commit.
import type { SummariserModel } from "@ccc/domain";

export const CLAUDE_AUTH_STATUS_ARGV: readonly string[] = [];
export const CLAUDE_CHILD_ENV_KEYS: readonly string[] = [];

export function buildClaudeArgv(_input: {
  readonly model: SummariserModel;
  readonly instructions: string;
}): readonly string[] {
  return [];
}

export function buildClaudeChildEnv(
  _parent: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> | null {
  return {};
}
