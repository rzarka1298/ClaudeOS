import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  RESEARCH_STAGES,
  type ResearchSourceEntry,
  type ResearchSourcesConfig,
  type ResearchUpdatedPayload,
  type SummariserId,
} from "@ccc/domain";
import { applyMigrations, openStore } from "@ccc/operational-store";
import {
  createExtractiveTransport,
  createResearchServices,
  type FetchSourceInput,
  type FetchSourceResult,
  type ResearchServices,
  type RunBudget,
  type TextTransport,
} from "@ccc/service/research";
import { initializeVault } from "@ccc/vault-repo";

/**
 * Support for the research pipeline integration tests (plan 07-12). Builds a temporary vault, a
 * file-backed temporary store, a scripted fetcher and an event recorder around the REAL
 * `createResearchServices`. Nothing here reaches the network, a real model or a process: the
 * fetcher answers from a table and the transport is the extractive double or a fake. Test code
 * only.
 */

const TEST_BASE = join(homedir(), ".ccc-test");

export const SOURCE_ONE = "https://one.example.invalid/releases.atom";
export const SOURCE_TWO = "https://two.example.invalid/releases.atom";
export const SOURCE_THREE = "https://three.example.invalid/releases.atom";

export const THREE_SOURCES: readonly ResearchSourceEntry[] = [
  { label: "Alpha releases", url: SOURCE_ONE, kind: "feed" },
  { label: "Beta releases", url: SOURCE_TWO, kind: "feed" },
  { label: "Gamma releases", url: SOURCE_THREE, kind: "feed" },
];

export interface AtomEntry {
  readonly title: string;
  readonly text: string;
  readonly updated?: string;
  readonly author?: string;
  readonly link?: string;
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** An Atom feed with the given entries. */
export function atomFeed(entries: readonly AtomEntry[]): string {
  const body = entries
    .map(
      (entry, index) =>
        `<entry><title>${escapeXml(entry.title)}</title><link href="${entry.link ?? `https://entries.example.invalid/e${index}`}"/><updated>${entry.updated ?? "2026-10-14T10:00:00Z"}</updated><author><name>${escapeXml(entry.author ?? "Release Bot")}</name></author><summary>${escapeXml(entry.text)}</summary></entry>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Feed</title>${body}</feed>`;
}

/** A successful fetch result carrying `text`. */
export function okFetch(
  url: string,
  text: string,
  contentType = "application/atom+xml",
): FetchSourceResult {
  return {
    ok: true,
    bytes: new TextEncoder().encode(text),
    text,
    charset: "utf-8",
    contentType,
    finalUrl: url,
  };
}

/** A failed fetch result. */
export function failedFetch(
  code: Extract<FetchSourceResult, { ok: false }>["code"],
): FetchSourceResult {
  return { ok: false, code };
}

/** One feed per source with entries long enough to carry verifiable quotes. */
export function defaultResponses(): Record<string, FetchSourceResult> {
  const one = atomFeed([
    {
      title: "Alpha 2.0 released",
      text: "The maintainers confirmed that the alpha parser is now twice as fast in this release.",
    },
    { title: "Alpha 1.9 released", text: "Version 1.9 fixes a crash when reading empty archives." },
  ]);
  const two = atomFeed([
    {
      title: "Beta tooling update",
      text: "The beta command line tool now reports progress while it downloads packages.",
    },
  ]);
  const three = atomFeed([
    {
      title: "Gamma runtime patch",
      text: "The gamma runtime patch removes a memory leak in the scheduler component.",
    },
  ]);
  return {
    [SOURCE_ONE]: okFetch(SOURCE_ONE, one),
    [SOURCE_TWO]: okFetch(SOURCE_TWO, two),
    [SOURCE_THREE]: okFetch(SOURCE_THREE, three),
  };
}

export interface RecordedFetch {
  readonly urls: readonly string[];
  readonly kinds: readonly string[];
  readonly budget: RunBudget | undefined;
  readonly inFlightPeak: number;
}

export interface ResearchHarnessOptions {
  readonly sources?: readonly ResearchSourceEntry[];
  readonly responses?: Readonly<Record<string, FetchSourceResult>>;
  /** Answers one fetch instead of the table. May be slow. */
  readonly respond?: (input: FetchSourceInput) => FetchSourceResult | Promise<FetchSourceResult>;
  readonly transport?: TextTransport;
  readonly summariserId?: SummariserId;
  readonly now?: () => Date;
  /** False: no vault root is set up. */
  readonly vault?: boolean;
  /** False: the allowlist file is not written (the loader then seeds the defaults). */
  readonly writeConfig?: boolean;
  readonly watchdogMs?: number;
  readonly scheduleTimeout?: (fire: () => void, ms: number) => () => void;
  readonly publishThrows?: boolean;
  readonly topicLabel?: string;
}

export interface LoggedLine {
  readonly level: "warn" | "error";
  readonly fields: Record<string, unknown>;
}

export interface ResearchHarness {
  readonly vaultRoot: string;
  readonly runtimeDir: string;
  readonly sourcesPath: string;
  readonly db: ReturnType<typeof openStore>["db"];
  readonly services: ResearchServices;
  readonly events: { readonly type: string; readonly payload: ResearchUpdatedPayload }[];
  readonly fetches: RecordedFetch[];
  readonly transportInputs: string[];
  readonly logLines: LoggedLine[];
  /** The classified effects the pipeline reported, in order. */
  readonly effects: string[];
  /** The files (not index.md) directly in a vault folder, sorted. */
  list(folder: string): string[];
  writeSources(config: unknown): void;
  close(): void;
}

function tickingClock(): () => Date {
  let at = Date.parse("2026-10-15T09:00:00.000Z");
  return () => {
    at += 1000;
    return new Date(at);
  };
}

/** Builds the temporary vault, store, scripted fetcher and the real services around them. */
export function createResearchHarness(options: ResearchHarnessOptions = {}): ResearchHarness {
  mkdirSync(TEST_BASE, { recursive: true });
  const dir = mkdtempSync(join(TEST_BASE, "r-"));
  const vaultRoot = join(dir, "vault");
  const runtimeDir = join(dir, "runtime");
  mkdirSync(vaultRoot, { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });
  if (options.vault !== false) initializeVault(vaultRoot);

  const store = openStore(join(runtimeDir, "operational.db"));
  applyMigrations(store.db);

  const sourcesPath = join(runtimeDir, "research-sources.json");
  const config: ResearchSourcesConfig = {
    topicLabel: options.topicLabel ?? "Developer tooling",
    summariserModel: "claude-haiku-5-5",
    sources: [...(options.sources ?? THREE_SOURCES)],
  };
  const writeSources = (value: unknown): void => {
    writeFileSync(sourcesPath, JSON.stringify(value, null, 2), { mode: 0o600 });
  };
  if (options.writeConfig !== false) writeSources(config);

  const responses = options.responses ?? defaultResponses();
  const events: ResearchHarness["events"] = [];
  const fetches: RecordedFetch[] = [];
  const transportInputs: string[] = [];
  const logLines: LoggedLine[] = [];
  const effects: string[] = [];

  const answer = async (input: FetchSourceInput): Promise<FetchSourceResult> => {
    if (options.respond !== undefined) return options.respond(input);
    return responses[input.url] ?? failedFetch("network-error");
  };
  let inFlight = 0;
  const fetcher = {
    async fetchSources(
      inputs: readonly FetchSourceInput[],
      budget?: RunBudget,
    ): Promise<FetchSourceResult[]> {
      let peak = 0;
      const results: FetchSourceResult[] = [];
      for (const input of inputs) {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        try {
          results.push(await answer(input));
        } finally {
          inFlight -= 1;
        }
      }
      fetches.push({
        urls: inputs.map((input) => input.url),
        kinds: inputs.map((input) => input.kind),
        budget,
        inFlightPeak: peak,
      });
      return results;
    },
  };

  const base = options.transport ?? createExtractiveTransport();
  const transport: TextTransport = {
    async complete(request) {
      transportInputs.push(request.input);
      return base.complete(request);
    },
  };

  const services = createResearchServices({
    db: store.db,
    getVaultRoot: () => (options.vault === false ? null : vaultRoot),
    runtimeDir,
    eventBus: {
      publish(type, payload) {
        if (options.publishThrows === true) throw new Error("bus down");
        events.push({ type, payload: payload as ResearchUpdatedPayload });
        return { id: events.length, type, at: "", payload } as never;
      },
    },
    fetcher,
    chooseSummariser: () => ({
      transport,
      id: options.summariserId ?? "extractive",
    }),
    audit: (operation) => effects.push(operation),
    now: options.now ?? tickingClock(),
    log: {
      warn: (fields) => logLines.push({ level: "warn", fields: { ...fields } }),
      error: (fields) => logLines.push({ level: "error", fields: { ...fields } }),
    },
    ...(options.watchdogMs === undefined ? {} : { watchdogMs: options.watchdogMs }),
    ...(options.scheduleTimeout === undefined ? {} : { scheduleTimeout: options.scheduleTimeout }),
  });

  return {
    vaultRoot,
    runtimeDir,
    sourcesPath,
    db: store.db,
    services,
    events,
    fetches,
    transportInputs,
    logLines,
    effects,
    list(folder) {
      try {
        return readdirSync(join(vaultRoot, folder))
          .filter((name) => name !== "index.md")
          .sort();
      } catch {
        return [];
      }
    },
    writeSources,
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** The stages a successful run passes through, in order. */
export const EXPECTED_STAGES = [...RESEARCH_STAGES];
