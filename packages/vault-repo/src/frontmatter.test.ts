// Edge-hardening for the 02-01 serializer: determinism at the margins
// (permuted construction order, absent optional keys), body fidelity
// (unicode, a leading `---` line, Windows newlines), and the two
// deserialization-safety claims T-02-03 rests on.
//
// The safety tests assert on a SENTINEL rather than on a thrown error
// alone. "Rejected" is not the property that matters — "never evaluated"
// is. A parser that evaluates an embedded function and then rejects the
// resulting value has already lost, and only a sentinel can tell those two
// outcomes apart.

import type { NoteFrontmatter } from "@ccc/domain";
import {
  GENERATED_BY_KEY_ORDER,
  NOTE_FRONTMATTER_KEY_ORDER,
  NoteFrontmatterSchema,
} from "@ccc/domain";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  InvalidNoteFrontmatterError,
  parseNote,
  parseUntrustedFrontmatter,
  stringifyNote,
} from "./frontmatter.js";

const SENTINEL = "__cccFrontmatterEvalSentinel";

type Sentinel = Record<string, unknown>;

beforeEach(() => {
  (globalThis as Sentinel)[SENTINEL] = false;
});

afterEach(() => {
  delete (globalThis as Sentinel)[SENTINEL];
});

function evaluated(): unknown {
  return (globalThis as Sentinel)[SENTINEL];
}

/** A schema-valid frontmatter with every optional key present. */
function fullFrontmatter(): NoteFrontmatter {
  return NoteFrontmatterSchema.parse({
    id: "0000000001234567890abcdef",
    scope: "global",
    stage: "wiki",
    created: "2026-01-01T00:00:00.000Z",
    updated: "2026-01-02T00:00:00.000Z",
    generatedBy: { model: "m", skill: "s", automation: "a", runId: "r" },
    aiGenerated: true,
    claimType: "inference",
    sources: ["https://example.invalid/a"],
    confidence: "inferred",
    lastReviewed: "2026-01-03T00:00:00.000Z",
    contentHash: "f".repeat(64),
  });
}

/** A schema-valid frontmatter with every optional key ABSENT. */
function minimalFrontmatter(): NoteFrontmatter {
  return NoteFrontmatterSchema.parse({
    id: "0000000001234567890abcdef",
    scope: "global",
    stage: "capture",
    created: "2026-01-01T00:00:00.000Z",
    updated: "2026-01-01T00:00:00.000Z",
    generatedBy: {},
    aiGenerated: false,
    sources: [],
    confidence: "unverified",
    lastReviewed: null,
  });
}

/** The YAML block's top-level keys, in the order they appear on disk. */
function topLevelKeys(serialized: string): string[] {
  const block = serialized.split("---")[1] ?? "";
  return block
    .split("\n")
    .map((line) => /^([A-Za-z][A-Za-z0-9]*):/.exec(line)?.[1])
    .filter((key): key is string => key !== undefined);
}

describe("stringifyNote determinism", () => {
  test("two permutations of the same note serialize byte-identically", () => {
    // Deliberately NOT built through `NoteFrontmatterSchema.parse`: zod
    // rebuilds the object in schema order, which would erase the very
    // construction-order difference this test exists to defeat.
    const a = {
      id: "id-1",
      scope: "global",
      stage: "wiki",
      created: "2026-01-01T00:00:00.000Z",
      updated: "2026-01-01T00:00:00.000Z",
      generatedBy: { model: "m", runId: "r" },
      aiGenerated: false,
      sources: [],
      confidence: "unverified",
      lastReviewed: null,
    } as unknown as NoteFrontmatter;
    const b = {
      lastReviewed: null,
      confidence: "unverified",
      sources: [],
      aiGenerated: false,
      generatedBy: { runId: "r", model: "m" },
      updated: "2026-01-01T00:00:00.000Z",
      created: "2026-01-01T00:00:00.000Z",
      stage: "wiki",
      scope: "global",
      id: "id-1",
    } as unknown as NoteFrontmatter;

    const first = Buffer.from(stringifyNote(a, "# Body\n"), "utf8");
    const second = Buffer.from(stringifyNote(b, "# Body\n"), "utf8");

    expect(Buffer.compare(first, second)).toBe(0);
  });

  test("present keys follow NOTE_FRONTMATTER_KEY_ORDER exactly", () => {
    const keys = topLevelKeys(stringifyNote(fullFrontmatter(), "# Body\n"));

    expect(keys).toEqual([...NOTE_FRONTMATTER_KEY_ORDER]);
  });

  test("absent optional keys are omitted entirely, never emitted as null placeholders", () => {
    const serialized = stringifyNote(minimalFrontmatter(), "# Body\n");
    const keys = topLevelKeys(serialized);

    // `claimType` and `contentHash` are the two genuinely optional keys.
    // `lastReviewed: null` IS present on purpose — null there positively
    // records "never reviewed", which is a different claim from absence.
    expect(keys).not.toContain("claimType");
    expect(keys).not.toContain("contentHash");
    expect(serialized).not.toMatch(/^claimType:/m);
    expect(serialized).not.toMatch(/^contentHash:/m);
    expect(serialized).not.toMatch(/undefined/);
    expect(keys).toContain("lastReviewed");
    expect(serialized).toMatch(/^lastReviewed: null$/m);
  });

  test("an empty generatedBy map emits no subfield placeholders", () => {
    const serialized = stringifyNote(minimalFrontmatter(), "# Body\n");

    for (const subKey of GENERATED_BY_KEY_ORDER) {
      expect(serialized).not.toMatch(new RegExp(`^\\s+${subKey}:`, "m"));
    }
  });
});

describe("stringifyNote/parseNote body fidelity", () => {
  test("a unicode body with emoji and CJK round-trips byte-for-byte", () => {
    const body = "# 目標 🚀\n\n日本語のテキスト — dash, ellipsis …, emoji 🎉🇯🇵\n";

    const parsed = parseNote(stringifyNote(fullFrontmatter(), body));

    expect(parsed.body).toBe(body);
    expect(Buffer.from(parsed.body, "utf8")).toEqual(Buffer.from(body, "utf8"));
  });

  test("a body whose first line is --- round-trips without being swallowed into the frontmatter", () => {
    // A Markdown thematic break, or a fenced YAML example, legitimately
    // starts a body with `---`. If the serializer re-parses the body as if
    // it were its own front matter, the body is destroyed AND its
    // characters land in the frontmatter as forged keys.
    const body = "---\nnot frontmatter, just a body that starts with a rule\n";

    const serialized = stringifyNote(fullFrontmatter(), body);
    const parsed = parseNote(serialized);

    expect(parsed.body).toBe(body);
    expect(parsed.frontmatter.id).toBe("0000000001234567890abcdef");
    // No character-indexed junk keys smuggled in from the body.
    expect(topLevelKeys(serialized)).toEqual([...NOTE_FRONTMATTER_KEY_ORDER]);
  });

  test("a body with Windows newlines keeps its CRLF line endings", () => {
    const body = "line one\r\nline two\r\n";

    const parsed = parseNote(stringifyNote(fullFrontmatter(), body));

    expect(parsed.body).toBe(body);
    expect(parsed.body).toContain("\r\n");
  });

  test("a body with no trailing newline gains exactly one — the single documented normalization", () => {
    const parsed = parseNote(stringifyNote(fullFrontmatter(), "no trailing newline"));

    expect(parsed.body).toBe("no trailing newline\n");
  });
});

describe("parseNote deserialization safety", () => {
  test("a !!js/function YAML tag is refused and never evaluated", () => {
    const raw = [
      "---",
      "id: id-1",
      "scope: global",
      "stage: wiki",
      `pwn: !!js/function "function(){ globalThis['${SENTINEL}'] = 'yaml-tag'; return 1; }"`,
      "---",
      "body",
      "",
    ].join("\n");

    expect(() => parseNote(raw)).toThrow();
    // The load-bearing assertion: the tag was inert, not merely rejected
    // after the fact.
    expect(evaluated()).toBe(false);
  });

  test("a ---js language-tagged delimiter is refused and never evaluated", () => {
    const raw = `---js\n{ pwn: (globalThis['${SENTINEL}'] = 'js-delimiter') }\n---\nbody\n`;

    expect(() => parseNote(raw)).toThrow(InvalidNoteFrontmatterError);
    expect(evaluated()).toBe(false);
  });

  test("a ---javascript language-tagged delimiter is refused and never evaluated", () => {
    const raw = `---javascript\n{ pwn: (globalThis['${SENTINEL}'] = 'javascript-delimiter') }\n---\nbody\n`;

    expect(() => parseNote(raw)).toThrow(InvalidNoteFrontmatterError);
    expect(evaluated()).toBe(false);
  });

  test("a language tag hidden behind a BOM, whitespace or capitals is refused too", () => {
    const variants = [
      `﻿---js\n{ pwn: (globalThis['${SENTINEL}'] = 'bom') }\n---\nbody\n`,
      `--- js\n{ pwn: (globalThis['${SENTINEL}'] = 'space') }\n---\nbody\n`,
      `---\tjs\n{ pwn: (globalThis['${SENTINEL}'] = 'tab') }\n---\nbody\n`,
      `---JS\n{ pwn: (globalThis['${SENTINEL}'] = 'caps') }\n---\nbody\n`,
      `---js\r\n{ pwn: (globalThis['${SENTINEL}'] = 'crlf') }\r\n---\r\nbody\r\n`,
    ];

    for (const raw of variants) {
      expect(() => parseNote(raw)).toThrow(InvalidNoteFrontmatterError);
    }
    expect(evaluated()).toBe(false);
  });

  test("a plain --- delimiter and an explicit ---yaml delimiter both still parse", () => {
    const serialized = stringifyNote(minimalFrontmatter(), "# Body\n");

    expect(parseNote(serialized).frontmatter.stage).toBe("capture");
    expect(parseNote(serialized.replace(/^---/, "---yaml")).frontmatter.stage).toBe("capture");
  });

  test("frontmatter missing required keys throws InvalidNoteFrontmatterError naming each one", () => {
    const raw = "---\nid: id-1\n---\nbody\n";

    let thrown: unknown;
    try {
      parseNote(raw);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(InvalidNoteFrontmatterError);
    const paths = (thrown as InvalidNoteFrontmatterError).issues.map((issue) =>
      String((issue as { path?: unknown[] }).path?.[0]),
    );
    expect(paths).toContain("scope");
    expect(paths).toContain("stage");
    expect(paths).toContain("confidence");
  });
});

// The read-modify-write round trip. `NoteFrontmatterSchema` strips unknown
// keys, so a caller that parsed a note and re-serialized it would delete
// every key the user put there. The plugin-side writer had exactly that
// defect; these hold the service-side pair to the same contract before any
// service path gains a read-modify-write.
describe("user-authored frontmatter keys survive a parse/stringify round trip", () => {
  const USER_KEYS = ["tags:", "  - research", "aliases:", "  - The Note", "cssclasses: wide"];

  function noteWithUserKeys(): string {
    const serialized = stringifyNote(fullFrontmatter(), "# Body\n");
    return serialized.replace(/\n---\n/, `\n${USER_KEYS.join("\n")}\n---\n`);
  }

  test("parseNote returns them separately rather than discarding them", () => {
    const parsed = parseNote(noteWithUserKeys());

    expect(parsed.passthrough).toEqual({
      tags: ["research"],
      aliases: ["The Note"],
      cssclasses: "wide",
    });
    // And they are absent from the validated value, which is what makes
    // carrying them separately necessary rather than merely tidy.
    expect(Object.keys(parsed.frontmatter)).not.toContain("tags");
  });

  test("stringifyNote re-emits them after the managed block, in read order", () => {
    const parsed = parseNote(noteWithUserKeys());

    const round = stringifyNote(parsed.frontmatter, parsed.body, parsed.passthrough);

    expect(topLevelKeys(round)).toEqual([
      ...NOTE_FRONTMATTER_KEY_ORDER,
      "tags",
      "aliases",
      "cssclasses",
    ]);
    expect(parseNote(round).passthrough).toEqual(parsed.passthrough);
    expect(parseNote(round).body).toBe(parsed.body);
  });

  test("passthrough can neither forge nor override a schema-owned key", () => {
    const forged = stringifyNote(minimalFrontmatter(), "# Body\n", {
      id: "forged",
      stage: "deliverable",
      tags: ["kept"],
    });

    expect(parseNote(forged).frontmatter.id).toBe("0000000001234567890abcdef");
    expect(parseNote(forged).frontmatter.stage).toBe("capture");
    expect(parseNote(forged).passthrough).toEqual({ tags: ["kept"] });
  });

  test("omitting the argument leaves the managed-only output byte-identical", () => {
    expect(stringifyNote(fullFrontmatter(), "# Body\n", {})).toBe(
      stringifyNote(fullFrontmatter(), "# Body\n"),
    );
  });
});

// The identity read-back in `index-generation.ts` parses a file whose
// frontmatter is NOT `NoteFrontmatterSchema`-shaped, so it cannot go
// through `parseNote`. These assert that the escape hatch it does use
// carries the same two defences — the omission of exactly this coverage is
// what let a bare `matter(raw)` survive in that module.
describe("parseUntrustedFrontmatter", () => {
  test("a ---js language-tagged delimiter is refused and never evaluated", () => {
    const raw = `---js\n{ pwn: (globalThis['${SENTINEL}'] = 'index-identity') }\n---\nbody\n`;

    expect(() => parseUntrustedFrontmatter(raw)).toThrow(InvalidNoteFrontmatterError);
    expect(evaluated()).toBe(false);
  });

  test("every spelling of the language tag is refused, and a !!js/function tag is inert", () => {
    const variants = [
      `﻿---js\n{ pwn: (globalThis['${SENTINEL}'] = 'bom') }\n---\nbody\n`,
      `--- js\n{ pwn: (globalThis['${SENTINEL}'] = 'space') }\n---\nbody\n`,
      `---\tjs\n{ pwn: (globalThis['${SENTINEL}'] = 'tab') }\n---\nbody\n`,
      `---JAVASCRIPT\n{ pwn: (globalThis['${SENTINEL}'] = 'caps') }\n---\nbody\n`,
      `---js\r\n{ pwn: (globalThis['${SENTINEL}'] = 'crlf') }\r\n---\r\nbody\r\n`,
    ];

    for (const raw of variants) {
      expect(() => parseUntrustedFrontmatter(raw)).toThrow(InvalidNoteFrontmatterError);
    }

    const yamlTag = [
      "---",
      "type: index",
      `pwn: !!js/function "function(){ globalThis['${SENTINEL}'] = 'yaml-tag'; return 1; }"`,
      "---",
      "body",
      "",
    ].join("\n");
    expect(() => parseUntrustedFrontmatter(yamlTag)).toThrow();
    expect(evaluated()).toBe(false);
  });

  test("an ordinary index frontmatter block still parses, unvalidated", () => {
    const raw = "---\ntype: index\nfolder: global/wiki\nworkspaceId: w1\n---\n# Index\n";

    expect(parseUntrustedFrontmatter(raw)).toEqual({
      type: "index",
      folder: "global/wiki",
      workspaceId: "w1",
    });
  });
});

describe("stringifyNote write-time safety", () => {
  test("a body whose first line is a ---js delimiter is written verbatim, never evaluated", () => {
    // The write path takes bodies from research capture, imported
    // Markdown and email — ADR-0014's untrusted-content boundary. A
    // serializer that re-parses its own body argument turns that content
    // into code at WRITE time, before any reader is involved.
    const body = `---js\n{ pwn: (globalThis['${SENTINEL}'] = 'write-time') }\n---\nbody\n`;

    const serialized = stringifyNote(fullFrontmatter(), body);

    expect(evaluated()).toBe(false);
    expect(parseNote(serialized).body).toBe(body);
    expect(topLevelKeys(serialized)).toEqual([...NOTE_FRONTMATTER_KEY_ORDER]);
  });
});
