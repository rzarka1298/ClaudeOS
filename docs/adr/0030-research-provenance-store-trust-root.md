---
status: accepted
satisfies: RSRCH-03 and RSRCH-04 (the quote shown as evidence is the source's own words; this record fixes what makes a quote count as evidence)
---

# A quote is verified only when the operational store vouches for it, not the vault

A research report cites sources and may quote them. The reader shows a quote as evidence (a `source-fact` with the
words in quotation) only if the words are in the stored source. Phase 7 first made that check against files in the
vault: the report's frontmatter, and the raw source note it points at (07-14, 07-FIX5). This record moves the trust
root out of the vault, into the operational store, and says what that does and does not defend. It was amended by
07-FIX6b (the report itself is bound to its run, and only the run that published a report vouches for it).

## Context

The vault is Markdown on the owner's disk. A writer that can reach the vault and nothing else (a sync client that
merges another device's files, a note the owner pastes or imports, a tool whose scope is the vault folder) can write a
report and a raw source note together. Every check the view model made in the vault passes on such a pair: the invented
body hashes to the hash the report cites, the raw note's own reference agrees with the report's, the source id is the
hash of the address, the snapshot path is the one derived from the id and the hash, and the quote is in the invented
body. The wave 5 opus review (M2) found this, and the owner decided (D-A, 07-WAVE-REVIEWS.md) that the trust root must
be the operational store, which a vault-confined writer cannot reach.

## The attacker this defends against

**The defended attacker is a writer confined to the vault.** It can create, edit, rename and delete files under the
vault folder, as a sync client, an import or a vault-scoped tool can. It cannot write the operational store (a SQLite
file under the service's runtime directory, outside the vault) and cannot act inside the service process.

**Out of scope: anyone who can write the operational store or the service process.** A compromised plugin, an agent
with general file access and any other process that runs as the owner's user can write the SQLite file, and the
service runs as that same user. Such a party can record any run, source and report it likes, and nothing here stops it.
The store is a local file under the owner's account; this record defends against the vault, not against the account.
(An earlier draft of this record listed a compromised plugin and an agent with file access as defended. They are not:
they have the same access as the service.)

## Decision

### 1. A source record is written when the raw note is written and read back

Migration `0011_research_source_records` adds one table, `research_source_records`, with primary key
`(job_run_id, source_id)` and the columns `canonical_url`, `content_hash`, `snapshot_path`, `label`, `recorded_at`.
The pipeline writes one row per source, in the raw stage, after the raw note has been written and read back and its
hash recomputed from the stored body. A source that fails any earlier step has no row. A row is written once and never
updated; recording identical values again is a no-op and recording different values for the same run and source is an
error (`packages/operational-store/src/research-source-store.ts`). A record can be made only for a run that exists and
is still in flight (07-FIX6b): a run that is unknown, finished, failed or stale cannot take one, and the writer throws
the job-run store's typed error and writes nothing.

The row holds ids, a SHA-256, an https address the owner's allowlist already named, a vault-relative path, the owner's
short label and an instant. No fetched text, remote title or model output column exists and none may be added. Each
input is checked against closed shapes before any statement runs, and `migration-provenance.audit.test.ts` walks the
column names and the stored values.

### 2. A report record binds the report to its run (07-FIX6b)

Migration `0012_research_report_records` adds one table, `research_report_records`, with primary key `job_run_id` and
the columns `report_note_id`, `content_digest` and `recorded_at`. It is content-free: a run id, a note id, a SHA-256
and an instant (`research-report-store.ts`; `migration-report-record.audit.test.ts` walks the columns and the values).

The digest is the SHA-256 of a canonical serialisation (sorted keys, absent optionals omitted, arrays in order, strings
written exactly) of everything the reader serves from the report: its note id, run id, topic, generation instant and
summariser; `partial`, `sourceTotal` and the unavailable sources with their codes; every cited source reference in
order (the order is the citation numbering) and the per-source handling counts; and every finding with its kind, text,
quote and cited source ids in order (`packages/service/src/research/report-digest.ts`). The stage is not covered, since
finalising changes it.

The pipeline writes the row when it has finalised the report: it reads the report back from the vault, parses it exactly
as the reader will, records the digest, and only then logs the `output` stage and finishes the run. A report that is
taken back (a failed finalise, a store write that fails, a run that cannot record its success) takes its record back
with it. A record can be made only for a run that is still in flight, and a store fault while recording ends the run as
`vault-write-failed` with nothing published.

### 3. Verification requires the store

The view model (`packages/service/src/research/view-model.ts`) serves a quote as evidence only when every existing
vault-side check passes AND

- the report's run is the run that published this report: it finished (`completed`, outcome success or partial) naming
  this report's note id; or it is still working and its stage log already holds an `output` entry naming this report
  (the pipeline appends that entry after it has finalised the report and recorded its digest, and before it finishes
  the run). A run that failed, was cut off, went stale, finished naming no report or another one, or is still working
  but has not reached its output stage, does not vouch, and a run the store never saw does not either. Such a run keeps
  the sources it recorded genuinely, and a forged report must not be able to borrow them (07-FIX6b, MAJOR-1);
- the report record for that run names this report and holds the digest of the report as it is now, recomputed from the
  report parsed from the vault (07-FIX6b, MAJOR-2). No record means no match;
- a source record exists for (the report's run, the cited source id), the raw note's body, hashed again now, equals the
  recorded `content_hash` (and the cited one), and the recorded address and snapshot path equal the cited ones.

Otherwise the finding is served as an inference with no quote and `quoteUnverified: true`, which is the existing
downgrade path and wire marker; the domain contract did not change. A report whose digest does not match loses the
quotes of every finding, not only the edited one, because it is no longer the run's report. The title and the address
that are served (the citations on the items page, every source on the sources page) come from the source record when
there is one: the label is the title and the record's address is the address. A source carries exactly one address, so
when the record supplies the https address a deep link in the raw note is not served beside it (a source with both would
not be a valid source). With no record they come from the raw note as before.

### 4. What is defended

A vault-confined writer cannot make an invented quote verified:

- a forged report plus a matching forged raw note, for a run the store never saw, or for a real run that never recorded
  that source;
- a genuine run whose raw note and report citation were then rewritten together (new body, its real hash, matching
  frontmatter): the recorded hash is the original one;
- a raw note body edited in place;
- a report that names a job-run id the store does not know, or a run that published another report;
- a report that borrows a real run that did not publish it: one that failed, went stale or was cut off, one still
  working before its output stage, one that finished naming no report (07-FIX6b);
- a genuine report edited in place, with its note id and run id kept: a claim reworded, a finding's kind flipped (an
  inference given a real quote of the source and turned into a source fact), a quote swapped for another real quote of
  the same source, the partial flag or the unavailable sources rewritten, the source total changed, a finding dropped or
  a source reordered. The digest no longer matches, so no quote of the report is shown as verified (07-FIX6b);
- a report with no report record, a record holding another digest, or a record naming another report (07-FIX6b);
- one source whose record is missing while others exist: only the findings that cite it lose their quote;
- a record that disagrees with the citation (another address, another hash).

Tests: `view-model-store-trust.test.ts` and `view-model-report-binding.test.ts` (each case above and the genuine run),
`pipeline-provenance.test.ts` and `pipeline-record-refusal.test.ts` (rows for exactly the sources written and read back,
the report record and its removal on rollback, a real run's quotes served end to end, a store fault while recording),
and the forged-variant sweep in `research-routes-hostile.int.test.ts` (a real service process; forged variants of every
hostile text, none verified, including a report edited in place and a report with no digest, each applied to every
text; the same texts from a genuine run still are).

### 5. What is not defended, and the limits of what is

- **Write access to the operational store, or to the service process.** See "The attacker this defends against".
- **The model's own sentence over genuine sources.** The digest binds the report to what the run wrote, so a vault
  writer can no longer attach a real quote to a sentence the run did not write. A sentence the run itself wrote
  (the summariser's reading, which can misrepresent a quote that is really in the source) is still served with its
  quote; the check proves the quoted words are in the stored source, never that the claim follows from them. Verified
  means "these words are in what the run stored", not "these words are true", and a genuine fetch of a page that lies is
  recorded as fetched.
- **Verification is up to the canonical hash form.** The raw note's body is compared by the canonical hash of the
  service (`canonicalHashInput`: NFC, CRLF and lone CR to LF, trailing whitespace trimmed on every line, one trailing
  newline), so the differences that form removes do not change the hash: a U+FEFF at the end of a line (it counts as
  trailing whitespace; a leading one does change the hash), CRLF against LF line endings, Unicode normalisation (NFC
  against NFD), trailing spaces and trailing blank lines. A body edited only in those ways still verifies. The quote
  itself is matched on the normalised comparison form, as it always was.
- **The sources page has no unverified marker.** `ResearchReportSource` has no unverified or tampered field, so an
  unrecorded source is listed with the raw note's (or the report's) title and address and the reader cannot tell it from
  a recorded one on that page. The finding that cites it carries the marker. A marker on the sources page is a domain
  schema change and was not made. The same holds for the report header's facts (partial, source total, unavailable
  sources): they are read from the report; on a report whose digest does not match they are not vouched for, and the
  header does not say so.
- **No backfill.** A report written before migration 0011 has no source records, and one written before migration 0012
  has no report record, so their quotes are served as inferences with the withheld marker. A backfill would have to
  trust the vault, which is the thing this record stops trusting. In practice no report of this version predates them.
- **No pruning.** Records are not removed when a raw note, a report or a run is deleted. A deleted raw note leaves its
  record, and the source then has no evidence text and its quotes are served as inferences; a deleted report leaves its
  report record. Both are content-free and small. Only a publication the pipeline itself takes back removes its report
  record.
- **Label and address are the only recorded descriptors.** The source type, access class, author and dates are not in
  the store and are still taken from the raw note or the report (the digest covers the report's copy of them, so a
  report cannot change them after the run, but a raw note can still differ from them in those fields).

## Consequences

- The pipeline's raw stage and its finalise write to the store; a store fault there fails the run with
  `vault-write-failed`, the same code as a vault fault, so a source can never be cited as evidence without its row and a
  report is never published without its record. A source whose own record is refused (a value outside the closed shapes,
  a different record for the same address already made) fails alone, like a snapshot that was edited, and the run goes
  on. A run that was ended under the pipeline (cut off, recovered as stale) stops as `interrupted` without recording
  anything more.
- Test helpers that build reports by hand must record the run, the sources and the report (`recordProvenance` in
  `packages/service/src/research/test-support/report-vault.ts`); a report with no record is, correctly, never verified.
- The threat register of plan 07-14 (T-07-35 to T-07-37) is unchanged; the forgery of a verified quote from the vault is
  threat T-07-F6 (tampering by a vault-confined writer), mitigated by this record. See 07-FIX6-SUMMARY.md and
  07-FIX6b-SUMMARY.md.
