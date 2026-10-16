import {
  closeSync,
  promises as fsPromises,
  ftruncateSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  WriteStream,
  writeSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { Worker } from "node:worker_threads";
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
import {
  type FetchSourceResult,
  PIPELINE_EFFECTS,
  type ResearchServices,
  sourceIdFor,
} from "@ccc/service/research";
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

// RSRCH-09, D-26: the hostile research corpus goes through the REAL pipeline. Process-starting,
// code-running, network and file-writing functions of node are replaced by recorders for this
// file. The process, code and network functions record and refuse (a hostile command must never
// run, even by mistake); the write functions record and pass through, placing a descriptor-based
// write on the path it was opened on. Every recorder has a live canary (see "the spies bite").
//
// What no in-process spy can see: SQLite writes made by the native better-sqlite3 code. They are
// bounded instead: the store file is the only database (the test asserts the run directory holds
// nothing but that file, its journal files and the allowlist, and the harness directory holds
// nothing but the vault and the run directory).

const spies = vi.hoisted(() => {
  const processCalls: string[] = [];
  const networkCalls: string[] = [];
  const writes: { fn: string; path: string }[] = [];
  /** Which path each file descriptor was opened on, so an fd-based write can be placed. */
  const fdPaths = new Map<number, string>();

  /** Path-first writers: the first argument (and for the pair functions the second) is a path. */
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
    "lchmodSync",
    "lchownSync",
    "lutimesSync",
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
    "lchmod",
    "lchown",
    "lutimes",
  ];
  /** Writers whose first argument is a file descriptor: placed through the descriptor table. */
  const FS_FD_WRITERS = [
    "writeSync",
    "writevSync",
    "write",
    "writev",
    "ftruncateSync",
    "ftruncate",
    "fchmodSync",
    "fchmod",
    "fchownSync",
    "fchown",
    "futimesSync",
    "futimes",
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
  /** The FileHandle methods that change a file. */
  const HANDLE_WRITERS = [
    "write",
    "writev",
    "writeFile",
    "appendFile",
    "truncate",
    "chmod",
    "chown",
    "utimes",
  ];

  function pathOf(value: unknown): string {
    if (typeof value === "number") return fdPaths.get(value) ?? `fd:${value}`;
    if (value instanceof URL) return decodeURIComponent(value.pathname);
    if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) return value.toString();
    if (typeof value === "object" && value !== null && "fd" in value) {
      return pathOf((value as { fd: number }).fd);
    }
    return String(value);
  }
  const isWriteFlag = (flags: unknown): boolean =>
    typeof flags === "string" ? /[wa+]/.test(flags) : typeof flags === "number" && flags !== 0;

  function wrapHandle(handle: Record<string, unknown>, path: string): Record<string, unknown> {
    for (const name of HANDLE_WRITERS) {
      const original = handle[name];
      if (typeof original !== "function") continue;
      handle[name] = (...args: unknown[]) => {
        writes.push({ fn: `FileHandle.${name}`, path });
        return (original as (...a: unknown[]) => unknown).apply(handle, args);
      };
    }
    return handle;
  }

  function wrapWriters(source: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = { ...source };
    for (const name of FS_WRITERS) {
      const original = source[name];
      if (typeof original !== "function") continue;
      out[name] = (...args: unknown[]) => {
        writes.push({ fn: name, path: pathOf(args[0]) });
        if (FS_PAIR.has(name)) writes.push({ fn: name, path: pathOf(args[1]) });
        return (original as (...a: unknown[]) => unknown)(...args);
      };
    }
    for (const name of FS_FD_WRITERS) {
      const original = source[name];
      if (typeof original !== "function") continue;
      out[name] = (...args: unknown[]) => {
        writes.push({ fn: name, path: pathOf(args[0]) });
        return (original as (...a: unknown[]) => unknown)(...args);
      };
    }
    // writeFile and appendFile may be given a descriptor or a handle instead of a path: pathOf places it.
    const opener = source.openSync;
    if (typeof opener === "function") {
      out.openSync = (...args: unknown[]) => {
        if (isWriteFlag(args[1])) writes.push({ fn: "openSync", path: pathOf(args[0]) });
        const fd = (opener as (...a: unknown[]) => unknown)(...args);
        if (typeof fd === "number") fdPaths.set(fd, pathOf(args[0]));
        return fd;
      };
    }
    const asyncOpener = source.open;
    if (typeof asyncOpener === "function") {
      out.open = (...args: unknown[]) => {
        if (isWriteFlag(args[1])) writes.push({ fn: "open", path: pathOf(args[0]) });
        const last = args.length - 1;
        const callback = args[last];
        if (typeof callback === "function") {
          args[last] = (error: unknown, fd: unknown) => {
            if (typeof fd === "number") fdPaths.set(fd, pathOf(args[0]));
            (callback as (...a: unknown[]) => unknown)(error, fd);
          };
        }
        return (asyncOpener as (...a: unknown[]) => unknown)(...args);
      };
    }
    return out;
  }

  /** The promise-flavoured `open`: a FileHandle whose writers record. Applied to fs.promises only. */
  function wrapPromiseOpen(source: Record<string, unknown>): Record<string, unknown> {
    const out = wrapWriters(source);
    const original = source.open;
    if (typeof original === "function") {
      out.open = async (...args: unknown[]) => {
        const path = pathOf(args[0]);
        if (isWriteFlag(args[1])) writes.push({ fn: "promises.open", path });
        const handle = await (original as (...a: unknown[]) => Promise<Record<string, unknown>>)(
          ...args,
        );
        return wrapHandle(handle, path);
      };
    }
    return out;
  }

  /** Replaces the named functions with recorders that refuse. */
  function refuse(
    source: Record<string, unknown>,
    names: readonly string[],
    sink: string[],
    prefix = "",
  ): Record<string, unknown> {
    const out: Record<string, unknown> = { ...source };
    for (const name of names) {
      if (typeof source[name] !== "function") continue;
      out[name] = () => {
        sink.push(`${prefix}${name}`);
        throw new Error(`refused: ${prefix}${name}`);
      };
    }
    return out;
  }

  /** Replaces a constructor with one that records and refuses to be built. */
  function refuseConstructor(original: unknown, label: string, sink: string[]): unknown {
    if (typeof original !== "function") return original;
    return new Proxy(original, {
      construct() {
        sink.push(label);
        throw new Error(`refused: ${label}`);
      },
    });
  }

  const DNS_NAMES = [
    "lookup",
    "lookupService",
    "resolve",
    "resolve4",
    "resolve6",
    "resolveAny",
    "resolveCname",
    "resolveCaa",
    "resolveMx",
    "resolveNaptr",
    "resolveNs",
    "resolvePtr",
    "resolveSoa",
    "resolveSrv",
    "resolveTxt",
    "reverse",
  ];

  function wrapDns(source: Record<string, unknown>): Record<string, unknown> {
    const out = refuse(source, DNS_NAMES, networkCalls, "dns.");
    if (typeof source.promises === "object" && source.promises !== null) {
      out.promises = refuse(
        source.promises as Record<string, unknown>,
        DNS_NAMES,
        networkCalls,
        "dns.promises.",
      );
    }
    return out;
  }

  /** A module whose named connection functions record and refuse. */
  function networkModule(
    source: Record<string, unknown>,
    label: string,
    names: readonly string[],
  ): Record<string, unknown> {
    const wrapped = refuse(source, names, networkCalls, `${label}.`);
    return { ...wrapped, default: wrapped };
  }

  return {
    processCalls,
    networkCalls,
    networkModule,
    writes,
    fdPaths,
    wrapWriters,
    wrapPromiseOpen,
    refuse,
    refuseConstructor,
    wrapDns,
    DNS_NAMES,
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const wrapped = spies.refuse(
    await importOriginal<Record<string, unknown>>(),
    ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"],
    spies.processCalls,
  );
  return { ...wrapped, default: wrapped };
});

vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const wrapped = {
    ...actual,
    Worker: spies.refuseConstructor(actual.Worker, "Worker", spies.processCalls),
  };
  return { ...wrapped, default: wrapped };
});

vi.mock("node:cluster", async (importOriginal) => {
  const actual = await importOriginal<{ default: Record<string, unknown> }>();
  const wrapped = spies.refuse(actual.default, ["fork"], spies.processCalls, "cluster.");
  return { ...wrapped, default: wrapped };
});

vi.mock("node:vm", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const wrapped = {
    ...spies.refuse(
      actual,
      ["runInContext", "runInNewContext", "runInThisContext", "compileFunction"],
      spies.processCalls,
      "vm.",
    ),
    Script: spies.refuseConstructor(actual.Script, "vm.Script", spies.processCalls),
  };
  return { ...wrapped, default: wrapped };
});

vi.mock("node:http", async (importOriginal) =>
  spies.networkModule(await importOriginal<Record<string, unknown>>(), "http", [
    "request",
    "get",
    "createServer",
  ]),
);
vi.mock("node:https", async (importOriginal) =>
  spies.networkModule(await importOriginal<Record<string, unknown>>(), "https", [
    "request",
    "get",
    "createServer",
  ]),
);
vi.mock("node:http2", async (importOriginal) =>
  spies.networkModule(await importOriginal<Record<string, unknown>>(), "http2", [
    "connect",
    "createServer",
    "createSecureServer",
  ]),
);
vi.mock("node:tls", async (importOriginal) =>
  spies.networkModule(await importOriginal<Record<string, unknown>>(), "tls", [
    "connect",
    "createServer",
  ]),
);
vi.mock("node:dgram", async (importOriginal) =>
  spies.networkModule(await importOriginal<Record<string, unknown>>(), "dgram", ["createSocket"]),
);

vi.mock("node:net", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const wrapped = {
    ...spies.refuse(
      actual,
      ["connect", "createConnection", "createServer"],
      spies.networkCalls,
      "net.",
    ),
    Socket: spies.refuseConstructor(actual.Socket, "net.Socket", spies.networkCalls),
  };
  return { ...wrapped, default: wrapped };
});

vi.mock("node:dns", async (importOriginal) => {
  const wrapped = spies.wrapDns(await importOriginal<Record<string, unknown>>());
  return { ...wrapped, default: wrapped };
});

vi.mock("node:dns/promises", async (importOriginal) => {
  const wrapped = spies.refuse(
    await importOriginal<Record<string, unknown>>(),
    spies.DNS_NAMES,
    spies.networkCalls,
    "dns.promises.",
  );
  return { ...wrapped, default: wrapped };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const wrapped = spies.wrapWriters(actual as unknown as Record<string, unknown>);
  wrapped.promises = spies.wrapPromiseOpen(actual.promises as unknown as Record<string, unknown>);
  wrapped.WriteStream = new Proxy(actual.WriteStream, {
    construct(target, args, newTarget) {
      spies.writes.push({ fn: "WriteStream", path: String(args[0]) });
      return Reflect.construct(target, args, newTarget);
    },
  });
  return { ...wrapped, default: wrapped };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const wrapped = spies.wrapPromiseOpen(actual as unknown as Record<string, unknown>);
  return { ...wrapped, default: wrapped };
});

// ---------------------------------------------------------------------------

const BATCH = 6;
/** True for a format, separator, surrogate or control character other than the ordinary line characters. */
const INVISIBLE = {
  test: (text: string): boolean =>
    /[\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u.test(text) || /[^\P{Cc}\n\t\r]/u.test(text),
};

/** True when `target` is `root` or inside it. Separator-safe: a sibling that shares a prefix is outside. */
function isWithin(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Refuses any native load for the duration of a run (a hostile payload must not load code). */
function armDlopen(): () => void {
  const spy = vi.spyOn(process, "dlopen").mockImplementation(() => {
    spies.processCalls.push("process.dlopen");
    throw new Error("refused: process.dlopen");
  });
  return () => spy.mockRestore();
}

/** Presses the button once and waits for the run, with the native-load guard armed. */
async function guardedRun(target: { readonly services: ResearchServices }) {
  const disarm = armDlopen();
  try {
    const started = target.services.runNow();
    if (!started.ok) throw new Error("refused");
    await target.services.idle();
    return started;
  } finally {
    disarm();
  }
}

const STORE_FILES = new Set([
  "operational.db",
  "operational.db-wal",
  "operational.db-shm",
  "operational.db-journal",
  "research-sources.json",
]);

/** Every recorded write went to the vault or the allowlist; the store file is the only database. */
function expectContained(
  target: { readonly vaultRoot: string; readonly runtimeDir: string; readonly sourcesPath: string },
  label: string,
): void {
  for (const write of spies.writes) {
    const allowed = isWithin(target.vaultRoot, write.path) || write.path === target.sourcesPath;
    expect(allowed, `${label}: ${write.fn} wrote ${write.path}`).toBe(true);
  }
  for (const name of readdirSync(target.runtimeDir)) {
    expect(STORE_FILES.has(name), `${label}: unexpected file ${name} in the run directory`).toBe(
      true,
    );
  }
  expect(
    readdirSync(resolve(target.vaultRoot, "..")).sort(),
    `${label}: unexpected entry beside the vault`,
  ).toEqual(["runtime", "vault"]);
}

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
  vi.stubGlobal("WebSocket", function WebSocketRefused() {
    spies.networkCalls.push("WebSocket");
    throw new Error("WebSocket refused");
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
  /** One record per batch, so the suite can tell a green run from a vacuous one. */
  const batchResults: { reachedTransport: boolean; report: boolean; contributed: number }[] = [];

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

      const started = await guardedRun(harness);

      // Test 1: nothing was started or loaded, and no request left the process.
      expect(spies.processCalls).toEqual([]);
      expect(spies.networkCalls).toEqual([]);
      expect(fetchCalls).toEqual([]);

      // Test 2: every write went through a vault writer or the store or the allowlist.
      // The recorder is live over the code under test: the run note alone is a vault write.
      expect(spies.writes.some((write) => isWithin(harness.vaultRoot, write.path))).toBe(true);
      expectContained(harness, `batch ${batchIndex + 1}`);

      // Test 3: the fetcher once per configured source, the transport at most once.
      expect(harness.fetches).toHaveLength(fetchesBefore + 1);
      expect(harness.fetches.at(-1)?.urls).toEqual(sources.map((source) => source.url));
      const calls = harness.transportInputs.length - transportBefore;
      expect(calls).toBeLessThanOrEqual(1);
      // A batch that holds a document whose text survives the sanitiser must reach the model:
      // an early honest failure is not allowed to stand in for the checks below.
      if (batch.some((entry) => entry.keeps.length > 0)) {
        expect(
          calls,
          `batch ${batchIndex + 1} holds surviving text but never reached the model`,
        ).toBe(1);
      }

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
      batchResults.push({
        reachedTransport: calls === 1,
        report: latest !== undefined,
        contributed: row?.sourceCount ?? 0,
      });
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

  it("is not vacuous: most batches reached the model and enough produced a report", () => {
    // Run the whole file: the per-batch results are collected by the batch tests above.
    expect(batchResults.length, "run the whole file, not a filtered subset").toBe(batches.length);
    const reached = batchResults.filter((result) => result.reachedTransport).length;
    const reports = batchResults.filter((result) => result.report).length;
    const contributed = batchResults.reduce((sum, result) => sum + result.contributed, 0);
    // A regression that rejects every hostile document (for example a throw swallowed in the
    // preparation step) leaves every batch green under the per-batch checks; these floors fail it.
    // Measured when written: all 41 batches reach the model, 13 produce a report, 78 sources.
    expect(reached).toBeGreaterThanOrEqual(Math.floor(batches.length * 0.9));
    expect(reports).toBeGreaterThanOrEqual(8);
    expect(contributed).toBeGreaterThanOrEqual(40);
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
        spies.networkCalls.length = 0;
        spies.writes.length = 0;
        await guardedRun(model);
        expect(spies.processCalls).toEqual([]);
        expect(spies.networkCalls).toEqual([]);
        expect(spies.writes.some((write) => isWithin(model.vaultRoot, write.path))).toBe(true);
        expectContained(model, hostile.name);
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

// A spy that never fires proves nothing. Each recorder above is exercised here directly, and the
// containment check is shown to refuse a sibling folder that shares the vault path as a prefix.
describe("the spies bite", () => {
  const sibling = (): string => join(harness.runtimeDir, "canary.txt");
  const written = (fn: string): boolean =>
    spies.writes.some((write) => write.fn === fn && write.path === sibling());

  it("records a write through an open descriptor, on the path it was opened on", () => {
    const fd = openSync(sibling(), "w");
    expect(written("openSync")).toBe(true);
    spies.writes.length = 0;
    writeSync(fd, "x");
    expect(written("writeSync")).toBe(true);
    spies.writes.length = 0;
    ftruncateSync(fd, 0);
    expect(written("ftruncateSync")).toBe(true);
    closeSync(fd);
    rmSync(sibling(), { force: true });
  });

  it("records a write through fs.promises.open and its handle", async () => {
    const handle = await fsPromises.open(sibling(), "w");
    expect(written("promises.open")).toBe(true);
    spies.writes.length = 0;
    await handle.write("x");
    expect(written("FileHandle.write")).toBe(true);
    await handle.close();
    rmSync(sibling(), { force: true });
  });

  it("records a WriteStream built directly", async () => {
    const stream = new WriteStream(sibling());
    expect(written("WriteStream")).toBe(true);
    await new Promise<void>((done) => stream.end(done));
    rmSync(sibling(), { force: true });
  });

  it("refuses and records a process start, a worker and code run by vm", async () => {
    const { spawn } = await import("node:child_process");
    const vm = await import("node:vm");
    expect(() => spawn("true")).toThrow(/refused/);
    expect(() => new Worker("1", { eval: true })).toThrow(/refused/);
    expect(() => vm.runInNewContext("1")).toThrow(/refused/);
    expect(() => new vm.Script("1")).toThrow(/refused/);
    expect(spies.processCalls).toEqual(["spawn", "Worker", "vm.runInNewContext", "vm.Script"]);
  });

  it("refuses and records a native load", () => {
    const disarm = armDlopen();
    try {
      expect(() => process.dlopen({} as never, "/nonexistent.node")).toThrow(/refused/);
    } finally {
      disarm();
    }
    expect(spies.processCalls).toEqual(["process.dlopen"]);
  });

  it("refuses and records every way out to the network the pipeline could take", async () => {
    const net = await import("node:net");
    const tls = await import("node:tls");
    const http = await import("node:http");
    const https = await import("node:https");
    const http2 = await import("node:http2");
    const dns = await import("node:dns");
    const dnsPromises = await import("node:dns/promises");
    const dgram = await import("node:dgram");
    expect(() => net.connect(1)).toThrow(/refused/);
    expect(() => new net.Socket()).toThrow(/refused/);
    expect(() => tls.connect(1)).toThrow(/refused/);
    expect(() => http.request("http://x.invalid/")).toThrow(/refused/);
    expect(() => https.get("https://x.invalid/")).toThrow(/refused/);
    expect(() => http2.connect("https://x.invalid/")).toThrow(/refused/);
    expect(() => dns.lookup("x.invalid", () => {})).toThrow(/refused/);
    expect(() => dns.promises.lookup("x.invalid")).toThrow(/refused/);
    expect(() => dnsPromises.resolve("x.invalid")).toThrow(/refused/);
    expect(() => dgram.createSocket("udp4")).toThrow(/refused/);
    expect(
      () => new (globalThis as { WebSocket: new (u: string) => unknown }).WebSocket("x"),
    ).toThrow(/refused/);
    expect(() => globalThis.fetch("https://x.invalid/")).toThrow(/refused/);
    expect(spies.networkCalls).toEqual([
      "net.connect",
      "net.Socket",
      "tls.connect",
      "http.request",
      "https.get",
      "http2.connect",
      "dns.lookup",
      "dns.promises.lookup",
      "dns.promises.resolve",
      "dgram.createSocket",
      "WebSocket",
    ]);
    expect(fetchCalls).toEqual(["https://x.invalid/"]);
  });

  it("treats a sibling folder that shares the vault path as a prefix as outside the vault", () => {
    const root = harness.vaultRoot;
    expect(isWithin(root, join(root, "global", "x.md"))).toBe(true);
    expect(isWithin(root, root)).toBe(true);
    expect(isWithin(root, `${root}-sibling${sep}x.md`)).toBe(false);
    expect(isWithin(root, `${root}${sep}..${sep}escape.md`)).toBe(false);
    expect(isWithin(root, "fd:7")).toBe(false);
  });
});
