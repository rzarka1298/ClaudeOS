import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type ReportItem,
  rawSnapshotPathFor,
  type SanitiseCounts,
  type SourceReference,
  type SummariserId,
} from "@ccc/domain";
import { applyMigrations, type OperationalStore, openStore } from "@ccc/operational-store";
import { evidenceText } from "@ccc/research";
import {
  finaliseReportNote,
  initializeVault,
  writeRawSourceNote,
  writeReportNote,
} from "@ccc/vault-repo";
import { contentHashFor, sourceIdFor } from "../hash.js";

/**
 * Builds reports in a temporary vault for the research view model and route tests (plan 07-14):
 * real raw source notes (the evidence text stored byte for byte, the hash recomputed) and a real
 * finalised report written through the vault-repo writers. Test code only.
 */

const TEST_BASE = join(homedir(), ".ccc-test");
const NONCE = "0123456789abcdef0123456789abcdef";

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

export interface ReportSourceSpec {
  readonly url: string;
  readonly title?: string;
  readonly author?: string | null;
  /** The text the source holds; stored as its evidence text. */
  readonly text: string;
}

export interface ReportItemSpec {
  readonly kind: ReportItem["kind"];
  readonly text: string;
  readonly quote?: string;
  /** Indexes into the report's sources. */
  readonly cites: readonly number[];
}

export interface ReportSpec {
  readonly sources?: readonly ReportSourceSpec[];
  readonly items?: readonly ReportItemSpec[];
  readonly generatedAt?: string;
  readonly runId?: string;
  readonly topicLabel?: string;
  readonly sourceTotal?: number;
  readonly unavailable?: readonly { label: string; code: "timeout" | "network-error" }[];
  readonly summariser?: SummariserId;
  /** Leaves the report as `deliverable` (not finalised). */
  readonly unfinalised?: boolean;
}

export interface BuiltReport {
  readonly noteId: string;
  readonly path: string;
  readonly runId: string;
  readonly sourceRefs: readonly SourceReference[];
  readonly rawPaths: readonly string[];
}

export interface ReportVault {
  readonly root: string;
  readonly store: OperationalStore;
  addReport(spec?: ReportSpec): BuiltReport;
  cleanup(): void;
}

let counter = 0;

/** A run id: 25 characters of `[0-9a-z]`, unique within the process. */
export function testRunId(): string {
  counter += 1;
  return `r${counter.toString(36).padStart(5, "0")}${"abcdefghijklmnopqrst".slice(0, 19)}`;
}

export function createReportVault(): ReportVault {
  mkdirSync(TEST_BASE, { recursive: true });
  const base = mkdtempSync(join(TEST_BASE, "rvm-"));
  const root = join(base, "vault");
  mkdirSync(root, { recursive: true });
  initializeVault(root);
  const store = openStore(join(base, "operational.db"));
  applyMigrations(store.db);

  function addReport(spec: ReportSpec = {}): BuiltReport {
    const sources = spec.sources ?? [
      {
        url: "https://one.example.invalid/feed.atom",
        text: "The maintainers confirmed that the alpha parser is now twice as fast in this release.",
      },
    ];
    const items = spec.items ?? [
      {
        kind: "source-fact" as const,
        text: "The alpha parser is faster.",
        quote: "the alpha parser is now twice as fast",
        cites: [0],
      },
    ];
    const generatedAt = spec.generatedAt ?? "2026-10-14T10:00:00.000Z";
    const runId = spec.runId ?? testRunId();
    const refs: SourceReference[] = [];
    const rawPaths: string[] = [];
    for (const [index, source] of sources.entries()) {
      const evidence = evidenceText(source.text, NONCE);
      const id = sourceIdFor(source.url);
      const hash = contentHashFor(evidence);
      const ref: SourceReference = {
        sourceType: "feed-entry",
        id,
        title: source.title ?? `Source ${index + 1}`,
        canonicalUrl: source.url,
        author: source.author ?? null,
        publishedAt: null,
        retrievedAt: generatedAt,
        contentHash: hash,
        snapshotPath: rawSnapshotPathFor(id, hash),
        accessClass: "public",
      };
      writeRawSourceNote({
        vaultRoot: root,
        sourceRef: ref,
        sanitise: ZERO_COUNTS,
        text: evidence,
        canonicalHash: contentHashFor,
        now: new Date(generatedAt),
      });
      refs.push(ref);
      rawPaths.push(ref.snapshotPath);
    }
    const reportItems: ReportItem[] = items.map((item) => ({
      kind: item.kind,
      text: item.text,
      ...(item.quote === undefined ? {} : { quote: item.quote }),
      citedSourceIds: item.cites.map((at) => refs[at]?.id ?? ""),
    }));
    const written = writeReportNote({
      vaultRoot: root,
      topicLabel: spec.topicLabel ?? "Developer tooling",
      generatedAt,
      jobRunId: runId,
      summariser: spec.summariser ?? "extractive",
      sourceTotal: spec.sourceTotal ?? sources.length + (spec.unavailable?.length ?? 0),
      unavailableSources: [...(spec.unavailable ?? [])],
      sourceRefs: refs,
      sourceHandling: refs.map((ref) => ({ sourceId: ref.id, counts: ZERO_COUNTS })),
      items: reportItems,
      now: new Date(generatedAt),
    });
    if (spec.unfinalised !== true) {
      finaliseReportNote({ vaultRoot: root, path: written.path, now: new Date(generatedAt) });
    }
    return { noteId: written.id, path: written.path, runId, sourceRefs: refs, rawPaths };
  }

  return {
    root,
    store,
    addReport,
    cleanup() {
      store.close();
      rmSync(base, { recursive: true, force: true });
    },
  };
}

/** Three-byte characters: U+5B57 is three bytes in UTF-8. */
export const THREE_BYTE_CHARACTER = "\u5b57";

/** A quote of four three-byte words (239 characters) that the shared quote predicate accepts. */
export function worstCaseQuote(seed: number): string {
  const word = `${THREE_BYTE_CHARACTER.repeat(58)}${String.fromCodePoint(0x4e00 + seed)}`;
  return [word, word, word, word].join(" ");
}

/**
 * The worst-case report of the socket-budget work (research Pitfall 11): twelve sources with
 * maximum-length three-byte titles, and `itemCount` findings with maximum-length three-byte text
 * and quotes, each citing eight sources. Every quote is in the stored text of every source it cites.
 */
export function addWorstCaseReport(vault: ReportVault, itemCount = 25): BuiltReport {
  const quotes = Array.from({ length: itemCount }, (_, index) => worstCaseQuote(index));
  const text = quotes.join("\n");
  const sources = Array.from({ length: 12 }, (_, index) => ({
    url: `https://s${index}.example.invalid/feed.atom`,
    title: THREE_BYTE_CHARACTER.repeat(200),
    text,
  }));
  const items: ReportItemSpec[] = quotes.map((quote, index) => ({
    kind: "source-fact" as const,
    text: THREE_BYTE_CHARACTER.repeat(600),
    quote,
    cites: [0, 1, 2, 3, 4, 5, 6, 7].map((offset) => (index + offset) % 12),
  }));
  return vault.addReport({ sources, items });
}
