/**
 * The research fetcher's public surface (plan 07-09). The research pipeline imports the fetcher
 * from here; `@ccc/test-fixtures` imports it as `@ccc/service/research-fetch` to sweep the hostile
 * corpus. The test fake of the transport is deliberately not exported.
 */
export {
  createSafeLookup,
  IPV4_BLOCKED_RANGES,
  IPV6_BLOCKED_RANGES,
  isBlockedAddress,
  type LookupResolver,
  REFUSED_ADDRESS_CODE,
  safeLookup,
} from "./address-policy.js";
export { type DecodeResult, decodeBody } from "./decode-body.js";
export * from "./limits.js";
export { envProxyRequested } from "./proxy-env.js";
export {
  createRunBudget,
  createSafeFetcher,
  type FetchLogEntry,
  type FetchSourceInput,
  type FetchSourceResult,
  type RequestFn,
  type RequestHandle,
  type ResponseStream,
  type RunBudget,
  type SafeFetcher,
  type SafeFetcherDeps,
  type SafeRequestOptions,
} from "./safe-fetch.js";
export {
  type FetchUrlContext,
  type FetchUrlVerdict,
  resolveRedirectTarget,
  validateFetchUrl,
} from "./url-policy.js";
