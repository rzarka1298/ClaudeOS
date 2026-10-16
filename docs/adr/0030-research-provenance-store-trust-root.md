---
status: accepted
satisfies: RSRCH-03 and RSRCH-04 (the quote shown as evidence is the source's own words; this record fixes what makes a quote count as evidence)
---

# A quote is verified only when the operational store vouches for it, not the vault

A research report cites sources and may quote them. The reader shows a quote as evidence (a `source-fact` with the
words in quotation) only if the words are in the stored source. Phase 7 first made that check against files in the
vault: the report's frontmatter, and the raw source note it points at (07-14, 07-FIX5). This record moves the trust
root out of the vault, into the operational store, and says what that does and does not defend.

## Context

The vault is Markdown on the owner's disk. Anything that can write the vault (a sync client, another tool, a
compromised plugin, a malicious note the owner pastes in, an agent with file access) can write a report and a raw
source note together. Every check the view model made in the vault passes on such a pair: the invented body hashes to
the hash the report cites, the raw note's own reference agrees with the report's, the source id is the hash of the
address, the snapshot path is the one derived from the id and the hash, and the quote is in the invented body. The wave
5 opus review (M2) found this, and the owner decided (D-A, 07-WAVE-REVIEWS.md) that the trust root must be the
operational store, which the vault's writers cannot reach.

## Decision

### 1. A record is written when the raw note is written and read back

Migration `0011_research_source_records` adds one table, `research_source_records`, with primary key
`(job_run_id, source_id)` and the columns `canonical_url`, `content_hash`, `snapshot_path`, `label`, `recorded_at`.
The pipeline writes one row per source, in the raw stage, after the raw note has been written and read back and its
hash recomputed from the stored body. A source that fails any earlier step has no row. A row is written once and never
updated; recording identical values again is a no-op and recording different values for the same run and source is an
error (`packages/operational-store/src/research-source-store.ts`).

The row holds ids, a SHA-256, an https address the owner's allowlist already named, a vault-relative path, the owner's
short label and an instant. No fetched text, remote title or model output column exists and none may be added. Each
input is checked against closed shapes before any statement runs, and `migration-provenance.audit.test.ts` walks the
column names and the stored values.

### 2. Verification requires the store

The view model (`packages/service/src/research/view-model.ts`) serves a quote as evidence only when every existing
vault-side check passes AND

- the report's `jobRunId` exists in the job-run store, and the run, if it already names the report it published,
  names this report;
- a record exists for (the report's run, the cited source id);
- the raw note's body, hashed again now, equals the recorded `content_hash` (and the cited one);
- the recorded address and snapshot path equal the cited ones.

Otherwise the finding is served as an inference with no quote and `quoteUnverified: true`, which is the existing
downgrade path and wire marker; the domain contract did not change. The title and the address that are served (the
citations on the items page, every source on the sources page) come from the record when there is one: the label is
the title and the record's address is the address. With no record they come from the raw note as before.

### 3. What is defended

An attacker who can write the vault but cannot write the operational store cannot make an invented quote verified:

- a forged report plus a matching forged raw note, for a run the store never saw, or for a real run that never recorded
  that source;
- a genuine run whose raw note and report citation were then rewritten together (new body, its real hash, matching
  frontmatter): the recorded hash is the original one;
- a raw note body edited in place;
- a report that names a job-run id the store does not know, or a run that published another report;
- one source whose record is missing while others exist: only the findings that cite it lose their quote;
- a record that disagrees with the citation (another address, another hash).

Tests: `view-model-store-trust.test.ts` (each case above and the genuine run), `pipeline-provenance.test.ts` (rows for
exactly the sources written and read back, and a real run's quotes served end to end), and the forged-variant sweep in
`research-routes-hostile.int.test.ts` (a real service process, five forged variants of every hostile text, none
verified; the same texts from a genuine run still are).

### 4. What is not defended

- **Write access to the operational store, or to the service process.** Whoever can write the store (or the SQLite
  file, the service's memory, or the machine as the owner's user with the store unlocked) can record anything. The
  store is a local file under the owner's account; this record defends against the vault, not against the account.
- **Genuine sources, misleading report text.** A forged report that cites a real run's real sources can still attach a
  real quote to a sentence that misrepresents it, or a report can omit what the source says. The check proves the
  quoted words are in the stored source, as it always did; it does not prove the report's claim follows from them.
- **The source itself.** A genuine fetch of a page that lies is recorded as fetched. Verified means "these words are in
  what the run stored", not "these words are true".
- **Records and the vault drifting apart.** Deleting a raw note leaves the record: the source then has no evidence text
  and its quotes are served as inferences. Pruning records when a run is pruned is not built.
- **Runs from before this migration.** A report written before migration 0011 has no records, so its quotes are served
  as inferences with the withheld marker. There is no backfill: a backfill would have to trust the vault, which is the
  thing this record stops trusting. In practice no report of this version predates it.
- **The sources page has no marker.** `ResearchReportSource` has no unverified or tampered field, so an unrecorded
  source is listed with the raw note's (or the report's) title and address and the reader cannot tell it from a
  recorded one on that page. The finding that cites it carries the marker. A marker on the sources page is a domain
  schema change and was not made.
- **Label and address are the only recorded descriptors.** The source type, access class, author and dates are not in
  the store and are still taken from the raw note or the report.

## Consequences

- The pipeline's raw stage writes to the store; a store fault there fails the run with `vault-write-failed`, the same
  code as a vault fault, so a source can never be cited as evidence without its row.
- Test helpers that build reports by hand must record the run and the sources (`recordProvenance` in
  `packages/service/src/research/test-support/report-vault.ts`); a report with no record is, correctly, never verified.
- The threat register of plan 07-14 (T-07-35 to T-07-37) is unchanged; the forgery of a verified quote from the vault is
  threat T-07-F6 (tampering by anyone with vault write access), mitigated by this record. See 07-FIX6-SUMMARY.md.
