---
status: accepted
---

# Every Run has a service-minted ID; the Claude session ID is a correlation field

A Session's identity is assigned by Claude Code and arrives from outside, while
an Automation Run's is minted here. Keying Runs by whatever their originating
system assigned would make the two subtypes structurally different. Instead
every Run gets a service-minted `RunId`, and a Session additionally carries a
nullable `claudeSessionId`.

## Consequences

- `SESS-17` (associate an unclassified session with a Project after the fact)
  becomes possible. It would not be if Claude's ID were the primary key, since
  a Run must be able to exist in the store before we know what Claude calls it.
- An externally-launched session and a dashboard-launched one are the same
  shape, differing only in whether the correlation field is populated yet.
- `SESS-13` resume still passes Claude's own identifier to Claude; the two ID
  spaces never need to be reconciled, only linked.
