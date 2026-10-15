import dns from "node:dns";
import net from "node:net";

/**
 * Which addresses the research fetcher may connect to (D-09, research Pitfalls 2 and 3).
 *
 * The decision is made on the ADDRESS a name resolves to, never on how a name looks: a name such as
 * `127.0.0.1.nip.io` or a rebinding host is allowed only if every address it resolves to is public.
 * `safeLookup` is passed as the request's `lookup` option, so the address that was checked is the
 * address Node connects to (no second resolution, no gap between check and connect). IP literals
 * never call `lookup`, so the URL policy checks them with {@link isBlockedAddress} first.
 */

/** The marker on the error `safeLookup` raises when an answer holds a refused address. */
export const REFUSED_ADDRESS_CODE = "ECCC_REFUSED_ADDRESS";

export type AddressRange = readonly [address: string, prefixLength: number];

/**
 * IPv4: "this" network, private, shared (carrier-grade NAT), loopback, link-local (incl. the cloud
 * metadata address), IETF protocol assignments, the three documentation blocks, 6to4 relay anycast,
 * private, benchmark, multicast and the reserved block (which holds the broadcast address).
 */
export const IPV4_BLOCKED_RANGES: readonly AddressRange[] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

/**
 * IPv6: unspecified, loopback, the deprecated IPv4-compatible block, unique-local, link-local,
 * site-local, multicast, discard, NAT64 (well-known and local-use), documentation, the IPv4-
 * translated block, Teredo and 6to4 (both embed an IPv4 target in the address). The embedded-IPv4
 * prefixes are refused whole rather than decoded: no legitimate research source is served from them.
 *
 * The IPv4-mapped prefix (::ffff:0:0/96) is deliberately NOT here: listing it blocks every IPv4
 * address. Node's BlockList already applies the IPv4 rules to a mapped address, so
 * `::ffff:127.0.0.1` and `::ffff:7f00:1` hit 127.0.0.0/8 (research Pitfall 3).
 */
export const IPV6_BLOCKED_RANGES: readonly AddressRange[] = [
  ["::", 128],
  ["::1", 128],
  ["::", 96],
  ["::ffff:0:0:0", 96],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
  ["100::", 64],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["2001::", 32],
  ["2001:db8::", 32],
  ["2002::", 16],
];

const blocked = new net.BlockList();
for (const [address, prefix] of IPV4_BLOCKED_RANGES) blocked.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of IPV6_BLOCKED_RANGES) blocked.addSubnet(address, prefix, "ipv6");

/**
 * True when the address must not be connected to. Anything that is not exactly a literal IPv4 or
 * IPv6 address (an empty string, surrounding space, a zone identifier, a short or hex form) is
 * unparseable and therefore blocked.
 */
export function isBlockedAddress(address: string): boolean {
  if (address.includes("%")) return true;
  const family = net.isIP(address);
  if (family === 0) return true;
  if (family === 4 && !/^\d{1,3}(\.\d{1,3}){3}$/.test(address)) return true;
  return blocked.check(address, family === 6 ? "ipv6" : "ipv4");
}

/** The shape of `dns.lookup`, so a test can inject a resolver that never touches DNS. */
export type LookupResolver = (
  hostname: string,
  options: dns.LookupOptions,
  callback: (
    error: NodeJS.ErrnoException | null,
    address: string | dns.LookupAddress[],
    family?: number,
  ) => void,
) => void;

function refusedError(): NodeJS.ErrnoException {
  return Object.assign(new Error("refused address"), { code: REFUSED_ADDRESS_CODE });
}

function emptyAnswerError(): NodeJS.ErrnoException {
  return Object.assign(new Error("no address"), { code: "ENODATA" });
}

/**
 * A `lookup` function that refuses the WHOLE answer if any address in it is blocked, and otherwise
 * hands back exactly the shape it was asked for: an array when Node asks for `all: true` (Node 24's
 * autoSelectFamily does) and the scalar address and family otherwise (research Pitfall 2).
 */
export function createSafeLookup(resolve: LookupResolver): net.LookupFunction {
  return (hostname, options, callback) => {
    let answered = false;
    const once = (run: () => void): void => {
      if (answered) return;
      answered = true;
      run();
    };
    resolve(hostname, options, (error, address, family) => {
      if (error) {
        once(() => callback(error, "", 0));
        return;
      }
      if (Array.isArray(address)) {
        if (address.length === 0) {
          once(() => callback(emptyAnswerError(), "", 0));
          return;
        }
        if (address.some((entry) => isBlockedAddress(entry.address))) {
          once(() => callback(refusedError(), "", 0));
          return;
        }
        once(() => callback(null, address));
        return;
      }
      if (address === "") {
        once(() => callback(emptyAnswerError(), "", 0));
        return;
      }
      if (isBlockedAddress(address)) {
        once(() => callback(refusedError(), "", 0));
        return;
      }
      once(() => callback(null, address, family));
    });
  };
}

export const safeLookup: net.LookupFunction = createSafeLookup(dns.lookup);
