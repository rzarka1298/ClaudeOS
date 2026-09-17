// Owned by Phase 7 (Connectors / research pipeline). This package exists
// now, with an empty functional surface, so the import-boundary lint
// (REPO-03, plan 01-03) has a real package to constrain from day one.

/**
 * An integration with an external service that requires credentials and
 * scopes. Per CONTEXT.md, a Connector has a write path, so every write it
 * performs originates as a Proposal (ADR-0012) — this package will import
 * `@ccc/domain`'s `CapabilityToken` type once real write methods land.
 */
export interface Connector {
  readonly connectorId: string;
}
