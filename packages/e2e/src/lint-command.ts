export interface LintCommandInput {
  scriptPath: string;
  specsDir: string;
  readFile: (path: string) => string | null;
  /** The file names directly inside a folder; empty when it does not exist. */
  listFiles: (dir: string) => string[];
  /** The spec files the standard profile runs; defaults to the table's standard list. */
  standardSpecs?: readonly string[];
}

export interface LintCommandResult {
  exitCode: 0 | 1;
  lines: string[];
}

export function lintTagsCommand(_input: LintCommandInput): LintCommandResult {
  throw new Error("lintTagsCommand is not implemented yet (typed skeleton)");
}
