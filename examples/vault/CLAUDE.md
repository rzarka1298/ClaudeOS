# Managed knowledge vault

This vault is managed by Claude Command Center. Folders, `index.md` files
and this file were generated at setup; everything else is authored by a
human or by an agent writing through the managed write path.

Two rules govern every write:

- `index.md` in any managed folder is **generated**. It is rebuilt from
  scratch whenever the folder's notes change, so hand-edits to it are lost.
  Put durable prose in a note, never in an index.
- Every other file is **yours**. Setup creates missing folders and
  regenerates indexes; it never overwrites a note, and it never overwrites
  this file once it exists.

## Lifecycle

A piece of knowledge moves through six stages. The stage is recorded in a
note's `stage` frontmatter field, not inferred from its folder, so moving
a note does not silently reclassify it.

1. **capture** — something arrived and was written down before it was
   understood. Lands in `inbox/`, which is a queue, not a home.
2. **raw** — unprocessed source material kept verbatim: fetched pages,
   transcripts, pasted excerpts. Lives in a `raw/` folder.
3. **synthesis** — the working stage where raw material is read, compared
   and reduced into claims. Usually short-lived.
4. **wiki** — durable, deduplicated knowledge meant to be re-read and
   linked. Lives in a `wiki/` folder. This is the stage most notes should
   end up in.
5. **deliverable** — knowledge shaped for a specific audience or purpose.
6. **output** — the finished artifact, published or handed off. Lives in an
   `output/` folder.

Supporting folders sit outside that flow: `daily/` holds date-stamped
journal notes, `automation-runs/` holds the vault-visible record of
scheduled work, and `system/` holds operational content the vault needs to
surface to a human.

## Finding notes

**Resolve a note by its ID, not by its title or its path.** Every managed
note carries a stable opaque `id` in its frontmatter. Titles get edited and
files get moved between lifecycle folders; the ID does not change, so it is
the only reliable handle.

To find something:

1. Open the `index.md` of the folder you expect it in. Every index lists
   its folder's direct-child notes with each note's ID, stage and last
   update.
2. Match on the ID from that listing, then open the file the row names.
3. If an index lists a note under `## Unreadable`, that file exists but its
   frontmatter failed validation — read it directly and repair the
   frontmatter rather than assuming the note is gone.

An index describes **only its own folder**, never subfolders. Walk down one
level at a time. Indexes are regenerated, so a stale-looking index means
regeneration has not run yet, not that a note was deleted.

## Tasks

Tasks live in a `tasks/` folder: `global/tasks/` for tasks that belong to
no workspace, and one `tasks/` folder inside every workspace. Each task is
**one note**, with a stable `id` in its frontmatter. As with every note,
resolve a task by that ID: the file name is chosen once, when the task is
created, and never changes when the title does.

The `index.md` of a tasks folder is a summary, not a listing. It holds fixed
text and per-status counts as of the last rebuild, and it names no individual
task, so it stays the same size however many tasks there are. Find tasks
through the task views, or by opening the folder.

Tasks are created and edited through the plugin, or by hand in Obsidian's
Properties view. Change any field you like, but leave the `id` alone: it is
how the task is tracked. A task note with no `id`, or two notes that share
one, is listed for attention and is never fixed automatically.

## Scope boundaries

Knowledge is partitioned into exactly two kinds of scope, and the partition
is enforced at write time — a write that crosses it is refused, not merged.

- **global** — `global/` plus the shared `inbox/`, `daily/`,
  `automation-runs/` and `system/` folders. Knowledge that belongs to no
  single workspace.
- **workspace** — `workspaces/<workspace-id>/`. One self-contained
  knowledge tree per workspace, addressed by an opaque ID.

The rules:

- A process working on behalf of one workspace reads and writes **inside
  that workspace's folder only**. It must never write into another
  workspace, and it must never write into `global/`.
- A global-scoped write must never reach into `workspaces/` at all.
- A workspace directory is named by its opaque ID, never by its display
  name. The display name lives in the workspace's root `index.md`
  frontmatter. **Renaming a workspace changes that one field and nothing
  else** — no path moves, no note is rewritten, no link breaks.
- Nothing may be written outside this vault through a managed write.

If a task seems to require crossing a scope boundary, the right move is to
write a note in your own scope that references the other one — not to reach
across.
