---
status: accepted
satisfies: ADR-08
---

# Write methods are capability-typed, and the Proposal ID is the idempotency key

`APPR-01` requires the approval engine to be a choke point enforced at the
import boundary rather than by convention. A write method on a Connector is
therefore typed such that it cannot be called without a token the approval
engine issues on Approval. The import-boundary lint remains as a second layer.
An approved write's idempotency key is the Proposal's own ID.

## Considered Options

**A central registry listing operation types that require approval.**
Rejected. It is readable in one place, but it drifts the moment someone adds
an adapter method and forgets to register it — and it drifts *silently*, which
is the exact failure mode `APPR-01` is written to prevent. With capability
typing, forgetting means it does not compile.

## Consequences

- Using the Proposal ID as the idempotency key gives `APPR-10` the right
  semantics: one Approval authorises one execution, a retry of that execution
  reuses the key, and a re-proposed action after expiry is a different Proposal
  with a different key — which is what `APPR-06` needs.
- Collectors are structurally outside this scheme. They hold no credentials and
  have no write path, so nothing they do can be consequential.
