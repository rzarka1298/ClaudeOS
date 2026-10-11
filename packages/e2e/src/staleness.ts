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

/**
 * Paths whose change can alter what a live run proved (D-10, T-05.2-20). Every pattern is
 * anchored at the repository root. Planning documents, docs, the e2e package itself and
 * markdown outside packages are deliberately absent, so they leave a run current.
 */
export const PRODUCT_PATH_PATTERNS: readonly RegExp[] = [
  /^packages\/(?!e2e\/)[^/]+\//,
  /^scripts\//,
  /^package\.json$/,
  /^pnpm-lock\.yaml$/,
  /^pnpm-workspace\.yaml$/,
  /^eslint\.config\.[cm]?[jt]s$/,
  /^\.eslintrc[^/]*$/,
  /^tsconfig[^/]*\.json$/,
  /^turbo\.json$/,
  /^biome\.json$/,
  /^vitest\.config\.[cm]?[jt]s$/,
  /^\.(npmrc|nvmrc|node-version)$/,
];

const NAME_CAP = 10;

function normalise(file: string): string {
  return file.startsWith("./") ? file.slice(2) : file;
}

export function changedProductFiles(files: readonly string[]): string[] {
  return files
    .map(normalise)
    .filter((file) => PRODUCT_PATH_PATTERNS.some((pattern) => pattern.test(file)));
}

function known(head: string | undefined): head is string {
  return head !== undefined && head !== "" && head !== "unknown";
}

/** A run is current only if no product-code file changed since the HEAD it recorded. */
export function isRunCurrent(input: StalenessInput): Staleness {
  if (!known(input.recordedHead) || !known(input.currentHead)) {
    return { current: false, reason: "unknown HEAD", files: [] };
  }
  if (input.recordedHead === input.currentHead) return { current: true };
  if (input.changedFiles === null) return { current: false, reason: "changes unknown", files: [] };
  const product = changedProductFiles(input.changedFiles);
  if (product.length === 0) return { current: true };
  return {
    current: false,
    reason: "product code changed since the run",
    files: product.slice(0, NAME_CAP),
  };
}
