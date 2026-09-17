import { execa } from "execa";
import type { SecretStore } from "./index.js";

/** The Keychain "service" every account this project stores is filed under. */
export const SERVICE_NAME = "com.claude-command-center";

function isExecaExitCodeError(err: unknown): err is { exitCode: number } {
  return typeof err === "object" && err !== null && "exitCode" in err;
}

/**
 * Thrown when a value that must travel through the `security -i` stdin
 * command line (account, service name, or secret value) does not match
 * the expected shape for that field. Every legitimate value here is
 * machine-generated (hex/base64/base64url from `randomBytes`, or a
 * literal constant), so this is an allowlist, not a denylist: rather
 * than enumerate dangerous characters (a double quote breaks the
 * quoting, a newline starts a second command, a backslash can escape a
 * quote from inside it), it enforces the exact character set the real
 * inputs use and rejects everything else, including control characters
 * a denylist could miss.
 */
export class UnsafeSecretInputError extends Error {
  constructor(field: string) {
    super(
      `${field} does not match the expected character set and cannot be safely written to the ` +
        "security -i stdin command line",
    );
    this.name = "UnsafeSecretInputError";
  }
}

/** account/service: identifier-shaped — letters, digits, dot, underscore, hyphen. */
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9._-]+$/;
/** value: base64 / base64url / hex output — letters, digits, +/=_- only. */
const SAFE_SECRET_VALUE_PATTERN = /^[A-Za-z0-9+/=_-]+$/;

function assertSafeIdentifier(value: string, field: string): void {
  if (!SAFE_IDENTIFIER_PATTERN.test(value)) {
    throw new UnsafeSecretInputError(field);
  }
}

function assertSafeSecretValue(value: string, field: string): void {
  if (!SAFE_SECRET_VALUE_PATTERN.test(value)) {
    throw new UnsafeSecretInputError(field);
  }
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

/**
 * Writes (or updates, via `-U`) `account`'s secret in the macOS Keychain.
 *
 * The secret never appears in argv: `security add-generic-password -w
 * <value>` puts the plaintext value directly in the child process's
 * command line, which is visible for the process's entire lifetime to
 * any same-user process via `ps`/`KERN_PROCARGS2`. Instead this spawns
 * `security -i` (interactive mode, reads commands from stdin) with only
 * `-i` in argv, and writes the full `add-generic-password` command line
 * over stdin. Exit code and stderr are checked exactly as before — `-i`
 * mode still propagates the underlying command's exit code and error
 * output, verified against the real `security` binary. Quoting each
 * value is belt-and-braces on top of the allowlist checks above, not a
 * substitute for them.
 */
export async function setSecret(account: string, value: string): Promise<void> {
  assertSafeIdentifier(account, "account");
  assertSafeIdentifier(SERVICE_NAME, "service name");
  assertSafeSecretValue(value, "value");
  const command = `add-generic-password -a "${account}" -s "${SERVICE_NAME}" -w "${value}" -U\n`;
  await execa("security", ["-i"], { input: command });
}

/** Deletes `account`'s Keychain item. */
export async function deleteSecret(account: string): Promise<void> {
  await execa("security", ["delete-generic-password", "-a", account, "-s", SERVICE_NAME]);
}

/** A {@link SecretStore} backed by this module's three functions. */
export function createSecurityCliSecretStore(): SecretStore {
  return { get: getSecret, set: setSecret, delete: deleteSecret };
}
