import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  RESEARCH_LIST_PAGE_SIZE,
  RESEARCH_LIST_PATH,
  RESEARCH_REPORT_PATH,
  RESEARCH_RUN_PATH,
  RESEARCH_STATUS_PATH,
  ResearchErrorBodySchema,
  ResearchListResponseSchema,
  type ResearchListRow,
  ResearchReportItemsPageSchema,
  ResearchReportSourcesPageSchema,
  ResearchRunResponseSchema,
  ResearchStatusResponseSchema,
  rawSnapshotPathFor,
  type SanitiseCounts,
  type SourceReference,
  VAULT_SETUP_PATH,
} from "@ccc/domain";
import { evidenceText } from "@ccc/research";
import { contentHashFor, sourceIdFor } from "@ccc/service/research";
import { finaliseReportNote, writeRawSourceNote, writeReportNote } from "@ccc/vault-repo";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  authedRequest,
  collectEvents,
  handshake,
  setUpServiceEnvironment,
  tearDownServiceEnvironment,
} from "./approval-int-support.js";
import { HOSTILE_REPORT_TEXTS } from "./hostile-report-text.js";
import { HOSTILE_RESEARCH_CORPUS, type HostileResearchEntry } from "./hostile-research-corpus.js";
import { startServiceForTest, type TestServiceHandle } from "./service-harness.js";
import { withTempSocketDir } from "./socket-fixture.js";

/**
 * Plan 07-14 (HOSTILE_RESEARCH_CORPUS sweeps through the route layer and provenance; T-07-37,
 * T-07-38, RSRCH-08, RSRCH-09): the REAL built service process, with the guarded fixture override,
 * is fed
 *
 * 1. every document of the hostile research corpus as a fetched source (in runs of up to twelve
 *    sources), and everything the routes then serve is checked: the closed response schemas, the
 *    response budget, plain text and no hostile string in any served field or in the service log;
 * 2. reports crafted with every hostile report text as title, finding text, quote, source title and
 *    author, with real raw notes, to check that the routes serve each as the same plain string and
 *    that provenance re-verification downgrades what the stored snapshot does not hold;
 * 3. hostile request values in every body field: closed error bodies that never echo them.
 *
 * No network, no model, no real key. Every hostile string comes from the corpus files; this file
 * holds none of its own.
 */

const TEST_BASE = join(homedir(), ".ccc-test");
const BATCH = 12;
const RUN_WAIT_MS = 90_000;
const BUDGET = 57344;
const STAMP = "0123456789abcdef0123456789abcdef";

let account: string;
const started: TestServiceHandle[] = [];
const extraDirs: string[] = [];

beforeEach(() => {
  account = setUpServiceEnvironment();
});
afterEach(async () => {
  for (const service of started.splice(0)) await service.kill();
  for (const dir of extraDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  tearDownServiceEnvironment(account);
});

const ZERO_COUNTS: SanitiseCounts = {
  scripts: 0,
  styles: 0,
  comments: 0,
  hiddenBlocks: 0,
  mediaDropped: 0,
  linksDropped: 0,
  controlChars: 0,
  commandLikeLines: 0,
};

function sourceUrl(index: number): string {
  return `https://h${index}.example.invalid/doc`;
}

interface Running {
  readonly socketPath: string;
  readonly dir: string;
  readonly token: string;
  readonly vaultRoot: string;
  call<T = unknown>(
    path: string,
    body: unknown,
    token?: string,
  ): Promise<{ status: number; body: T; raw: string }>;
}

/** Starts the service on a fixture directory holding every corpus document, with a vault set up. */
async function withCorpusService<T>(fn: (running: Running) => Promise<T>): Promise<T> {
  return withTempSocketDir(async ({ dir, socketPath }) => {
    const fixtureDir = join(dir, "fixtures");
    mkdirSync(fixtureDir, { recursive: true });
    const entries = HOSTILE_RESEARCH_CORPUS.map((entry, index) => {
      writeFileSync(join(fixtureDir, `d${index}.txt`), entry.document);
      return {
        url: sourceUrl(index),
        file: `d${index}.txt`,
        contentType: entry.kind === "feed" ? "application/atom+xml" : "text/html",
      };
    });
    writeFileSync(join(fixtureDir, "manifest.json"), JSON.stringify({ entries }));
    mkdirSync(join(dir, "claude", "projects"), { recursive: true });
    process.env.CLAUDE_CONFIG_DIR = join(dir, "claude");
    const service = await startServiceForTest({
      socketPath,
      dbPath: join(dir, "operational.db"),
      waitAttempts: 200,
      env: {
        CCC_ENABLE_TEST_OVERRIDES: "1",
        CCC_RESEARCH_TEST_FIXTURE_DIR: fixtureDir,
        CCC_RESEARCH_TEST_SUMMARISER: "extractive",
      },
    });
    started.push(service);
    try {
      const token = await handshake(socketPath);
      mkdirSync(TEST_BASE, { recursive: true });
      const vaultRoot = mkdtempSync(join(TEST_BASE, "hv-"));
      extraDirs.push(vaultRoot);
      mkdirSync(join(vaultRoot, ".obsidian"), { recursive: true });
      const setup = await authedRequest<unknown>(socketPath, token, {
        method: "POST",
        path: VAULT_SETUP_PATH,
        body: { vaultRoot },
      });
      expect(setup.status).toBe(200);
      const call: Running["call"] = async (path, body, withToken = token) => {
        const reply = await authedRequest<never>(socketPath, withToken, {
          method: "POST",
          path,
          body,
        });
        return { status: reply.status, body: reply.body as never, raw: JSON.stringify(reply.body) };
      };
      return await fn({ socketPath, dir, token, vaultRoot, call });
    } finally {
      await service.kill();
    }
  });
}

function writeSources(dir: string, entries: readonly HostileResearchEntry[], offset: number): void {
  writeFileSync(
    join(dir, "research-sources.json"),
    JSON.stringify({
      topicLabel: "Hostile topic",
      summariserModel: "claude-haiku-5-5",
      sources: entries.map((entry, index) => ({
        label: `Hostile ${offset + index}`,
        url: sourceUrl(offset + index),
        kind: entry.kind === "feed" ? "feed" : "page",
      })),
    }),
    { mode: 0o600 },
  );
}

/** Characters no served field may hold: controls, format characters (bidi, zero width), separators. */
const NEVER_SERVED = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

function servedTexts(page: ReturnType<typeof ResearchReportItemsPageSchema.parse>): string[] {
  return [
    page.header.title,
    ...page.header.unavailableSources.map((source) => source.label),
    ...page.items.flatMap((item) => [
      item.text,
      ...(item.quote === null ? [] : [item.quote]),
      ...item.citations.map((citation) => citation.title),
    ]),
  ];
}

describe("Part 1: the hostile research corpus, through the real process and its routes", () => {
  it("serves only valid, budgeted, plain responses and leaks no hostile string into the log", async () => {
    await withCorpusService(async ({ socketPath, token, dir, call }) => {
      const events = collectEvents(socketPath, token);
      const batches: HostileResearchEntry[][] = [];
      for (let at = 0; at < HOSTILE_RESEARCH_CORPUS.length; at += BATCH) {
        batches.push(HOSTILE_RESEARCH_CORPUS.slice(at, at + BATCH));
      }
      let reports = 0;
      let servedItems = 0;
      const sizes: number[] = [];
      try {
        for (const [batchIndex, batch] of batches.entries()) {
          writeSources(dir, batch, batchIndex * BATCH);
          const run = await call(RESEARCH_RUN_PATH, {});
          expect(run.status).toBe(200);
          const runId = ResearchRunResponseSchema.parse(run.body).runId;
          const ended = await events.waitFor(
            (event) =>
              event.type === "research.updated" &&
              (event.payload as { runId?: string }).runId === runId &&
              (event.payload as { outcome?: string }).outcome !== undefined,
            RUN_WAIT_MS,
          );
          const outcome = (ended.payload as { outcome: string }).outcome;
          expect(["success", "partial", "failure"]).toContain(outcome);

          const status = await call(RESEARCH_STATUS_PATH, {});
          expect(status.status).toBe(200);
          sizes.push(Buffer.byteLength(status.raw));
          const parsedStatus = ResearchStatusResponseSchema.parse(status.body);
          expect(parsedStatus.inFlight).toBeNull();
          if (outcome === "failure") continue;

          // The newest report is the one this run wrote.
          const list = await call(RESEARCH_LIST_PATH, {});
          sizes.push(Buffer.byteLength(list.raw));
          const rows = ResearchListResponseSchema.parse(list.body).rows;
          const row = rows.find(
            (candidate): candidate is Extract<ResearchListRow, { readable: true }> =>
              candidate.readable && candidate.noteId === parsedStatus.lastSuccess?.reportNoteId,
          );
          expect(row, `batch ${batchIndex + 1} report is listed`).toBeDefined();
          if (row === undefined) continue;
          reports += 1;

          let cursor: string | undefined;
          for (let page = 0; page < 12; page += 1) {
            const items = await call<{ nextCursor: string | null }>(RESEARCH_REPORT_PATH, {
              noteId: row.noteId,
              page: "items",
              ...(cursor === undefined ? {} : { cursor }),
            });
            expect(items.status).toBe(200);
            sizes.push(Buffer.byteLength(items.raw));
            const parsed = ResearchReportItemsPageSchema.parse(items.body);
            servedItems += parsed.items.length;
            for (const text of servedTexts(parsed)) {
              expect(NEVER_SERVED.test(text), `a served text holds an invisible character`).toBe(
                false,
              );
            }
            for (const item of parsed.items) {
              // Addresses in the model's own words are neutralised (neutralise.ts); Markdown, wikilink
              // and HTML characters stay literal here and are escaped by the note writer, while the
              // reader renders them as text nodes. No served text carries a live address or scheme.
              expect(
                /:\/\/|javascript:/i.test(item.text),
                `finding text holds an address: ${item.text}`,
              ).toBe(false);
              expect(item.kind).not.toBe("recommendation");
            }
            if (parsed.nextCursor === null) break;
            cursor = parsed.nextCursor;
          }
          const sources = await call(RESEARCH_REPORT_PATH, { noteId: row.noteId, page: "sources" });
          expect(sources.status).toBe(200);
          sizes.push(Buffer.byteLength(sources.raw));
          const parsedSources = ResearchReportSourcesPageSchema.parse(sources.body);
          for (const source of parsedSources.sources) {
            // The title is the owner's label, never a remote string.
            expect(source.title).toMatch(/^Hostile \d+$/);
          }
          // No absolute path of this machine in any response of the batch.
          for (const reply of [status.raw, list.raw, sources.raw]) {
            expect(reply.includes(homedir())).toBe(false);
          }
        }
      } finally {
        events.close();
      }

      for (const size of sizes) expect(size).toBeLessThan(BUDGET);
      // Aggregate floors, so a vacuous green run is impossible.
      expect(reports).toBeGreaterThanOrEqual(8);
      expect(servedItems).toBeGreaterThan(0);

      // The service log holds codes and event names, never a hostile string.
      const log = readFileSync(join(dir, "logs", "service.log"), "utf8");
      for (const entry of HOSTILE_RESEARCH_CORPUS) {
        for (const marker of entry.forbidden) {
          if (marker.length < 10) continue;
          expect(
            log.toLowerCase().includes(marker.toLowerCase()),
            `${entry.name} marker in log`,
          ).toBe(false);
        }
      }
    });
  }, 600_000);
});

describe("Part 2: hostile report texts, through provenance and the routes", () => {
  /** Writes one finalised report whose every text field is `text`, backed by real raw notes. */
  function craftReport(
    vaultRoot: string,
    text: string,
    index: number,
  ): { noteId: string; path: string } {
    const url = `https://crafted${index}.example.invalid/feed.atom`;
    // The stored evidence is long enough to hold the hostile text as a substantial quote, so a
    // text that is a whole-word run of at least four words verifies and the rest does not.
    const evidence = evidenceText(`alpha beta gamma delta ${text} epsilon zeta eta theta\n`, STAMP);
    const id = sourceIdFor(url);
    const hash = contentHashFor(evidence);
    const ref: SourceReference = {
      sourceType: "feed-entry",
      id,
      title: text,
      canonicalUrl: url,
      author: text,
      publishedAt: null,
      retrievedAt: "2026-10-14T10:00:00.000Z",
      contentHash: hash,
      snapshotPath: rawSnapshotPathFor(id, hash),
      accessClass: "public",
    };
    writeRawSourceNote({
      vaultRoot,
      sourceRef: ref,
      sanitise: ZERO_COUNTS,
      text: evidence,
      canonicalHash: contentHashFor,
      now: new Date("2026-10-14T10:00:00.000Z"),
    });
    const day = String(1 + (index % 28)).padStart(2, "0");
    const month = String(1 + Math.floor(index / 28)).padStart(2, "0");
    const written = writeReportNote({
      vaultRoot,
      topicLabel: text,
      generatedAt: `2026-${month}-${day}T10:00:00.000Z`,
      jobRunId: `c${String(index).padStart(5, "0")}abcdefghijklmnopqrs`,
      summariser: "extractive",
      sourceTotal: 1,
      unavailableSources: [],
      sourceRefs: [ref],
      sourceHandling: [{ sourceId: id, counts: ZERO_COUNTS }],
      items: [{ kind: "source-fact", text, quote: text, citedSourceIds: [id] }],
      now: new Date("2026-10-14T10:00:00.000Z"),
    });
    finaliseReportNote({
      vaultRoot,
      path: written.path,
      now: new Date("2026-10-14T10:00:00.000Z"),
    });
    return { noteId: written.id, path: written.path };
  }

  it("serves every hostile text as the same plain string, and downgrades a quote the snapshot does not hold", async () => {
    await withCorpusService(async ({ vaultRoot, call }) => {
      const crafted = HOSTILE_REPORT_TEXTS.map((hostile, index) => ({
        hostile,
        ...craftReport(vaultRoot, hostile.text, index),
      }));
      let verified = 0;
      let downgraded = 0;
      for (const { hostile, noteId, path } of crafted) {
        const items = await call(RESEARCH_REPORT_PATH, { noteId, page: "items" });
        expect(items.status, hostile.name).toBe(200);
        expect(Buffer.byteLength(items.raw)).toBeLessThan(BUDGET);
        const page = ResearchReportItemsPageSchema.parse(items.body);
        expect(page.header.notePath, hostile.name).toBe(path);
        expect(page.header.title.startsWith(hostile.text), hostile.name).toBe(true);
        const item = page.items[0];
        // The text is the stored string, unescaped and uninterpreted.
        expect(item?.text, hostile.name).toBe(hostile.text);
        if (item?.quote === null) {
          // Not a substantial whole-word quote of the stored snapshot: not shown as evidence.
          expect(item.kind, hostile.name).toBe("inference");
          expect(item.quoteSourceNumber).toBeNull();
          // Plan 07-15: the downgrade is said on the wire, never silent.
          expect(item.quoteUnverified, hostile.name).toBe(true);
          downgraded += 1;
        } else {
          expect(item?.quote, hostile.name).toBe(hostile.text);
          expect(item?.kind, hostile.name).toBe("source-fact");
          expect("quoteUnverified" in (item ?? {}), hostile.name).toBe(false);
          verified += 1;
        }
        const sources = await call(RESEARCH_REPORT_PATH, { noteId, page: "sources" });
        const parsedSources = ResearchReportSourcesPageSchema.parse(sources.body);
        expect(parsedSources.sources[0]?.title, hostile.name).toBe(hostile.text);
        expect(parsedSources.sources[0]?.author, hostile.name).toBe(hostile.text);
        expect(items.raw.includes(vaultRoot), hostile.name).toBe(false);
      }
      // Both outcomes occur in the corpus, so neither branch is vacuous.
      expect(verified).toBeGreaterThan(0);
      expect(downgraded).toBeGreaterThan(0);

      // The list, newest first, across pages: every crafted report once, every row valid.
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 5; page += 1) {
        const list = await call(RESEARCH_LIST_PATH, cursor === undefined ? {} : { cursor });
        expect(list.status).toBe(200);
        expect(Buffer.byteLength(list.raw)).toBeLessThan(BUDGET);
        const parsed = ResearchListResponseSchema.parse(list.body);
        expect(parsed.rows.length).toBeLessThanOrEqual(RESEARCH_LIST_PAGE_SIZE);
        for (const row of parsed.rows) {
          expect(row.readable).toBe(true);
          if (row.readable) seen.push(row.noteId);
        }
        if (parsed.nextCursor === null) break;
        cursor = parsed.nextCursor;
      }
      expect(new Set(seen).size).toBe(seen.length);
      expect([...seen].sort()).toEqual(crafted.map((entry) => entry.noteId).sort());
    });
  }, 300_000);
});

describe("Part 3: hostile request values", () => {
  it("answers closed bodies that never echo the value, and the log holds none of them", async () => {
    await withCorpusService(async ({ dir, call }) => {
      const hostileValues = [
        ...HOSTILE_REPORT_TEXTS.map((entry) => entry.text),
        ...HOSTILE_RESEARCH_CORPUS.slice(0, 40).map((entry) => entry.name),
      ];
      const urlSafe = (value: string): boolean => /^[A-Za-z0-9_-]{1,256}$/.test(value);
      for (const value of hostileValues) {
        if (/^[0-9a-z]{25}$/.test(value)) continue;
        const invalidBody = { error: "invalid-body" };
        const cases: [string, Awaited<ReturnType<typeof call>>, number, unknown][] = [
          [
            "noteId",
            await call(RESEARCH_REPORT_PATH, { noteId: value, page: "items" }),
            400,
            invalidBody,
          ],
          [
            "page",
            await call(RESEARCH_REPORT_PATH, { noteId: "a".repeat(25), page: value }),
            400,
            invalidBody,
          ],
          [
            "report cursor",
            await call(RESEARCH_REPORT_PATH, {
              noteId: "a".repeat(25),
              page: "items",
              cursor: value,
            }),
            urlSafe(value) ? 404 : 400,
            urlSafe(value) ? { error: "not-found" } : invalidBody,
          ],
          [
            "list cursor",
            await call(RESEARCH_LIST_PATH, { cursor: value }),
            400,
            urlSafe(value) ? { error: "invalid-cursor" } : invalidBody,
          ],
          ["list key", await call(RESEARCH_LIST_PATH, { [value]: true }), 400, invalidBody],
          ["run key", await call(RESEARCH_RUN_PATH, { [value]: true }), 400, invalidBody],
          ["status key", await call(RESEARCH_STATUS_PATH, { value }), 400, invalidBody],
        ];
        for (const [label, reply, status, body] of cases) {
          expect(reply.status, label).toBe(status);
          expect(ResearchErrorBodySchema.parse(reply.body), label).toEqual(body);
        }
      }
      // Valid shapes with values that name nothing: closed codes, nothing echoed.
      const unknown = await call(RESEARCH_REPORT_PATH, { noteId: "z".repeat(25), page: "items" });
      expect(unknown.status).toBe(404);
      expect(ResearchErrorBodySchema.parse(unknown.body)).toEqual({ error: "not-found" });
      const badCursor = await call(RESEARCH_LIST_PATH, { cursor: "AAAA" });
      expect(badCursor.status).toBe(400);
      expect(badCursor.body).toEqual({ error: "invalid-cursor" });

      const log = readFileSync(join(dir, "logs", "service.log"), "utf8");
      for (const value of hostileValues) {
        if (value.length < 12) continue;
        expect(log.includes(value), "a hostile request value reached the log").toBe(false);
      }
    });
  }, 300_000);
});
