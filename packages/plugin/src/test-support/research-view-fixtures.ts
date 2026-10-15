import type {
  ResearchListResponse,
  ResearchListRow,
  ResearchRunResponse,
  ResearchStatusResponse,
} from "@ccc/domain/research-routes.js";

/**
 * Synthetic data for the Research view tests (plan 07-11). Every name, host and id is made up
 * (PRIV-04): hosts are reserved `.invalid` names and ids are plain lowercase letters and digits
 * of the right length.
 */

/** The frozen "now" every Research test reads: 2026-10-14 12:00 UTC. */
export const RESEARCH_NOW_MS = Date.parse("2026-10-14T12:00:00.000Z");
export const RESEARCH_ZONE = "UTC";
export const RESEARCH_TOPIC = "Developer tooling and open-source releases";

/** A 25-character id (the run id and note id shape) built from a short seed. */
export function id25(seed: string): string {
  const clean = seed.toLowerCase().replace(/[^0-9a-z]/g, "");
  return (clean + "0".repeat(25)).slice(0, 25);
}

export function iso(offsetMinutesFromNow: number): string {
  return new Date(RESEARCH_NOW_MS + offsetMinutesFromNow * 60_000).toISOString();
}

type ReadableRow = Extract<ResearchListRow, { readable: true }>;
type UnreadableRow = Extract<ResearchListRow, { readable: false }>;

/** A readable report row, newest when `index` is small. Generated `index` hours before now. */
export function reportRow(index: number, overrides: Partial<ReadableRow> = {}): ReadableRow {
  return {
    readable: true,
    noteId: id25(`note${index}`),
    title: `${RESEARCH_TOPIC} — Oct ${14 - Math.min(index, 13)}, 2026`,
    generatedAt: iso(-60 * (index + 1)),
    partial: false,
    sourceCount: 3,
    sourceTotal: 3,
    itemCount: 12,
    unavailableCount: 0,
    ...overrides,
  };
}

export function unreadableRow(name = "broken-report.md"): UnreadableRow {
  return {
    readable: false,
    fileName: name,
    notePath: `global/output/${name}`,
  };
}

export function listOf(
  rows: readonly ResearchListRow[],
  nextCursor: string | null = null,
): ResearchListResponse {
  return { rows: [...rows], nextCursor };
}

export const EMPTY_STATUS: ResearchStatusResponse = {
  lastSuccess: null,
  lastFailure: null,
  inFlight: null,
  latestUnknown: null,
  configuredSources: null,
  topicLabel: null,
};

export const CONFIGURED_SOURCES = [
  { label: "Example tools changelog", host: "changelog.example.invalid" },
  { label: "Sample runtime releases", host: "releases.sample.invalid" },
  { label: "Demo language blog", host: "blog.demo.invalid" },
] as const;

export function statusOf(overrides: Partial<ResearchStatusResponse> = {}): ResearchStatusResponse {
  return { ...EMPTY_STATUS, ...overrides };
}

export function runResponse(overrides: Partial<ResearchRunResponse> = {}): ResearchRunResponse {
  return { runId: id25("run1"), alreadyRunning: false, state: "running", ...overrides };
}
