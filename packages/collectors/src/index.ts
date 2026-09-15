// Owned by Phase 5 (Claude Code hook package, session collectors, usage
// aggregation). This package exists now, with an empty functional surface,
// so the import-boundary lint (REPO-03, plan 01-03) has a real package to
// constrain from day one.

/**
 * A local, read-only source of telemetry. Per CONTEXT.md, a Collector
 * holds no credentials and has no write path, so nothing it does is ever
 * a Proposal — structurally outside the capability-typed write scheme
 * (ADR-0012).
 */
export interface Collector {
  readonly collectorId: string;
}
