/**
 * Whether the environment changes which certificates the key-carrying request would trust. Node
 * honours `NODE_TLS_REJECT_UNAUTHORIZED=0` (verification off) and `NODE_EXTRA_CA_CERTS` (an extra
 * trusted root, loaded at process start and not removable per request) for every TLS connection. A
 * request that carries the API key must not depend on either: the request pins verification on
 * explicitly, and this check refuses the call outright when the environment asks for more trust,
 * because an extra root could vouch for a man-in-the-middle that then reads the key.
 *
 * Only an empty or unset value counts as "off" for the CA variable; for the verification variable
 * only the value that disables verification counts. The variable names are read from the injected
 * environment, never from the process.
 */
export function tlsTrustOverrideRequested(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  if (env.NODE_TLS_REJECT_UNAUTHORIZED?.trim() === "0") return true;
  const extra = env.NODE_EXTRA_CA_CERTS;
  return extra !== undefined && extra.trim() !== "";
}
