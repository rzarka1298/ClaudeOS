import { EXTRACTIVE_SUMMARISER_ID, type ResearchSourcesConfig } from "@ccc/domain";
import type { TextTransport } from "../untrusted/index.js";
import { createAnthropicTransport } from "./anthropic-transport.js";
import type { SummariserChoice } from "./pipeline.js";

/**
 * Chooses the summariser for one run (plan 07-14, D-03, D-04). Built at the composition root with
 * a key-reading closure; this module never imports the keychain package and never sees a key
 * string outside the closure.
 *
 * Without a test override the live Anthropic transport is built for the model named in the
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
}

export function createChooseSummariser(
  deps: ChooseSummariserDeps,
): (config: ResearchSourcesConfig) => SummariserChoice {
  const createTransport = deps.createTransport ?? createAnthropicTransport;
  return (config) => {
    if (deps.overrideTransport !== undefined) {
      return { transport: deps.overrideTransport, id: EXTRACTIVE_SUMMARISER_ID };
    }
    return {
      transport: createTransport({
        readApiKey: deps.readApiKey,
        model: config.summariserModel,
      }),
      id: config.summariserModel,
    };
  };
}
