---
status: accepted
satisfies: ADR-08 (completes — the capability half is ADR 0012; this record is the classification, expiration, audit, recovery and residual-risk half)
---

# Approvals are classified by a static table, enforced in three layers, expired by denial and recovered from evidence

`APPR-01`, `APPR-02`, `APPR-05`, `APPR-06`, `APPR-08` and `APPR-10` together require an approval engine that cannot be
bypassed, that fails closed, that records every decision in a record nobody can rewrite, and that never runs an action
twice or invents an outcome after a crash. ADR-08 of the PRD asks for the decision record behind all of that. It completes
the capability half of ADR-08 that Write methods are capability-typed, and the Proposal ID is the idempotency key (ADR 0012)
already records: that record says a write cannot be called without a token; this one records what issues the token, what
decides whether an operation needs one, how long a request lives, what is written down, and what happens after a crash.
It also states, in plain words, the one risk the design accepts for milestone 1 and the condition that ends the acceptance.

## Context

The engine lives in `packages/service/src/approval/`. It is a new exclusive element of the import boundary (ADR 0019), reached
from the rest of the service only through its public entry. Requests are persisted in the operational store (ADR 0009, ADR 0018);
the inbox the owner sees is a projection of that store (D-21). The plugin shows requests and sends decisions; it never
decides on its own and never holds approval state in its settings file. In this phase the only real operation is
force-terminate of a Claude session (`session.force-terminate`); a zero-effect `diagnostic.test` operation exists so that
exactly-once, expiry, notification and persistence can be proven without destroying anything.

## Decision

### 1. Classification model

Every operation the product can perform has exactly one row in a static table in `@ccc/domain` (`classification.ts`). The table
is code, not data: there is no storage, setting, column or field through which a row could be changed at run time, so
nothing can express a standing or remembered choice (`APPR-05`). A capability string the table does not know classifies to
nothing, and every caller treats nothing as refuse (D-04, D-06).

A row has one of three classes. `approval-required` waits in the inbox for an explicit decision. `no-approval` is allowed
without a decision and states why. `direct-gesture` means the owner's own click is the decision and states why.
An `approval-required` row is either `enabled` or `reserved`. An enabled row has a registered executor. A reserved row is
classified now so that the operation must fail closed: it has no executor, and submit, decide and recovery all refuse it until a later
phase enables it (D-05, T-06-15). Requesters may shorten a lifetime and never lengthen it. A decision approves or denies;
the payload is never editable by the approver.

The table below is machine-checked against the domain table by a doc gate: it must list every operation and nothing else,
with the same class, status, lifetime, maximum approval age and retry policy.

<!-- classification:begin -->
| Operation | Class | Status | Lifetime | Maximum approval age | Retry |
|---|---|---|---|---|---|
| `session.force-terminate` | approval-required | enabled | 15 minutes | 5 minutes | idempotent |
| `diagnostic.test` | approval-required | enabled | 24 hours | 5 minutes | idempotent |
| `vault.delete` | approval-required | reserved | 24 hours | 5 minutes | never |
| `vault.cross-scope-move` | approval-required | reserved | 24 hours | 5 minutes | never |
| `hooks.install` | approval-required | reserved | 24 hours | 5 minutes | never |
| `automation.git-write` | approval-required | reserved | 24 hours | 5 minutes | never |
| `publish` | approval-required | reserved | 24 hours | 5 minutes | never |
| `skill.run` | approval-required | reserved | 24 hours | 5 minutes | never |
| `codex.hooks.install` | approval-required | reserved | 24 hours | 5 minutes | never |
| `launch.antigravity` | direct-gesture | - | - | - | - |
| `launch.claude-code` | direct-gesture | - | - | - | - |
| `launch.finder` | direct-gesture | - | - | - | - |
| `launch.github` | direct-gesture | - | - | - | - |
| `launch.claude-desktop` | direct-gesture | - | - | - | - |
| `launch.codex` | direct-gesture | - | - | - | - |
| `launch.claude-codex-pair` | direct-gesture | - | - | - | - |
| `codex.open-transcript` | direct-gesture | - | - | - | - |
| `codex.follow-log` | direct-gesture | - | - | - | - |
| `project.registry` | direct-gesture | - | - | - | - |
| `switcher.open` | direct-gesture | - | - | - | - |
| `session.focus` | direct-gesture | - | - | - | - |
| `session.resume` | direct-gesture | - | - | - | - |
| `session.branch` | direct-gesture | - | - | - | - |
| `session.open-transcript` | direct-gesture | - | - | - | - |
| `session.associate` | direct-gesture | - | - | - | - |
| `session.interrupt` | direct-gesture | - | - | - | - |
| `usage.transcript-analysis-toggle` | direct-gesture | - | - | - | - |
| `usage.delete-analytics` | direct-gesture | - | - | - | - |
| `connect.navigate` | direct-gesture | - | - | - | - |
| `vault.write-note` | no-approval | - | - | - | - |
| `vault.initialize` | no-approval | - | - | - | - |
| `vault.repair-index` | no-approval | - | - | - | - |
| `task.write` | no-approval | - | - | - | - |
| `approval.mirror-note` | no-approval | - | - | - | - |
| `store.write` | no-approval | - | - | - | - |
| `notify.local` | no-approval | - | - | - | - |
| `data.refresh` | no-approval | - | - | - | - |
| `note.capture` | no-approval | - | - | - | - |
<!-- classification:end -->

Enabling an operation in a later phase takes an operation definition and one row of this table. The persistent store
classifies through the production table rather than an injected one, so no engine change is needed and a connector defined
only in the test fixtures is rejected as unknown by an engine built with the production table (D-43).

### 2. Three enforcement layers, plus a compiler layer for sub-folders

The engine is a choke point because it is enforced three independent ways. Each has a fixture that proves it fires, and each
fixture has a quiet half that proves it does not fire on allowed code.

1. **The import-boundary lint (ADR 0019).** The `approval`, minter and executor folders are elements with domain-only
   policies. The minter may be imported only from inside `approval/`, and not from the public entry. Executors may be
   imported only by the composition root.
2. **Compiler project references.** `approval/` and `executors/` are nested composite TypeScript projects that reference only
   the domain package. A relative import out of either sub-folder fails with TS6307 (and TS6059), and an unreferenced package
   import fails only on a clean build, which is why the gate runs one.
3. **The grep backstop (`scripts/check-boundaries.sh`).** Rules that read the literal source list, independent of the lint and
   the compiler: only one anchored file may cast to the capability token; the minter and the executors are imported only from
   their allow-lists; a process kill call may appear only under the Claude services folder; a dotted terminate call may appear
   only under the executors folder; and the approval public entry never mentions the minter.

The token itself is minted in exactly one module-private file, covers one operation and one subject, and expires at the
earlier of the request's expiry and the approval time plus the maximum approval age. Tokens are never persisted. Each
executor also checks its own token covers the action it is about to take.

### 3. Expiration is an automatic denial

Expiration is an automatic denial (`APPR-06`). A request still pending at its expiry becomes `expired`, is shown as
"Expired - denied automatically", and is audited. It is never extended, snoozed or revived: re-proposing the same action
creates a new request with a new Proposal ID and therefore a new idempotency key (D-08).

Lifetimes are constants on the table: 24 hours by default, 15 minutes for `session.force-terminate`, and a ceiling of seven days
that no row may exceed (D-10). The maximum approval age, the time after approval during which the action may still begin, is
5 minutes. An approval that is never claimed in time becomes `lapsed`, its own state, never folded into `failed` (D-17).

Expiry is enforced three ways so that no path depends on a timer: an unref'd sweep that runs about every 45 seconds, a sweep at
startup, and a check on every decision, where `now < expiresAt` is re-checked inside the decision transaction. A decision that
loses a race with expiry at the same instant ends `expired` with one audit row and no effect, and a decision one millisecond
earlier wins. The clock is injected, so the boundary is tested without sleeping. A late decide after a sweep is answered with
the already-decided state.

### 4. The request states

A request has ten states, including `lapsed`. Every transition is a compare-and-set on the source state in one transaction with
its audit row, and the single-use claim is the `approved` to `executing` compare-and-set. `unknown` is terminal: nothing is
ever retried after an outcome could not be confirmed.

<!-- states:begin -->
| State | Next states |
|---|---|
| `pending` | approved, denied, expired, withdrawn |
| `approved` | executing, lapsed |
| `executing` | executed, failed, unknown |
| `executed` | - |
| `failed` | - |
| `unknown` | - |
| `denied` | - |
| `expired` | - |
| `withdrawn` | - |
| `lapsed` | - |
<!-- states:end -->

### 5. The audit record is append-only

Every state change writes one audit row in the same transaction, using the fixed vocabulary `requested`, `approved`, `denied`,
`expired`, `withdrawn`, `claimed`, `executed`, `failed`, `outcome-unknown`, `retried-after-restart`, `reconciled-executed` and
`lapsed`. History renders only these, never free text. The decision channel (`decided_via`) is recorded only on the `approved` and `denied` audit rows and in
`proposals.decided_via`, not on every audit row; a decide that loses to expiry records none (see the residual risk below).

The table is append-only by triggers in the approvals migration, not by convention:

- `approval_audit_no_update` and `approval_audit_no_delete` abort an update or delete of an audit row.
- `approval_audit_no_replace` aborts an insert that would replace an existing row. Without it an `INSERT OR REPLACE` bypasses
  the delete trigger when recursive triggers are off.
- `proposals_transition_guard` aborts any illegal state change, `proposals_identity_immutable` aborts a rewrite of the columns that
  identify a request, and `proposals_payload_purge_only` allows the payload column to change only by being purged after the
  request is decided.
- `proposals_no_replace` and `proposals_no_delete` forbid replacing or deleting a request.

A permanent test applies every migration to a fresh database and asserts that each named trigger exists and still aborts, so a
later migration that rebuilds a table cannot silently drop them.

### 6. Exactly once, with reconciliation

What you approve is what runs. The payload hash shown to the owner is the hash the decision must carry, and the hash is
recomputed from the stored payload inside the decision transaction. Executors read the payload from the stored row, never from
the request. The idempotency key is the Proposal ID and is never regenerated (ADR 0012).

Recovery runs at startup after the Phase 5 spool drain and revival sweep (because reconcile reads Run state) and before the
socket accepts a connection:

1. Pending requests past their expiry become `expired`.
2. Every `executing` request is reconciled before anything else is decided. Reconcile is consulted before any retry. It reads
   only and has no effect. If it proves the effect (for force-terminate: the Run is already cancelled with the same recorded
   process identity, or the recorded process is gone or has a different start time), the request becomes `executed` with the
   audit event `reconciled-executed` and an evidence code. If it shows the effect is absent and the operation's retry policy is
   `idempotent`, and the original approval token has not yet expired (the token-expiry gate: a retry never outlives the
   approval's maximum age), there is one retry with the same idempotency key, a freshly minted token and a recorded attempt.
   Anything else becomes `unknown` and is never retried.
3. **The late-refusal rule.** If the retry is refused or fails on attempt two or later (`process-ended`, `run-not-found`,
   `identity-mismatch`), reconcile is consulted again, and the request is `executed` only if proven, otherwise `unknown`. It
   is never recorded as a plain `failed`, because the first attempt may have had the effect. On the first attempt the same
   codes are definitive, nothing was done, and `failed` with the reason code is truthful.
4. An approved request never claimed within its maximum approval age becomes `lapsed`; within it, it is claimed and run.
5. An approved request, never claimed, whose operation is reserved or no longer registered is finished `failed` with a
   reserved code and never executed. An `executing` request of such an operation was already claimed, so an executor may have
   run before the operation was reserved or unregistered: it finishes `unknown`, never `failed`.
6. The payload columns of requests decided more than thirty days ago are purged. Audit rows are never deleted.

A force-terminate whose signal succeeds while the process still exists is `executed` with an awaiting-exit note, not a claim
that the process is gone; the owner is told so in a fixed sentence.

### 7. Notification and the mirror note

A notification is plugin-originated only. When Obsidian is unfocused and a new pending request arrives, the plugin raises a
notification with generic content: "Approval needed", the requester label (capped and neutralised) and the engine-templated
action. It carries no target, path, reason or payload, and no action buttons; clicking it focuses Obsidian and selects the
request. No notification is sent while Obsidian is closed in milestone 1, because every milestone 1 requester is
plugin-initiated; the first background requester revisits this (D-27). Expiry produces an inbox row and an event but no
notification (D-11). The `obsidian://ccc-approval?id=` link only navigates, accepts only an id of 25 lowercase
alphanumeric characters, and changes no state.

Each request is also mirrored as a read-only note in the global `system/` folder, with the banner "mirror - decisions are made
in the command center". The note is templated by the engine, contains no requester string, reason, diff or payload, is written
on a best-effort basis, is never read back and is never an authority. A decision made by editing the note does nothing.

Measured cost and retention: 100 mirror notes took 844 ms, 8.4 ms per write on average; the cost grows with the folder, because
the system folder's index is rebuilt in full on each write. Mirror notes are retained. There is no deletion path, and the
thirty-day purge clears payload columns in the store, not vault notes. The notes hold only templated text, so retention leaks
nothing; revisit when a background requester lands.

### 8. Bounds and measurements

Pending requests are capped at 25 per operation and 50 in total. The approvals part of a response is trimmed to a budget of
57,344 bytes, because the service's socket client rejects a body larger than 65,536 bytes and would drop the whole body. With
50 pending, 50 decided and 50 expired requests the snapshot measured 50,119 bytes with CJK text and 56,698 bytes with ASCII
text, so the whole snapshot fits under the cap and pending requests are never dropped. The largest detail view (a 500-line
diff, a 5,000-character reason, 25 extra audit rows and 20,000 control characters) measured 39,671 bytes. Requester text is
untrusted: it is neutralised and length-capped by the service, rendered as text nodes only, and labelled with its origin.

## Findings that shaped this decision

- **The inert lint.** The committed import-boundary lint never evaluated intra-package edges and classified nested folders as
  their enclosing package. It was repaired first (ADR 0019 addendum) and the `untrusted` boundary is now proven to fire.
- **REPLACE bypass.** A BEFORE DELETE trigger alone does not protect an append-only table: `INSERT OR REPLACE` removes the old
  row without firing it. A BEFORE INSERT guard closes all five attack forms, and transition and identity triggers were added.
- **Rebuild drops triggers.** drizzle-kit does not see triggers, and a later migration that must rebuild a table emits a drop
  and rename that silently drops them. The all-migrations survival test is the mitigation.
- **The response budget.** The socket client's 64 KiB cap would drop an oversized body silently, so the service trims to a
  budget below it and states the truncation.
- **The late-refusal rule.** A refusal after a retry is not proof that nothing happened, so it routes back through reconcile.
- **Two migrations.** The approvals tables and triggers are in one small migration and the task index in another, so the
  trigger-bearing file is independently reviewable.
- **Log depth.** One-level wildcard redaction leaks at depth two. The log never receives a payload, and a canary test checks the
  allow-listed keys.
- **A decision channel is self-declared.** See below.

## Residual risk: same-user self-approval

A prompt-injected agent running as the same user could open the service socket, submit a force-terminate request and decide
it itself. The socket's `0600` permission keeps other users and browsers out (ADR 0001) but does not separate two processes of
the same user, and ADR 0016 already says so. The decision route has no cheap in-process fix: peer-process identification or a
presence check needs native code or a helper binary.

This risk is accepted for milestone 1. The reason is that the only real operation is force-terminate of a Claude session, whose
worst effect is ending a session the owner can restart. The owner decided this on 2026-10-04 ("Accept for now", D-47, answer to
open question OQ-1, threat T-06-12).

Two further facts widen the risk and are stated plainly. First, the handshake is unauthenticated beyond the socket's `0600`
permission, so a same-user process needs only access to the socket to obtain a token and call the decide route. Second, a
same-user process able to write the SQLite file could insert an `approved` row that `recover()` would run after a restart.
Both belong to the accepted same-user class; the second is to be named explicitly at the milestone 2 hardening gate.

The mitigations that do exist are narrow and are not a boundary:

- The decision channel is recorded as `plugin` or `other`, but only on the `approved` and `denied` audit rows and in
  `proposals.decided_via`; it is not on every audit row, and a decide that loses to expiry records none. The plugin sets the `X-Ccc-Decided-Via` header on
  a decision, and anything else is recorded as `other`. The header is self-declared, so the field is an accident detector and
  not a trust signal: it shows that a decision came from outside the plugin by mistake, and it proves nothing against an
  adversary who sets the header.
- An optional Claude Code deny rule can keep an agent session away from the socket. Agents cannot edit permission files, so the
  rule is owner-applied, optional, and not enforced by the product. It matches command prefixes only and does not stop a
  script file or an interpreter one-liner, so it reduces accidents and is not a defence.

```json
{
  "permissions": {
    "deny": [
      "Read(/Users/USERNAME/.claude-command-center/**)",
      "Edit(/Users/USERNAME/.claude-command-center/**)",
      "Bash(curl --unix-socket:*)",
      "Bash(nc -U:*)",
      "Bash(socat:*)"
    ]
  }
}
```

The snippet follows the syntax of the existing deny entries in the project's settings file, and uses a placeholder path.

## Milestone 2 gate

A hardening decision is required before the Gmail and Calendar connectors land. Those connectors make approvals guard
operations that cannot be undone and that act outside this machine, so the accepted risk above stops being acceptable. The
decision must choose a native presence check at decide time or peer-process identification on the socket, or record why neither
is needed. This requirement is also recorded in ADR 0016 and in the deferred-items record, so it cannot be forgotten.

## Considered Options

**Visual-only expiry.** Rejected. A request that only looks expired in the interface can still be approved through the
socket. Expiry is enforced in the service, inside the decision transaction.

**Vault note as the authority.** Rejected. A note can be edited by anyone and by sync tools, and it has no compare-and-set. The
store is the authority and the note is a regenerable, read-only mirror.

**A generic client-submitted proposal route.** Rejected. A route that accepts any operation and payload from a client makes
every caller a requester. Each requester has its own fixed route that builds the payload itself, and no generic submit route
exists.

**A persistent allow.** Rejected. A remembered "always allow" is exactly the blanket approval `APPR-05` forbids. The table has no
column or field that could hold one, and a schema test and a source scan check for the wording.

**Building a native presence check now.** Rejected for milestone 1. It needs native code or a signed helper binary and a
signing and distribution story for a risk the owner accepted. It is required before the connectors (see the gate above).

## Consequences

- The record is checked against the code: the classification and state tables are parsed by a doc gate, and the trigger names
  must exist in the migrations. Adding an operation without updating this table fails the gate.
- Audit rows cannot be changed through the application or by a stray SQL statement, but a process with file access to the store
  as the same user can still replace the file. That is the same accepted residual risk.
- Reserved operations are classified and refused today, so a later phase that enables one changes a definition and one row, and
  the dangerous ones start from fail-closed.
- An `unknown` request is permanent. It tells the owner the truth (the outcome could not be confirmed) at the cost of a request
  that never resolves to success or failure.
- Mirror notes accumulate with no deletion path. The folder index growth is the only cost at milestone 1 volumes.
