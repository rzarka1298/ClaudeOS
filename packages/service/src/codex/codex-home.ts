// RED stub (plan 05.1-14, task 1): signatures only, neutral behaviour.
// The real implementation lands in the GREEN commit.

export type CodexHomeAccessCode =
  | "name-not-allowed"
  | "path-not-allowed"
  | "archived"
  | "bad-rollout-name"
  | "escape"
  | "unreadable"
  | "bad-argument";

export class CodexHomeAccessError extends Error {
  readonly code: CodexHomeAccessCode;

  constructor(code: CodexHomeAccessCode) {
    super(`codex home access refused: ${code}`);
    this.name = "CodexHomeAccessError";
    this.code = code;
  }
}

export interface CodexFileStat {
  readonly isFile: boolean;
  readonly size: number;
  readonly mtimeMs: number;
}

export interface CodexDirEntry {
  readonly name: string;
  readonly isFile: boolean;
}

export interface CodexFs {
  realpath(path: string): string;
  stat(path: string): CodexFileStat;
  readDir(path: string): readonly CodexDirEntry[];
  readBytes(path: string, offset: number, length: number): Buffer;
}

export const defaultCodexFs: CodexFs = {
  realpath: () => "",
  stat: () => ({ isFile: false, size: 0, mtimeMs: 0 }),
  readDir: () => [],
  readBytes: () => Buffer.alloc(0),
};

export const CODEX_HOME_READABLE_NAMES = [
  "session_index.jsonl",
  "version.json",
  "hooks.json",
] as const;
export type CodexHomeReadableName = (typeof CODEX_HOME_READABLE_NAMES)[number];

export const CODEX_STATE_DB_NAME = "state_5.sqlite";
export const MAX_NAMED_READ_BYTES = 4 * 1024 * 1024;
export const MAX_ROLLOUT_READ_BYTES = 1024 * 1024;
export const MAX_ROLLOUT_LIST = 5000;

export interface RolloutRef {
  readonly path: string;
}

export interface BoundedRead {
  readonly bytes: Buffer;
  readonly size: number;
}

export interface CodexHomePort {
  stateDbPath(): string | null;
  readNamed(name: string, maxBytes: number): BoundedRead | null;
  listRolloutFiles(range: { readonly from: number; readonly to: number }): readonly RolloutRef[];
  statRollout(ref: RolloutRef): { readonly size: number; readonly mtimeMs: number } | null;
  readRolloutRange(ref: RolloutRef, offset: number, maxBytes: number): BoundedRead;
  resolveSessionsFile(path: string): string | null;
}

export function resolveCodexHome(
  _env: Readonly<Record<string, string | undefined>>,
  _home: string,
): string {
  return "";
}

export function createCodexHomePort(_options: {
  readonly root: string;
  readonly fs?: CodexFs;
}): CodexHomePort {
  return {
    stateDbPath: () => null,
    readNamed: () => null,
    listRolloutFiles: () => [],
    statRollout: () => null,
    readRolloutRange: () => ({ bytes: Buffer.alloc(0), size: 0 }),
    resolveSessionsFile: () => null,
  };
}
