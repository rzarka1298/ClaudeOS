---
status: accepted
satisfies: ADR-03, ADR-05
---

# SQLite via better-sqlite3 for operational state; the `security` CLI for secrets

The operational store holds project paths, run state, usage aggregates, star
snapshots, and cache indexes — relational, queried, and migrating over time, so
SQLite rather than JSON files. We use `better-sqlite3` rather than Node's
built-in `node:sqlite`, which is still Release Candidate on Node 24. For
secrets we shell out to `/usr/bin/security` rather than binding a native
Keychain addon: `keytar` is archived, and even its maintained fork drags in a
`node-gyp` build step.

## Consequences

- Shelling out to a system binary for credentials is the same pattern `git`,
  `docker`, and `gh` use, and it keeps the install free of native compilation —
  which matters for a project meant to build from a clean clone (`REPO-01`).
- Revisit `node:sqlite` once it reaches Stable; migrating off `better-sqlite3`
  would remove a native dependency.
