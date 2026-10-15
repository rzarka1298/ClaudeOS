import dns from "node:dns";
import net from "node:net";

/**
 * Which addresses the research fetcher may connect to (D-09, research Pitfalls 2 and 3).
 *
 * This file is completed in Task 2 of plan 07-09; the lists below are the minimum the tracer
 * needs (loopback only).
 */

/** The marker on the error `safeLookup` raises when an answer holds a refused address. */
export const REFUSED_ADDRESS_CODE = "ECCC_REFUSED_ADDRESS";

const blocked = new net.BlockList();
blocked.addSubnet("127.0.0.0", 8, "ipv4");
blocked.addSubnet("::1", 128, "ipv6");

export function isBlockedAddress(address: string): boolean {
  const family = net.isIP(address);
  return family === 0 || blocked.check(address, family === 6 ? "ipv6" : "ipv4");
}

export type LookupResolver = (
  hostname: string,
  options: dns.LookupOptions,
  callback: (
    error: NodeJS.ErrnoException | null,
    address: string | dns.LookupAddress[],
    family?: number,
  ) => void,
) => void;

export function createSafeLookup(resolve: LookupResolver): net.LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname, options, (error, address, family) => {
      if (error) {
        callback(error, "", 0);
        return;
      }
      if (Array.isArray(address)) {
        if (address.some((entry) => isBlockedAddress(entry.address))) {
          callback(refusedError(), "", 0);
          return;
        }
        callback(null, address);
        return;
      }
      if (isBlockedAddress(address)) {
        callback(refusedError(), "", 0);
        return;
      }
      callback(null, address, family);
    });
  };
}

function refusedError(): NodeJS.ErrnoException {
  return Object.assign(new Error("refused address"), { code: REFUSED_ADDRESS_CODE });
}

export const safeLookup: net.LookupFunction = createSafeLookup(dns.lookup);
