---
status: accepted
satisfies: ADR-09 (completes — the scope half is ADR 0013; this record is key composition, run states and outcomes, recovery and the catch-up seam)
---

# A job run has a manual or a scheduled key, a state beside an outcome, and is recovered to stale rather than invented

`ADR-09` of the PRD asks for the scheduler and missed-run semantics to be recorded, including how the idempotency key is
composed. ADR 0013, titled "Milestone 1 records the scheduler architecture but builds only a manual trigger", settled the
scope: a durable `JobRun` record, an idempotency key built from the job and its schedule window in an IANA zone, and a
manual trigger, with no clock loop. This record completes the scope half. It fixes the key forms, what a run's state and
outcome mean, what happens to a run that a crash interrupts, how a second press is handled, how long raw snapshots are
kept, and the seam milestone 2 will use for catch-up. The code is in `packages/scheduler` (pure functions, domain imports
only) and the store extension of plan 07-06.

## Context

Phase 7 produces one cited report from a press of Run now. The ROADMAP asks for the record and the key now so that milestone
2's catch-up policy has a correct foundation rather than a retrofit. Two things must not happen: a press must never use up
the window a scheduled run is owed (PRD 9.7), and a daylight-saving change must never create two windows for one date.

## Decision

### 1. Key composition

A key is a string in exactly one of two forms. The grammar keeps them apart, so one can never equal or consume the other.

| Form | Composition | Example |
|---|---|---|
| manual | `<jobId>:manual:<runId>` | `research.daily-tech:manual:0mfk1a2b3c4d5e6f7a8b9c0d2` |
| scheduled | `<jobId>:<cadence>:<YYYY-MM-DD>@<IANA zone>` | `research.daily-tech:daily:2026-10-13@America/New_York` |

A job id is lower-case words joined by single dots or hyphens and holds neither a colon nor an at sign. A run id is the
service-minted run id of ADR 0006 (25 lower-case base-36 characters), which holds neither. The middle segment of a manual
key is the literal `manual`; a scheduled key carries a cadence there (only `daily` exists in milestone 1) and always ends in
`@<zone>`. `parseJobRunKey` accepts exactly these two shapes and returns nothing for anything else; a parsed manual key never
carries a window.

The date in a scheduled key is the local date the occurrence belongs to, in the key's zone. The zone sits inside the key on
purpose. If the machine's configured zone changes, the next occurrence is keyed under the new zone, which opens a new window
deliberately rather than silently reusing the old one. The consequence is that one calendar date can produce a duplicate run
across a zone change. Milestone 1 accepts that, because it never produces a scheduled key; milestone 2 may add a same-date
guard when it builds the loop.

A zone is valid when `Intl.DateTimeFormat` accepts it, with `UTC` allowed explicitly because the platform's supported-values
list omits it. A spelling that differs from the canonical name only by case, and an offset string such as `+01:00`, are
refused so that one zone has one spelling inside a key.

### 2. Manual runs never touch a scheduled window

A press of Run now writes a manual key. A manual run never consumes or alters a scheduled window (PRD 9.7): it cannot write a
scheduled key, and a scheduled key cannot be written by a press. For a manual run `scheduled_for`, which is not null in the
table, holds the start instant of the press.

### 3. Windows are local dates, computed with Intl only

Node 24 has no Temporal, so `windowDate` (the local date of an instant in a zone) and `wallToInstant` (the instant of a local
wall time) are derived from `Intl.DateTimeFormat` offsets. Both fall-back hours of a change-over day map to the same local
date, so daylight saving cannot open two windows for one date. A wall time that falls in a spring-forward gap moves forward by
the length of the gap, and a wall time that happens twice resolves to its first occurrence. A skipped day such as
Pacific/Apia's 2011-12-30 maps its instants to the day after. These are tested against real offsets and neither function
reads the machine zone or the clock.

### 4. State and outcome are separate

A job run's `state` reuses the run state vocabulary (`running`, then `completed`, `failed` or `stale`). Its outcome is a
second field with three values.

- `failure`: no source succeeded, or a stage error occurred (the summariser, or a vault write).
- `partial`: at least one source succeeded and at least one failed.
- `success`: every source succeeded and no stage error occurred.

A partial report is a `completed` run with outcome partial; partial is never a failure (ADR 0002 keeps partiality beside the
state, never as a fifth freshness value). The outcome is null while the run is running and stays null for a stale run, so a
run whose end was never observed does not get an outcome it did not earn. The outcomes `skipped` and `missed` are reserved in
this vocabulary because PRD 9.7 lists them. Milestone 1 never produces them and the code does not define them; a later
phase appends them to the closed list.

### 5. Recovery: an interrupted run becomes stale, never an invented terminal state

On start the service marks every non-terminal run it finds as `stale`. A research run is a pair: a row in `runs` and a row in
`job_runs`. Recovery sets both rows to `stale` in one transaction, with the error code `interrupted` on the job run. A
`runs` row alone going stale would leave the `job_runs` row `running` and the in-flight lock below would block every future
run, so the two tables change together or not at all. A stale run keeps a null outcome. After recovery a new press succeeds.

### 6. The in-flight lock

At most one run per job is in flight. Two layers enforce it. An in-process map from job to run id guards the same critical
section as the database insert, so two presses in one process cannot both pass. A partial unique index,
`job_runs_one_inflight_per_job`, on `job_runs(job_key)` where the state is queued, starting or running is the crash-safe
backstop: it holds even if the in-process map is lost. A second press while a run is in flight does not start another and
returns the running run, so the plugin shows the run that is already under way.

### 7. Raw snapshot retention

Raw source snapshots are content-addressed, one file per changed fetch, and an unchanged re-fetch writes nothing.
Milestone 1 deletes nothing: raw snapshots are never deleted, because no delete path exists and `vault.delete` is a reserved
approval row (ADR 0026). Growth is bounded by the number of distinct source contents, and a retention policy waits for the
phase that enables a delete executor.

### 8. The milestone-2 catch-up seam

`windowDate` and `wallToInstant` ship now because the key and its tests need them. The catch-up entry point,
`decideCatchUp(lastSuccessfulWindow, now, zone, maxDelay)`, is documented here and not built: it is milestone-2 work. It will
compare the last successful window with the window of `now` and decide whether to run one missed execution, under the rule
in the PRD that at most one eligible missed execution runs on wake or restart. No clock loop exists in milestone 1, so
nothing calls it.

## Consequences

- The idempotency key and the window arithmetic are pure, tested functions the store and the pipeline call.
- A press and a clock can never be confused for one another, in the key or in the table.
- A crash leaves an honest `stale` run in both tables and never blocks the next press.
- Two costs are accepted: a zone change can yield a second run for one date, and raw snapshots accumulate until a delete
  path is approved.
