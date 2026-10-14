---
status: accepted
satisfies: ADR-04 (partial — schema half; index-generation half lands in 0022)
---

# Note provenance is twelve frontmatter keys in a fixed order

`VAULT-07` requires every generated durable note to carry its full provenance,
and `VAULT-08` requires generated content to be visibly labeled and to
distinguish five kinds of claim. Both land in the same place — the note's YAML
frontmatter — because `PRD §4.2` principle 3 makes ordinary readable Markdown
the durable storage layer: anything the product knows about a note must be
legible in the file itself, not only in a sidecar database the user cannot see.

## The twelve keys

| Key | Why it exists |
|---|---|
| `id` | The note's identity, not its path. `VAULT-07`'s "stable note ID": a note may be renamed or moved between lifecycle folders and still be the same note, so indexes and the cache resolve by this, never by title or location. Minted per ADR 0021. |
| `scope` | `global` or `workspace:<id>` — which knowledge tree owns the note. Also the input to `VAULT-10`'s write guard, which is why its grammar forbids separators (see `packages/domain/src/note-schema.ts`). |
| `stage` | The `capture → raw → synthesis → wiki → deliverable → output` position. Metadata rather than a folder-derived fact, so a note's stage survives being moved and an index can group by it without inferring it from a path. |
| `created` / `updated` | `VAULT-07`'s two timestamps. Kept as separate keys rather than trusting filesystem mtime, which any sync tool, backup restore or `git checkout` rewrites. |
| `generatedBy` | `VAULT-07`'s "generating model/skill/automation/run ID", as a nested map of four optional subfields. Every subfield is optional because the provenance genuinely may not be known — a user-authored note has no model, a manual capture has no automation — and an absent subfield means "unknown", never "none". |
| `aiGenerated` | `VAULT-08`'s label. A plain boolean, deliberately separate from both `claimType` and `confidence` (see below). |
| `claimType` | `VAULT-08`'s five-way taxonomy: `source-fact`, `summary`, `inference`, `recommendation`, `unverified-claim`. Optional ONLY so a user-authored note can omit it; everything this repository generates sets it. |
| `sources` | `VAULT-07`'s source links, defaulting to `[]`. The empty list is a real state — "this note cites nothing" — and is deliberately distinct from the key being missing. |
| `confidence` | `VAULT-07`'s verification status: `verified`, `inferred` or `unverified`. |
| `lastReviewed` | `VAULT-07`'s last review date. Nullable rather than optional: `null` positively records "never reviewed", which a missing key could not distinguish from "this schema version had no such field". |
| `contentHash` | SHA-256 of the BODY only. Not a `VAULT-07` field — it is ours, and it earns its place by answering "has the content changed" for the metadata cache and the index without re-reading the file. Hashing the serialized note instead would make the hash flip on a provenance-only edit, which defeats the question it exists to answer. |

## `claimType` and `confidence` are orthogonal, not one field

They describe different things and must both be representable at once. A claim
type is the epistemic SHAPE of the content ("this is an inference I drew" vs.
"this is a fact I copied"); a confidence state is how far that content has been
CHECKED. An `inference` can be `verified` (someone confirmed the reasoning
holds) and a `source-fact` can be `unverified` (nobody re-read the source since
capture). Collapsing them into a single "status" field — the tempting
simplification — makes both of those notes unrepresentable, which is precisely
why `VAULT-07` and `VAULT-08` name them as two requirements rather than one.
`aiGenerated` is a third independent axis for the same reason: "a model wrote
this" stays answerable even for a note whose claim type is unknown.

## Key order is fixed in code, not delegated to the YAML library

`VAULT-03`/`VAULT-04` define deterministic as "re-running with no content
change produces a byte-identical file". JavaScript preserves string-key
insertion order, so the only thing that fixes YAML key order is the order a
writer inserts keys. `NOTE_FRONTMATTER_KEY_ORDER` (and
`GENERATED_BY_KEY_ORDER` for the nested map — pinning only the outer keys
leaves the inner ones following construction order, which alone breaks the
contract) is walked into a fresh object by every writer.

This is deliberately NOT a YAML library option:

- It would be one dependency upgrade away from silently changing, and a
  determinism regression shows up as noisy diffs in the user's vault, not as a
  failing import.
- The plugin (Phase 3 on) writes notes too, and may not use the same YAML
  library as the service. A key-order array exported from `@ccc/domain` is
  consumable by both; a library flag is not.
- The rule stays readable at the call site, where the next person changing the
  serializer will actually see it.

Absent optional keys are OMITTED entirely rather than emitted as `null`
placeholders — `null` in `model` would assert "there was no model", a different
claim from "the model is unknown".

## "Visibly labeled" means the frontmatter properties, for now

`VAULT-08` says generated content is *visibly labeled*. The accepted
interpretation for Phase 2 is: **the frontmatter keys ARE the label surface.**
Obsidian renders frontmatter as its Properties panel, so `aiGenerated: true`
and `claimType: inference` are visible to the user in the app, with no plugin
installed and no rendering work done.

Any richer treatment — a banner, an icon in the note header, a distinct
background for AI-generated sections — is a Phase 3+ concern that belongs to
the plugin's design system, and is recorded here as *not yet delivered* rather
than quietly assumed. Stating it explicitly is the point: without this
paragraph a later reader could read `VAULT-08` as satisfied by rendering that
does not exist, or as unsatisfied by metadata that does.

## Managed notes are plain-YAML-fronted, and that is enforced

A note's frontmatter is untrusted input: it may have been hand-edited in
Obsidian, synced in by another tool, or captured from the web (ADR 0014's
boundary). Parsing therefore refuses any opening delimiter carrying a LANGUAGE
TAG — only a bare `---` (or the explicit `---yaml`) is accepted.

The reason is concrete rather than precautionary. `gray-matter` reads the text
after the opening `---` as the name of the engine to parse the block with, and
one engine it ships — reachable as `js`, `JS` or `javascript` — is a literal
`eval`. Before this rule, a note beginning `---js` was arbitrary code executed
inside the companion-service process that holds the Keychain secrets and can
launch other processes. The `!!js/function` YAML tag that the phase research
flagged was never the exposure: js-yaml's safe load already refuses those (now
asserted in-repo). The exposure was the language selector one layer ABOVE YAML.

Consequences of the refusal: a `---json`- or `---toml`-fronted note is rejected
rather than parsed. That is accepted — one on-disk format, one parser, one
thing to reason about — and it costs nothing today, since every managed note is
written by `stringifyNote`.

## Consequences

- Twelve keys is a lot of ceremony for a short note, and the frontmatter can
  exceed the body in a capture. Accepted: `VAULT-07` asks for all of it, and a
  provenance field that is optional in practice is a provenance field that is
  usually absent.
- The schema validates on write AND on read. A hand-edit that breaks the shape
  surfaces as an `InvalidNoteFrontmatterError` naming the offending key, which
  is what plan 02-06's repair command consumes.
- Adding a thirteenth key later means updating the schema, the key-order array,
  and the tests that assert their agreement — deliberately, so a key cannot be
  added without a decision about where it sorts on disk.

## Amendment: research notes (Phase 7)

Phase 7 writes three new kinds of managed note. None of them forks the schema
above: each is `NoteFrontmatterSchema.extend({...})`, with the twelve provenance
keys as a literal prefix of its key-order array (spread from
`NOTE_FRONTMATTER_KEY_ORDER`), exactly as the task note does. The definitions
live in `packages/domain/src/research-note-schema.ts` and
`packages/domain/src/source-reference.ts`.

**Item kinds map onto `claimType`.** A report carries `claimType: summary` at note
level; each finding in `items[]` carries its own kind, a subset of `CLAIM_TYPES`:

| Visible label | Kind (a `claimType` value) | Confidence |
|---|---|---|
| Reported fact | `source-fact` | `unverified` |
| Source claim | `unverified-claim` | `unverified` |
| Model inference | `inference` | `inferred` |

`recommendation` is excluded in milestone 1 (PRD 7.9: no recommendations): it is not
in the item-kind enum, so a report that carries one fails the strict parse. A
reported fact and a source claim must cite at least one fetched source; a finding
that cites none is an inference. The labels, glyphs and rule shapes are one exported
map, `REPORT_ITEM_KIND_DISPLAY`, read by both the reader and the vault note writer,
so the note body and the view show identical words (RSRCH-04 "both its rendering and
its Markdown metadata").

**The three extended schemas and their key orders.**

- `ReportFrontmatterSchema` / `REPORT_FRONTMATTER_KEY_ORDER`: `type: report`,
  `stage` of `deliverable` or `output`, `generatedBy.automation` equal to the job id,
  then `topicLabel`, `generatedAt`, `jobRunId`, `summariser`, `partial`,
  `sourceTotal`, `unavailableSources`, `sourceRefs`, `sourceHandling`, `items`.
  `partial` is true exactly when `unavailableSources` is non-empty (ADR-0002:
  partiality is a flag, never a fifth freshness value). Every cited id and every
  handling entry names a source in `sourceRefs`.
- `RawSourceFrontmatterSchema` / `RAW_SOURCE_FRONTMATTER_KEY_ORDER`: `type:
  research-source`, `stage: raw`, the full `sourceRef`, the `sanitise` counts and an
  optional `truncated` flag. The reference's `snapshotPath` must equal the note's own
  path rule, `global/raw/<32 hex id>.<first 8 hash characters>.md`.
- `WikiSourceFrontmatterSchema` / `WIKI_SOURCE_FRONTMATTER_KEY_ORDER`: `type:
  research-wiki`, `stage: wiki`, `sourceId`, `latestSnapshotPath`, `lastRetrievedAt`.

The nested orders (`REPORT_ITEM_KEY_ORDER`, `REPORT_UNAVAILABLE_SOURCE_KEY_ORDER`,
`REPORT_HANDLING_KEY_ORDER`, `SOURCE_REFERENCE_KEY_ORDER`) are exported too, so a
rewrite is byte-identical all the way down.

**Why the report cap is 128 KiB.** The task note's 64 KiB frontmatter cap does not
fit a report: 25 findings at the maximum text (600 characters) and quote (240
characters) lengths in a three-byte script, plus twelve full references, is well
over 64 KiB. `REPORT_FRONTMATTER_MAX_BYTES` is 128 KiB and
`REPORT_FILE_MAX_BYTES` is 256 KiB; a raw source note is capped at 64 KiB of
frontmatter and 1 MiB in all, because its body holds one sanitised snapshot. A
worst-case test with real three-byte text pins the margin. Parsers enforce the caps
before parsing (alias and size amplification).

**Two different hashes, both called `contentHash`.** The note-level `contentHash`
is stamped by the writer over the whole note body. `sourceRef.contentHash` is the
SHA-256 of the canonical sanitised text before any Markdown escaping and without
the untrusted-content banner, computed by the service; it is recomputable from a
raw note body by removing the banner. They answer different questions (did this
file change; is this the same source text), so neither can stand in for the other.

**The schema, the order arrays and the tests change together**, as for tasks: a key
added to one and not the others fails `research-note-schema.test.ts`.
