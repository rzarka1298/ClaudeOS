---
status: accepted
satisfies: ADR-12 (completes — stable-ID half; task-syntax half is ADR 0004)
---

# Note and Workspace IDs extend the RunId scheme, and take no arguments

`VAULT-07` needs a stable note ID, `VAULT-09` needs workspace IDs that survive
display-name changes, and `TASK-02` needs a task's identity to round-trip
through Markdown intact. All three want the same thing: an opaque, sortable,
service-minted string that no user-visible name can influence. This decision
records how one is minted; ADR 0004 records the shape of the file it lives in.

## The scheme

Nine base-36 characters of `Date.now()` (zero-padded), then sixteen hex
characters from `randomUUID()` — a fixed 25-character ASCII string, matching
`/^[0-9a-z]{9}[0-9a-f]{16}$/`.

`newNoteId()` and `newWorkspaceId()` are the same shape as the existing
`newRunId()` from ADR 0006, on purpose. Two properties follow:

- **Sortable.** The zero-padded timestamp prefix keeps every ID the same width,
  so a plain lexicographic sort IS mint order. An index can therefore order
  notes without opening a single body. The padding is what makes this true
  across the width change: base-36 milliseconds occupy eight characters today
  and nine from 2059, and would not reach ten until roughly the year 5188, so
  the padded field is stable well past any horizon this product has.
- **Opaque.** Nothing about a note's title, path, or workspace is recoverable
  from its ID, so renaming or moving a note does not change its identity.

## `newWorkspaceId()` takes no arguments, and that absence IS the mechanism

`VAULT-09` is satisfied structurally rather than by discipline: because the
minting function accepts no display name — and nothing derived from one — a
rename cannot reach the minting site, cannot change the ID, and therefore
cannot move the `workspaces/<id>/` directory the workspace's knowledge lives
under. Display names are presentation data held beside the ID (ADR 0005) and
never enter a filesystem path.

The test that guards this asserts `newWorkspaceId.length === 0` — the declared
arity — because a comment saying "do not pass a name here" is exactly the kind
of instruction a future refactor overwrites.

## Considered options

**`ulidx` (2.4.1).** Rejected for this phase. A real ULID is a more widely
recognized format than a house scheme, and `ulidx` is actively maintained and
legitimate (checked in `02-RESEARCH.md`; the original `ulid` package is
superseded by it). But this repository already mints sortable, opaque,
dependency-free IDs for every Run, and adopting ULIDs for notes and workspaces
would leave two ID formats in a codebase that currently has one — a permanent
"which kind is this?" tax paid for a property nothing needs yet. **Revisit if a
future phase needs canonical ULID interop** — exporting notes to a system that
expects them, for instance. IDs are opaque strings on both sides of that
change, so the cost of being wrong here is a migration of minting, not a
correctness or data-loss risk.

**A content hash as the ID.** Rejected. An identity derived from content
changes when the content does, which is the opposite of what a stable ID is
for. The content hash exists (ADR 0020's `contentHash`) and answers a different
question.

**A slug of the title.** Rejected outright — it is precisely what `VAULT-09`
forbids, and it leaks user content into a path.

## This completes ADR-12

`ADR-12` asks for the task syntax and stable-ID strategy to be recorded,
"evaluating Tasks-plugin-compatible syntax, block references, and
one-note-per-task against the round-trip requirement". That evaluation is
already on record in
[`docs/adr/0004-one-note-per-task.md`](./0004-one-note-per-task.md), which
rejected Tasks-plugin inline syntax (its emoji vocabulary has no slot for
provenance, source links, or a seven-value status, so the unsupported fields
could only be smuggled into an adjacent comment — a round-trip guarantee held
by discipline, which `TASK-02` forbids) and rejected an inline checkbox
anchored by a block reference to a sidecar note (two objects whose consistency
nothing enforces, and a hand-edit can orphan the anchor).

ADR 0004 is the syntax half; this ADR is the stable-ID half. Together they are
the whole answer `ADR-12` asked for: **each task is its own note (0004), and
its identity is a service-minted opaque sortable ID carried in that note's
`id` frontmatter key (0021).** Neither half is sufficient alone — one note per
task without a stable ID still breaks references on rename, and a stable ID
inside an inline checkbox still has nowhere to put the other seventeen fields.

## Consequences

- The Phase 6 task store inherits this with no new mechanism: a Task is a
  durable note, so it gets `VAULT-07` provenance and a stable ID for free.
- Two IDs minted in the same millisecond differ only in their random suffix, so
  their relative order is arbitrary. Anything needing a total order on
  same-millisecond events must add its own discriminator — plan 02-02's index
  already does exactly this, sorting by `created`, then `id`, then filename.
- The IDs are not globally unique in the cryptographic sense: collision
  resistance rests on 64 bits of `randomUUID()` entropy within a single
  millisecond. For a single-user local product that is ample; a future
  multi-writer scenario should revisit rather than assume it.
