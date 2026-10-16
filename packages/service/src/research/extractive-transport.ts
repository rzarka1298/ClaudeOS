import { extractiveSummary } from "@ccc/research";
import type { TextTransport } from "../untrusted/index.js";

/**
 * The deterministic summariser double (D-05) behind the `TextTransport` port. It is the CI and
 * automated-UAT transport: no model, no network, no key. It answers what `extractiveSummary`
 * answers, which only ever holds source-fact and unverified-claim items with verifiable quotes.
 */
export function createExtractiveTransport(): TextTransport {
  return {
    async complete(request) {
      return extractiveSummary(request.input);
    },
  };
}
