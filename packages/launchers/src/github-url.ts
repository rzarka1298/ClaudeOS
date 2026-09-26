export type NormalisedRemote =
  | { readonly kind: "github"; readonly owner: string; readonly repo: string }
  | { readonly kind: "other"; readonly host: string; readonly path: string }
  | { readonly kind: "invalid" };

/** RED skeleton (plan 04-02 task 3). */
export function normaliseRemote(_raw: string): NormalisedRemote {
  return { kind: "invalid" };
}

/** RED skeleton. */
export function githubRepoUrl(_owner: string, _repo: string): string {
  return "";
}

/** RED skeleton. */
export function parseGithubOverride(_url: string): { owner: string; repo: string } | null {
  return null;
}

/** RED skeleton. */
export function remoteDisplay(_remote: NormalisedRemote): { host: string; path: string } | null {
  return null;
}
