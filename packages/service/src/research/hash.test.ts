import { createHash } from "node:crypto";
import { canonicalHashInput } from "@ccc/research";
import { describe, expect, it } from "vitest";
import { contentHashFor, newNonce, sourceIdFor } from "./hash.js";

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

describe("Test 4 (ids and hashes): ids, hashes and the nonce are computed in the service", () => {
  it("derives the source id as the first 32 hex characters of the SHA-256 of the canonical address", () => {
    const url = "https://feeds.example.invalid/releases.atom";
    expect(sourceIdFor(url)).toBe(sha256(url).slice(0, 32));
    expect(sourceIdFor(url)).toMatch(/^[0-9a-f]{32}$/);
    expect(sourceIdFor("https://feeds.example.invalid/other.atom")).not.toBe(sourceIdFor(url));
  });

  it("hashes the canonical form of the text, so line endings and trailing space do not change it", () => {
    const text = "line one  \r\nline two\r\n\r\n";
    expect(contentHashFor(text)).toBe(sha256(canonicalHashInput(text)));
    expect(contentHashFor(text)).toBe(contentHashFor("line one\nline two"));
    expect(contentHashFor(text)).toMatch(/^[0-9a-f]{64}$/);
    expect(contentHashFor("line one\nline three")).not.toBe(contentHashFor(text));
  });

  it("mints a 32-character lowercase hex nonce from random bytes that differs between calls", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      const nonce = newNonce();
      expect(nonce).toMatch(/^[0-9a-f]{32}$/);
      seen.add(nonce);
    }
    expect(seen.size).toBe(50);
  });
});
