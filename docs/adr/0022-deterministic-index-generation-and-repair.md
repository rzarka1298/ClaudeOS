---
status: accepted
satisfies: ADR-04 (completes — index-generation half; schema half is ADR 0020)
---

# Indexes are recomputed wholesale, and repair flags ambiguity instead of resolving it

`VAULT-03` requires index generation to be deterministic and `VAULT-04` requires
a repair command that rebuilds every index from vault contents without altering
note bodies. Together they fix the shape of every derived artifact in the
managed vault: an index is a pure function of the notes beside it, and repair is
that function applied everywhere at once.

This ADR completes `ADR-04`. The schema half — what a note's frontmatter
contains and in what order — is `docs/adr/0020-note-frontmatter-provenance-schema.md`.
The identity half is `docs/adr/0005-workspace-identity-and-project-binding.md`.

## Full recompute, then one atomic replace

`index.md` is never patched. Regeneration re-reads every direct-child note's
frontmatter, rebuilds the whole file as one string, and replaces it through
`atomicWriteFileSync`.

The cheaper-looking alternative — read the old index, add or remove the one
changed line, write it back — reintroduces a stale-read/stale-write race on the
index itself, because between the read and the write another writer may have
regenerated it. Full recompute has no read step to race against. It is also
what makes "byte-identical on re-run with no changes" — the actual operational
meaning of *deterministic* — reachable at all, rather than a property that holds
until two writes interleave.

Consequence: regenerating a folder costs a frontmatter read per direct child,
paid on every managed write. That is the price, and it is accepted. The scan is
direct-children-only (an index describes its own folder, never a subtree), and
note bodies are never read.

## The sort is `created`, then `id`, then filename

Two runs over the same notes must produce the same bytes, so the row order
cannot come from `readdirSync`. APFS returns entries in something close to
creation order, which is stable enough to look deterministic in testing and is
not deterministic. The comparator is written out explicitly and uses plain
`<` / `>` rather than `localeCompare`, whose result depends on ICU collation.

`created` then `id` is the documented pair. Filename is a third tiebreak, and it
is not redundant: two notes genuinely **can** carry the same `id` — a duplicated
file is exactly the corruption repair exists to detect — and without a final
discriminator those two rows would fall back to enumeration order in the one
situation where the index most needs to be stable. `repairVault`'s returned
records sort on the same principle: `created`, then `id`, then path.

## `index.md` is exempt from the `VAULT-07` provenance schema

A generated index carries a minimal, constant marker frontmatter — `type`,
`generated`, `folder` — and not the twelve-key note schema ADR 0020 defines.

This is a direct consequence of determinism rather than a convenience. The
provenance schema's centre of gravity is `created` / `updated` / `lastReviewed`:
clock values. An index that stamped a `generatedAt` would differ from its
predecessor on every single regeneration, which makes `VAULT-03`'s byte-identical
contract unsatisfiable **by construction** — not hard to satisfy, impossible.
The two requirements are mutually exclusive on the same file, and determinism is
the one the repair command, the idempotent setup path and the git-diff
regeneration gate are all built on.

There is no loss here. Provenance describes authored content, and an index has
none: every byte of it is derived from notes that carry their own full
provenance. The marker keys exist so that a human or a tool reading a stray
`index.md` can tell at a glance that it is generated and will be overwritten.

## Workspace identity is the one thing an index reads back

`readIdentity()` recovers exactly two keys — `workspaceId` and `displayName` —
from the index being replaced, and re-emits them. Everything else is recomputed.

This is the accepted nuance to "an index is never user-authored". A workspace's
display name **is** user-authored: ADR 0005 keeps workspace directories opaque
precisely so a rename is rename-safe, and the workspace-root `index.md`
frontmatter is where that name lives. Making a rename a single-field edit to
that file — with regeneration carrying the field forward while rebuilding every
other byte — is what turns "a rename moves no path and touches no note" from an
aspiration into a mechanical fact.

The read-back is deliberately narrow (two keys, at the workspace root only) so
the full-recompute contract above stays intact: there is still no path by which
old index *content* influences new index content.

## Repair flags ambiguity; it never resolves it

`repairVault(vaultRoot)` walks the managed folder list `computeSetupEntries`
drives setup from, plus every existing `workspaces/<id>` subtree, recursively;
reads frontmatter only; regenerates every managed index; and returns
`{ notes, warnings }`.

Three conditions are reported and never repaired:

| Condition | What repair does |
|---|---|
| A note `id` at more than one path | One `duplicate-id` warning naming **every** path, and **every** copy excluded from the returned records |
| An `id` listed in a pre-existing index but absent from disk | An `orphaned-index-entry` warning; regeneration drops the row naturally |
| Frontmatter that fails `NoteFrontmatterSchema` | An `invalid-frontmatter` warning naming the file and the failing field; the file is left exactly as found |

A repair command that silently picked a winner among duplicates would be a
data-loss mechanism wearing a maintenance command's name, and the loss would be
invisible — the user would see a tidy vault and a missing note. This is the same
discipline `SchemaAheadOfCodeError` applies in the operational store: refuse and
report rather than guess.

Two scope decisions follow from this:

- **Repair writes `index.md` files and nothing else.** Note bodies are never
  read, rewritten, moved, or deleted — including the invalid ones. The proof is
  a full-tree per-file sha256 comparison across a repair run, not a comment.
- **Repair rebuilds derived artifacts; it does not invent managed folders.**
  Notes are *scanned* recursively (so a copy stashed in a subfolder is still
  caught by the duplicate check), but an index is *regenerated* only in the
  fixed skeleton and in workspace trees. Repair will not drop a generated file
  into a subfolder the user made for their own reasons.
- **An orphan warning is one-shot by design.** Regeneration removes the row that
  produced it, so a second repair over an untouched vault reports nothing.
  Duplicate and invalid-frontmatter warnings persist across runs, because repair
  does not touch the notes that cause them. Both behaviours are asserted.

## Repair rebuilds both derived artifacts from one walk

The walk that regenerates the indexes also returns the note records, and those
records repopulate the `vault_notes` metadata cache through `rebuildVaultNotes`.
One pass over the vault, two derived artifacts reconstructed — the cache is
disposable precisely because this path exists.

The composition happens in the **service layer**, never inside
`@ccc/vault-repo`: that package must not import `@ccc/operational-store`, which
is an import-boundary the CI gate enforces (ADR 0019). `repairVault` therefore
returns records rather than writing rows.

## Three Phase 2 consistency policies, each with its Phase 6 trigger

Phase 2 builds the mechanisms. Each of these is **recorded now and mechanically
enforced later**, because the consumer that would make enforcement meaningful
does not exist until Phase 6.

**(a) Write-class routing.** Service-generated artifacts are written by the
service's `writeNote`. Any note that may be open in an editor is written only
through the plugin's vault-write module, which goes via Obsidian's Vault API so
the editor's own state is not fought over. Phase 2 records the two classes but
does not enforce them, because there is no cross-process write consumer yet — a
rule with no possible violator is untestable. Enforcement lands with the first
Phase 6 consumer that can write from both sides.

**(b) Cache population.** In Phase 2 the `vault_notes` cache is populated by
`rebuildVaultNotes`, fed by repair's single walk. Every future production write
route must additionally upsert through the service-layer seam that composes
`writeNote`'s returned `WrittenNote` into `upsertVaultNote` — never by
`vault-repo` importing `operational-store`, which would breach the layering
`ci:boundaries` protects. `upsertVaultNote` is exported, tested against real
`writeNote` output, and deliberately uncalled in production in Phase 2; its
first production caller is the first service-side note-write route (Phase 6).

**(c) Index eventual consistency for plugin-side provenance updates.** A
provenance edit made by the plugin does not synchronously regenerate the
folder's index. The bound is narrow and stated exactly: the only thing that can
lag is a row's **displayed `updated` value**. No row appears, disappears, or
changes identity, because the plugin's provenance edits do not create, delete,
move, or re-id notes. The lag is closed by the next service-side write into that
folder or by the next repair run. Service-side writes have no such window at
all — `writeNote` regenerates its folder's index synchronously as its final
step, which is what makes "the index is stale" unreachable on that path. Phase 6
is where a write route could widen the class of plugin-side edits, and is
therefore where this bound must be re-checked rather than assumed.

## Consequences

- Any change that adds a clock value, a counter, or a host-dependent value to a
  generated file breaks `VAULT-03` on contact. The determinism tests compare raw
  bytes with `Buffer.compare`, so such a change fails loudly rather than
  degrading quietly.
- Repair's output is diffable: two runs over an unchanged vault produce
  deep-equal reports, so a difference between runs is information about the
  vault rather than about filesystem enumeration order.
- The cache can be deleted at any time. Repair reconstructs it, and nothing
  durable lives only there (ADR 0020's note schema is the ground truth, on
  disk, in readable Markdown).

## Amendment: the tasks folder summary index

Added in Phase 6. Everything above is unchanged and still governs every other managed folder.

A tasks folder's `index.md` is a summary of constant size: counts by status, not one row per note. Per-note rows measured
212 ms per incremental write and a 1.13 MB index at 10,000 task notes, so a per-write regeneration could not meet the
responsiveness target. The summary's size does not grow with the number of tasks.

The counts are computed only by setup, repair and rebuild, and are stated as of the last rebuild. Task writes never
touch the index: creating, editing or completing a task leaves it byte-identical, and the per-task listing is served
from the disposable index in the operational store. The summary is still a pure function of the notes beside it, so the
determinism and repair rules of this record hold for it. The record for the task model is the one titled "A task is
one note under a managed tasks folder, filtered by fixed predicates in the owner's time zone".
