// The normalized source reference (plan 07-03 task 1; D-11, RSRCH-03, research
// Pattern 4, threat T-07-07). The schema is strict: exactly the PRD 10.1 fields,
// exactly one address, and ids and paths that cannot express a traversal.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ACCESS_CLASS_DISPLAY,
  ACCESS_CLASSES,
  CONTENT_HASH_PATTERN,
  DEEP_LINK_SCHEMES,
  RAW_SNAPSHOT_PATH_PATTERN,
  rawSnapshotPathFor,
  SOURCE_ID_PATTERN,
  SOURCE_REFERENCE_FIELDS,
  SOURCE_TYPE_DISPLAY,
  SOURCE_TYPES,
  SourceReferenceSchema,
} from "./source-reference.js";

const ID = "0123456789abcdef0123456789abcdef";
const HASH = "a".repeat(64);

function feedEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sourceType: "feed-entry",
    id: ID,
    title: "Release 1.2.3",
    canonicalUrl: "https://example.org/releases/1.2.3",
    author: "A. Maintainer",
    publishedAt: "2026-10-12T08:00:00Z",
    retrievedAt: "2026-10-13T09:00:00Z",
    contentHash: HASH,
    snapshotPath: `global/raw/${ID}.aaaaaaaa.md`,
    accessClass: "public",
    ...overrides,
  };
}

function privateNote(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const { canonicalUrl: _drop, ...rest } = feedEntry();
  return {
    ...rest,
    sourceType: "note",
    deepLink: "obsidian://open?vault=x&file=y",
    accessClass: "private",
    ...overrides,
  };
}

function parses(value: Record<string, unknown>): boolean {
  return SourceReferenceSchema.safeParse(value).success;
}

describe("Test 1 (reference shape)", () => {
  it("parses a full public feed-entry reference", () => {
    expect(parses(feedEntry())).toBe(true);
  });

  it("parses a private reference with a deep link and no canonical address", () => {
    expect(parses(privateNote())).toBe(true);
  });

  it("carries exactly the PRD 10.1 fields", () => {
    expect(SOURCE_REFERENCE_FIELDS).toEqual([
      "sourceType",
      "id",
      "title",
      "canonicalUrl",
      "deepLink",
      "author",
      "publishedAt",
      "retrievedAt",
      "contentHash",
      "snapshotPath",
      "accessClass",
    ]);
  });

  it("rejects an extra key", () => {
    expect(parses(feedEntry({ summary: "x" }))).toBe(false);
  });

  it("rejects both addresses and neither address", () => {
    expect(parses(feedEntry({ deepLink: "obsidian://open?vault=x&file=y" }))).toBe(false);
    const { canonicalUrl: _drop, ...none } = feedEntry();
    expect(parses(none)).toBe(false);
  });

  it("rejects a malformed id: uppercase, 31 characters, 33 characters, non-hex, a path", () => {
    for (const id of [
      ID.toUpperCase(),
      ID.slice(1),
      `${ID}0`,
      `${ID.slice(2)}zz`,
      "../../../../etc/passwd/xxxxxxxxxx",
    ]) {
      expect(parses(feedEntry({ id })), id).toBe(false);
    }
  });

  it("rejects a 63-character hash, an uppercase hash and a non-hex hash", () => {
    for (const contentHash of ["a".repeat(63), "A".repeat(64), `${"a".repeat(63)}g`, `${HASH}a`]) {
      expect(parses(feedEntry({ contentHash })), contentHash).toBe(false);
    }
  });

  it("rejects a snapshot path outside global/raw, with a traversal, or of the wrong shape", () => {
    for (const snapshotPath of [
      `global/wiki/${ID}.aaaaaaaa.md`,
      `global/raw/../wiki/${ID}.aaaaaaaa.md`,
      `global/raw/${ID}.aaaaaaaa.md/..`,
      `../global/raw/${ID}.aaaaaaaa.md`,
      `/global/raw/${ID}.aaaaaaaa.md`,
      `global/raw/${ID}.aaaaaaa.md`,
      `global/raw/${ID}.AAAAAAAA.md`,
      `global/raw/${ID}.aaaaaaaa.txt`,
      `workspaces/abcdefghi0123456789abcdef/raw/${ID}.aaaaaaaa.md`,
      `global\\raw\\${ID}.aaaaaaaa.md`,
    ]) {
      expect(parses(feedEntry({ snapshotPath })), snapshotPath).toBe(false);
    }
  });

  it("rejects canonical addresses that are not plain https", () => {
    for (const canonicalUrl of [
      "http://example.org/releases",
      "ftp://example.org/x",
      "javascript:alert(1)",
      "data:text/html,x",
      "https://user:pw@example.org/",
      "https://example.org/a b",
      "https://example.org/\n",
      "not a url",
      "",
    ]) {
      expect(parses(feedEntry({ canonicalUrl })), canonicalUrl).toBe(false);
    }
  });

  it("accepts only the reserved deep link schemes", () => {
    expect(DEEP_LINK_SCHEMES).toEqual(["obsidian"]);
    for (const deepLink of [
      "https://example.org/",
      "javascript:alert(1)",
      "file:///etc/passwd",
      "obsidian:/open",
      "obsidian://open?vault=x y",
    ]) {
      expect(parses(privateNote({ deepLink })), deepLink).toBe(false);
    }
  });

  it("exports the id, hash and path patterns", () => {
    expect(SOURCE_ID_PATTERN.test(ID)).toBe(true);
    expect(SOURCE_ID_PATTERN.test(ID.toUpperCase())).toBe(false);
    expect(CONTENT_HASH_PATTERN.test(HASH)).toBe(true);
    expect(RAW_SNAPSHOT_PATH_PATTERN.test(`global/raw/${ID}.aaaaaaaa.md`)).toBe(true);
    expect(RAW_SNAPSHOT_PATH_PATTERN.test(`global/raw/${ID}.aaaaaaaa.md\n`)).toBe(false);
  });

  it("derives the snapshot path from the id and the first eight hash characters", () => {
    expect(rawSnapshotPathFor(ID, HASH)).toBe(`global/raw/${ID}.aaaaaaaa.md`);
    expect(
      RAW_SNAPSHOT_PATH_PATTERN.test(rawSnapshotPathFor(ID, "0123456789abcdef".repeat(4))),
    ).toBe(true);
    expect(() => rawSnapshotPathFor("../x", HASH)).toThrow(RangeError);
    expect(() => rawSnapshotPathFor(ID, "zz")).toThrow(RangeError);
  });
});

describe("Test 2 (nullable facts)", () => {
  it("accepts a null author and a null published instant", () => {
    expect(parses(feedEntry({ author: null, publishedAt: null }))).toBe(true);
  });

  it("requires the author and published keys to be present", () => {
    const { author: _a, ...noAuthor } = feedEntry();
    expect(parses(noAuthor)).toBe(false);
    const { publishedAt: _p, ...noPublished } = feedEntry();
    expect(parses(noPublished)).toBe(false);
  });

  it("requires ISO instants for the published and retrieved times", () => {
    for (const key of ["publishedAt", "retrievedAt"]) {
      for (const bad of ["yesterday", "2026-10-12", "2026-10-12 08:00:00", 1760256000000, ""]) {
        expect(parses(feedEntry({ [key]: bad })), `${key}=${String(bad)}`).toBe(false);
      }
    }
    expect(parses(feedEntry({ retrievedAt: null }))).toBe(false);
  });

  it("holds the title to 1 to 200 characters with no control, format or separator character", () => {
    expect(parses(feedEntry({ title: "x" }))).toBe(true);
    expect(parses(feedEntry({ title: "x".repeat(200) }))).toBe(true);
    expect(parses(feedEntry({ title: "" }))).toBe(false);
    expect(parses(feedEntry({ title: "   " }))).toBe(false);
    expect(parses(feedEntry({ title: "x".repeat(201) }))).toBe(false);
    for (const code of [0x0a, 0x00, 0x1b, 0x202e, 0x200b, 0xfeff, 0x2028, 0x2029, 0xad]) {
      const title = `a${String.fromCodePoint(code)}b`;
      expect(parses(feedEntry({ title })), `U+${code.toString(16)}`).toBe(false);
    }
  });
});

describe("Test 3a (source vocabularies)", () => {
  it("starts the source types with feed-entry and web-page and keeps the reserved ones after", () => {
    expect(SOURCE_TYPES.slice(0, 2)).toEqual(["feed-entry", "web-page"]);
    expect([...SOURCE_TYPES]).toEqual(["feed-entry", "web-page", "email", "note", "repository"]);
    expect(SOURCE_TYPE_DISPLAY["feed-entry"]).toBe("Feed entry");
    expect(SOURCE_TYPE_DISPLAY["web-page"]).toBe("Web page");
    expect(Object.keys(SOURCE_TYPE_DISPLAY).sort()).toEqual([...SOURCE_TYPES].sort());
    for (const sourceType of SOURCE_TYPES) {
      expect(parses(feedEntry({ sourceType })), sourceType).toBe(true);
    }
    expect(parses(feedEntry({ sourceType: "tweet" }))).toBe(false);
  });

  it("has exactly the three access classes with the UI-SPEC label and explanation", () => {
    expect([...ACCESS_CLASSES]).toEqual(["public", "private", "sensitive"]);
    expect(ACCESS_CLASS_DISPLAY).toEqual({
      public: { label: "Public", explanation: "Fetched from a public web address." },
      private: {
        label: "Private",
        explanation: "Comes from your own vault or accounts. Stays on this Mac.",
      },
      sensitive: {
        label: "Sensitive",
        explanation: "Personal content. Stays on this Mac and is never sent to the summariser.",
      },
    });
    for (const accessClass of ACCESS_CLASSES) {
      expect(parses(feedEntry({ accessClass })), accessClass).toBe(true);
    }
    expect(parses(feedEntry({ accessClass: "secret" }))).toBe(false);
  });
});

describe("Node-free", () => {
  it("imports no node: module", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, "source-reference.ts"), "utf8");
    expect(source).not.toMatch(/from\s+["']node:/);
    expect(source).not.toMatch(/import\(\s*["']node:/);
  });
});
