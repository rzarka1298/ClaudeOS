---
status: accepted
satisfies: ADR-13
supersedes-in-part: 0024
---

# Codex data is read through allowlisted ports, gated by shape, and used only for owner-visible sessions and headroom

## Context

The owner added Codex co-work to v1 on 2026-09-30 and chose the Antigravity
terminal as the default launcher on 2026-10-04 (D-01, D-12). Phase 05.1 builds
against the merged Phase 4, 5 and 6 tree. It reuses launcher ports, attribution,
the shared analysis setting and the approval classification table. It does
not create an orchestration engine. The product never dispatches work or buys
credits (D-04). ADR-13 is the requirement; 0028 is the file number.

Codex's private store and experimental app-server protocol can change without
this product changing. Guessing a state or treating missing capacity as zero
would mislead the owner. The structural privacy boundary must also survive an
upstream release that adds identifiers or content to a reply.

## Decision

### 1. Read a mirror through a constrained port

All Codex file I/O goes through an allowlisted CODEX_HOME port (D-14, D-15,
D-17, D-26). The threads store is opened read-only with file existence
required; queries select explicit telemetry columns, never all columns. This
avoids creating a missing database or writing to its sidecars. The session
index supplements attribution; rollout references come from the port's own
bounded listing. Canonical containment rejects symlink escapes. Titles,
names, previews, first messages and origin URLs are excluded from the default
SELECT. Private working directories and rollout paths never reach public
events or widgets.

Rollout lifecycle tails use cursors and partial-line carry. Their read path
must not leak a file head when resuming a tail. Token scans have different
semantics after the v3 redesign (now parser version 4): a changed rollout is
read in full through bounded chunks, then its counters are replaced atomically. A Codex session
is an in-memory read-only mirror of a thread, never a product Run row. Only
counter aggregates, cursors and the last rate-limit snapshot persist, using
migration 0009. Polling follows subscribers rather than running permanently.

### 2. Recognize data shape instead of trusting a binary version

The shape-based version gate checks the migrations table and required
threads columns, then the per-session CLI recognition ratio (D-16). A CLI
version probe is diagnostic evidence, not permission to interpret unknown
data. Recognition reuses the Phase 5 thresholds: at least 20 observations
with a ratio below 0.9, or at least five with none recognized, pauses that
version. The freshness canary samples eight newest threads and is suspect
at three missing or more-than-five-minute-old rollout mismatches (plan 08).
Missing shape or excessive unrecognized records yields
`unavailable — Codex data format changed`; it never fabricates sessions or
numeric zero. Recognition tallies belong to the parser version. Prerelease
version strings remain distinct. This tolerates additive upstream changes
while refusing semantic drift.

### 3. Derive lifecycle from evidence, not silence

The last lifecycle event in file order wins (D-18), even when timestamps are
equal or inconsistent. A started task is running only within the inactivity
window; silence resolves to stale/unknown, never inferred completed. The
default window is 30 minutes (A5); the configured value is shared by the
mirror, overlays and follow service. Child thread-spawn and guardian sources
are hidden; review subagents can be shown (A4). Attribution uses registered
project roots and existing worktree-aware lookup, not prompt text.

Headless and bridge runs add strict, allowlisted wrapper records with
`schemaVersion`; legacy version 0 is tolerated (D-20). Pending resume and
rate-limit evidence yield `limit-paused`. End reports older than newer
session activity do not override the newer evidence. The run overlay is
registered before the hook overlay and refreshed before the first poll.
Hook facts older than store or rollout lifecycle evidence are rejected.

### 4. Offer hooks without taking ownership of Codex configuration

The optional fail-open hook package minimizes five lifecycle events,
reuses the delivery budget of about 300 ms, writes no stdout and always exits
successfully (D-19). SessionEnd has write-ahead spool delivery; socket and
spool ingestion deduplicate on event id. The owner-run installer merges only
the hook definitions and installs a private compiled copy. It backs up before
atomic edits and supports byte-exact uninstall when unrelated edits have not
intervened. Trust through `/hooks` remains manual; installed status never
claims trust has been granted. Status derives from the installer marker and
received events, with installedSince the later of marker time and service
start (plan 32).

The notify slot is never taken (D-05). The owner's existing client already
uses it. Headless runs and wrapper TUI runs with hooks disabled rely on
rollouts and wrapper records instead. Hook latency, real trust and identifier
joining remain Owner UAT observations (A3, A6, A16).

### 5. Read usage from the supported app-server request

`account/rateLimits/read` over bidirectional stdio to `codex app-server` is
the only live plan-usage source (D-05, D-21). The saved Codex launcher row is
the only executable used by both usage and doctor, re-read on each call
(plan 28). Each read initializes one child, sends initialized, reads once
with reset-credit details excluded and reserve support disabled, and stops
within its 20-second cap. It uses argv, no shell, and a minimal environment.
Only percentages, window minutes, reset times, limit labels and ordinary
usage/refusal facts survive parsing. The account identifier is discarded.
No credential file or private endpoint is consulted, and no reset-credit or
consume operation exists.

OQ-3 permits a rollout snapshot to draw a bar only; it can never allow the
guard. The rollout fallback is not implemented in the composed service:
its provider returns null (plan 28, wave 7). Without a live read, headroom
refuses. This is a known delivery gap, not verified fallback behavior.

### 6. Preserve the reserve and expose a read-only signal

The 80 percent line preserves a 20 percent reserve (D-22, D-24).
The worst of all windows governs refusal: at or above that line, ordinary
usage disallowed, a reached limit, unavailable usage or any limit-paused run
all refuse. Shared-fixture parity tests compare the TypeScript decision with
the wrapper guard. A rollout fallback never permits work. A live observation
is live for two minutes, stale through ten, then unavailable and refusing
(A11); failed-read retries have their own ten-second throttle.

The read-only headroom signal carries both agents' snapshots with source,
observation time and freshness. It ranks neither agent and never dispatches
or buys credits. GSD continues to use the wrapper guard. A 10080-minute
window is labelled Weekly; other windows use their reported minutes. The
weekly-window wording describes a reported allowance window, not a calendar
week or a billing estimate. The reserve tick also has text and a word state;
unavailable has no meter or numeric zero.

### 7. Count token activity separately from plan capacity

The counting unit is the latest cumulative value per thread and turn,
never a sum of cumulative snapshots (D-24). Parser v3 superseded the earlier
incremental reconciliation described in plan 23's original summary; the parser
version is now 4, bumped when off-period cumulative deltas began consuming
pending cover so that stale cover cannot suppress enabled usage. Any change to
what the counter counts bumps the version, and a guard test enforces it. A pure
whole-rollout function computes per-counter positive growth and applies
analysis-off intervals at each record's own timestamp. Thread-cumulative
records cover per-turn records up to their timestamp; later turn increments
count until a newer cumulative covers them. Off-period increments never
become enabled usage on a later read. Timestamps are assumed non-decreasing
in file order. A turn first seen after the last cumulative counts in full;
the owner must confirm this token counting unit against CODEX-10's wording.

Stored rows belong to a rollout and are replaced with its recognition tally
and cursor in one transaction. Parser upgrades clear derived state while
retaining counted rows and each rollout's cursor, which is marked stale so the
rollout is recomputed even at an unchanged size. A rollout that shrinks below
the extent last read in full keeps its rows and reports incomplete coverage
until it regrows past that extent. Missing, refused or oversized rollouts keep
their rows and report incomplete coverage;
partial reads never claim complete coverage. Five labelled counters and the
Codex-reported total are independent of plan capacity and carry no billing
claim. Rescanning, restarting and changing chunk sizes must preserve totals.

### 8. Share the privacy control and deletion

The shared transcript-analysis gate controls prompt-derived fields and token
scanning for both agents (D-17). It is checked before files and chunks and
again after reads. Off means no content inspection or token updates.
Delete cached usage analytics clears both agents' counters and Codex's
usage-derived settings in one transaction; sessions remain. Coverage stays
honest during rebuild. The toggle and deletion do not edit upstream records.

### 9. Reach Antigravity through an argv-only queue

Antigravity is a third terminal kind behind the existing launcher port
(D-07 to D-12), retaining launch caps, in-flight deduplication and the
Claude-only concurrent-write guard. Protocol version 2 adds an agent request
with enum, absolute executable, validated argv, approved environment keys
and no prompt payload. The TypeScript validator and JavaScript helper share
a hostile corpus and parity tests. The helper re-validates against saved
agent pins and execs argv directly. Requests are atomic; handoff means a
claim, not merely a queued file. Any fresh old window sharing the queue can
force an outdated result, even if another window covers the project.

The typed errors are `bridge-not-installed`, `bridge-outdated` and
`window-not-ready`. Timeout withdraws the request to prevent stray late
tabs. Missing or non-IDE saved app selection is a setup error, never an
unbounded heartbeat wait. Detection proposes the IDE app; a saved choice is
never rewritten. Terminal.app remains the fallback when no bridge exists.
The pair requests Claude first, preserves separate results, and does not
hide a successful half when the other fails.

This supersedes ADR-0024 only for the third terminal kind: Antigravity uses
an argv-only request/claim queue instead of a generated shell script. Its
other terminal adapters, quoting rules and application decisions remain.
The queue assumes a trusted same-user boundary as ADR-0001 does; validation
prevents accidental and confused-deputy requests, not arbitrary same-user
code execution. Real window targeting and tab order are A1/A18 Owner UAT.

### 10. Keep gestures and privacy enforcement explicit

A10 follows the merged classification: launch and open/follow capabilities
are direct gestures; only Codex hook installation is reserved
approval-required. D-31's earlier blanket wording is qualified by the owner
decision dated 2026-10-06. Reconfirmation remains an open item rather than a
new approval flow. Default Codex arguments are empty (A14), with the owner's
own interactive settings governing behavior and the product refusing the
documented bypass set.

CODEX-09 has three enforcement layers (D-26): the allowlisted port, a
credential canary with a negative control, and backstop rule 16. The rule
scans non-test package source, including JavaScript, for forbidden credential
access, reset-credit/consume RPC and notify writes. The composed-service
canary (with negative controls) and the realtime-budget test were delivered by
plan 29; their measured numbers live in its summary and live behavior stays an
Owner UAT item. The lower-level port tests and rule were delivered earlier. Logs keep fixed reasons and counts, never raw error text
that could expose paths or content.

## Alternatives rejected

- Read private credentials or a private usage endpoint: rejected because it
  crosses CODEX-09 and couples the product to account secrets.
- Gate solely by installed CLI version: rejected because multiple binaries
  and independently migrated session stores coexist; data shape is evidence.
- Infer completion from inactivity or PID absence: rejected because Codex's
  thread records do not prove a process ending. Unknown is honest.
- Replace notify or automate hook trust: rejected because the slot has an
  existing owner and trust is the owner's decision.
- Sum cumulative token events or persist chunk-dependent reconciliation:
  rejected because repeated reads, source mixing and restarts double count.
  Parser v3 and v4 rebuild one rollout deterministically instead.
- Allow dispatch from a rollout fallback or rank an agent: rejected because
  a cached bar is not live permission and D-04 keeps the signal read-only.
- Rewrite saved Terminal.app choices: rejected because detection is only a
  proposal. Use an explicit owner save to change a launcher.
- Shell strings or URI command payloads for the bridge: rejected because
  argv validation and helper revalidation preserve the launcher boundary.
- Approve every pair click: rejected under the A10 default because a reserved
  capability has no executor and would make the pair inert.

## Consequences

Phase 6's classification and approvals remain authoritative. Future
connectors must use them; none can turn headroom into dispatch implicitly.
Snapshot additions are optional and bounded before approvals receive the
remaining space under the 64 KiB cap. Codex startup faults degrade its routes
to 503 rather than stopping Claude; Codex shutdown is bounded before the
store closes. Without a configured executable, capacity stays unavailable.
The missing rollout fallback remains a phase gap for the judges.

The owner must install and trust optional hooks and the bridge in isolated
UAT before accepting real-machine behavior. Accessibility follows the
existing UI contract: keyboard reachability, visible focus, reduced motion,
200 percent zoom and no color-only status. Visual baselines require the
pinned container and an orchestrator baseline commit, not this plan.

## Verification and open items

**Verified on the owner's machine** means the historical read-only probes in
RECONCILE R-STORE and R-CODEX-ENV, not a live run by this executor: standalone
0.159.2, bundled 0.160.0, 59 upstream migrations, the unchanged 42-column
threads shape, an occupied notify slot, extension 0.1.0 and heartbeat keys
that lack protocol capabilities. The saved Antigravity bundle was the IDE
app in the Phase 5 UAT store; the live default store had no saved launcher.
The saved terminal kind there was Terminal.app. These are counts and setup
facts, not permission to inspect the owner's data now.

**Cited upstream** evidence lives in research R1 to R7: hook event schema,
app-server request/response contracts, migrations and bridge API semantics.
No new upstream verification was performed by this documentation plan.
Fake app-server, store, bridge and rollout tests demonstrate local contracts,
not authentication on the owner's machine. R-GATES' 6624 passing tests and
four skips are the pre-phase baseline, not this plan's final test count.

**Assumed / Owner UAT:** A1/A18 window and tab behavior, A3/A16 hook joining,
A5 inactivity suitability, A6 latency, A7 GUI environment, A11 freshness,
A12 cold-start time and A15 real first app-server read remain live checks in
`05.1-UAT.md`, whose results are pending. Real doctor shape and follow tabs
also remain unverified. Four owner confirmations remain explicit:

1. A10: direct gestures for launches and opens; only hook install reserved
   (plan 02, default retained).
2. Token counting unit: thread/turn latest cumulative plus thread-cumulative
   precedence versus CODEX-10 wording (plans 11/23, parser v4; this unit is
   still an open owner item).
3. Default Codex arguments: empty, product adds no flags (plan 21, A14).
4. Saved Antigravity bundle: IDE app on the actual test install, no saved
   choice rewritten (plan 13, A13, U16).

Planner copy, Settings rows, limit-paused observations, weekly-window wording
and the single visual baseline commit are also pending owner/judge checks.
Acceptance is not claimed until the owner completes U1 through U16.
