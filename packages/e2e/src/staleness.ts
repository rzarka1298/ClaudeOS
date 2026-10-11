export type Staleness =
  | { readonly current: true }
  | { readonly current: false; readonly reason: string; readonly files: string[] };

export interface StalenessInput {
  /** The HEAD recorded in the report; missing or "unknown" means stale. */
  readonly recordedHead: string | undefined;
  readonly currentHead: string;
  /** Files changed since the recorded HEAD, or null when they could not be listed. */
  readonly changedFiles: readonly string[] | null;
}

export function changedProductFiles(_files: readonly string[]): string[] {
  throw new Error("changedProductFiles is not implemented yet (typed skeleton)");
}

export function isRunCurrent(_input: StalenessInput): Staleness {
  throw new Error("isRunCurrent is not implemented yet (typed skeleton)");
}
