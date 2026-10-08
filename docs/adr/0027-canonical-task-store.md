---
status: accepted
satisfies: TASK-01, TASK-02, TASK-03, TASK-04, TASK-05, TASK-06, TASK-07, TASK-08, TASK-09
amends: ADR 0022 (the tasks folder index is a constant-size summary)
---

# A task is one note under a managed tasks folder, filtered by fixed predicates in the owner's time zone

`TASK-01` and `TASK-02` require a task to round-trip through Markdown without losing its stable id or any field.
`TASK-06` and `TASK-07` require seven filters whose results stay independent between the global list and a project
list, and `TASK-09` requires them to stay responsive at 10,000 tasks. ADR 0004 already decided that a task is one
note. This record fixes what that note contains, where it lives, who may write it, and exactly which tasks each view
shows. It amends the record titled "Indexes are recomputed wholesale, and repair flags ambiguity instead of resolving
it" (ADR 0022): a tasks folder gets a constant-size summary index, because a per-note index measured too slow.

## Context

Tasks are canonical in the vault and indexed, disposably, in the operational store (`task_index`, `task_tags`,
`task_deps`). The index is a cache: deleting it loses nothing, and "Rebuild task index" reconstructs it from the notes.
The service owns creation and the index; the plugin owns edits to existing notes. External edits (the owner in
another editor, a sync tool) arrive as vault events and a startup walk.

## Decision

### 1. The task note

Every task note carries the twelve provenance keys of ADR 0020 as a fixed prefix, then the task keys. The provenance
keys form the prefix of one shared key order, `TASK_FRONTMATTER_KEY_ORDER`, used by every writer, so the service and
the plugin produce byte-identical frontmatter for the same task. The task keys follow in this order: `type` (always
`task`), `title`, `status`, `priority`, `due`, `scheduled`, `completed`, `projectId`, `assignee`, `sourceType`,
`sourceLink`, `parent`, `dependencies`, `tags`, `decision`.

Every task note is stage `capture`: a task's lifecycle is its `status`, not the knowledge lifecycle. A task with no
priority has the key absent, never a sentinel. The `contentHash` is computed from the whole file and is never stored
in the frontmatter.

The statuses and priorities below are machine-checked against the domain.

<!-- statuses:begin -->
| Status | Meaning |
|---|---|
| `inbox` | captured, not yet triaged |
| `proposed` | suggested by an automation; not canonical until accepted |
| `ready` | accepted or created ready; can be worked on |
| `in-progress` | being worked on |
| `blocked` | waiting on something outside the task |
| `done` | finished |
| `cancelled` | abandoned or dismissed |
<!-- statuses:end -->

<!-- priorities:begin -->
| Priority | Sort rank |
|---|---|
| `urgent` | 0 |
| `high` | 1 |
| `medium` | 2 |
| `low` | 3 |
<!-- priorities:end -->

Dates come in two kinds. `due` and `scheduled` are either a calendar date (date-only, all-day) or an instant with an
explicit offset or `Z`; an offset-less date-time names no instant and is refused. `completed` is always an instant.
The index keeps the two kinds in separate columns, so a later time-zone change cannot move an all-day task.

A title is a single line of 1 to 200 characters, not blank, with no control, format or separator character, stored as
authored. Tags are written without the leading `#`, at most 64 characters each and 20 per task, from letters,
digits, underscore, hyphen and slash, and never all digits. Dependencies hold at most 50 note ids.

The `decision` record of a proposed task is a top-level `decision` key, not part of the producer map, because the
owner makes the decision after the fact. It holds exactly two keys in this order, `outcome` (`accepted` or
`dismissed`) and `at` (an instant).

### 2. File name and location

A task lives in the managed `tasks` folder directly under `global/` or under `workspaces/<id>/`. The file name is
fixed at creation: a slug of the title (ASCII letters and digits, at most 48 characters), a hyphen, the last eight
characters of the note id, and `.md`. It is never derived again, so a later title edit does not rename the file and
links to the note stay valid. The id suffix keeps two tasks with the same title apart.

Limits are enforced before parsing: a frontmatter block over 64 KiB and a whole file over 256 KiB are refused, because
the YAML parser has no alias limit of its own.

### 3. Parsing

Task notes are parsed with the core schema of the YAML library, in both the service and the plugin. The default
schema turns an unquoted `2026-10-09` into a date object and an unquoted `12:30:45` into a number, and a date object
no longer round-trips to the authored string. The core schema keeps scalars as the strings the owner wrote, and the
task schema then validates them. A note that fails validation is listed as unreadable and left out of the index; it is
never repaired silently.

### 4. Filters

The eight views are fixed by this table, which is machine-checked against the domain filter list and sort keys. "Open"
means actionable: not `done`, not `cancelled` and not `proposed`. Dates are compared in the owner's IANA time zone,
which the request carries; the local day is computed once per request and the same bounds serve the list and every
count, so a chip count cannot disagree with the list below it.

<!-- filters:begin -->
| View | Open rule | Date rule | Sort |
|---|---|---|---|
| `all` | every status | none | updated, newest first |
| `today` | open | `due` or `scheduled` falls on the local day | time-of-day ascending, undated last; then priority, urgent first |
| `upcoming` | open | `due` or `scheduled` is after the local day, with no upper bound | due ascending, undated last |
| `overdue` | open | `due` is before the start of the local day | due ascending, oldest first |
| `project` | open, with a project set | none; narrowed to the chosen project | priority, urgent first; then due ascending |
| `proposed` | status `proposed` | none | created, newest first |
| `blocked` | open, status `blocked` or any dependency unmet | none | due ascending, undated last |
| `completed` | status `done` | none | completed, newest first |
<!-- filters:end -->

Rules that the table cannot carry:

- Cancelled appears only under All. Proposed tasks appear only under All and Proposed, so a suggestion never shows in
  an actionable view.
- Upcoming has no upper bound: every dated open task after the local day is listed, however far out.
- A dependency is unmet when its task is not `done` or `cancelled`. A dependency that names no task, a dangling
  dependency, counts as unmet, so a deleted prerequisite never silently unblocks a task. The status label itself is
  never rewritten to show this.
- The local day is a 23-hour day on a spring-forward date and a 25-hour day on a fall-back date. A zone that skips
  midnight starts its day at the first instant that exists on that date. The day bounds are found by search over real
  instants, not by adding 24 hours, and a daylight-saving test pins all three cases.
- The project panel and the global Tasks view each hold their own context (scope and project), so neither changes the
  other's filter (`TASK-07`). Choosing the Project filter with no project returns an empty page marked "choose a project".
- Pages are keyset-paginated over the sort key and the note id; a cursor from one view is not valid for another.

### 5. Write routing

The service creates tasks and owns the index. A manual task enters the inbox or ready depending on which form action the
owner chose. A proposed task has no HTTP route at all: only an internal call (an automation, in a later phase) can
create one.

The plugin edits existing task notes, and only through one function, `updateTaskNote`. It reads the note, compares it
with the content the form was loaded from, and writes through the vault's atomic process call, so an edit made
elsewhere in between is reported as a conflict instead of being overwritten (conflict-safe). It then tells the service
which path changed. The changed route never writes: the service re-reads the frontmatter and updates the index, so a
bug or a hostile caller of that route cannot alter a note. The plugin edits no other part of a note than the task keys
and keeps keys it does not know.

External edits reach the index through debounced vault events (an own-writes ledger drops the plugin's own echoes), a
startup walk after migrations, and the "Rebuild task index" action.

### 6. Status edits

Done sets `completed` when it is empty. Leaving Done clears `completed`. Reopen sets `ready`. Each action is guarded by
the status it starts from: accept and dismiss need `proposed`, and a stale view gets an invalid result, not a write.

### 7. Proposed tasks

An automation-generated task enters as `proposed` with its provenance. Accept moves the task to `ready` and records
`decision` with outcome `accepted`. Dismiss moves the task to `cancelled` and records `decision` with outcome
`dismissed`, so dismissal is recorded (`TASK-05`) and nothing is deleted. A proposed task is not an approval request:
it uses none of the approval engine, and the interface does not call it a request.

### 8. Duplicate and missing ids

Two notes that share an id, a note with no id, and a note that cannot be read are surfaced in a "notes need attention"
list. They are never resolved: the service does not pick a winner, mint a new id or rename a file. The owner decides.
The scan separates tasks from attention items, and only tasks reach the index rebuild.

### 9. Completing a task is structurally contained

`TASK-08` requires that completing a task modifies no external system. It holds by construction, not by discipline.
The completion path is a status edit through `updateTaskNote` followed by the changed route, and neither can reach a
network client, a connector, a launcher or the approval engine: the plugin and the task service import none of them,
which the import-boundary lint and the backstop enforce. A spy test asserts that completing a task makes no call other
than the note write and the changed notification. The decision depends on seams that other phases own: a connector
added later must not be imported by the task code, and the boundary rule for that stays in force.

### 10. Measurements

Index queries cost 0.04 to 1.5 ms per page and all eight counts 3.4 ms in one pass at 10,000 tasks; a startup walk of
10,000 notes costs 208 ms (research spikes S1, S9, S10). A per-write folder index cost 212 ms and produced a 1.13 MB
file at the same size, which is why the folder index is a summary (see the amendment to ADR 0022).

## Considered Options

**Tasks in the inbox folder.** Rejected. The inbox is a queue that is meant to drain, tasks are durable, and a task
count of thousands would bury captures. A managed folder per scope also keeps scope boundaries (ADR 0003) exact.

**One file for all tasks.** Rejected. It contradicts ADR 0004, loses per-task identity and provenance, and turns every
edit into a whole-file conflict.

**Per-note rows in the tasks index.** Rejected. It measured 212 ms per write and a 1.13 MB index at 10,000 tasks, and the
per-task listing is the operational store's job.

**Parsing with the default YAML schema.** Rejected. It converts unquoted dates and times to objects and numbers, which
breaks the round trip and the date-only versus instant distinction.

**A service write for edits.** Rejected. The service would have to take the owner's unsaved form state or overwrite a
concurrent edit; the plugin already has the conflict-safe write path and the open note.

**Auto-minting a new id for a copied note.** Rejected. A copy that silently gets a new id hides the duplicate, and a
guess about which note is the original can orphan links and dependencies. The duplicate is shown and the owner decides.

## Consequences

- A task is readable and editable in any editor, and a damaged note costs one task, never the index.
- The index can always be rebuilt from the vault, so the index schema may change without a data migration of tasks.
- The plugin bundle carries the YAML library (already bundled in an earlier phase).
- Two writers must keep the same key order and the same dump options; a parity test compares their bytes.
- Overview surfacing of due and overdue tasks is deferred to a later phase and reads the due-today feed.
