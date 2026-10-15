// Neutralising untrusted model text (plan 07-07 Task 2, D-06, RSRCH-08, research Pitfall 7).
// Hostile characters are written as \u escapes so this file stays pure ASCII.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SANITISE_COUNT_KEYS } from "@ccc/domain";
import { describe, expect, it } from "vitest";
import { newReport, SANITISE_REPORT_KEYS } from "./html-to-text.js";
import { ADDRESS_REMOVED_MARKER, neutraliseUntrustedSpan } from "./neutralise.js";

const MAX = 600;
const DISALLOWED = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

function neutralise(text: string, max = MAX) {
  return neutraliseUntrustedSpan(text, max);
}

describe("Task 2 Test 1 (characters)", () => {
  it("removes bidi, joiner, NUL and line separator characters and counts each", () => {
    const result = neutralise("a\u202Eb\u200Dc\u0000d\u2028e");
    expect(result.text).not.toMatch(DISALLOWED);
    expect(result.text.replace(/ /g, "")).toBe("abcde");
    expect(result.controlCharsRemoved).toBe(4);
  });

  it("turns newlines and tabs into single spaces without counting them", () => {
    const result = neutralise("  a\nb\t\tc\r\n\r\nd  ");
    expect(result.text).toBe("a b c d");
    expect(result.controlCharsRemoved).toBe(0);
  });

  it("applies NFC", () => {
    expect(neutralise("e\u0301").text).toBe("\u00E9");
  });

  it("removes lone surrogates and invisible fillers", () => {
    const result = neutralise("a\uD800b\u3164c\u2800d");
    expect(result.text).toBe("abcd");
    expect(result.controlCharsRemoved).toBe(3);
  });

  it("returns an empty string for text that is only invisible", () => {
    expect(neutralise("\u200B\u202E \n").text).toBe("");
  });
});

describe("Task 2 Test 2 (addresses)", () => {
  const ADDRESSES = [
    "https://evil.example/p?x=1",
    "http://a.b",
    "HTTPS://EVIL.EXAMPLE/X",
    "www.example.com/x",
    "WWW.Example.com",
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "data:text/html;base64,AAAA",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "obsidian://open?vault=v",
    `mailto:someone${"@"}evil.example`,
    "ftp://evil.example/f",
    "https:\\\\evil.example\\x",
    "xhttps://evil.example",
    `${"a".repeat(60)}https://evil.example/x`,
    "hxxp://evil.example",
  ];

  it("replaces each address with the fixed marker and counts it", () => {
    for (const address of ADDRESSES) {
      const result = neutralise(`see ${address} now`);
      expect(result.text, address).toBe(`see ${ADDRESS_REMOVED_MARKER} now`);
      expect(result.addressesRemoved, address).toBe(1);
    }
  });

  it("replaces several addresses in one span", () => {
    const result = neutralise("a https://x.example b www.y.example c data:text/plain,hi d");
    expect(result.text).toBe(
      `a ${ADDRESS_REMOVED_MARKER} b ${ADDRESS_REMOVED_MARKER} c ${ADDRESS_REMOVED_MARKER} d`,
    );
    expect(result.addressesRemoved).toBe(3);
  });

  it("leaves ordinary words with a colon, times, ratios and drive paths alone", () => {
    for (const plain of [
      "Note: fixed",
      "Warning: this is data: not an address",
      "at 12:30 today",
      "ratio 3:1",
      "C:\\Users\\x",
      "the www prefix",
      "see www. alone",
      "file a report",
    ]) {
      const result = neutralise(plain);
      expect(result.text, plain).toBe(plain);
      expect(result.addressesRemoved, plain).toBe(0);
    }
  });

  it("sees through a zero-width split and a fullwidth spelling of a scheme", () => {
    const split = neutralise("ht\u200Btps://evil.example/x");
    expect(split.text).toBe(ADDRESS_REMOVED_MARKER);
    expect(split.addressesRemoved).toBe(1);
    expect(split.controlCharsRemoved).toBe(1);
    const wide = neutralise("\uFF48\uFF54\uFF54\uFF50\uFF53\uFF1A\uFF0F\uFF0Fevil.example/x ok");
    expect(wide.text).toBe(`${ADDRESS_REMOVED_MARKER} ok`);
    expect(wide.addressesRemoved).toBeGreaterThanOrEqual(1);
  });

  it("is idempotent: neutralising a result changes nothing", () => {
    for (const address of ADDRESSES) {
      const once = neutralise(`x ${address} \u202E y\n`);
      const twice = neutralise(once.text);
      expect(twice.text, address).toBe(once.text);
      expect(twice.addressesRemoved).toBe(0);
      expect(twice.controlCharsRemoved).toBe(0);
    }
  });
});

describe("Task 2 Test 3 (markup survives only as text)", () => {
  it("keeps wikilinks, embeds, tags and emphasis as literal characters", () => {
    for (const literal of [
      "[[secret note]]",
      "![[secret note]]",
      "<img src=x onerror=y>",
      "**bold** and _it_",
      "#tag %%comment%% $x$",
      "`code`",
    ]) {
      expect(neutralise(literal).text, literal).toBe(literal);
    }
  });

  it("replaces only the address inside link, image and autolink syntax", () => {
    expect(neutralise("![x](https://e.example/p.png)").text).toBe(
      `![x](${ADDRESS_REMOVED_MARKER})`,
    );
    expect(neutralise("[click](https://e.example/x)").text).toBe(
      `[click](${ADDRESS_REMOVED_MARKER})`,
    );
    expect(neutralise("<https://e.example/x>").text).toBe(`<${ADDRESS_REMOVED_MARKER}>`);
    expect(neutralise('<a href="https://e.example/x">go</a>').text).toBe(
      `<a href="${ADDRESS_REMOVED_MARKER}">go</a>`,
    );
    expect(neutralise("![[https://e.example/x]]").text).toBe(`![[${ADDRESS_REMOVED_MARKER}]]`);
  });
});

describe("Task 2 Test 4 (caps after neutralisation)", () => {
  it("cuts text over the limit and reports it, never rejecting", () => {
    const result = neutralise("a".repeat(700), 600);
    expect(result.text).toHaveLength(600);
    expect(result.truncated).toBe(true);
    expect(neutralise("a".repeat(600), 600).truncated).toBe(false);
    expect(neutralise("a".repeat(300), 240).text).toHaveLength(240);
  });

  it("does not leave half of a surrogate pair at the cut", () => {
    const result = neutralise(`${"a".repeat(599)}\uD83D\uDE00`, 600);
    expect(result.text).toBe("a".repeat(599));
    expect(result.truncated).toBe(true);
  });

  it("measures the limit after an address has shrunk to the marker", () => {
    const result = neutralise(`start https://e.example/${"p".repeat(2000)} end`, 600);
    expect(result.text).toBe(`start ${ADDRESS_REMOVED_MARKER} end`);
    expect(result.truncated).toBe(false);
  });

  it("does not end the cut text with a space", () => {
    const result = neutralise(`${"a".repeat(599)} b`, 600);
    expect(result.text.endsWith(" ")).toBe(false);
  });
});

describe("Task 2 resource bounds", () => {
  it("handles long runs of scheme-like characters and colons in linear time", () => {
    const inputs = [
      "a".repeat(400_000),
      "a:".repeat(200_000),
      `${"a.".repeat(100_000)}:x`,
      "www.".repeat(100_000),
      ":/".repeat(200_000),
    ];
    for (const input of inputs) {
      const started = Date.now();
      neutralise(input, 600);
      expect(Date.now() - started).toBeLessThan(5000);
    }
  });
});

describe("Task 2 Test 5 (sanitise key parity)", () => {
  it("uses the domain list for the sanitiser report keys", () => {
    expect(SANITISE_REPORT_KEYS).toBe(SANITISE_COUNT_KEYS);
    expect(Object.keys(newReport())).toEqual([...SANITISE_COUNT_KEYS]);
  });

  it("no longer defines a separate key list in html-to-text.ts", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, "html-to-text.ts"), "utf8");
    expect(source).not.toMatch(/\[\s*"scripts"/);
    expect(source).toMatch(/SANITISE_COUNT_KEYS/);
  });

  it("keeps this test file pure ASCII", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const file of ["neutralise.test.ts", "claims.test.ts"]) {
      const text = readFileSync(join(here, file), "utf8");
      for (let i = 0; i < text.length; i += 1) {
        expect(text.charCodeAt(i), `${file} offset ${i}`).toBeLessThan(128);
      }
    }
  });
});
