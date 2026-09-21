/**
 * RED-phase compile surface for deterministic per-folder index generation
 * (VAULT-03). The body throws so the determinism suite LOADS and RUNS and
 * fails on the behavior under test — in this project-references monorepo a
 * test importing a symbol that does not exist at all fails at `tsc -b`
 * build time, never executes, and is classified `fixture_or_load_failure`
 * (INVALID_RED) rather than authorizing GREEN.
 */

/**
 * The workspace-root identity keys an index preserves across regeneration.
 * They are the ONLY thing an index ever reads back from its own previous
 * output — the listing itself is always rebuilt from a fresh frontmatter
 * scan, never patched.
 */
export interface IndexIdentity {
  readonly workspaceId: string;
  readonly displayName: string;
}

/** Everything {@link regenerateIndex} needs beyond the folder itself. */
export interface RegenerateIndexOptions {
  /** The managed vault's root; the index's `folder` key is relative to it. */
  readonly vaultRoot: string;
  /** Supply at workspace-root creation; omitted, identity is preserved. */
  readonly identity?: IndexIdentity;
}

/** What one regeneration produced, so callers never re-read the file. */
export interface RegeneratedIndex {
  /** Absolute path of the `index.md` that was written. */
  readonly path: string;
  /** The exact bytes written, as a string. */
  readonly content: string;
  /** How many direct-child notes were listed. */
  readonly noteCount: number;
  /** Filenames of children whose frontmatter failed validation. */
  readonly unreadable: readonly string[];
}

export function regenerateIndex(
  _folderPath: string,
  _options: RegenerateIndexOptions,
): RegeneratedIndex {
  throw new Error(
    "regenerateIndex is not implemented yet (packages/vault-repo/src/index-generation.ts)",
  );
}
