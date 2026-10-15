/**
 * The live summariser's public surface (plan 07-10). The research pipeline wiring imports the
 * transport from here; `@ccc/test-fixtures` imports it as `@ccc/service/research-summariser` to
 * sweep hostile model replies through the real request and parser code. The test fake of the
 * HTTPS request is deliberately not exported.
 */
export {
  AnthropicRequestSchema,
  buildAnthropicRequest,
  DEFAULT_MAX_TOKENS,
  MAX_TOKENS_LIMIT,
  MIN_TOKENS_LIMIT,
  parseAnthropicResponse,
  SYSTEM_MAX_CHARS,
  THINKING_BY_MODEL,
  USER_CONTENT_MAX_CHARS,
} from "./anthropic-request.js";
export {
  ANTHROPIC_HOST,
  ANTHROPIC_PATH,
  ANTHROPIC_VERSION,
  type AnthropicLogEntry,
  type AnthropicRequestFn,
  type AnthropicRequestHandle,
  type AnthropicRequestOptions,
  type AnthropicResponseStream,
  type AnthropicTransportDeps,
  createAnthropicTransport,
  REQUEST_TIMEOUT_MS,
  RESPONSE_BYTE_CAP,
} from "./anthropic-transport.js";
export { RESEARCH_API_KEY_ACCOUNT } from "./research-key.js";
export { SummariserError, type SummariserErrorCode } from "./summariser-error.js";
