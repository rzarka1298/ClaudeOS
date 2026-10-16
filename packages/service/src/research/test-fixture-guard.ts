import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { TextTransport } from "../untrusted/index.js";
import { createExtractiveTransport } from "./extractive-transport.js";
import type { SafeFetcher } from "./fetch/safe-fetch.js";
import { createFixtureFetcher, type FixtureFetcherOptions } from "./fixture-fetcher.js";
import { ResearchOverrideError } from "./override-error.js";
import { RESEARCH_API_KEY_ACCOUNT } from "./research-key.js";

/**
 * The research test-override guard (plan 07-14, D-27, research Pitfall 15, T-07-34). The ONLY
 * module that reads the research test variables, behind the one enabling flag that the approval
 * lifetime override already uses. With the flag absent or anything but `1`, nothing is overridden,
 * whatever else is set: the installed service's environment never sets any of these, and a stray
 * variable in a developer shell cannot change a real run.
 *
 * What the variables do, each only when the flag is on:
 *
 * - the fixture directory swaps the safe fetcher for an in-process fixture reader;
 * - the summariser variable (only the value `extractive`) swaps the live model transport for the
 *   deterministic extractive double;
 * - the key account names a test-only Keychain account, so an automated run can exercise the real
 *   "no key" path against an empty account and never the owner's key. It must carry the
 *   live-UAT account prefix, and it can never be an account the service itself uses (the
 *   research key, the install secret, or the install-secret account this process was told to use).
 *
 * No override is accepted when the runtime directory is the owner's default one: an automated run
 * always has its own temporary directory, so the installed service (which uses the default) cannot
 * be turned into a fixture-fed one by a variable left in a shell or in `launchctl setenv`.
 *
 * It never weakens the real fetcher: no plain HTTP or loopback fetching is added anywhere.
 * An unusable value is refused at startup with a code-only log line and a thrown
 * {@link ResearchOverrideError}.
 */

export interface ResearchTestOverrides {
  readonly fetcher?: SafeFetcher;
  readonly transport?: TextTransport;
  readonly keyAccount?: string;
}

/** The one log method the guard uses: fixed fields, never an environment value. */
export interface OverrideLog {
  warn(fields: Readonly<Record<string, unknown>>, message?: string): void;
  error(fields: Readonly<Record<string, unknown>>, message?: string): void;
}

/** What a Keychain account may look like: the keychain package's own safe alphabet. */
const KEY_ACCOUNT_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * The prefix every Keychain account of a live-UAT run carries. The end-to-end package defines it
 * (`UAT_ACCOUNT_PREFIX` in `packages/e2e/src/isolation-guards.ts`); the service cannot import a
 * test package, so the value is repeated here and a test pins the two equal.
 */
export const RESEARCH_TEST_ACCOUNT_PREFIX = "ccc-uat-";

/** The install-secret account of a service started without an override (see `auth/install-secret.ts`). */
const DEFAULT_INSTALL_SECRET_ACCOUNT = "install-secret";

/** The owner's default runtime directory name, below the home directory. */
const DEFAULT_RUNTIME_DIR_NAME = ".claude-command-center";

/** True when `account` is a name the service itself keeps a secret under. */
function isServiceAccount(account: string, env: NodeJS.ProcessEnv): boolean {
  return (
    account === RESEARCH_API_KEY_ACCOUNT ||
    account === DEFAULT_INSTALL_SECRET_ACCOUNT ||
    account === env.CCC_INSTALL_SECRET_ACCOUNT
  );
}

export interface ResolveOverridesOptions {
  /** The runtime directory this process uses. An override is refused when it is the default one. */
  readonly runtimeDir: string;
  /** Test seam: the home directory the default runtime directory is computed from. */
  readonly home?: string;
  /** Test seam for the fixture reader's file and timer ports. */
  readonly fixture?: Omit<FixtureFetcherOptions, "dir">;
}

export function resolveResearchTestOverrides(
  env: NodeJS.ProcessEnv,
  log: OverrideLog,
  options: ResolveOverridesOptions,
): ResearchTestOverrides {
  const fixtureDir = env.CCC_RESEARCH_TEST_FIXTURE_DIR;
  const summariser = env.CCC_RESEARCH_TEST_SUMMARISER;
  const keyAccount = env.CCC_RESEARCH_KEY_ACCOUNT;

  if (env.CCC_ENABLE_TEST_OVERRIDES !== "1") {
    if (fixtureDir !== undefined || summariser !== undefined || keyAccount !== undefined) {
      log.warn({ code: "research-test-override-ignored" });
    }
    return {};
  }

  const overrides: {
    fetcher?: SafeFetcher;
    transport?: TextTransport;
    keyAccount?: string;
  } = {};
  try {
    // Computed from the path alone (nothing is stat-ed or created): the directory the installed
    // service uses is never the directory of an automated run.
    const wantsOverride =
      fixtureDir !== undefined || summariser !== undefined || keyAccount !== undefined;
    const defaultDir = resolve(join(options.home ?? homedir(), DEFAULT_RUNTIME_DIR_NAME));
    if (wantsOverride && resolve(options.runtimeDir) === defaultDir) {
      throw new ResearchOverrideError("default-runtime-dir");
    }
    if (fixtureDir !== undefined) {
      overrides.fetcher = createFixtureFetcher({ ...options.fixture, dir: fixtureDir });
    }
    if (summariser !== undefined) {
      if (summariser !== "extractive") throw new ResearchOverrideError("unknown-summariser");
      overrides.transport = createExtractiveTransport();
    }
    if (keyAccount !== undefined) {
      if (
        !KEY_ACCOUNT_PATTERN.test(keyAccount) ||
        !keyAccount.startsWith(RESEARCH_TEST_ACCOUNT_PREFIX) ||
        isServiceAccount(keyAccount, env)
      ) {
        throw new ResearchOverrideError("invalid-key-account");
      }
      overrides.keyAccount = keyAccount;
    }
  } catch (error) {
    if (error instanceof ResearchOverrideError) {
      log.error({ code: `research-test-override-${error.code}` });
    }
    throw error;
  }
  if (Object.keys(overrides).length > 0) {
    // Which overrides are on, by fixed name: the only trace that a run was not a live one.
    const active = [
      ...(overrides.fetcher === undefined ? [] : ["fixture-fetcher"]),
      ...(overrides.transport === undefined ? [] : ["extractive-summariser"]),
      ...(overrides.keyAccount === undefined ? [] : ["key-account"]),
    ];
    log.warn({ code: "research-test-overrides-active", overrides: active });
  }
  return overrides;
}
