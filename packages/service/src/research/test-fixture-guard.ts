import type { TextTransport } from "../untrusted/index.js";
import { createExtractiveTransport } from "./extractive-transport.js";
import type { SafeFetcher } from "./fetch/safe-fetch.js";
import { createFixtureFetcher, type FixtureFetcherOptions } from "./fixture-fetcher.js";
import { ResearchOverrideError } from "./override-error.js";

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
 *   "no key" path against an empty account and never the owner's key.
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

export interface ResolveOverridesOptions {
  /** Test seam for the fixture reader's file and timer ports. */
  readonly fixture?: Omit<FixtureFetcherOptions, "dir">;
}

export function resolveResearchTestOverrides(
  env: NodeJS.ProcessEnv,
  log: OverrideLog,
  options: ResolveOverridesOptions = {},
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
    if (fixtureDir !== undefined) {
      overrides.fetcher = createFixtureFetcher({ ...options.fixture, dir: fixtureDir });
    }
    if (summariser !== undefined) {
      if (summariser !== "extractive") throw new ResearchOverrideError("unknown-summariser");
      overrides.transport = createExtractiveTransport();
    }
    if (keyAccount !== undefined) {
      if (!KEY_ACCOUNT_PATTERN.test(keyAccount)) {
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
  if (Object.keys(overrides).length > 0) log.warn({ code: "research-test-overrides-active" });
  return overrides;
}
