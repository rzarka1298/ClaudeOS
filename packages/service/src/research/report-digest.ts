import { createHash } from "node:crypto";
import type { ReportFrontmatter } from "@ccc/domain";

/**
 * The digest of a research report's served content (07-FIX6b, ADR-0030).
 *
 * The pipeline records this SHA-256 in the operational store when it finalises a report, and the
 * reader recomputes it from the report it parses from the vault. A quote is shown as verified only
 * when the two are equal, so a report edited in place after the run (a claim reworded, a kind
 * flipped to source-fact, another real quote of the same source swapped in, the partial flag
 * flipped, a source added, dropped or reordered) is no longer the run's own report, even though it
 * keeps its note id and its run id and every raw source note still verifies.
 *
 * What is covered is everything the reader serves from the report: the identity (note id, run id,
 * topic, generation instant, summariser), the run facts (partial, source total, the unavailable
 * sources with their codes), every cited source reference in order (the order is the citation
 * numbering), the per-source handling counts and every finding with its kind, text, quote and
 * cited source ids in order. What is not covered is generic note bookkeeping that is never served
 * (type, stage, timestamps of the note file, tags). The stage is left out on purpose: finalising
 * changes it, and the digest is taken of the finalised report.
 *
 * The serialisation is canonical: object keys are sorted, an absent optional value is omitted,
 * arrays keep their order and strings are written exactly (no normalisation), so the same parsed
 * report always gives the same digest and any change to a covered value gives another.
 */

const DIGEST_VERSION = 1;

type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

function canonical(value: unknown): Json {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") return value;
  if (Array.isArray(value)) return value.map((entry) => canonical(entry));
  if (typeof value === "object" && value !== undefined) {
    const out: Record<string, Json> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry !== undefined) out[key] = canonical(entry);
    }
    return out;
  }
  return null;
}

/** SHA-256 (lowercase hex) of the canonical serialisation of the report's served content. */
export function reportContentDigest(report: ReportFrontmatter): string {
  const covered = {
    version: DIGEST_VERSION,
    id: report.id,
    jobRunId: report.jobRunId,
    topicLabel: report.topicLabel,
    generatedAt: report.generatedAt,
    summariser: report.summariser,
    partial: report.partial,
    sourceTotal: report.sourceTotal,
    unavailableSources: report.unavailableSources,
    sourceRefs: report.sourceRefs,
    sourceHandling: report.sourceHandling,
    items: report.items,
  };
  return createHash("sha256")
    .update(JSON.stringify(canonical(covered)), "utf8")
    .digest("hex");
}
