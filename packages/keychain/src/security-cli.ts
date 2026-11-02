import { userInfo } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import type { SecretStore } from "./index.js";

/** The one binary this package spawns; absolute so a hijacked PATH cannot substitute it. */
const SECURITY_BINARY = "/usr/bin/security";

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

/**
 * account/service: identifier-shaped — letters, digits, dot, underscore, hyphen, and never a leading hyphen
 * (`security` would read it as an option).
 */
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9._][A-Za-z0-9._-]*$/;
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
  assertSafeIdentifier(account, "account");
  try {
    const { stdout } = await execa(SECURITY_BINARY, [
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
  await execa(SECURITY_BINARY, ["-i"], { input: command });
}

/** Deletes `account`'s Keychain item. */
export async function deleteSecret(account: string): Promise<void> {
  assertSafeIdentifier(account, "account");
  await execa(SECURITY_BINARY, ["delete-generic-password", "-a", account, "-s", SERVICE_NAME]);
}

/** How long a presence lookup may run before it is killed (T-08-08). */
export const HAS_SECRET_TIMEOUT_MS = 1500;
/** `security` exits with 44 when the item is not in the keychain (`errSecItemNotFound`). */
const EXIT_ITEM_NOT_FOUND = 44;

/**
 * The spawn options of the presence lookup, in ONE place so a test can run the very same options
 * against a harmless real child (`/bin/sleep`) and prove an abort kills it (FIX3A). The cap and the
 * SIGKILL bound the child; stdio is ignored so nothing it prints is captured; the caller's signal,
 * when there is one, kills the child instead of leaving it to run out its own cap.
 */
export function presenceSpawnOptions(signal: AbortSignal | undefined) {
  return {
    reject: false,
    timeout: HAS_SECRET_TIMEOUT_MS,
    killSignal: "SIGKILL",
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    ...(signal === undefined ? {} : { cancelSignal: signal }),
  } as const;
}

/** The fields of an execa result the presence answer is read from. */
export interface PresenceResultFacts {
  readonly exitCode?: number | undefined;
  readonly failed?: boolean | undefined;
  readonly timedOut?: boolean | undefined;
  readonly isTerminated?: boolean | undefined;
  readonly isCanceled?: boolean | undefined;
}

/** Exit 0 is present, exit 44 is absent; a killed, canceled or timed-out child, or any other exit, is error. */
export function classifyPresenceResult(
  result: PresenceResultFacts,
): "present" | "absent" | "error" {
  // A child that was killed, canceled or timed out has no answer, whatever exit code it was reporting.
  if (result.timedOut === true || result.isTerminated === true || result.isCanceled === true) {
    return "error";
  }
  if (result.exitCode === 0 && result.failed !== true) return "present";
  if (result.exitCode === EXIT_ITEM_NOT_FOUND) return "absent";
  return "error";
}

/**
 * Whether `account`'s item exists in the macOS Keychain, **without ever
 * reading its value** (plan 08-04; D-38, research A 1.5; threat T-08-06).
 *
 * The argv is attribute-only: `find-generic-password -a <account> -s
 * <service>` with no `-w` (print the password) and no `-g` (print the
 * password to stderr), so the secret is never read into this process and
 * nothing the child prints is ever captured: stdin, stdout and stderr are all
 * ignored. Exit 0 is `present`, exit 44 is `absent`, and everything else (any
 * other exit, a timeout, a kill, a spawn failure) is `error`, never a guess.
 * It never throws for an absent item or a failed lookup; only an unsafe
 * `account` throws, before any process is spawned.
 *
 * Bounded by {@link HAS_SECRET_TIMEOUT_MS} with SIGKILL, spawned directly (no
 * shell), by absolute path. An optional `signal` (the health probe's own) kills
 * the child when it fires; a signal that has already fired spawns nothing and
 * answers `error`. It runs only on an owner gesture (opening or
 * re-checking Diagnostics), never on a timer, so any one-time Keychain access
 * dialog appears only when the owner is looking at the screen; the first
 * real-keychain run is confirmed prompt-free by an owner UAT item (ADR-0017).
 */
export async function hasSecret(
  account: string,
  options: { readonly signal?: AbortSignal } = {},
): Promise<"present" | "absent" | "error"> {
  assertSafeIdentifier(account, "account");
  // A leading dash would read as a `security` option, not an account; no real account starts with one.
  if (account.startsWith("-")) throw new UnsafeSecretInputError("account");
  const { signal } = options;
  // A caller that has already given up gets no process at all.
  if (signal?.aborted === true) return "error";
  try {
    const result = await execa(
      SECURITY_BINARY,
      ["find-generic-password", "-a", account, "-s", SERVICE_NAME],
      presenceSpawnOptions(signal),
    );
    return classifyPresenceResult(result);
  } catch {
    return "error";
  }
}

/** `security` prints a handful of short attribute lines; this is far more than any real output. */
const READ_COMMENT_MAX_BYTES = 4096;
/** A P-256 SubjectPublicKeyInfo: 26 header bytes and the 65-byte uncompressed point. */
const SPKI_P256_BYTES = 91;
/** The `"icmt"<blob>="..."` line of a `find-generic-password` attribute listing. */
const COMMENT_LINE_PATTERN = /^\s*"icmt"<blob>="([^"\n]*)"\s*$/m;

/** The fixed 26-byte DER prefix of a P-256 SubjectPublicKeyInfo (id-ecPublicKey, prime256v1, bit string). */
const SPKI_P256_HEADER = Buffer.from("3059301306072a8648ce3d020106082a8648ce3d030107034200", "hex");
/** The login keychain, relative to the account's home directory. */
const LOGIN_KEYCHAIN_RELATIVE = "Library/Keychains/login.keychain-db";
/** The `keychain: "<path>"` line `security` prints before an item's attributes. */
const KEYCHAIN_LINE_PATTERN = /^keychain: "([^"\n]*)"\s*$/m;
const ACCT_LINE_PATTERN = /^\s*"acct"<blob>="([^"\n]*)"\s*$/m;
const SVCE_LINE_PATTERN = /^\s*"svce"<blob>="([^"\n]*)"\s*$/m;

/**
 * Canonical (padded, standard-alphabet) base64 of exactly a P-256 SPKI: 91 bytes that start with the fixed
 * 26-byte header and carry an uncompressed (0x04) point. Any other 91 bytes are not a pin (FIX6B m4).
 */
function isPinnedPublicKey(value: string): boolean {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  const bytes = Buffer.from(value, "base64");
  return (
    bytes.length === SPKI_P256_BYTES &&
    bytes.toString("base64") === value &&
    bytes.subarray(0, SPKI_P256_HEADER.length).equals(SPKI_P256_HEADER) &&
    bytes[SPKI_P256_HEADER.length] === 0x04
  );
}

/**
 * The login keychain of the account running this process, named by the passwd database. Never `HOME` (and so
 * never `os.homedir()`, which reads it): a same-user process controls its own environment but not the passwd entry.
 */
function loginKeychainPath(): string | null {
  try {
    const home = userInfo().homedir;
    return home.startsWith("/") ? join(home, LOGIN_KEYCHAIN_RELATIVE) : null;
  } catch {
    return null;
  }
}

/**
 * The comment attribute of `account`'s Keychain item, **without ever reading its secret** (plan 09-15,
 * R-02; the ADR 0017 attribute-read pattern). The presence helper stores the base64 public key of its
 * signing key there; the service reads it as the pin a presence signature is verified against.
 *
 * The argv is the attribute-only lookup of {@link hasSecret}: `find-generic-password -a <account> -s
 * <service> <login keychain>`, no `-w` and no `-g`, so the secret is never read into this process and the
 * helper-only item raises no prompt (spike: attr_read_silent). The login keychain is named explicitly
 * (FIX6B B2): without it `security` walks the user's search list, which a same-user process can reorder to put
 * a keychain holding a decoy item first. The output must also say the item came from exactly that keychain
 * and carry exactly this account and service, so a decoy that survives any other way is still `null`. Only
 * stdout is captured (capped at {@link READ_COMMENT_MAX_BYTES}); the value is returned only when it is
 * canonical base64 of exactly a 91-byte P-256 SPKI (header and point format checked). A missing item (exit 44), a timeout, a kill, a cancel, any other failure, a missing
 * comment and any other value are all `null`, never a guess. Only an unsafe `account` throws, before any
 * process is spawned. Spawned directly (no shell) by absolute path and bounded by
 * {@link HAS_SECRET_TIMEOUT_MS} with SIGKILL.
 */
export async function readItemComment(
  account: string,
  signal?: AbortSignal,
): Promise<string | null> {
  assertSafeIdentifier(account, "account");
  // A leading dash would read as a `security` option, not an account; no real account starts with one.
  if (account.startsWith("-")) throw new UnsafeSecretInputError("account");
  // A caller that has already given up gets no process at all.
  if (signal?.aborted === true) return null;
  const keychain = loginKeychainPath();
  if (keychain === null) return null;
  try {
    const result = await execa(
      SECURITY_BINARY,
      ["find-generic-password", "-a", account, "-s", SERVICE_NAME, keychain],
      {
        reject: false,
        timeout: HAS_SECRET_TIMEOUT_MS,
        killSignal: "SIGKILL",
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
        maxBuffer: READ_COMMENT_MAX_BYTES,
        ...(signal === undefined ? {} : { cancelSignal: signal }),
      },
    );
    if (classifyPresenceResult(result) !== "present") return null;
    const stdout: unknown = result.stdout;
    if (typeof stdout !== "string") return null;
    // The item must be the login keychain's, for exactly this account and service (FIX6B B2).
    if (KEYCHAIN_LINE_PATTERN.exec(stdout)?.[1] !== keychain) return null;
    if (ACCT_LINE_PATTERN.exec(stdout)?.[1] !== account) return null;
    if (SVCE_LINE_PATTERN.exec(stdout)?.[1] !== SERVICE_NAME) return null;
    const comment = COMMENT_LINE_PATTERN.exec(stdout)?.[1];
    return comment !== undefined && isPinnedPublicKey(comment) ? comment : null;
  } catch {
    return null;
  }
}

/** A {@link SecretStore} backed by this module's three functions. */
export function createSecurityCliSecretStore(): SecretStore {
  return { get: getSecret, set: setSecret, delete: deleteSecret };
}
