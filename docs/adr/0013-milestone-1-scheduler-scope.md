---
status: accepted
satisfies: ADR-09
---

# Milestone 1 records the scheduler architecture but builds only a manual trigger

Phase 7 needs one cited report to exist with provenance, not a report that
arrived at 08:00. We implement the durable `JobRun` record and the idempotency
key — composed of the job ID and the schedule window identified in its IANA
timezone — and a manual trigger. No clock loop fires in milestone 1.

## Considered Options

**A real cron loop now, with catch-up deferred.** Rejected as the worst of
both: it looks finished and then silently misbehaves the first time the laptop
sleeps through a window. That is precisely the `SCHED-02` failure milestone 2
is meant to design for deliberately rather than inherit.

## Consequences

- The idempotency key is designed now, so milestone 2's catch-up policy has a
  correct foundation rather than a retrofit.
- `RSRCH-06`'s automation-run record and `DIAG-05`'s last-successful and
  last-failed display are real in milestone 1, driven by manual runs.
