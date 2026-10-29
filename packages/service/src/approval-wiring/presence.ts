import { isAbsolute, join } from "node:path";
import {
  canonicalJson,
  PAYLOAD_HASH_PATTERN,
  PRESENCE_PROMPT_TIMEOUT_MS,
  PROPOSAL_ID_PATTERN,
  type PresenceAvailability,
  type PresencePort,
  type PresenceRequest,
  type PresenceResult,
} from "@ccc/domain";
import { z } from "zod";
import type { CommandOutcome, CommandRunner } from "../projects/command-runner.js";

/**
 * The service's side of the owner-presence check (plan 09-15, D-01, D-04, R-02).
 *
 * The helper is the Objective-C program `scripts/presence/ccc-presence.m`, built locally into
 * `<runtime dir>/bin/ccc-presence`. This adapter is the only code that starts it, and it starts it the
 * one safe way (research "spawn discipline"):
 *
 * - by ABSOLUTE path, never a PATH lookup, through the existing fixed-argv, no-shell
 *   {@link CommandRunner} (backstop rule 8: nothing in this package spawns a shell);
 * - with an environment built from scratch (`HOME` and nothing else), an output cap of
 *   {@link PRESENCE_HELPER_MAX_OUTPUT_BYTES} and a SIGKILL deadline of
 *   {@link PRESENCE_HELPER_KILL_MS};
 * - with the message built HERE as canonical JSON from fields validated against the domain patterns
 *   and passed base64-encoded as the only argument after `prove --message`. The adapter never passes
 *   caller text for the prompt: the helper rebuilds the prompt from the parsed fields (T-09-30,
 *   T-09-31).
 *
 * Every helper outcome maps to a closed {@link PresenceResult}: exit 0 with exactly one strict JSON
 * line is `proved`; exit 4 with its strict denied line is `denied`; every other exit, a timeout, a
 * kill, truncated or unparseable output, a field outside the contract and a missing binary are
 * `unavailable`. Nothing here ever guesses a proof.
 */

/** The SIGKILL deadline of one `prove`: the helper's own 60 s ceiling plus a grace for its exit. */
export const PRESENCE_HELPER_KILL_MS = PRESENCE_PROMPT_TIMEOUT_MS + 2000;
/** The non-prompting `check` answers at once; five seconds is generous. */
export const PRESENCE_CHECK_TIMEOUT_MS = 5000;
/** One short JSON line is all a helper run may print; more than this is a misbehaving helper. */
export const PRESENCE_HELPER_MAX_OUTPUT_BYTES = 4096;

/**
 * The key custody the helper implements, as decided by the Wave 0 spike (09-PRESENCE-SPIKE.md):
 * `K-SE` a persistent Secure Enclave key, `K-ATTR` a software P-256 key in a helper-only Keychain
 * item, `K-SVC` no key (the check alone). The spike recorded K-ATTR for this machine.
 */
export type PresenceCustody = "K-SE" | "K-ATTR" | "K-SVC";

/** The custody this build of the helper implements (09-PRESENCE-SPIKE.md: custody K-ATTR). */
export const RECORDED_PRESENCE_CUSTODY: PresenceCustody = "K-ATTR";

function schemeOf(custody: PresenceCustody): "p256" | "none" {
  return custody === "K-SVC" ? "none" : "p256";
}

export interface HelperPresencePortOptions {
  /** Absolute path of the built helper, `<runtime dir>/bin/ccc-presence`. */
  readonly helperPath: string;
  readonly runner: CommandRunner;
  /** Whether a file exists; injected so a test never depends on the real disk. */
  readonly exists: (path: string) => boolean;
  /** The home directory the helper runs with (the Keychain search list is found through it). */
  readonly homeDir: string;
  readonly custody: PresenceCustody;
  /** Test seam: the `prove` deadline. Production keeps {@link PRESENCE_HELPER_KILL_MS}. */
  readonly killMs?: number;
}

// The patterns below mirror the helper's own (scripts/presence/ccc-presence.m): a request the helper
// would refuse as a usage error is refused here first, before any process starts.
const OPERATION_PATTERN = /^[a-z][a-z0-9.-]{0,63}$/;
const INSTANT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

function isValidInstant(value: string): boolean {
  const m = INSTANT_PATTERN.exec(value);
  if (m === null) return false;
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (year < 1970 || month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const maxDay = (DAYS_IN_MONTH[month - 1] ?? 0) + (month === 2 && leap ? 1 : 0);
  return day <= maxDay && hour <= 23 && minute <= 59 && second <= 59;
}

function isValidRequest(request: PresenceRequest): boolean {
  return (
    typeof request.proposalId === "string" &&
    PROPOSAL_ID_PATTERN.test(request.proposalId) &&
    typeof request.operation === "string" &&
    OPERATION_PATTERN.test(request.operation) &&
    typeof request.payloadHash === "string" &&
    PAYLOAD_HASH_PATTERN.test(request.payloadHash) &&
    typeof request.approvedAt === "string" &&
    isValidInstant(request.approvedAt)
  );
}

/** A DER ECDSA P-256 signature is 70 to 72 bytes; this accepts a little either side, nothing wild. */
const MIN_SIGNATURE_BYTES = 8;
const MAX_SIGNATURE_BYTES = 80;

function isCanonicalBase64(value: string): boolean {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  const bytes = Buffer.from(value, "base64");
  return (
    bytes.toString("base64") === value &&
    bytes.length >= MIN_SIGNATURE_BYTES &&
    bytes.length <= MAX_SIGNATURE_BYTES
  );
}

const provedLine = z.strictObject({
  v: z.literal(1),
  result: z.literal("proved"),
  scheme: z.enum(["p256", "none"]),
  signature: z.string().refine(isCanonicalBase64).nullable(),
});

const deniedLine = z.strictObject({
  v: z.literal(1),
  result: z.literal("denied"),
  error: z.number().int(),
  cause: z.literal("timeout").optional(),
});

const checkLine = z.strictObject({
  v: z.literal(1),
  canEvaluate: z.boolean(),
  biometry: z.enum(["touch-id", "none"]).optional(),
  enrolled: z.boolean().optional(),
  // FIX6B M1: present (true) only when a pin exists that a different binary enrolled (the helper was rebuilt
  // without a re-enrol). A stale pin is never `available`, whatever else the line says.
  stale: z.boolean().optional(),
});

/** The one JSON line a helper run printed, or null when there is not exactly one parseable line. */
function singleJsonLine(stdout: string): unknown {
  const body = stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
  // Exactly one object, with no padding: a line that is not `{...}` from its first byte to its last is refused.
  if (!body.startsWith("{") || !body.endsWith("}") || body.includes("\n") || body.includes("\r")) {
    return null;
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
}

/** True when the run produced a complete, trustworthy output stream (it exited on its own, untruncated). */
function ranToCompletion(outcome: CommandOutcome): boolean {
  return (
    outcome.errno === null && !outcome.timedOut && !outcome.truncated && outcome.exitCode !== null
  );
}

const UNAVAILABLE: PresenceResult = { kind: "unavailable" };

export function createHelperPresencePort(options: HelperPresencePortOptions): PresencePort {
  const { helperPath, runner, exists, homeDir, custody } = options;
  if (!isAbsolute(helperPath)) {
    throw new TypeError("the presence helper path must be absolute (no PATH lookup)");
  }
  const killMs = options.killMs ?? PRESENCE_HELPER_KILL_MS;
  const env = { HOME: homeDir } as const;

  const run = (args: readonly string[], timeoutMs: number): Promise<CommandOutcome> =>
    runner.run(helperPath, args, {
      timeoutMs,
      env,
      maxBufferBytes: PRESENCE_HELPER_MAX_OUTPUT_BYTES,
    });

  return {
    async prove(request: PresenceRequest): Promise<PresenceResult> {
      if (!isValidRequest(request)) return UNAVAILABLE;
      if (!exists(helperPath)) return UNAVAILABLE;
      let message: string;
      try {
        message = canonicalJson({
          v: 1,
          proposalId: request.proposalId,
          operation: request.operation,
          payloadHash: request.payloadHash,
          decision: "approve",
          approvedAt: request.approvedAt,
        });
      } catch {
        return UNAVAILABLE;
      }
      const outcome = await run(
        ["prove", "--message", Buffer.from(message, "utf8").toString("base64")],
        killMs,
      );
      if (!ranToCompletion(outcome)) return UNAVAILABLE;
      const line = singleJsonLine(outcome.stdout);
      if (outcome.exitCode === 0) {
        const parsed = provedLine.safeParse(line);
        if (!parsed.success) return UNAVAILABLE;
        const { scheme, signature } = parsed.data;
        if (scheme !== schemeOf(custody)) return UNAVAILABLE;
        if ((scheme === "none") !== (signature === null)) return UNAVAILABLE;
        return { kind: "proved", scheme, signature };
      }
      if (outcome.exitCode === 4) {
        return deniedLine.safeParse(line).success ? { kind: "denied" } : UNAVAILABLE;
      }
      return UNAVAILABLE;
    },

    async availability(): Promise<PresenceAvailability> {
      if (!exists(helperPath)) return "unavailable";
      const outcome = await run(["check"], PRESENCE_CHECK_TIMEOUT_MS);
      if (!ranToCompletion(outcome) || outcome.exitCode !== 0) return "unavailable";
      const parsed = checkLine.safeParse(singleJsonLine(outcome.stdout));
      if (!parsed.success || !parsed.data.canEvaluate) return "unavailable";
      if (parsed.data.stale === true) return "unavailable";
      if (custody !== "K-SVC" && parsed.data.enrolled !== true) return "unavailable";
      return "available";
    },
  };
}

/** The port used wherever the real helper must never run: it answers unavailable and spawns nothing. */
export function createFailClosedPresencePort(): PresencePort {
  return {
    prove: async () => UNAVAILABLE,
    availability: async () => "unavailable",
  };
}

export interface PresencePortFromEnvDeps {
  readonly runner: CommandRunner;
  readonly exists: (path: string) => boolean;
  readonly homeDir: string;
  /** Defaults to {@link RECORDED_PRESENCE_CUSTODY}. */
  readonly custody?: PresenceCustody;
  readonly killMs?: number;
}

/**
 * The presence port for a running service. Under any test or sandbox environment
 * (`CCC_INSTALL_SECRET_ACCOUNT` set, the same switch that keeps the sandbox from the real Keychain) it
 * is the fail-closed port: it never spawns the helper and never reads a Keychain item (T-09-33, D-17).
 * Otherwise it is the helper port at `<runtime dir>/bin/ccc-presence`.
 */
export function presencePortFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  runtimeDir: string,
  deps: PresencePortFromEnvDeps,
): PresencePort {
  if (!isAbsolute(runtimeDir)) {
    throw new TypeError("the runtime directory must be absolute");
  }
  const account = env.CCC_INSTALL_SECRET_ACCOUNT;
  if (account !== undefined) return createFailClosedPresencePort();
  return createHelperPresencePort({
    helperPath: join(runtimeDir, "bin", "ccc-presence"),
    runner: deps.runner,
    exists: deps.exists,
    homeDir: deps.homeDir,
    custody: deps.custody ?? RECORDED_PRESENCE_CUSTODY,
    ...(deps.killMs === undefined ? {} : { killMs: deps.killMs }),
  });
}
