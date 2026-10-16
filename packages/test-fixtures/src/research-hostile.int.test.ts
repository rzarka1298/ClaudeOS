import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  JOB_RUN_OUTCOMES,
  RESEARCH_JOB_ID,
  RESEARCH_PIPELINE_OPERATIONS,
  type ResearchSourceEntry,
  RUN_ERROR_CODES,
  SANITISE_COUNT_KEYS,
} from "@ccc/domain";
import { listJobRuns } from "@ccc/operational-store";
import { parseDelimitedBlocks, quoteInSource } from "@ccc/research";
import { type FetchSourceResult, PIPELINE_EFFECTS, sourceIdFor } from "@ccc/service/research";
import { readRawSourceNote, readReportNote, readWikiSourceNote } from "@ccc/vault-repo";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HOSTILE_MODEL_ANSWERS,
  MODEL_ANSWER_ID_A,
  MODEL_ANSWER_ID_B,
} from "./hostile-model-answers.js";
import {
  HOSTILE_RESEARCH_CORPUS,
  HOSTILE_RESEARCH_NONCE,
  type HostileResearchEntry,
} from "./hostile-research-corpus.js";
import { createResearchHarness, okFetch, type ResearchHarness } from "./research-int-support.js";

// RSRCH-09, D-26: the hostile research corpus goes through the REAL pipeline. Process-starting
// and file-writing functions of node are replaced by recorders for this file. The process
// functions record and refuse (a hostile command must never run, even by mistake); the write
// functions record and pass through.

const spies = vi.hoisted(() => {
  const processCalls: string[] = [];
  const networkCalls: string[] = [];
  const writes: { fn: string; path: string }[] = [];
  const FS_WRITERS = [
    "writeFileSync",
    "appendFileSync",
    "mkdirSync",
    "mkdtempSync",
    "renameSync",
    "unlinkSync",
    "rmSync",
    "rmdirSync",
    "copyFileSync",
    "cpSync",
    "symlinkSync",
    "linkSync",
    "truncateSync",
    "utimesSync",
    "chmodSync",
    "chownSync",
    "createWriteStream",
    "writeFile",
    "appendFile",
    "mkdir",
    "mkdtemp",
    "rename",
    "unlink",
    "rm",
    "rmdir",
    "copyFile",
    "cp",
    "symlink",
    "link",
    "truncate",
    "utimes",
    "chmod",
    "chown",
  ];
  const FS_PAIR = new Set([
    "renameSync",
    "copyFileSync",
    "symlinkSync",
    "linkSync",
    "rename",
    "copyFile",
    "symlink",
    "link",
    "cp",
    "cpSync",
  ]);

  function wrapWriters(source: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = { ...source };
    for (const name of FS_WRITERS) {
      const original = source[name];
      if (typeof original !== "function") continue;
      out[name] = (...args: unknown[]) => {
        writes.push({ fn: name, path: String(args[0]) });
        if (FS_PAIR.has(name)) writes.push({ fn: name, path: String(args[1]) });
        return (original as (...a: unknown[]) => unknown)(...args);
      };
    }
    const opener = source.openSync;
    if (typeof opener === "function") {
      out.openSync = (...args: unknown[]) => {
        const flags = args[1];
        if (
          typeof flags === "string" ? /[wa+]/.test(flags) : typeof flags === "number" && flags !== 0
        ) {
          writes.push({ fn: "openSync", path: String(args[0]) });
        }
        return (opener as (...a: unknown[]) => unknown)(...args);
      };
    }
    return out;
  }
  function wrapNetwork(source: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = { ...source };
    for (const name of ["request", "get"]) {
      out[name] = () => {
        networkCalls.push(name);
        throw new Error(`network request refused: ${name}`);
      };
    }
    return out;
  }
  return { processCalls, networkCalls, writes, wrapWriters, wrapNetwork };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const wrapped: Record<string, unknown> = { ...actual };
  for (const name of [
    "spawn",
    "spawnSync",
    "exec",
    "execSync",
    "execFile",
    "execFileSync",
    "fork",
  ]) {
    wrapped[name] = () => {
      spies.processCalls.push(name);
      throw new Error(`process start refused: ${name}`);
    };
  }
  return { ...wrapped, default: wrapped };
});

vi.mock("node:http", async (importOriginal) => {
  const wrapped = spies.wrapNetwork(await importOriginal<Record<string, unknown>>());
  return { ...wrapped, default: wrapped };
});

vi.mock("node:https", async (importOriginal) => {
  const wrapped = spies.wrapNetwork(await importOriginal<Record<string, unknown>>());
  return { ...wrapped, default: wrapped };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const wrapped = spies.wrapWriters(actual as unknown as Record<string, unknown>);
  wrapped.promises = spies.wrapWriters(actual.promises as unknown as Record<string, unknown>);
  return { ...wrapped, default: wrapped };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const wrapped = spies.wrapWriters(actual as unknown as Record<string, unknown>);
  return { ...wrapped, default: wrapped };
});

// ---------------------------------------------------------------------------

const BATCH = 6;
/** True for a format, separator, surrogate or control character other than the ordinary line characters. */
const INVISIBLE = {
  test: (text: string): boolean =>
    /[\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u.test(text) || /[^\P{Cc}\n\t\r]/u.test(text),
};

let harness: ResearchHarness;
let answers = new Map<string, FetchSourceResult>();

beforeAll(() => {
  harness = createResearchHarness({
    respond: async (input) =>
      answers.get(input.url) ?? ({ ok: false, code: "network-error" } as FetchSourceResult),
  });
});
afterAll(() => {
  vi.unstubAllGlobals();
  harness.close();
});
const fetchCalls: string[] = [];
beforeEach(() => {
  fetchCalls.length = 0;
  vi.stubGlobal("fetch", (input: unknown) => {
    fetchCalls.push(String(input));
    throw new Error("fetch refused");
  });
  spies.networkCalls.length = 0;
  spies.processCalls.length = 0;
  spies.writes.length = 0;
});

function entryFor(index: number, entry: HostileResearchEntry): ResearchSourceEntry {
  return {
    label: `Hostile ${index}`,
    url: `https://h${index}.example.invalid/doc`,
    kind: entry.kind === "feed" ? "feed" : "page",
  };
}

function readAll(vaultRoot: string, folder: string): { name: string; text: string }[] {
  try {
    return readdirSync(join(vaultRoot, folder))
      .filter((name) => name !== "index.md")
      .map((name) => ({ name, text: readFileSync(join(vaultRoot, folder, name), "utf8") }));
  } catch {
    return [];
  }
}

/** Removes inline code spans: addresses and paths are shown there, as inert text. */
function withoutCode(line: string): string {
  return line.replace(/(`+)[\s\S]*?\1/g, "");
}

function expectInertBody(body: string, label: string): void {
  for (const line of body.split("\n")) {
    const text = withoutCode(line);
    expect(/(?<!\\)!\[/.test(text), `${label}: image syntax in "${line}"`).toBe(false);
    expect(/(?<!\\)\]\(/.test(text), `${label}: link syntax in "${line}"`).toBe(false);
    expect(/(?<!\\)\[\[/.test(text), `${label}: wikilink in "${line}"`).toBe(false);
    expect(/(?<!\\)</.test(text), `${label}: markup in "${line}"`).toBe(false);
    expect(/:\/\//.test(text), `${label}: address in "${line}"`).toBe(false);
    expect(/javascript:/i.test(text), `${label}: script scheme in "${line}"`).toBe(false);
  }
}

describe("Test 1 to 4: the hostile corpus runs through the real pipeline and nothing is executed", () => {
  const batches: HostileResearchEntry[][] = [];
  for (let at = 0; at < HOSTILE_RESEARCH_CORPUS.length; at += BATCH) {
    batches.push(HOSTILE_RESEARCH_CORPUS.slice(at, at + BATCH));
  }

  it("has a corpus to run", () => {
    expect(HOSTILE_RESEARCH_CORPUS.length).toBeGreaterThan(100);
  });

  batches.forEach((batch, batchIndex) => {
    it(`batch ${batchIndex + 1} of ${batches.length}: ${batch[0]?.name} to ${batch.at(-1)?.name}`, async () => {
      const sources = batch.map((entry, i) => entryFor(batchIndex * BATCH + i, entry));
      answers = new Map(
        sources.map((source, i) => {
          const entry = batch[i] as HostileResearchEntry;
          return [
            source.url,
            okFetch(
              source.url,
              entry.document,
              entry.kind === "feed" ? "application/atom+xml" : "text/html",
            ),
          ];
        }),
      );
      harness.writeSources({
        topicLabel: "Hostile topic",
        summariserModel: "claude-haiku-5-5",
        sources,
      });
      const fetchesBefore = harness.fetches.length;
      const transportBefore = harness.transportInputs.length;
      const effectsBefore = harness.effects.length;
      spies.processCalls.length = 0;
      spies.writes.length = 0;

      const started = harness.services.runNow();
      if (!started.ok) throw new Error("refused");
      await harness.services.idle();

      // Test 1: nothing was started, and no request left the process.
      expect(spies.processCalls).toEqual([]);
      expect(spies.networkCalls).toEqual([]);
      expect(fetchCalls).toEqual([]);

      // Test 2: every write went through a vault writer or the store or the allowlist.
      // The recorder is live over the code under test: the run note alone is a vault write.
      expect(spies.writes.some((write) => write.path.startsWith(harness.vaultRoot))).toBe(true);
      for (const write of spies.writes) {
        const inVault = write.path.startsWith(harness.vaultRoot);
        const isAllowlist = write.path === harness.sourcesPath;
        expect(inVault || isAllowlist, `${write.fn} wrote ${write.path}`).toBe(true);
      }

      // Test 3: the fetcher once per configured source, the transport at most once.
      expect(harness.fetches).toHaveLength(fetchesBefore + 1);
      expect(harness.fetches.at(-1)?.urls).toEqual(sources.map((source) => source.url));
      const calls = harness.transportInputs.length - transportBefore;
      expect(calls).toBeLessThanOrEqual(1);

      const row = listJobRuns(harness.db, RESEARCH_JOB_ID, 1)[0];
      expect(JOB_RUN_OUTCOMES).toContain(row?.outcome);
      if (row?.outcome === "failure") expect(RUN_ERROR_CODES).toContain(row.errorCode);

      // Only classified effects, and never an approval-required one.
      const performed = harness.effects.slice(effectsBefore);
      for (const operation of performed) {
        expect(Object.values(PIPELINE_EFFECTS)).toContain(operation);
        expect(RESEARCH_PIPELINE_OPERATIONS).toContain(operation);
      }
      // Every run is a press, a fetch and a record; a run that reached the model also wrote notes.
      for (const operation of [
        PIPELINE_EFFECTS.trigger,
        PIPELINE_EFFECTS.recordRun,
        PIPELINE_EFFECTS.fetch,
      ]) {
        expect(performed, operation).toContain(operation);
      }
      if (calls === 1) {
        expect(performed).toContain(PIPELINE_EFFECTS.writeNotes);
        expect(performed).toContain(PIPELINE_EFFECTS.summarise);
      }

      if (calls === 1) {
        const input = harness.transportInputs.at(-1) ?? "";
        // Each source block is wrapped with the one run nonce.
        const headers = [...input.matchAll(/^<<<SRC id=[0-9a-f]{32} nonce=([0-9a-f]{32})>>>$/gm)];
        const footers = [...input.matchAll(/^<<<END nonce=([0-9a-f]{32})>>>$/gm)];
        const nonces = new Set([...headers, ...footers].map((m) => m[1]));
        expect(nonces.size).toBe(1);
        const blocks = parseDelimitedBlocks(input);
        expect(blocks.length).toBeGreaterThan(0);
        expect([...input.matchAll(/^<<<SRC /gm)]).toHaveLength(blocks.length);
        expect([...input.matchAll(/^<<<END /gm)]).toHaveLength(blocks.length);
        // No key, no absolute path of this machine.
        for (const secret of [harness.vaultRoot, harness.runtimeDir, "/Users/", "/home/"]) {
          expect(input.includes(secret), `input contains ${secret}`).toBe(false);
        }
        expect(
          INVISIBLE.test(input.replace(/\n/g, " ")),
          "input holds an invisible character",
        ).toBe(false);
        // What the sanitiser drops never reaches the model.
        batch.forEach((entry, i) => {
          const block = blocks.find((b) => b.sourceId === sourceIdFor(sources[i]?.url ?? ""));
          if (block === undefined) return;
          for (const bad of entry.forbidden.filter((word) => word !== HOSTILE_RESEARCH_NONCE)) {
            expect(
              block.text.toLowerCase().includes(bad.toLowerCase()),
              `${entry.name} block holds "${bad}"`,
            ).toBe(false);
          }
        });
      }

      // Test 4: the results.
      const reports = readAll(harness.vaultRoot, "global/output");
      const latest = reports.find((report) => report.name.includes(started.value.runId));
      if (latest === undefined) {
        // No report: the run failed honestly, and no report note exists for it.
        expect(row?.outcome).toBe("failure");
        return;
      }
      const read = readReportNote(harness.vaultRoot, `global/output/${latest.name}`);
      expect(read.readable).toBe(true);
      if (!read.readable) return;
      expectInertBody(read.body, `report ${started.value.runId}`);
      for (const item of read.frontmatter.items) {
        const text = `${item.text} ${item.quote ?? ""}`;
        expect(INVISIBLE.test(text)).toBe(false);
        expect(/[a-z][a-z0-9+.-]*:\/\//i.test(text)).toBe(false);
        expect(/<\s*script|javascript:|\son[a-z]+\s*=/i.test(text)).toBe(false);
      }
      for (const ref of read.frontmatter.sourceRefs) {
        const index = sources.findIndex((source) => sourceIdFor(source.url) === ref.id);
        const entry = batch[index] as HostileResearchEntry;
        const raw = readRawSourceNote(harness.vaultRoot, ref.snapshotPath);
        expect(raw.readable).toBe(true);
        if (!raw.readable) continue;
        // The sanitiser's description is stored, and it is non-zero for the categories present.
        for (const key of entry.counts) {
          expect(raw.frontmatter.sanitise[key], `${entry.name} ${key}`).toBeGreaterThan(0);
        }
        expect(INVISIBLE.test((raw.text ?? "").replace(/\n/g, " "))).toBe(false);
        const rawText = readFileSync(
          join(harness.vaultRoot, ref.snapshotPath),
          "utf8",
        ).toLowerCase();
        for (const bad of entry.forbidden.filter((word) => word !== HOSTILE_RESEARCH_NONCE)) {
          expect(rawText.includes(bad.toLowerCase()), `${entry.name} raw note holds "${bad}"`).toBe(
            false,
          );
        }
        const wiki = readWikiSourceNote(harness.vaultRoot, ref.id);
        expect(wiki.readable).toBe(true);
        if (wiki.readable) expectInertBody(wiki.body, `wiki ${ref.id}`);
        // Every stored quote re-verifies against the stored snapshot with the one predicate.
        for (const item of read.frontmatter.items) {
          if (item.quote === undefined || !item.citedSourceIds.includes(ref.id)) continue;
          expect(quoteInSource(raw.text ?? "", item.quote)).toBe(true);
        }
        for (const key of SANITISE_COUNT_KEYS) {
          expect(Number.isInteger(raw.frontmatter.sanitise[key])).toBe(true);
        }
      }
    });
  });
});

describe("hostile model answers through the real pipeline", () => {
  const FEED_LINES = (text: string): string =>
    `<p>${text
      .split("\n")
      .map((line) => line.replace(/&/g, "&amp;").replace(/</g, "&lt;"))
      .join("</p><p>")}</p>`;

  for (const hostile of HOSTILE_MODEL_ANSWERS) {
    it(hostile.name, async () => {
      const urlA = "https://model-a.example.invalid/page";
      const urlB = "https://model-b.example.invalid/page";
      const idA = sourceIdFor(urlA);
      const idB = sourceIdFor(urlB);
      const page = (text: string): string => `<html><body>${FEED_LINES(text)}</body></html>`;
      answers = new Map([
        [urlA, okFetch(urlA, page(hostile.sources[MODEL_ANSWER_ID_A] ?? ""), "text/html")],
        [urlB, okFetch(urlB, page(hostile.sources[MODEL_ANSWER_ID_B] ?? ""), "text/html")],
      ]);
      const answer = hostile.answer
        .split(MODEL_ANSWER_ID_A)
        .join(idA)
        .split(MODEL_ANSWER_ID_B)
        .join(idB);
      const model = createResearchHarness({
        respond: async (input) => answers.get(input.url) ?? { ok: false, code: "network-error" },
        transport: { complete: async () => answer },
        sources: [
          { label: "Model A", url: urlA, kind: "page" },
          { label: "Model B", url: urlB, kind: "page" },
        ],
      });
      try {
        spies.processCalls.length = 0;
        const started = model.services.runNow();
        if (!started.ok) throw new Error("refused");
        await model.services.idle();
        expect(spies.processCalls).toEqual([]);
        expect(spies.networkCalls).toEqual([]);
        const row = listJobRuns(model.db, RESEARCH_JOB_ID, 1)[0];
        const expected = hostile.expect;
        const noItems = "invalid" in expected && expected.invalid === true;
        const kindsEmpty = !noItems && "kinds" in expected && expected.kinds.length === 0;
        if (noItems || kindsEmpty) {
          expect(row?.outcome).toBe("failure");
          expect(row?.errorCode).toBe("summariser-invalid-output");
          expect(model.list("global/output")).toEqual([]);
          return;
        }
        // A case whose second source sanitises to nothing is honestly partial, never a failure.
        expect(["success", "partial"]).toContain(row?.outcome);
        const name = model.list("global/output")[0] ?? "";
        const read = readReportNote(model.vaultRoot, `global/output/${name}`);
        if (!read.readable) throw new Error("report must be readable");
        const known = new Set([idA, idB]);
        for (const item of read.frontmatter.items) {
          expect(["source-fact", "unverified-claim", "inference"]).toContain(item.kind);
          for (const id of item.citedSourceIds) expect(known.has(id)).toBe(true);
          const text = `${item.text} ${item.quote ?? ""}`;
          expect(INVISIBLE.test(text)).toBe(false);
          expect(/[a-z][a-z0-9+.-]*:\/\//i.test(text)).toBe(false);
          if (item.quote !== undefined) {
            for (const id of item.citedSourceIds) {
              const ref = read.frontmatter.sourceRefs.find((candidate) => candidate.id === id);
              const raw = readRawSourceNote(model.vaultRoot, ref?.snapshotPath ?? "");
              expect(raw.readable && quoteInSource(raw.text ?? "", item.quote)).toBe(true);
            }
          }
        }
        expectInertBody(read.body, hostile.name);
      } finally {
        model.close();
      }
    });
  }
});
