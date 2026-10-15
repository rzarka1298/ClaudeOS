/**
 * The Keychain account that holds the Anthropic API key, under the existing service name of
 * `@ccc/keychain`. The account satisfies the keychain package's account pattern. The key lives
 * nowhere else: the owner stores it with `scripts/research-key-setup.mjs` (standard input, never
 * argv) and the transport reads it through a closure on every call.
 */
export const RESEARCH_API_KEY_ACCOUNT = "anthropic-api-key";
