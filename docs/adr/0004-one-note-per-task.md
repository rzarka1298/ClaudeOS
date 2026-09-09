---
status: accepted
satisfies: ADR-12
---

# A Task is one Markdown note, not an inline checkbox

`TASK-02` requires a Task to round-trip through Markdown without losing its
stable ID or any of the eighteen fields `TASK-01` lists, including parent,
dependencies, and provenance. No existing Obsidian convention delivers that.
The Tasks plugin's inline emoji vocabulary is fixed and has no slot for
provenance, source links, or a seven-value status; an inline checkbox anchored
by a block reference to a sidecar note leaves two objects to keep consistent
and lets a hand-edit orphan the anchor. We store each Task as its own note with
every field a first-class frontmatter key.

## Considered Options

**Tasks-plugin-compatible inline syntax.** Rejected. Interoperating with the
ecosystem's most-installed task plugin is genuine value, but it can only be had
by smuggling the unsupported fields into an adjacent comment, at which point
the round-trip guarantee holds by discipline rather than by construction —
which is exactly what `TASK-02` forbids.

**Inline checkbox plus block-referenced metadata note.** Rejected. Keeps text
readable inline, but splits one entity across two files whose consistency
nothing enforces.

## Consequences

- Interoperability with the Tasks plugin is lost. This is the real cost and it
  is accepted deliberately: `TASK-02` is a hard requirement, interop is not.
- Provenance comes free — a Task is just another durable note carrying the
  `VAULT-07` schema, so it needs no parallel mechanism.
- The vault gains thousands of small files. This does not threaten `TASK-09`,
  whose 10,000-task responsiveness target applies to filters reading the
  service's own index, not to a vault scan.
