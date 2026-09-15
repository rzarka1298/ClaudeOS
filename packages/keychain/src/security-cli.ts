import { execa } from "execa";
import type { SecretStore } from "./index.js";

/** The Keychain "service" every account this project stores is filed under. */
export const SERVICE_NAME = "com.claude-command-center";

function isExecaExitCodeError(err: unknown): err is { exitCode: number } {
  return typeof err === "object" && err !== null && "exitCode" in err;
}

/**
 * Reads `account`'s secret from the macOS Keychain via
 * `/usr/bin/security find-generic-password`. Exit code 44 means the item
 * does not exist — not a failure — so it maps to `null` rather than
 * throwing; any other non-zero exit rethrows. Always an argument array,
 * never an interpolated shell string (research Pitfall 7): no element
 * below is ever built by concatenating a caller-supplied name into a
 * larger token.
 */
export async function getSecret(account: string): Promise<string | null> {
  try {
    const { stdout } = await execa("security", [
      "find-generic-password",
      "-a",
      account,
      "-s",
      SERVICE_NAME,
      "-w",
    ]);
    return stdout.trim();
  } catch (err: unknown) {
    if (isExecaExitCodeError(err) && err.exitCode === 44) return null;
    throw err;
  }
}

/** Writes (or updates, via `-U`) `account`'s secret in the macOS Keychain. */
export async function setSecret(account: string, value: string): Promise<void> {
  await execa("security", [
    "add-generic-password",
    "-a",
    account,
    "-s",
    SERVICE_NAME,
    "-w",
    value,
    "-U",
  ]);
}

/** Deletes `account`'s Keychain item. */
export async function deleteSecret(account: string): Promise<void> {
  await execa("security", ["delete-generic-password", "-a", account, "-s", SERVICE_NAME]);
}

/** A {@link SecretStore} backed by this module's three functions. */
export function createSecurityCliSecretStore(): SecretStore {
  return { get: getSecret, set: setSecret, delete: deleteSecret };
}
