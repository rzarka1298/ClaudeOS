// The sweep for the live summariser transport (plan 07-10, D-04, RSRCH-07, RSRCH-08, T-07-25 to
// T-07-27). Hostile whole HTTP replies go through the real request and parser code with a fake
// HTTPS request and must each end in one closed run error code. Hostile summariser answers (the
// 07-07 corpus and the Markdown and address item texts of this plan) go through the transport,
// then the trusted stage (`validateSummariserOutput`, the one place model text is neutralised and
// quotes are checked with `quoteInSource`), then the report writer with its escape helpers. No
// network, no key store, no real vault.
import { readFileSync } from "node:fs";
import { REPORT_ITEM_QUOTE_MIN_LENGTH, RUN_ERROR_CODES, type SourceReference } from "@ccc/domain";
import { quoteInSource, validateSummariserOutput } from "@ccc/research";
import {
  type AnthropicRequestFn,
  createAnthropicTransport,
  SummariserError,
} from "@ccc/service/research-summariser";
import {
  escapeMarkdownText,
  initializeVault,
  parseReportNote,
  writeReportNote,
} from "@ccc/vault-repo";
import { describe, expect, it } from "vitest";
import { HOSTILE_MODEL_ANSWERS } from "./hostile-model-answers.js";
import {
  HOSTILE_ANTHROPIC_REPLIES,
  HOSTILE_ITEM_TEXT_ANSWERS,
  ITEM_TEXT_ID_A,
  ITEM_TEXT_ID_B,
} from "./hostile-summariser-replies.js";
import { withTempVaultDir } from "./vault-fixture.js";

const CANARY = "canary-research-key-0000";
const NOW = new Date("2026-10-15T09:00:00.000Z");
const RUN_ID = "r0123456789abcdefghijklmn";
const ADDRESS =
  /(?:[a-z][a-z0-9+.-]*:[/\\]|\bwww\.|\b(?:javascript|data|vbscript|file|obsidian|mailto):)/i;
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u;
const ITEM_QUOTE = "the maintainers confirmed that stream reset is fixed in this release";

interface FakeReply {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body: string;
}

/** A fake of `https.request`: records every call, plays one reply, opens no socket. */
function fakeRequest(play: FakeReply): { request: AnthropicRequestFn; calls: number[] } {
  const calls: number[] = [];
  const request: AnthropicRequestFn = (_options, onResponse) => {
    calls.push(1);
    const listeners: ((error: Error) => void)[] = [];
    return {
      on(_event: "error" | "timeout", listener: ((error: Error) => void) | (() => void)) {
        if (_event === "error") listeners.push(listener as (error: Error) => void);
        return this;
      },
      end() {
        queueMicrotask(() =>
          onResponse({
            statusCode: play.status,
            headers: { "content-type": "application/json", ...(play.headers ?? {}) },
            destroy() {},
            async *[Symbol.asyncIterator]() {
              yield Buffer.from(play.body, "utf8");
            },
          }),
        );
      },
      destroy() {},
    };
  };
  return { request, calls };
}

function transportFor(play: FakeReply, logs: unknown[] = []) {
  const fake = fakeRequest(play);
  const transport = createAnthropicTransport({
    readApiKey: async () => CANARY,
    model: "claude-haiku-5-5",
    request: fake.request,
    log: (entry) => logs.push(entry),
  });
  return { transport, calls: fake.calls };
}

function textReply(text: string): FakeReply {
  return {
    status: 200,
    body: JSON.stringify({
      id: "msg_x",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
    }),
  };
}

function asciiOnly(file: string): string[] {
  const source = readFileSync(new URL(file, import.meta.url), "utf8");
  return [...source]
    .filter((c) => (c.codePointAt(0) ?? 0) > 0x7e || (c < " " && c !== "\n"))
    .map((c) => `U+${c.codePointAt(0)?.toString(16).toUpperCase()}`);
}

describe("hostile summariser replies: shape of the set", () => {
  it("has unique kebab-case names and enough cases", () => {
    const names = HOSTILE_ANTHROPIC_REPLIES.map((c) => c.name);
    expect(names.length).toBeGreaterThanOrEqual(60);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    const texts = HOSTILE_ITEM_TEXT_ANSWERS.map((c) => c.name);
    expect(texts.length).toBeGreaterThanOrEqual(35);
    expect(new Set(texts).size).toBe(texts.length);
  });

  it("is written with escapes only: the fixture source holds no non-ASCII character", () => {
    expect(asciiOnly("./hostile-summariser-replies.ts")).toEqual([]);
    expect(asciiOnly("./summariser-transport-sweep.test.ts")).toEqual([]);
  });
});

describe("hostile whole replies end in one closed code", () => {
  for (const entry of HOSTILE_ANTHROPIC_REPLIES) {
    it(`${entry.name} gives ${entry.code}`, async () => {
      const logs: unknown[] = [];
      const { transport, calls } = transportFor(entry, logs);
      const error = await transport.complete({ instructions: "i", input: "x" }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(SummariserError);
      const failure = error as SummariserError;
      expect(failure.code).toBe(entry.code);
      expect(RUN_ERROR_CODES as readonly string[]).toContain(failure.code);
      expect(calls).toHaveLength(1);
      // Nothing of the reply or the key travels with the error or into a log entry.
      expect(failure.message).toBe(entry.code);
      expect(JSON.stringify(failure)).not.toContain(CANARY);
      expect(JSON.stringify(logs)).not.toContain(CANARY);
      expect(logs).toEqual([{ event: "research-summariser-failed", code: entry.code }]);
    });
  }
});

function sourceRef(id: string): SourceReference {
  const hash = (id[0] ?? "a").repeat(64);
  return {
    sourceType: "web-page",
    id,
    title: "A source",
    canonicalUrl: `https://news.example/${id.slice(0, 4)}`,
    author: null,
    publishedAt: null,
    retrievedAt: "2026-10-15T08:59:00.000Z",
    contentHash: hash,
    snapshotPath: `global/raw/${id}.${hash.slice(0, 8)}.md`,
    accessClass: "public",
  };
}

/** Text with every escaped pair and every inline code span removed: only active syntax is left. */
function activeSyntaxOf(text: string): string {
  return text.replace(/\\[!-/:-@[-`{-~]/g, "").replace(/(`+) [^\n]*? \1(?!`)/g, "");
}

interface ChainCase {
  readonly name: string;
  readonly answer: string;
  readonly sources: Readonly<Record<string, string>>;
}

const ITEM_TEXT_CASES: readonly ChainCase[] = HOSTILE_ITEM_TEXT_ANSWERS.map((entry) => {
  const quote = entry.quote ?? ITEM_QUOTE;
  return {
    name: `item-text-${entry.name}`,
    answer: JSON.stringify({
      items: [
        { kind: "source-fact", text: entry.text, citedSourceIds: [ITEM_TEXT_ID_A], quote },
        { kind: "inference", text: entry.text, citedSourceIds: [] },
      ],
    }),
    sources: {
      [ITEM_TEXT_ID_A]: `Intro line. ${quote}. More text follows here.`,
      [ITEM_TEXT_ID_B]: "A second source that is not cited.",
    },
  };
});

const CHAIN_CASES: readonly ChainCase[] = [
  ...HOSTILE_MODEL_ANSWERS.map((entry) => ({
    name: `model-answer-${entry.name}`,
    answer: entry.answer,
    sources: entry.sources,
  })),
  ...ITEM_TEXT_CASES,
];

describe("hostile answers: transport, trusted stage and report writer", () => {
  it("has the 07-07 corpus and the item-text cases to run", () => {
    expect(CHAIN_CASES.length).toBeGreaterThanOrEqual(70);
  });

  for (const entry of CHAIN_CASES) {
    it(entry.name, async () => {
      // 1. The transport hands the answer on byte for byte: it neither cleans nor reads it.
      const { transport } = transportFor(textReply(entry.answer));
      const returned = await transport.complete({ instructions: "i", input: "x" });
      expect(returned).toBe(entry.answer);

      // 2. The one trusted stage: same verdict as on the original, whatever the answer says.
      const result = validateSummariserOutput(returned, { sources: entry.sources });
      expect(result).toEqual(validateSummariserOutput(entry.answer, { sources: entry.sources }));
      if (!result.ok) {
        expect(result.code).toBe("summariser-invalid-output");
        return;
      }
      for (const item of result.items) {
        for (const field of [item.text, item.quote ?? ""]) {
          expect(ADDRESS.test(field.normalize("NFKC")), field).toBe(false);
          expect(INVISIBLE.test(field), field).toBe(false);
        }
        if (item.quote !== undefined) {
          expect(item.quote.length).toBeGreaterThanOrEqual(REPORT_ITEM_QUOTE_MIN_LENGTH);
          // The single exported matcher, not a second one.
          const holders = item.citedSourceIds.filter((id) =>
            quoteInSource(entry.sources[id] ?? "", item.quote ?? ""),
          );
          if (item.kind === "inference") expect(holders.length).toBeGreaterThan(0);
          else expect(holders).toEqual([...item.citedSourceIds]);
        }
      }

      // 3. The writer's escape helper makes what is left inert text in the note.
      const ids = [...new Set(result.items.flatMap((i) => [...i.citedSourceIds]))];
      const refs = (ids.length > 0 ? ids : [Object.keys(entry.sources)[0] ?? ITEM_TEXT_ID_A]).map(
        sourceRef,
      );
      await withTempVaultDir(({ vaultRoot }) => {
        initializeVault(vaultRoot);
        const written = writeReportNote({
          vaultRoot,
          topicLabel: "Daily tech",
          generatedAt: "2026-10-15T08:59:30.000Z",
          jobRunId: RUN_ID,
          summariser: "claude-haiku-5-5",
          sourceTotal: refs.length,
          unavailableSources: [],
          sourceRefs: refs,
          sourceHandling: [],
          items: result.items,
          now: NOW,
        });
        const raw = readFileSync(written.absolutePath, "utf8");
        const parsed = parseReportNote(raw);
        expect(parsed.frontmatter.items).toEqual(result.items);
        const lines = parsed.body.split("\n");
        for (const item of result.items) {
          const escaped = escapeMarkdownText(item.text);
          expect(lines).toContain(escaped);
          expect(activeSyntaxOf(escaped)).not.toMatch(/[!-/:-@[-`{-~]/);
          if (item.quote !== undefined) {
            const quoted = `> ${escapeMarkdownText(item.quote)}`;
            expect(lines).toContain(quoted);
            expect(activeSyntaxOf(quoted.slice(2))).not.toMatch(/[!-/:-@[-`{-~]/);
          }
        }
        // No address survives anywhere in the body outside an inline code span (source URLs).
        const active = activeSyntaxOf(parsed.body);
        expect(active).not.toContain("://");
        expect(active.toLowerCase()).not.toContain("www.");
      });
    });
  }
});
