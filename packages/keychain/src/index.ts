// Owned by plan 01-02 of this phase (the /usr/bin/security shell-out
// wrapper, ADR-0009). This package exists now, with only the interface
// shape below, so the import-boundary lint (REPO-03, plan 01-03) has a
// real package to constrain from day one.

export interface SecretStore {
  get(account: string): Promise<string | null>;
  set(account: string, value: string): Promise<void>;
  delete(account: string): Promise<void>;
}
