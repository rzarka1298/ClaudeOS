import type dns from "node:dns";
import { describe, expect, it } from "vitest";
import {
  createSafeLookup,
  IPV4_BLOCKED_RANGES,
  IPV6_BLOCKED_RANGES,
  isBlockedAddress,
  REFUSED_ADDRESS_CODE,
  safeLookup,
} from "./address-policy.js";
import { tableResolver } from "./test-support/fake-https.js";

const BLOCKED: readonly string[] = [
  // plan table
  "127.0.0.1",
  "10.1.2.3",
  "172.16.0.1",
  "192.168.1.1",
  "169.254.169.254",
  "100.64.0.1",
  "0.0.0.0",
  "198.18.0.1",
  "224.0.0.1",
  "240.0.0.1",
  "::1",
  "::",
  "fc00::1",
  "fe80::1",
  "ff02::1",
  "64:ff9b::1",
  "2001:db8::1",
  "::ffff:127.0.0.1",
  "::ffff:7f00:1",
  "not an address",
  // range edges
  "127.255.255.255",
  "10.255.255.255",
  "172.31.255.255",
  "100.127.255.255",
  "169.254.0.1",
  "192.0.0.8",
  "198.19.255.255",
  "239.255.255.255",
  "255.255.255.255",
  "0.1.2.3",
  // documentation ranges
  "192.0.2.1",
  "198.51.100.7",
  "203.0.113.9",
  // IPv6 unique-local, link-local and multicast edges
  "fd12:3456::1",
  "febf::1",
  "ff00::",
  // IPv4-mapped IPv6 of private targets, in both spellings
  "::ffff:10.0.0.1",
  "::ffff:a00:1",
  "::ffff:169.254.169.254",
  "::ffff:a9fe:a9fe",
  "::ffff:192.168.0.1",
  "::ffff:c0a8:1",
  // forms that embed an IPv4 target
  "::127.0.0.1",
  "::7f00:1",
  "64:ff9b:1::7f00:1",
  "2002:7f00:1::1",
  "2002:a9fe:a9fe::1",
  "::ffff:0:7f00:1",
  // site-local and discard
  "fec0::1",
  "100::1",
  // not a literal the connection layer would accept
  "fe80::1%eth0",
  "",
  " 127.0.0.1",
  "127.0.0.1 ",
  "0x7f.1",
  "2130706433",
  "127.1",
];

const ALLOWED: readonly string[] = [
  "93.184.216.34",
  "2606:4700::1111",
  "8.8.8.8",
  "1.1.1.1",
  "::ffff:93.184.216.34",
  "::ffff:5db8:d822",
  "2a00:1450:4001:81b::200e",
];

describe("Test 1 (address table): isBlockedAddress", () => {
  for (const address of BLOCKED) {
    it(`blocks ${JSON.stringify(address)}`, () => {
      expect(isBlockedAddress(address)).toBe(true);
    });
  }
  for (const address of ALLOWED) {
    it(`allows ${address}`, () => {
      expect(isBlockedAddress(address)).toBe(false);
    });
  }

  it("never lists the IPv4-mapped prefix itself, which would block every IPv4 address", () => {
    const listed = IPV6_BLOCKED_RANGES.map(([address, prefix]) => `${address}/${prefix}`);
    for (const entry of listed) {
      expect(entry.startsWith("::ffff:0:0/")).toBe(false);
      expect(entry).not.toBe("::ffff:0.0.0.0/96");
    }
    expect(isBlockedAddress("93.184.216.34")).toBe(false);
    expect(isBlockedAddress("::ffff:93.184.216.34")).toBe(false);
  });

  it("lists the research ranges", () => {
    const v4 = IPV4_BLOCKED_RANGES.map(([address, prefix]) => `${address}/${prefix}`);
    for (const range of [
      "0.0.0.0/8",
      "10.0.0.0/8",
      "100.64.0.0/10",
      "127.0.0.0/8",
      "169.254.0.0/16",
      "172.16.0.0/12",
      "192.0.0.0/24",
      "192.168.0.0/16",
      "198.18.0.0/15",
      "224.0.0.0/4",
      "240.0.0.0/4",
    ]) {
      expect(v4).toContain(range);
    }
    const v6 = IPV6_BLOCKED_RANGES.map(([address, prefix]) => `${address}/${prefix}`);
    for (const range of [
      "::/128",
      "::1/128",
      "fc00::/7",
      "fe80::/10",
      "ff00::/8",
      "64:ff9b::/96",
      "2001:db8::/32",
    ]) {
      expect(v6).toContain(range);
    }
  });
});

type LookupOutcome = {
  error: NodeJS.ErrnoException | null;
  address: string | dns.LookupAddress[];
  family: number | undefined;
  calls: number;
};

function runLookup(
  lookup: ReturnType<typeof createSafeLookup>,
  hostname: string,
  all: boolean,
): Promise<LookupOutcome> {
  return new Promise((resolve) => {
    let calls = 0;
    lookup(hostname, { all, hints: 1024 }, (error, address, family) => {
      calls += 1;
      // resolve on the first call; later calls are visible through `calls` on a second tick
      setTimeout(() => resolve({ error, address, family, calls }), 0);
    });
  });
}

describe("Test 2 (lookup forms): the validator handles both shapes Node uses", () => {
  const table = {
    "mixed.example.invalid": ["93.184.216.34", "10.0.0.5"],
    "public.example.invalid": ["93.184.216.34", "2606:4700::1111"],
    "mapped.example.invalid": ["::ffff:127.0.0.1"],
    "loopback.example.invalid": ["127.0.0.1"],
    "empty.example.invalid": [],
  };
  const lookup = createSafeLookup(tableResolver(table));

  it("all:true refuses the whole answer when any address is private", async () => {
    const outcome = await runLookup(lookup, "mixed.example.invalid", true);
    expect(outcome.error?.code).toBe(REFUSED_ADDRESS_CODE);
    expect(outcome.calls).toBe(1);
  });

  it("all:true with only public addresses returns the array it was given", async () => {
    const outcome = await runLookup(lookup, "public.example.invalid", true);
    expect(outcome.error).toBeNull();
    expect(outcome.address).toEqual([
      { address: "93.184.216.34", family: 4 },
      { address: "2606:4700::1111", family: 6 },
    ]);
  });

  it("all:false returns the scalar form with its family", async () => {
    const outcome = await runLookup(lookup, "public.example.invalid", false);
    expect(outcome.error).toBeNull();
    expect(outcome.address).toBe("93.184.216.34");
    expect(outcome.family).toBe(4);
  });

  it("all:false refuses a private scalar answer", async () => {
    const outcome = await runLookup(lookup, "loopback.example.invalid", false);
    expect(outcome.error?.code).toBe(REFUSED_ADDRESS_CODE);
  });

  it("refuses an IPv4-mapped IPv6 answer that points at loopback", async () => {
    const outcome = await runLookup(lookup, "mapped.example.invalid", true);
    expect(outcome.error?.code).toBe(REFUSED_ADDRESS_CODE);
  });

  it("passes a resolver error through unchanged as a dns failure", async () => {
    const outcome = await runLookup(lookup, "unknown.example.invalid", true);
    expect(outcome.error?.code).toBe("ENOTFOUND");
  });

  it("treats an empty answer as a dns failure, not as success", async () => {
    const outcome = await runLookup(lookup, "empty.example.invalid", true);
    expect(outcome.error).not.toBeNull();
    expect(outcome.error?.code).not.toBe(REFUSED_ADDRESS_CODE);
  });

  it("refuses names that only look harmless (nip.io style) by the address they resolve to", async () => {
    const nip = createSafeLookup(
      tableResolver({
        "127.0.0.1.nip.io": ["127.0.0.1"],
        "10-0-0-1.nip.io": ["10.0.0.1"],
        "169.254.169.254.nip.io": ["169.254.169.254"],
        "metadata.example.invalid": ["169.254.169.254"],
      }),
    );
    for (const name of [
      "127.0.0.1.nip.io",
      "10-0-0-1.nip.io",
      "169.254.169.254.nip.io",
      "metadata.example.invalid",
    ]) {
      const outcome = await runLookup(nip, name, true);
      expect(outcome.error?.code, name).toBe(REFUSED_ADDRESS_CODE);
    }
  });
});

describe("Test 3 (real local name): localhost is refused by the real validator", () => {
  it("safeLookup('localhost', { all: true }) refuses (resolved locally, no network)", async () => {
    const outcome = await runLookup(safeLookup, "localhost", true);
    expect(outcome.error?.code).toBe(REFUSED_ADDRESS_CODE);
  });
});
