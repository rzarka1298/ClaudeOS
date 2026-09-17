// The `/usr/bin/security` shell-out wrapper (ADR-0009, ADR-0017) — the
// import-boundary lint (REPO-03, plan 01-03) constrains this as the one
// package permitted to talk to the macOS Keychain.

export interface SecretStore {
  get(account: string): Promise<string | null>;
  set(account: string, value: string): Promise<void>;
  delete(account: string): Promise<void>;
}

export {
  createSecurityCliSecretStore,
  deleteSecret,
  getSecret,
  SERVICE_NAME,
  setSecret,
} from "./security-cli.js";
