/**
 * Whether the process asked Node to route HTTP(S) through an environment proxy (research Pitfall 4,
 * assumption A8). Node 24 supports `NODE_USE_ENV_PROXY=1` and `--use-env-proxy`; with either, the
 * TCP connection goes to the PROXY, so the connect-time address check would validate the proxy and
 * not the target. The fetcher does not rely on its explicit agent staying outside that routing: it
 * refuses every source instead.
 *
 * Only `NODE_USE_ENV_PROXY=0` and an empty or unset value count as "off"; any other value is treated
 * as "on", because refusing by mistake costs a report and trusting by mistake costs the check. The
 * conventional proxy variables alone change nothing in Node without the flag, and the
 * fetcher never reads them.
 */
export function envProxyRequested(
  env: Readonly<Record<string, string | undefined>>,
  execArgv: readonly string[],
): boolean {
  const flag = env.NODE_USE_ENV_PROXY?.trim().toLowerCase();
  if (flag !== undefined && flag !== "" && flag !== "0") return true;
  if (execArgv.includes("--use-env-proxy")) return true;
  const options = (env.NODE_OPTIONS ?? "").split(/\s+/);
  return options.includes("--use-env-proxy");
}
