/**
 * One serialization chain per working tree, shared by every launch path
 * (Codex review findings 1 and 2). "Guard, then pre-register the Run" must be
 * atomic per tree: two launches into one tree may not both pass the guard
 * before either Run exists. Resume, branch and a fresh Start Claude Code all
 * take the same chain, so they exclude each other.
 *
 * The chain is keyed by the resolved git worktree root (the caller falls
 * back to the launch directory outside git), never by the directory the
 * launch happens to name: two subdirectories of one repository are one tree.
 *
 * `owner` scopes the chains to one composition (the guard object both the
 * session actions and the launch bridge are built over), so separate
 * compositions, such as parallel tests, never share state.
 */
const CHAINS = new WeakMap<object, Map<string, Promise<unknown>>>();

function chainsOf(owner: object): Map<string, Promise<unknown>> {
  let chains = CHAINS.get(owner);
  if (chains === undefined) {
    chains = new Map();
    CHAINS.set(owner, chains);
  }
  return chains;
}

/** Runs `work` after every earlier holder of `tree` has finished. */
export function serializedOnTree<T>(
  owner: object,
  tree: string,
  work: () => Promise<T>,
): Promise<T> {
  const chains = chainsOf(owner);
  const previous = chains.get(tree) ?? Promise.resolve();
  const current = previous.then(work, work);
  const settled = current.then(
    () => undefined,
    () => undefined,
  );
  chains.set(tree, settled);
  void settled.then(() => {
    if (chains.get(tree) === settled) chains.delete(tree);
  });
  return current;
}
