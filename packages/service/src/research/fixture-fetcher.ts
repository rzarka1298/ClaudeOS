import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { SourceFailureCodeSchema } from "@ccc/domain";
import { z } from "zod";
import { BYTE_CAP_BY_KIND } from "./fetch/limits.js";
import type { FetchSourceInput, FetchSourceResult, SafeFetcher } from "./fetch/safe-fetch.js";
import { ResearchOverrideError } from "./override-error.js";

/**
 * The fixture fetcher (plan 07-14, D-27, research Pitfall 15): the in-process stand-in for the
 * safe fetcher that an automated run uses. It reads a fixture directory and NEVER opens a socket,
 * resolves a name or starts a process: this module imports nothing network-capable (a source scan
 * pins that). It returns the same result union as the real fetcher.
 *
 * The directory holds a `manifest.json` mapping each configured source address to a fixture file,
 * a content type, an optional simulated failure code and an optional delay. An address missing
 * from the manifest is a `network-error`. A fixture file that is not inside the directory (a
 * `..` segment, an absolute path, a link pointing out) is refused: at load time for the shape, and
 * again at read time with the link resolved.
 */

export const FIXTURE_MANIFEST_FILE = "manifest.json";

/** A manifest above this many bytes is refused before parsing. */
export const FIXTURE_MANIFEST_MAX_BYTES = 64 * 1024;

/** The longest simulated delay: a fixture may slow a run down, never stall it for minutes. */
export const FIXTURE_DELAY_MAX_MS = 30_000;

const ManifestEntrySchema = z
  .strictObject({
    url: z.string().min(1).max(2048),
    file: z.string().min(1).max(200).optional(),
    contentType: z.string().min(1).max(100).optional(),
    failure: SourceFailureCodeSchema.optional(),
    delayMs: z.number().int().min(0).max(FIXTURE_DELAY_MAX_MS).optional(),
  })
  .refine((entry) => entry.failure !== undefined || entry.file !== undefined, {
    message: "an entry names a file or a failure",
  });

const ManifestSchema = z.strictObject({ entries: z.array(ManifestEntrySchema).max(64) });

type ManifestEntry = z.infer<typeof ManifestEntrySchema>;

/** The file operations the fetcher uses, so a test can observe them. Default: node:fs. */
export interface FixtureFs {
  readFileSync(path: string): Buffer;
  statSync(path: string): { isDirectory(): boolean; isFile(): boolean; readonly size: number };
  lstatSync(path: string): { isSymbolicLink(): boolean };
  realpathSync(path: string): string;
}

const NODE_FS: FixtureFs = {
  readFileSync: (path) => readFileSync(path),
  statSync,
  lstatSync,
  realpathSync,
};

export interface FixtureFetcherOptions {
  readonly dir: string;
  readonly fs?: FixtureFs;
  /** Default: a real timer. Tests inject a recorder. */
  readonly sleep?: (ms: number) => Promise<void>;
}

function contains(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** True for a file name that is one plain path segment. */
function isPlainFileName(file: string): boolean {
  return (
    file !== "." &&
    file !== ".." &&
    !file.includes("/") &&
    !file.includes("\\") &&
    !file.includes("\0") &&
    !isAbsolute(file)
  );
}

function fail(code: Extract<FetchSourceResult, { ok: false }>["code"]): FetchSourceResult {
  return { ok: false, code };
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });

/**
 * Builds the fetcher. @throws {ResearchOverrideError} when the directory or its manifest is not
 * usable, so a misconfigured automated run stops at startup with a code instead of fetching
 * nothing.
 */
export function createFixtureFetcher(options: FixtureFetcherOptions): SafeFetcher {
  const fs = options.fs ?? NODE_FS;
  const sleep = options.sleep ?? realSleep;
  const dir = options.dir;
  if (!isAbsolute(dir)) throw new ResearchOverrideError("invalid-fixture-dir");
  let root: string;
  try {
    if (!fs.statSync(dir).isDirectory()) throw new ResearchOverrideError("invalid-fixture-dir");
    root = fs.realpathSync(dir);
  } catch (error) {
    if (error instanceof ResearchOverrideError) throw error;
    throw new ResearchOverrideError("invalid-fixture-dir");
  }

  let manifest: z.infer<typeof ManifestSchema>;
  try {
    const manifestPath = join(root, FIXTURE_MANIFEST_FILE);
    if (fs.statSync(manifestPath).size > FIXTURE_MANIFEST_MAX_BYTES) {
      throw new ResearchOverrideError("invalid-fixture-manifest");
    }
    const parsed = ManifestSchema.safeParse(
      JSON.parse(fs.readFileSync(manifestPath).toString("utf8")),
    );
    if (!parsed.success) throw new ResearchOverrideError("invalid-fixture-manifest");
    manifest = parsed.data;
  } catch (error) {
    if (error instanceof ResearchOverrideError) throw error;
    throw new ResearchOverrideError("invalid-fixture-manifest");
  }

  const byUrl = new Map<string, ManifestEntry>();
  for (const entry of manifest.entries) {
    if (byUrl.has(entry.url)) throw new ResearchOverrideError("invalid-fixture-manifest");
    if (entry.file !== undefined && !isPlainFileName(entry.file)) {
      throw new ResearchOverrideError("fixture-path-outside");
    }
    byUrl.set(entry.url, entry);
  }

  function readFixture(entry: ManifestEntry, kind: FetchSourceInput["kind"]): FetchSourceResult {
    if (entry.file === undefined) return fail("network-error");
    const target = resolve(root, entry.file);
    if (!contains(root, target)) return fail("network-error");
    try {
      // A link is followed only when it still points inside the directory.
      const real = fs.lstatSync(target).isSymbolicLink() ? fs.realpathSync(target) : target;
      if (!contains(root, real)) return fail("network-error");
      const stat = fs.statSync(real);
      if (!stat.isFile()) return fail("network-error");
      if (stat.size > BYTE_CAP_BY_KIND[kind]) return fail("oversize");
      const bytes = fs.readFileSync(real);
      return {
        ok: true,
        bytes: new Uint8Array(bytes),
        text: bytes.toString("utf8"),
        charset: "utf-8",
        contentType:
          (entry.contentType ?? "text/plain").split(";")[0]?.trim().toLowerCase() ?? "text/plain",
        finalUrl: entry.url,
      };
    } catch {
      return fail("network-error");
    }
  }

  async function fetchSource(input: FetchSourceInput): Promise<FetchSourceResult> {
    const entry = byUrl.get(input.url);
    if (entry === undefined) return fail("network-error");
    if (entry.delayMs !== undefined && entry.delayMs > 0) await sleep(entry.delayMs);
    if (entry.failure !== undefined) return fail(entry.failure);
    return readFixture(entry, input.kind);
  }

  return {
    fetchSource,
    async fetchSources(inputs) {
      return Promise.all(
        inputs.map((input) => fetchSource(input).catch(() => fail("network-error"))),
      );
    },
  };
}
