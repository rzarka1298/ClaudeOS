import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import {
  type ApprovalLog,
  type ApprovalPresenceReason,
  PAYLOAD_HASH_PATTERN,
  PRESENCE_PROMPT_TIMEOUT_MS,
  PROPOSAL_ID_PATTERN,
  type PresenceAvailability,
  type PresencePort,
  type PresenceRequest,
  type PresenceResult,
} from "@ccc/domain";
import { z } from "zod";
import { isCanonicalSignature, presenceMessage } from "../approval/index.js";
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

/**
 * What the non-prompting `check` found, with the closed reason when it is unavailable (09-19). `availability()`
 * is this answer's `state`; Diagnostics shows the reason so the owner can tell a helper that was never built from
 * one that is not enrolled, was rebuilt, or did not answer.
 */
export interface PresenceInspection {
  readonly state: "available" | "unavailable";
  readonly reason: ApprovalPresenceReason | null;
}

/** A presence port that can also say why its check is unavailable. */
export type InspectablePresencePort = PresencePort & {
  inspect(): Promise<PresenceInspection>;
};

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

const provedLine = z.strictObject({
  v: z.literal(1),
  result: z.literal("proved"),
  scheme: z.enum(["p256", "none"]),
  signature: z.string().refine(isCanonicalSignature).nullable(),
});

const deniedLine = z.strictObject({
  v: z.literal(1),
  result: z.literal("denied"),
  error: z.number().int(),
  cause: z.literal("timeout").optional(),
});

const checkLine = z
  .strictObject({
    v: z.literal(1),
    canEvaluate: z.boolean(),
    biometry: z.enum(["touch-id", "none"]).optional(),
    enrolled: z.boolean().optional(),
    // FIX6B M1: present (true) only when a pin exists that a different binary enrolled (the helper was rebuilt
    // without a re-enrol). A stale pin is never `available`, whatever else the line says.
    stale: z.boolean().optional(),
    // The cannot-evaluate line carries the LocalAuthentication error code (exit 3): `{"canEvaluate":false,"error":N}`.
    error: z.number().int().optional(),
  })
  // An error code beside `canEvaluate: true` contradicts itself: it is a failed check, never an available one.
  .refine((line) => !(line.canEvaluate && line.error !== undefined));

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

export function createHelperPresencePort(
  options: HelperPresencePortOptions,
): InspectablePresencePort {
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

  const inspect = async (): Promise<PresenceInspection> => {
    if (!exists(helperPath)) return { state: "unavailable", reason: "helper-missing" };
    const outcome = await run(["check"], PRESENCE_CHECK_TIMEOUT_MS);
    // Exit 0 is a check that ran; exit 3 is the helper's own "cannot evaluate" line. Any other exit is a failure.
    if (!ranToCompletion(outcome) || (outcome.exitCode !== 0 && outcome.exitCode !== 3)) {
      return { state: "unavailable", reason: "check-failed" };
    }
    const parsed = checkLine.safeParse(singleJsonLine(outcome.stdout));
    if (!parsed.success) return { state: "unavailable", reason: "check-failed" };
    if (outcome.exitCode === 3 && parsed.data.canEvaluate) {
      return { state: "unavailable", reason: "check-failed" };
    }
    if (!parsed.data.canEvaluate) return { state: "unavailable", reason: "cannot-evaluate" };
    if (parsed.data.stale === true) return { state: "unavailable", reason: "pin-stale" };
    if (custody !== "K-SVC" && parsed.data.enrolled !== true) {
      return { state: "unavailable", reason: "not-enrolled" };
    }
    return { state: "available", reason: null };
  };

  return {
    async prove(request: PresenceRequest): Promise<PresenceResult> {
      if (!isValidRequest(request)) return UNAVAILABLE;
      if (!exists(helperPath)) return UNAVAILABLE;
      // The one canonical message builder is the verifier's (approval/proof.ts): what the helper signs is
      // exactly what the engine later checks. A request the builder cannot encode proves nothing.
      let message: string;
      try {
        message = presenceMessage(request);
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
        if (scheme === "p256" && signature !== null) return { kind: "proved", scheme, signature };
        if (scheme === "none" && signature === null) return { kind: "proved", scheme, signature };
        return UNAVAILABLE;
      }
      if (outcome.exitCode === 4) {
        const denied = deniedLine.safeParse(line);
        if (!denied.success) return UNAVAILABLE;
        return denied.data.cause === "timeout"
          ? { kind: "denied", cause: "timeout" }
          : { kind: "denied" };
      }
      return UNAVAILABLE;
    },

    async availability(): Promise<PresenceAvailability> {
      return (await inspect()).state;
    },

    inspect,
  };
}

/** The port used wherever the real helper must never run: it answers unavailable and spawns nothing. */
export function createFailClosedPresencePort(): InspectablePresencePort {
  return {
    prove: async () => UNAVAILABLE,
    availability: async () => "unavailable",
    inspect: async () => ({ state: "unavailable", reason: "sandbox" }),
  };
}

/** The absolute path of the built helper, `<runtime dir>/bin/ccc-presence` (the one place this is spelled). */
export function presenceHelperPath(runtimeDir: string): string {
  return join(runtimeDir, "bin", "ccc-presence");
}

/** True under any test or sandbox environment: the one switch that keeps the real helper and Keychain unreached. */
export function isPresenceSandbox(env: Readonly<Record<string, string | undefined>>): boolean {
  return env.CCC_INSTALL_SECRET_ACCOUNT !== undefined;
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
): InspectablePresencePort {
  if (!isAbsolute(runtimeDir)) {
    throw new TypeError("the runtime directory must be absolute");
  }
  if (isPresenceSandbox(env)) return createFailClosedPresencePort();
  return createHelperPresencePort({
    helperPath: presenceHelperPath(runtimeDir),
    runner: deps.runner,
    exists: deps.exists,
    homeDir: deps.homeDir,
    custody: deps.custody ?? RECORDED_PRESENCE_CUSTODY,
    ...(deps.killMs === undefined ? {} : { killMs: deps.killMs }),
  });
}

// ---------------------------------------------------------------------------
// The pin (09-18, R-02): the public key a presence signature is verified against

/** The Keychain account of the helper-only pin item (service `com.claude-command-center`). */
export const PRESENCE_PIN_ACCOUNT = "approval-presence-pin";

/** Reads the pin (base64 SPKI), or null when there is none or it cannot be read. Never throws. */
export type PinReader = () => Promise<string | null>;

/**
 * The pin reader for a running service: one attribute-only read of `approval-presence-pin` per call, never on a
 * timer. Under any test or sandbox environment (`CCC_INSTALL_SECRET_ACCOUNT` set, the same switch as
 * {@link presencePortFromEnv}) it answers null and never calls `read`, so no test reaches the Keychain (T-09-33).
 */
export function pinReaderFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  read: (account: string) => Promise<string | null>,
): PinReader {
  if (env.CCC_INSTALL_SECRET_ACCOUNT !== undefined) return async () => null;
  return async () => {
    try {
      return await read(PRESENCE_PIN_ACCOUNT);
    } catch {
      return null;
    }
  };
}

/** The `service_meta` key the SHA-256 of the pin the service trusts is kept under. */
export const PRESENCE_PIN_META_KEY = "presence_pin_sha256";

/** The file the install script leaves in the runtime directory after it enrols a key (consumed by the guard). */
export const PRESENCE_PIN_INSTALL_MARKER = "presence-pin-installed";

/**
 * How long an install's marker counts: ten minutes. The install restarts the service straight after it enrols, and
 * the service reads the pin as it starts (09-FIX9), so a real marker is used within seconds. A marker older than
 * this is a leftover or a plant, not an install.
 */
export const PRESENCE_PIN_INSTALL_MARKER_MAX_AGE_MS = 10 * 60 * 1000;

/** What the install marker is right now: not there, usable, too old (or dated in the future), or not a plain file. */
export type InstallMarkerState = "absent" | "fresh" | "stale" | "not-regular";

export interface InstallMarker {
  /** Looks at the marker without following a link; never throws. */
  inspect(): InstallMarkerState;
  /** Removes the marker if it is there (a link is removed, not followed); never throws. */
  clear(): void;
}

export interface InstallMarkerOptions {
  /** The marker file, `<runtime dir>/presence-pin-installed`. */
  readonly path: string;
  /** The wall clock in epoch milliseconds. */
  readonly now: () => number;
  /** `lstatSync`: stat without following a symbolic link. */
  readonly lstat: (path: string) => { isFile(): boolean; mtimeMs: number };
  readonly unlink: (path: string) => void;
  /** Defaults to {@link PRESENCE_PIN_INSTALL_MARKER_MAX_AGE_MS}. */
  readonly maxAgeMs?: number;
}

/**
 * The marker `install.sh` leaves after a successful enrol (09-FIX9): fresh only while it is a plain file whose
 * modification time lies within the window behind now. A directory, a link, a pipe, a file older than the window
 * and a file dated more than a minute ahead are not an install and are never honoured.
 */
export function createInstallMarker(options: InstallMarkerOptions): InstallMarker {
  const maxAgeMs = options.maxAgeMs ?? PRESENCE_PIN_INSTALL_MARKER_MAX_AGE_MS;
  return {
    inspect() {
      let stat: ReturnType<InstallMarkerOptions["lstat"]>;
      try {
        stat = options.lstat(options.path);
      } catch {
        return "absent";
      }
      if (!stat.isFile()) return "not-regular";
      const ageMs = options.now() - stat.mtimeMs;
      return ageMs <= maxAgeMs && ageMs >= -60_000 ? "fresh" : "stale";
    },
    clear() {
      try {
        options.unlink(options.path);
      } catch {
        // Already gone (or a directory that cannot be unlinked): the marker is single-use either way.
      }
    },
  };
}

/** What the pin guard last concluded about the pin in the Keychain (09-19): shown in Diagnostics. */
export interface PinObservation {
  /** `trusted` equals or first-recorded, `adopted` taken after an install, `changed` refused, `none` no readable pin. */
  readonly verdict: "trusted" | "adopted" | "changed" | "none";
  /** The first eight hex characters of the SHA-256 of the pin now in the Keychain; null when there is none. */
  readonly fingerprint: string | null;
}

/** The short, non-secret fingerprint of a pin: the first eight lowercase hex characters of its SHA-256. */
export function pinFingerprint(pin: string): string {
  return createHash("sha256").update(pin, "utf8").digest("hex").slice(0, 8);
}

export interface PinGuardDeps {
  /** The raw pin reader (see {@link pinReaderFromEnv}). */
  readonly read: PinReader;
  /** The SHA-256 (lowercase hex) of the pin the service trusts; null before it has seen one. */
  readonly recorded: {
    get(): string | null;
    set(sha256Hex: string): void;
  };
  /** The install script's marker (see {@link createInstallMarker}). */
  readonly installMarker: InstallMarker;
  readonly log: Pick<ApprovalLog, "info" | "warn">;
  /** Hears each read's conclusion (09-19). Optional; it must not throw and is never given the pin. */
  readonly observe?: (observation: PinObservation) => void;
}

/**
 * Detection for the delete-and-recreate residual (09-PRESENCE-SPIKE.md, "Residual"): trust on first use.
 *
 * - The first pin the service sees is recorded as its SHA-256 and returned. The service reads the pin once as it
 *   starts (09-FIX9), so install or first boot is that first sight, not the first presence-required approve.
 * - A later read equal to the record is returned as is.
 * - A later read that DIFFERS is accepted only when the install script left a FRESH marker (a plain file inside
 *   the window of {@link PRESENCE_PIN_INSTALL_MARKER_MAX_AGE_MS}): the new hash is recorded, the marker used up
 *   and `presence-pin-adopted` logged at warn level. Otherwise the pin is NOT returned (null, so presence
 *   signatures cannot verify and presence-required rows wait for it) and the closed warning
 *   `presence-pin-changed` is logged once for each distinct changed pin per process.
 * - A marker that is stale or not a plain file is deleted and ignored, with the closed warning
 *   `presence-pin-marker-ignored` (once per process), so it can never sit around waiting for a pin to be replaced.
 *   Nothing else is logged: never the pin and never its hash.
 *
 * The marker is cleared on any read that sees a pin, so it is never a standing permission. This is detection,
 * not prevention: a same-user process that replaces the pin item and writes a fresh marker file within the window
 * (or that also rewrites the record in the service store) is adopted, which is why the spike keeps the verdict at
 * partially met.
 */
export function guardPinReader(deps: PinGuardDeps): GuardedPinReader {
  const observed = guardPinReaderObserved(deps);
  const read: PinReader = async () => (await observed()).pin;
  return Object.assign(read, { observed });
}

/** A {@link PinReader} that also offers {@link ObservedPin} reads (same guard, same record, same warnings). */
export type GuardedPinReader = PinReader & { readonly observed: () => Promise<ObservedPin> };

/** One guarded read's result together with the conclusion that read itself reached (09-FIX10A). */
export interface ObservedPin {
  readonly pin: string | null;
  readonly observation: PinObservation;
}

/**
 * The guard behind {@link guardPinReader}, handing back, with each read's pin, the conclusion THAT read reached. Diagnostics uses
 * this instead of a shared "latest observation" slot, which a concurrent approval read could overwrite between a
 * check's read and its look at the slot. `deps.observe` still hears every conclusion.
 */
export function guardPinReaderObserved(deps: PinGuardDeps): () => Promise<ObservedPin> {
  const warned = new Set<string>();
  let markerIgnoredLogged = false;
  const NONE: PinObservation = { verdict: "none", fingerprint: null };
  const conclude = (pin: string | null, observation: PinObservation): ObservedPin => {
    try {
      deps.observe?.(observation);
    } catch {
      // A listener's failure never changes what the guard returns.
    }
    return { pin, observation };
  };
  return async () => {
    try {
      const pin = await deps.read();
      if (pin === null) return conclude(null, NONE);
      const fingerprint = createHash("sha256").update(pin, "utf8").digest("hex");
      const shortFingerprint = fingerprint.slice(0, 8);
      const recorded = deps.recorded.get();
      let installing = false;
      const marker = deps.installMarker.inspect();
      if (marker === "stale" || marker === "not-regular") {
        deps.installMarker.clear();
        if (!markerIgnoredLogged) {
          markerIgnoredLogged = true;
          deps.log.warn({ code: "presence-pin-marker-ignored" });
        }
      } else {
        installing = marker === "fresh";
      }
      if (recorded === null) {
        deps.recorded.set(fingerprint);
        if (installing) deps.installMarker.clear();
        return conclude(pin, { verdict: "trusted", fingerprint: shortFingerprint });
      }
      if (recorded === fingerprint) {
        if (installing) deps.installMarker.clear();
        return conclude(pin, { verdict: "trusted", fingerprint: shortFingerprint });
      }
      if (installing) {
        deps.recorded.set(fingerprint);
        deps.installMarker.clear();
        deps.log.warn({ code: "presence-pin-adopted" });
        return conclude(pin, { verdict: "adopted", fingerprint: shortFingerprint });
      }
      if (!warned.has(fingerprint)) {
        warned.add(fingerprint);
        deps.log.warn({ code: "presence-pin-changed" });
      }
      return conclude(null, { verdict: "changed", fingerprint: shortFingerprint });
    } catch {
      // A record that cannot be read or written proves nothing about the pin: no pin.
      return conclude(null, NONE);
    }
  };
}
