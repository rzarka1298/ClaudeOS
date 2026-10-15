// Plan 07-08, task 1 (tracer): the report note is written as a deliverable, finalised in place as
// output, and read back from validated frontmatter. Hostile strings are pure ASCII.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  REPORT_FILE_MAX_BYTES,
  REPORT_FRONTMATTER_KEY_ORDER,
  REPORT_FRONTMATTER_MAX_BYTES,
  REPORT_ITEM_KIND_DISPLAY,
  REPORT_ITEM_KINDS,
  ReportFrontmatterSchema,
  type ReportItem,
  SOURCE_FAILURE_DISPLAY,
  type SourceReference,
} from "@ccc/domain";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { escapeMarkdownText } from "./markdown-escape.js";
import {
  finaliseReportNote,
  parseReportNote,
  ReportNoteError,
  readReportNote,
  reportNotePathFor,
  type WriteReportNoteOptions,
  writeReportNote,
} from "./report-note.js";
import { initializeVault } from "./setup.js";
import { WorkspaceScopeViolationError } from "./workspace-scope.js";

const TEST_BASE = join(homedir(), ".ccc-test");
const NOW = new Date("2026-10-15T09:00:00.000Z");
const LATER = new Date("2026-10-15T09:00:05.000Z");
const RUN_ID = "r0123456789abcdefghijklmn";
const ID_A = "0123456789abcdef0123456789abcdef";
const ID_B = "fedcba9876543210fedcba9876543210";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

let vaultRoot: string;

beforeEach(() => {
  mkdirSync(TEST_BASE, { recursive: true });
  vaultRoot = mkdtempSync(join(TEST_BASE, "vreport-"));
  initializeVault(vaultRoot);
});

afterEach(() => {
  rmSync(vaultRoot, { recursive: true, force: true });
});

function ref(id: string, hash: string, extra: Partial<SourceReference> = {}): SourceReference {
  return {
    sourceType: "web-page",
    id,
    title: `Title of ${id.slice(0, 4)}`,
    canonicalUrl: `https://news.example/${id.slice(0, 4)}`,
    author: null,
    publishedAt: null,
    retrievedAt: "2026-10-15T08:59:00.000Z",
    contentHash: hash,
    snapshotPath: `global/raw/${id}.${hash.slice(0, 8)}.md`,
    accessClass: "public",
    ...extra,
  };
}

const SOURCE_REFS = [ref(ID_A, HASH_A), ref(ID_B, HASH_B, { sourceType: "feed-entry" })];

function item(kind: ReportItem["kind"], extra: Partial<ReportItem> = {}): ReportItem {
  return {
    kind,
    text: `A finding of kind ${kind}.`,
    citedSourceIds: kind === "inference" ? [] : [ID_A],
    ...extra,
  };
}

const ITEMS: ReportItem[] = [
  item("source-fact", { quote: "the quoted words from the source" }),
  item("unverified-claim", { citedSourceIds: [ID_B], quote: "another quoted passage here" }),
  item("inference"),
];

function options(extra: Partial<WriteReportNoteOptions> = {}): WriteReportNoteOptions {
  return {
    vaultRoot,
    topicLabel: "Daily tech",
    generatedAt: "2026-10-15T08:59:30.000Z",
    jobRunId: RUN_ID,
    summariser: "claude-haiku-5-5",
    sourceTotal: 3,
    unavailableSources: [{ label: "Slow feed", code: "timeout" }],
    sourceRefs: SOURCE_REFS,
    sourceHandling: [
      {
        sourceId: ID_A,
        counts: {
          scripts: 1,
          styles: 0,
          comments: 2,
          hiddenBlocks: 0,
          mediaDropped: 3,
          linksDropped: 0,
          controlChars: 0,
          commandLikeLines: 0,
        },
      },
    ],
    items: ITEMS,
    runNotePath: `automation-runs/${RUN_ID}.md`,
    now: NOW,
    ...extra,
  };
}

function frontmatterLines(text: string): string[] {
  const lines = text.split("\n");
  return lines.slice(1, lines.indexOf("---", 1));
}

function topLevelKeys(text: string): string[] {
  return frontmatterLines(text)
    .filter((line) => /^[A-Za-z_][A-Za-z0-9_]*:/.test(line))
    .map((line) => line.slice(0, line.indexOf(":")));
}

function bodyOf(text: string): string {
  const lines = text.split("\n");
  return lines.slice(lines.indexOf("---", 1) + 1).join("\n");
}

const ASCII_PUNCTUATION = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";

function commonMarkUnescape(escaped: string): string | null {
  let out = "";
  for (let i = 0; i < escaped.length; i++) {
    const ch = escaped.charAt(i);
    if (ch === "\\") {
      const next = escaped.charAt(i + 1);
      if (next === "" || !ASCII_PUNCTUATION.includes(next)) return null;
      out += next;
      i += 1;
    } else if (ASCII_PUNCTUATION.includes(ch)) {
      return null;
    } else {
      out += ch;
    }
  }
  return out;
}

/** The body with every escaped pair and every inline code span removed: only active syntax is left. */
function activeSyntaxOf(body: string): string {
  return body.replace(/\\[!-/:-@[-`{-~]/g, "").replace(/(`+) [^\n]*? \1(?!`)/g, "");
}

describe("Test 1 (tracer): deliverable, then output, then read back", () => {
  test("writes the report in global/output as a deliverable with valid frontmatter in key order", () => {
    const written = writeReportNote(options());
    expect(written.path).toBe(`global/output/research-2026-10-15-${RUN_ID}.md`);
    expect(written.path).toBe(reportNotePathFor("2026-10-15T08:59:30.000Z", RUN_ID));
    expect(written.frontmatter.stage).toBe("deliverable");
    const text = readFileSync(written.absolutePath, "utf8");
    const parsed = parseReportNote(text);
    expect(ReportFrontmatterSchema.safeParse(parsed.frontmatter).success).toBe(true);
    expect(parsed.frontmatter.stage).toBe("deliverable");
    expect(parsed.frontmatter.type).toBe("report");
    expect(parsed.frontmatter.claimType).toBe("summary");
    expect(parsed.frontmatter.aiGenerated).toBe(true);
    expect(parsed.frontmatter.partial).toBe(true);
    expect(parsed.frontmatter.generatedBy.automation).toBe("research.daily-tech");
    expect(parsed.frontmatter.generatedBy.runId).toBe(RUN_ID);
    expect(parsed.frontmatter.sources).toEqual([ID_A, ID_B]);
    const expectedKeys = REPORT_FRONTMATTER_KEY_ORDER.filter(
      (key) => (parsed.frontmatter as unknown as Record<string, unknown>)[key] !== undefined,
    );
    expect(topLevelKeys(text)).toEqual(expectedKeys);
    expect(parsed.frontmatter.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("finalise rewrites the same path as output and changes only stage and updated", () => {
    const written = writeReportNote(options());
    const before = readFileSync(written.absolutePath, "utf8");
    const final = finaliseReportNote({ vaultRoot, path: written.path, now: LATER });
    expect(final.path).toBe(written.path);
    expect(final.frontmatter.stage).toBe("output");
    const after = readFileSync(written.absolutePath, "utf8");
    const expected = before
      .replace("stage: deliverable\n", "stage: output\n")
      .replace(/^updated: .*$/m, `updated: '${LATER.toISOString()}'`);
    expect(after).toBe(expected);
    expect(after).not.toBe(before);
    // The same file name only: no rename, no second file.
    expect(existsSync(join(vaultRoot, written.path))).toBe(true);
    expect(parseReportNote(after).frontmatter.id).toBe(parseReportNote(before).frontmatter.id);
  });

  test("finalise never leaves the report absent: the path exists at every observation", () => {
    const written = writeReportNote(options());
    finaliseReportNote({ vaultRoot, path: written.path, now: LATER });
    expect(statSync(written.absolutePath).isFile()).toBe(true);
  });

  test("finalising an output report again changes nothing", () => {
    const written = writeReportNote(options());
    finaliseReportNote({ vaultRoot, path: written.path, now: LATER });
    const once = readFileSync(written.absolutePath, "utf8");
    finaliseReportNote({
      vaultRoot,
      path: written.path,
      now: new Date("2026-10-16T00:00:00.000Z"),
    });
    expect(readFileSync(written.absolutePath, "utf8")).toBe(once);
  });

  test("keeps keys the schema does not own when finalising", () => {
    const written = writeReportNote(options());
    const text = readFileSync(written.absolutePath, "utf8");
    const edited = text.replace("\n---\n", "\ntags:\n  - mine\n---\n");
    writeFileSync(written.absolutePath, edited);
    finaliseReportNote({ vaultRoot, path: written.path, now: LATER });
    expect(readFileSync(written.absolutePath, "utf8")).toContain("tags:\n  - mine\n");
  });

  test("readReportNote returns the validated frontmatter that was written", () => {
    const written = writeReportNote(options());
    const read = readReportNote(vaultRoot, written.path);
    expect(read.readable).toBe(true);
    if (!read.readable) return;
    expect(read.frontmatter).toEqual(written.frontmatter);
    expect(read.frontmatter.items).toEqual(ITEMS);
    expect(read.frontmatter.sourceRefs).toEqual(SOURCE_REFS);
    expect(read.frontmatter.topicLabel).toBe("Daily tech");
    expect(read.frontmatter.unavailableSources).toEqual([{ label: "Slow feed", code: "timeout" }]);
  });

  test("a report with no unavailable source is not partial", () => {
    const written = writeReportNote(options({ unavailableSources: [], sourceTotal: 2 }));
    expect(written.frontmatter.partial).toBe(false);
    expect(readFileSync(written.absolutePath, "utf8")).not.toContain("Unavailable sources");
  });

  test("the extractive summariser leaves generatedBy.model absent", () => {
    const written = writeReportNote(options({ summariser: "extractive" }));
    expect(written.frontmatter.generatedBy.model).toBeUndefined();
    expect(readFileSync(written.absolutePath, "utf8")).toContain(
      "the extractive summariser (no model)",
    );
  });
});

describe("Test 2: determinism", () => {
  test("writing the same report twice with the same clock produces byte-identical files", () => {
    const first = writeReportNote(options());
    const bytesOne = readFileSync(first.absolutePath, "utf8");
    const second = writeReportNote(options());
    expect(second.path).toBe(first.path);
    expect(second.frontmatter.id).toBe(first.frontmatter.id);
    expect(readFileSync(second.absolutePath, "utf8")).toBe(bytesOne);
  });

  test("the file name comes from the generation date and the run id only", () => {
    const hostile = options({
      topicLabel: "../../etc/passwd <b>",
      items: [item("inference", { text: "../x" })],
    });
    const written = writeReportNote(hostile);
    expect(written.path).toBe(`global/output/research-2026-10-15-${RUN_ID}.md`);
    expect(() => reportNotePathFor("not a date", RUN_ID)).toThrow(RangeError);
    expect(() => reportNotePathFor("2026-10-15T08:59:30.000Z", "../x")).toThrow(RangeError);
  });

  test("a different clock changes updated only", () => {
    const first = writeReportNote(options());
    const one = readFileSync(first.absolutePath, "utf8");
    writeReportNote(options({ now: LATER }));
    const two = readFileSync(first.absolutePath, "utf8");
    expect(two.replace(/^updated: .*$/m, "")).toBe(one.replace(/^updated: .*$/m, ""));
  });
});

describe("Test 3: the body carries the labels", () => {
  test("every kind shows its label and glyph from the shared display map", () => {
    const written = writeReportNote(options());
    const body = bodyOf(readFileSync(written.absolutePath, "utf8"));
    for (const kind of REPORT_ITEM_KINDS) {
      const display = REPORT_ITEM_KIND_DISPLAY[kind];
      expect(body).toContain(`${display.glyph} **${display.label}**`);
      expect(body).toContain(display.meaning);
    }
  });

  test("the title, the AI line, the partial notice and the failure phrase are present", () => {
    const written = writeReportNote(options());
    const body = bodyOf(readFileSync(written.absolutePath, "utf8"));
    expect(body).toContain("# Daily tech — Oct 15, 2026");
    expect(body).toContain(
      "AI-generated summary by ` claude-haiku-5-5 `. Not verified by a person.",
    );
    expect(body).toContain("## Unavailable sources");
    expect(body).toContain("1 of 3 sources were unavailable, so this report covers only the rest.");
    expect(body).toContain(`Slow feed — ${SOURCE_FAILURE_DISPLAY.timeout}`);
    expect(body).toContain("## How to read this report");
    expect(body).toContain("## Findings");
    expect(body).toContain("## Sources");
    expect(body.indexOf("## Unavailable sources")).toBeLessThan(body.indexOf("## Findings"));
  });

  test("citations number the sources in sourceRefs order and the Sources list matches", () => {
    const written = writeReportNote(options());
    const body = bodyOf(readFileSync(written.absolutePath, "utf8"));
    expect(body).toContain("Sources: \\[1\\]");
    expect(body).toContain("Sources: \\[2\\]");
    expect(body).toContain("No source cited");
    const sources = body.slice(body.indexOf("## Sources"));
    expect(sources.indexOf("1. ")).toBeLessThan(sources.indexOf("2. "));
    expect(sources).toContain(escapeMarkdownText(SOURCE_REFS[0]?.title ?? ""));
    expect(sources).toContain(escapeMarkdownText(SOURCE_REFS[1]?.title ?? ""));
    expect(sources).toContain(`\` global/raw/${ID_A}.${HASH_A.slice(0, 8)}.md \``);
    // Sanitise counts come from the structured handling entry.
    expect(sources).toContain("scripts 1");
    expect(sources).toContain("comments 2");
  });

  test("the run note path appears as code, not as a link", () => {
    const written = writeReportNote(options());
    const body = bodyOf(readFileSync(written.absolutePath, "utf8"));
    expect(body).toContain(`\` automation-runs/${RUN_ID}.md \``);
    expect(body).not.toContain("[[");
  });

  test("a run note path that is not under automation-runs is refused", () => {
    expect(() => writeReportNote(options({ runNotePath: "../../outside.md" }))).toThrow(
      ReportNoteError,
    );
    expect(() => writeReportNote(options({ runNotePath: "global/output/x.md" }))).toThrow(
      ReportNoteError,
    );
  });
});

describe("Test 4: escaping", () => {
  const HOSTILE_TEXT =
    "![x](https://e.example/p.png) [[secret]] ![[secret]] <img src=x> #tag %%c%% $x$ > [!note]";

  test("item text and quote are backslash-escaped, one line each, under the fixed caption", () => {
    const written = writeReportNote(
      options({
        items: [
          item("source-fact", { text: HOSTILE_TEXT, quote: HOSTILE_TEXT }),
          item("unverified-claim", {
            text: "[[Private]]",
            quote: "![x](https://evil.example/p.png)",
          }),
        ],
        unavailableSources: [],
        sourceTotal: 2,
      }),
    );
    const body = bodyOf(readFileSync(written.absolutePath, "utf8"));
    const escaped = escapeMarkdownText(HOSTILE_TEXT);
    expect(body).toContain(`\n${escaped}\n`);
    expect(body).toContain(`Quoted from source 1:\n\n> ${escaped}\n`);
    expect(commonMarkUnescape(escaped)).toBe(HOSTILE_TEXT);
    expect(body).toContain(`\n${escapeMarkdownText("[[Private]]")}\n`);
    expect(body).toContain(`> ${escapeMarkdownText("![x](https://evil.example/p.png)")}\n`);
    const active = activeSyntaxOf(body);
    expect(active).not.toContain("![");
    expect(active).not.toContain("[[");
    expect(active).not.toContain("](");
    expect(active).not.toContain("<");
    expect(active).not.toContain("%%");
    expect(active).not.toContain("$");
  });

  test("untrusted topic, source titles, authors and unavailable labels are escaped too", () => {
    const bad = "![t](https://evil.example/t.png) [[Private]] <b>";
    const written = writeReportNote(
      options({
        topicLabel: bad,
        unavailableSources: [{ label: bad, code: "dns-failure" }],
        sourceRefs: [ref(ID_A, HASH_A, { title: bad, author: bad }), ref(ID_B, HASH_B)],
      }),
    );
    const body = bodyOf(readFileSync(written.absolutePath, "utf8"));
    expect(body).toContain(escapeMarkdownText(bad));
    const active = activeSyntaxOf(body);
    expect(active).not.toContain("![");
    expect(active).not.toContain("[[");
    expect(active).not.toContain("<");
  });

  test("a canonical URL is inline code with a fence longer than any backtick run inside it", () => {
    const url = "https://news.example/a`b``c```d";
    const written = writeReportNote(
      options({ sourceRefs: [ref(ID_A, HASH_A, { canonicalUrl: url }), ref(ID_B, HASH_B)] }),
    );
    const body = bodyOf(readFileSync(written.absolutePath, "utf8"));
    expect(body).toContain(`\`\`\`\` ${url} \`\`\`\``);
    expect(body).not.toContain(`](${url}`);
    expect(body).not.toContain(`<${url}>`);
  });

  test("a private deep link is shown as code and never as a link", () => {
    const written = writeReportNote(
      options({
        sourceRefs: [
          ref(ID_A, HASH_A, {
            canonicalUrl: undefined,
            deepLink: "obsidian://open?vault=v&file=x",
            accessClass: "private",
          }),
          ref(ID_B, HASH_B),
        ],
      }),
    );
    const body = bodyOf(readFileSync(written.absolutePath, "utf8"));
    expect(body).toContain("` obsidian://open?vault=v&file=x `");
  });

  test("a body that begins like a delimiter or a language tag is only text", () => {
    const written = writeReportNote(options({ topicLabel: "---js" }));
    const text = readFileSync(written.absolutePath, "utf8");
    expect(text.startsWith("---\n")).toBe(true);
    expect(parseReportNote(text).frontmatter.topicLabel).toBe("---js");
  });

  test("the writer accepts structured fields only: a frontmatter that fails the schema throws before writing", () => {
    expect(() =>
      writeReportNote(options({ items: [item("source-fact", { citedSourceIds: [] })] })),
    ).toThrow();
    expect(() =>
      writeReportNote(
        options({ items: [item("inference", { citedSourceIds: ["0".repeat(32)] })] }),
      ),
    ).toThrow();
    expect(existsSync(join(vaultRoot, "global/output", `research-2026-10-15-${RUN_ID}.md`))).toBe(
      false,
    );
  });
});

describe("Test 5: unreadable reports", () => {
  test("a hand-edited, invalid frontmatter reads back as unreadable and never throws", () => {
    const written = writeReportNote(options());
    const text = readFileSync(written.absolutePath, "utf8");
    writeFileSync(written.absolutePath, text.replace("partial: true", "partial: false"));
    const read = readReportNote(vaultRoot, written.path);
    expect(read).toEqual({ readable: false, reason: "invalid-frontmatter" });
  });

  test("invalid YAML, a missing file and a missing id are unreadable with closed reasons", () => {
    const written = writeReportNote(options());
    writeFileSync(written.absolutePath, "---\nkey: [unclosed\n---\nbody\n");
    expect(readReportNote(vaultRoot, written.path)).toEqual({
      readable: false,
      reason: "invalid-yaml",
    });
    writeFileSync(written.absolutePath, "---\ntype: report\n---\nbody\n");
    expect(readReportNote(vaultRoot, written.path)).toEqual({
      readable: false,
      reason: "missing-id",
    });
    rmSync(written.absolutePath);
    expect(readReportNote(vaultRoot, written.path)).toEqual({ readable: false, reason: "missing" });
  });

  test("a frontmatter block over the cap is refused before parsing, as is a file over the cap", () => {
    const big = `---\nid: x\npad: ${"a".repeat(REPORT_FRONTMATTER_MAX_BYTES + 10)}\n---\nbody\n`;
    expect(() => parseReportNote(big)).toThrow(ReportNoteError);
    try {
      parseReportNote(big);
    } catch (error) {
      expect((error as ReportNoteError).reason).toBe("frontmatter-too-large");
    }
    const huge = `---\nid: x\n---\n${"a".repeat(REPORT_FILE_MAX_BYTES + 10)}`;
    try {
      parseReportNote(huge);
      throw new Error("expected a refusal");
    } catch (error) {
      expect((error as ReportNoteError).reason).toBe("too-large");
    }
    const written = writeReportNote(options());
    writeFileSync(written.absolutePath, huge);
    expect(readReportNote(vaultRoot, written.path)).toEqual({
      readable: false,
      reason: "too-large",
    });
  });

  test("a ---js delimiter is refused and executes nothing", () => {
    const text = '---js\n{ id: (globalThis.__ccc_pwned = 1, "x") }\n---\nbody\n';
    try {
      parseReportNote(text);
      throw new Error("expected a refusal");
    } catch (error) {
      expect((error as ReportNoteError).reason).toBe("refused-delimiter");
    }
    expect((globalThis as Record<string, unknown>).__ccc_pwned).toBeUndefined();
    const written = writeReportNote(options());
    writeFileSync(written.absolutePath, text);
    expect(readReportNote(vaultRoot, written.path)).toEqual({
      readable: false,
      reason: "refused-delimiter",
    });
  });

  test("alias amplification is refused", () => {
    const aliases = ["a: &a [1,1,1,1,1,1,1,1,1,1]"];
    let previous = "a";
    for (let i = 0; i < 8; i++) {
      const name = `b${i}`;
      aliases.push(`${name}: &${name} [${Array(10).fill(`*${previous}`).join(",")}]`);
      previous = name;
    }
    const text = `---\nid: x\n${aliases.join("\n")}\n---\nbody\n`;
    try {
      parseReportNote(text);
      throw new Error("expected a refusal");
    } catch (error) {
      expect((error as ReportNoteError).reason).toBe("frontmatter-too-large");
    }
  });

  test("finalising an unreadable report is refused and leaves the file alone", () => {
    const written = writeReportNote(options());
    writeFileSync(written.absolutePath, "---\ntype: report\n---\nhand edited\n");
    expect(() => finaliseReportNote({ vaultRoot, path: written.path, now: LATER })).toThrow(
      ReportNoteError,
    );
    expect(readFileSync(written.absolutePath, "utf8")).toBe(
      "---\ntype: report\n---\nhand edited\n",
    );
  });

  test("writing over an existing unreadable report is refused rather than clobbering it", () => {
    const written = writeReportNote(options());
    writeFileSync(written.absolutePath, "---\ntype: report\n---\nhand edited\n");
    expect(() => writeReportNote(options())).toThrow(ReportNoteError);
    expect(readFileSync(written.absolutePath, "utf8")).toBe(
      "---\ntype: report\n---\nhand edited\n",
    );
  });
});

describe("Test 6: scope and index", () => {
  test("the report is listed in global/output/index.md", () => {
    const written = writeReportNote(options());
    const index = readFileSync(join(vaultRoot, "global/output/index.md"), "utf8");
    expect(index).toContain(written.frontmatter.id);
    const final = finaliseReportNote({ vaultRoot, path: written.path, now: LATER });
    const indexAfter = readFileSync(join(vaultRoot, "global/output/index.md"), "utf8");
    expect(indexAfter).toContain(final.frontmatter.id);
    expect(indexAfter).toMatch(/output/);
  });

  test("a folder that escapes the vault through a link is refused by the scope guard", () => {
    const outside = mkdtempSync(join(TEST_BASE, "voutside-"));
    try {
      rmSync(join(vaultRoot, "global/output"), { recursive: true, force: true });
      symlinkSync(outside, join(vaultRoot, "global/output"));
      expect(() => writeReportNote(options())).toThrow(WorkspaceScopeViolationError);
      expect(existsSync(join(outside, `research-2026-10-15-${RUN_ID}.md`))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("finalise only accepts a path of the report file shape", () => {
    for (const bad of [
      "global/wiki/x.md",
      "../outside.md",
      `global/output/../wiki/research-2026-10-15-${RUN_ID}.md`,
      "global/output/other.md",
      `workspaces/x/output/research-2026-10-15-${RUN_ID}.md`,
    ]) {
      expect(() => finaliseReportNote({ vaultRoot, path: bad, now: LATER })).toThrow(
        ReportNoteError,
      );
    }
  });

  test("writing a report leaves no temp file behind", () => {
    const written = writeReportNote(options());
    finaliseReportNote({ vaultRoot, path: written.path, now: LATER });
    const names = readdirSync(join(vaultRoot, "global/output"));
    expect(names.sort()).toEqual(["index.md", `research-2026-10-15-${RUN_ID}.md`]);
  });
});
