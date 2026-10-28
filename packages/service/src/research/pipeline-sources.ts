import {
  type ResearchSourceEntry,
  type ResearchSourcesConfig,
  rawSnapshotPathFor,
  type SanitiseCounts,
  type SourceFailureCode,
  type SourceReference,
  SourceReferenceSchema,
} from "@ccc/domain";
import {
  JobRunNotFoundError,
  JobRunNotInFlightError,
  type ResearchSourceRecord,
  ResearchSourceRecordConflictError,
  ResearchSourceRecordError,
} from "@ccc/operational-store";
import {
  canonicaliseUrl,
  evidenceText,
  htmlToText,
  parseDelimitedBlocks,
  parseFeed,
  renderFeedText,
} from "@ccc/research";
import { SourceNoteError } from "@ccc/vault-repo";
import { USER_CONTENT_MAX_CHARS } from "./anthropic-request.js";
import { contentHashFor, sourceIdFor } from "./hash.js";
import type { RunTrace } from "./pipeline-trace.js";

/**
 * Source preparation and the summariser port call (09-12, D-12): the pure helpers the stages use to
 * turn a fetched body into an evidence text, trim it to the transport's cap, and bind it to a
 * provenance record. Moved out of pipeline.ts verbatim.
 */

// ---------------------------------------------------------------------------
// The summariser step

const BLOCK_HEADER = /^<<<SRC id=[0-9a-f]{32} nonce=([0-9a-f]{16,64})>>>$/m;

/**
 * True when `delimitedContent` is exactly one block per fetched source id, in order, and nothing
 * else: the blocks parsed back out and recomposed reproduce the content byte for byte. The
 * summariser port trusts its caller that the content is delimited with exactly these ids (its
 * folder cannot import `@ccc/research`), so the pipeline asserts it before any model call
 * (wave 2 opus review).
 */
export function checkDelimited(delimitedContent: string, sourceIds: readonly string[]): boolean {
  const blocks = parseDelimitedBlocks(delimitedContent);
  if (blocks.length !== sourceIds.length || blocks.length === 0) return false;
  if (!blocks.every((block, index) => block.sourceId === sourceIds[index])) return false;
  const nonce = BLOCK_HEADER.exec(delimitedContent)?.[1];
  if (nonce === undefined) return false;
  const recomposed = blocks
    .map(
      (block) =>
        `<<<SRC id=${block.sourceId} nonce=${nonce}>>>\n${block.text}\n<<<END nonce=${nonce}>>>`,
    )
    .join("\n");
  return recomposed === delimitedContent;
}

// ---------------------------------------------------------------------------
// Preparing sources

export interface PreparedSource {
  readonly index: number;
  readonly entry: ResearchSourceEntry;
  readonly sourceId: string;
  /** The EVIDENCE TEXT: the exact string the summariser is shown, and the raw note's body. */
  readonly evidence: string;
  readonly counts: SanitiseCounts;
  readonly truncated: boolean;
  readonly ref: SourceReference;
}

export type Prepared =
  | { readonly ok: true; readonly source: PreparedSource }
  | { readonly ok: false; readonly code: SourceFailureCode; readonly sourceId: string };

export function idFor(entry: ResearchSourceEntry): string {
  const canonical = canonicaliseUrl(entry.url);
  return sourceIdFor(canonical.ok ? canonical.url : entry.url);
}

export function prepare(
  index: number,
  entry: ResearchSourceEntry,
  fetched: { readonly text: string },
  retrievedAt: string,
  nonce: string,
): Prepared {
  const fallbackId = idFor(entry);
  try {
    const canonical = canonicaliseUrl(entry.url);
    if (!canonical.ok) return { ok: false, code: "parse-failure", sourceId: fallbackId };

    let text: string;
    let counts: SanitiseCounts;
    let truncated = false;
    let author: string | null = null;
    let publishedAt: string | null = null;
    if (entry.kind === "feed") {
      const parsed = parseFeed(fetched.text);
      if (parsed.entries.length === 0) {
        return {
          ok: false,
          code: parsed.format === "unknown" ? "parse-failure" : "empty-content",
          sourceId: fallbackId,
        };
      }
      text = renderFeedText(parsed.entries);
      counts = { ...parsed.report };
      author = parsed.entries.find((candidate) => candidate.author !== null)?.author ?? null;
      const retrievedMs = Date.parse(retrievedAt);
      for (const candidate of parsed.entries) {
        // An instant later than the retrieval is a feed's mistake, not a publication date.
        if (
          candidate.updated !== null &&
          Date.parse(candidate.updated) <= retrievedMs &&
          (publishedAt === null || candidate.updated > publishedAt)
        ) {
          publishedAt = candidate.updated;
        }
      }
    } else {
      const page = htmlToText(fetched.text);
      text = page.text;
      counts = { ...page.report };
      truncated = page.truncated;
    }

    const evidence = evidenceText(text, nonce);
    if (evidence.trim() === "") return { ok: false, code: "empty-content", sourceId: fallbackId };
    const sourceId = sourceIdFor(canonical.url);
    const contentHash = contentHashFor(evidence);
    const base = {
      sourceType: entry.kind === "feed" ? ("feed-entry" as const) : ("web-page" as const),
      id: sourceId,
      // The owner's own label, never a remote title: nothing remote reaches the reference's title.
      title: entry.label,
      canonicalUrl: canonical.url,
      publishedAt,
      retrievedAt,
      contentHash,
      snapshotPath: rawSnapshotPathFor(sourceId, contentHash),
      accessClass: "public" as const,
    };
    // A feed author or date the schema refuses is dropped rather than failing the whole source.
    let ref: SourceReference | null = null;
    for (const variant of [
      { author, publishedAt },
      { author: null, publishedAt },
      { author, publishedAt: null },
      { author: null, publishedAt: null },
    ]) {
      const parsedRef = SourceReferenceSchema.safeParse({ ...base, ...variant });
      if (parsedRef.success) {
        ref = parsedRef.data;
        break;
      }
    }
    if (ref === null) return { ok: false, code: "parse-failure", sourceId };
    return {
      ok: true,
      source: { index, entry, sourceId, evidence, counts, truncated, ref },
    };
  } catch {
    return { ok: false, code: "parse-failure", sourceId: fallbackId };
  }
}

/**
 * The provenance record of one prepared source (07-FIX6, ADR-0030): what the store keeps of a raw
 * note this run wrote and read back. Null when the reference has no https address to record (the
 * pipeline builds every research reference with one, so this is a guard, not a path): the source
 * is then refused alone, never recorded with an invented address.
 */
export function sourceRecordFor(
  source: Pick<PreparedSource, "sourceId" | "ref">,
  jobRunId: string,
  recordedAt: string,
): ResearchSourceRecord | null {
  if (source.ref.canonicalUrl === undefined) return null;
  return {
    jobRunId,
    sourceId: source.sourceId,
    canonicalUrl: source.ref.canonicalUrl,
    contentHash: source.ref.contentHash,
    snapshotPath: source.ref.snapshotPath,
    label: source.ref.title,
    recordedAt,
  };
}

const IDS_LABEL = "\nSource IDs: ";

/**
 * Keeps sources, in order, while the summariser input stays within the transport's cap. A source
 * whose block does not fit is dropped whole (never cut mid-block), so the delimiting stays valid
 * and the ids stay consistent; later, smaller sources may still fit.
 */
export function trimToInputCap(
  ready: readonly PreparedSource[],
  nonce: string,
  cap: number = USER_CONTENT_MAX_CHARS,
): { kept: PreparedSource[]; dropped: PreparedSource[] } {
  const overhead =
    `<<<SRC id=${"0".repeat(32)} nonce=${nonce}>>>\n`.length + `\n<<<END nonce=${nonce}>>>`.length;
  let total = IDS_LABEL.length;
  const kept: PreparedSource[] = [];
  const dropped: PreparedSource[] = [];
  for (const source of ready) {
    // block, the newline joining it to the previous block, its id in the id list, the ", " before it
    const add = overhead + source.evidence.length + 32 + (kept.length > 0 ? 1 + 2 : 0);
    if (total + add <= cap) {
      kept.push(source);
      total += add;
    } else {
      dropped.push(source);
    }
  }
  return { kept, dropped };
}

/**
 * Records which sources failed, which were read, and (only once a report is published) which
 * contributed, in allowlist order. `contributed` is false until the whole publication succeeded,
 * so a run that fails never says a source contributed.
 */
export function recordSources(
  trace: RunTrace,
  config: ResearchSourcesConfig,
  outcomes: readonly Prepared[],
  dropped: ReadonlySet<number>,
  refused: ReadonlySet<number>,
  contributed: boolean,
): void {
  trace.sources = [];
  trace.unavailable = [];
  trace.sourceCount = 0;
  config.sources.forEach((entry, index) => {
    const outcome = outcomes[index];
    let code: SourceFailureCode | null = null;
    let sourceId = idFor(entry);
    if (outcome === undefined) code = "network-error";
    else if (!outcome.ok) {
      code = outcome.code;
      sourceId = outcome.sourceId;
    } else {
      sourceId = outcome.source.sourceId;
      if (dropped.has(index)) code = "oversize";
      else if (refused.has(index)) code = "parse-failure";
    }
    if (code !== null) {
      trace.sources.push({ label: entry.label, contributed: false, code });
      trace.unavailable.push({ sourceId, label: entry.label, code });
    } else if (contributed) {
      trace.sourceCount += 1;
      trace.sources.push({ label: entry.label, contributed: true, code: null });
    } else {
      trace.sources.push({ label: entry.label, contributed: false, code: null, status: "fetched" });
    }
  });
}

/**
 * True when a stored raw note names the same source this run's reference does. A raw note that
 * already exists is reused (it is content-addressed), so what it says about WHERE the text came
 * from must agree with what the report will cite: the address, the source kind, the access class,
 * the hash and the snapshot path. The label and the retrieval time are this run's own (an earlier
 * run may have named the source differently and fetched it earlier), so they may differ (07-14,
 * opus m8).
 */
export function sameBinding(stored: SourceReference, cited: SourceReference): boolean {
  return (
    stored.id === cited.id &&
    stored.sourceType === cited.sourceType &&
    stored.canonicalUrl === cited.canonicalUrl &&
    stored.deepLink === cited.deepLink &&
    stored.contentHash === cited.contentHash &&
    stored.snapshotPath === cited.snapshotPath &&
    stored.accessClass === cited.accessClass
  );
}

/** Thrown inside the raw loop when a stored snapshot is not the one this run's evidence names. */
export class RawSnapshotRefused extends Error {
  constructor() {
    super("raw snapshot refused");
    this.name = "RawSnapshotRefused";
  }
}

/**
 * True for a failure that belongs to ONE source's raw snapshot or record: the file at the
 * content-addressed path was edited, rewritten or damaged since it was written (or shares the hash
 * prefix of other content), so it is not the evidence this run holds; or the source's provenance
 * record is refused for its own content (a value outside the closed shapes, or a different record
 * for the same address already made in this run, as when the allowlist names one address twice
 * under two labels). Any other failure (a folder that cannot be written, a store fault) is the
 * run's.
 */
export function isRawSnapshotRefusal(error: unknown): boolean {
  return (
    error instanceof RawSnapshotRefused ||
    error instanceof ResearchSourceRecordError ||
    error instanceof ResearchSourceRecordConflictError ||
    (error instanceof SourceNoteError && error.reason === "existing-unreadable")
  );
}

/** True for a store refusal because the run itself is gone or has ended (not a fault of one source). */
export function isRunGone(error: unknown): boolean {
  return error instanceof JobRunNotFoundError || error instanceof JobRunNotInFlightError;
}
