import { EXTRACTIVE_SUMMARISER_ID, type ResearchSourcesConfig } from "@ccc/domain";
import type { TextTransport } from "../untrusted/index.js";
import {
  createAnthropicTransport,
  isUsableApiKey,
  liveCallRefusedByEnvironment,
} from "./anthropic-transport.js";
import type { SummariserChoice } from "./pipeline.js";
import { SummariserError } from "./summariser-error.js";

/**
 * Chooses the summariser for one run (plan 07-14, D-03, D-04). Built at the composition root with
 * a key-reading closure; this module never imports the keychain package and never sees a key
 * string outside the closure.
 *
 * Without a test override the key is checked first (a missing, empty or unusable key is
 * `summariser-unconfigured`, an environment that forbids the call is `summariser-failed`, both
 * before any fetch), then the live Anthropic transport is built for the model named in the
 * owner's allowlist file. With the guard's extractive transport the report records the
 * extractive double as its summariser.
 */

export interface ChooseSummariserDeps {
  /** Resolves the stored Anthropic key at call time, or null when none is stored. */
  readonly readApiKey: () => Promise<string | null>;
  /** The guard's extractive double, when the test override is on. */
  readonly overrideTransport?: TextTransport | undefined;
  /** Default {@link createAnthropicTransport}; tests inject a recorder. */
  readonly createTransport?: typeof createAnthropicTransport;
  /** The environment the live call would run in. Default: the process's. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** The runtime flags the live call would run with. Default: the process's. */
  readonly execArgv?: readonly string[];
}

export function createChooseSummariser(
  deps: ChooseSummariserDeps,
): (config: ResearchSourcesConfig) => Promise<SummariserChoice> {
  const createTransport = deps.createTransport ?? createAnthropicTransport;
  return async (config) => {
    if (deps.overrideTransport !== undefined) {
      return { transport: deps.overrideTransport, id: EXTRACTIVE_SUMMARISER_ID };
    }
    // Whether the run is ABLE to summarise is decided up front, with the transport's own checks, so
    // a run that cannot summarise fetches nothing and writes no raw note (07-FIX4 e): the
    // environment must not forbid the call (refused before the key is read, as the transport
    // does), and the stored key must be one the transport would send (an empty or malformed
    // value is unconfigured). The transport still reads the key itself, through the closure, on
    // every call: nothing here keeps the value.
    if (liveCallRefusedByEnvironment(deps.env ?? process.env, deps.execArgv ?? process.execArgv)) {
      throw new SummariserError("summariser-failed");
    }
    let key: string | null;
    try {
      key = await deps.readApiKey();
    } catch {
      throw new SummariserError("summariser-failed");
    }
    if (!isUsableApiKey(key)) throw new SummariserError("summariser-unconfigured");
    return {
      transport: createTransport({
        readApiKey: deps.readApiKey,
        model: config.summariserModel,
      }),
      id: config.summariserModel,
    };
  };
}
