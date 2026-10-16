import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ResearchSourceEntry,
  ResearchSourcesConfig,
  ResearchUpdatedPayload,
  SummariserId,
} from "@ccc/domain";
import { applyMigrations, openStore } from "@ccc/operational-store";
import { initializeVault } from "@ccc/vault-repo";
import type { TextTransport } from "../../untrusted/index.js";
import { createExtractiveTransport } from "../extractive-transport.js";
import type {
  FetchSourceInput,
  FetchSourceResult,
  RunBudget,
  SafeFetcher,
} from "../fetch/index.js";
import { createResearchServices, type ResearchServices } from "../services.js";

/**
 * A temporary vault, a file-backed temporary store, a scripted fetcher and the real research
 * services, for the service package's own tests. No network, no model, no process. Test code only.
 */

const TEST_BASE = join(homedir(), ".ccc-test");

export const URL_ONE = "https://one.example.invalid/releases.atom";
export const URL_TWO = "https://two.example.invalid/releases.atom";
export const URL_THREE = "https://three.example.invalid/releases.atom";

export const THREE: readonly ResearchSourceEntry[] = [
  { label: "Alpha releases", url: URL_ONE, kind: "feed" },
  { label: "Beta releases", url: URL_TWO, kind: "feed" },
  { label: "Gamma releases", url: URL_THREE, kind: "feed" },
];

export function atom(text: string, title = "Release"): string {
  return `<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Feed</title><entry><title>${title}</title><link href="https://entries.example.invalid/e"/><updated>2026-10-14T10:00:00Z</updated><summary>${text}</summary></entry></feed>`;
}

export function ok(url: string, text: string): FetchSourceResult {
  return {
    ok: true,
    bytes: new TextEncoder().encode(text),
    text,
    charset: "utf-8",
    contentType: "application/atom+xml",
    finalUrl: url,
  };
}

export function defaultResponses(): Record<string, FetchSourceResult> {
  return {
    [URL_ONE]: ok(
      URL_ONE,
      atom("The maintainers confirmed that the alpha parser is now twice as fast in this release."),
    ),
    [URL_TWO]: ok(
      URL_TWO,
      atom("The beta command line tool now reports progress while it downloads packages."),
    ),
    [URL_THREE]: ok(
      URL_THREE,
      atom("The gamma runtime patch removes a memory leak in the scheduler component."),
    ),
  };
}

export interface KitOptions {
  readonly sources?: readonly ResearchSourceEntry[];
  readonly responses?: Readonly<Record<string, FetchSourceResult>>;
  readonly respond?: (input: FetchSourceInput) => FetchSourceResult | Promise<FetchSourceResult>;
  readonly fetcher?: Pick<SafeFetcher, "fetchSources">;
  readonly transport?: TextTransport;
  readonly summariserId?: SummariserId;
  readonly vault?: boolean;
  readonly writeConfig?: boolean;
  readonly now?: () => Date;
  readonly watchdogMs?: number;
  readonly scheduleTimeout?: (fire: () => void, ms: number) => () => void;
  readonly publishThrows?: boolean;
  readonly chooseThrows?: boolean;
}

export interface Kit {
  readonly dir: string;
  readonly vaultRoot: string;
  readonly runtimeDir: string;
  readonly sourcesPath: string;
  readonly store: ReturnType<typeof openStore>;
  readonly services: ResearchServices;
  readonly events: { type: string; payload: ResearchUpdatedPayload }[];
  readonly fetchCalls: { urls: string[]; budget: RunBudget | undefined }[];
  readonly transportInputs: string[];
  readonly logs: Record<string, unknown>[];
  close(): void;
}

export function createKit(options: KitOptions = {}): Kit {
  mkdirSync(TEST_BASE, { recursive: true });
  const dir = mkdtempSync(join(TEST_BASE, "k-"));
  const vaultRoot = join(dir, "vault");
  const runtimeDir = join(dir, "runtime");
  mkdirSync(vaultRoot, { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });
  if (options.vault !== false) initializeVault(vaultRoot);
  const store = openStore(join(runtimeDir, "operational.db"));
  applyMigrations(store.db);

  const sourcesPath = join(runtimeDir, "research-sources.json");
  if (options.writeConfig !== false) {
    const config: ResearchSourcesConfig = {
      topicLabel: "Developer tooling",
      summariserModel: "claude-haiku-5-5",
      sources: [...(options.sources ?? THREE)],
    };
    writeFileSync(sourcesPath, JSON.stringify(config), { mode: 0o600 });
  }

  const responses = options.responses ?? defaultResponses();
  const events: Kit["events"] = [];
  const fetchCalls: Kit["fetchCalls"] = [];
  const transportInputs: string[] = [];
  const logs: Record<string, unknown>[] = [];

  const fetcher: Pick<SafeFetcher, "fetchSources"> = options.fetcher ?? {
    async fetchSources(inputs, budget) {
      fetchCalls.push({ urls: inputs.map((input) => input.url), budget });
      const out: FetchSourceResult[] = [];
      for (const input of inputs) {
        out.push(
          options.respond !== undefined
            ? await options.respond(input)
            : (responses[input.url] ?? { ok: false, code: "network-error" }),
        );
      }
      return out;
    },
  };
  const base = options.transport ?? createExtractiveTransport();
  const transport: TextTransport = {
    complete(request) {
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
    chooseSummariser: () => {
      if (options.chooseThrows === true) throw new Error("no summariser");
      return { transport, id: options.summariserId ?? "extractive" };
    },
    now: options.now ?? (() => new Date("2026-10-15T09:00:00.000Z")),
    log: {
      warn: (fields) => logs.push({ level: "warn", ...fields }),
      error: (fields) => logs.push({ level: "error", ...fields }),
    },
    ...(options.watchdogMs === undefined ? {} : { watchdogMs: options.watchdogMs }),
    ...(options.scheduleTimeout === undefined ? {} : { scheduleTimeout: options.scheduleTimeout }),
  });

  return {
    dir,
    vaultRoot,
    runtimeDir,
    sourcesPath,
    store,
    services,
    events,
    fetchCalls,
    transportInputs,
    logs,
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
