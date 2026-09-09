---
status: accepted
satisfies: ADR-04 (partial — identity half)
---

# Workspace IDs are opaque, and the Project binding lives outside the vault

§7.11 requires that Workspace display names may change without breaking
references, which rules out deriving the vault directory from a human slug.
Workspaces are therefore identified by opaque, sortable IDs, with the display
name carried in the Workspace's own `index.md`. Separately, because a Project
is the private half of the pair (its absolute path must never reach tracked
files, per `PROJ-14`), the Project-to-Workspace binding is stored on the
Project side in the operational store rather than in vault content.

## Consequences

- Vault directories are not human-readable. Mitigated by every index carrying
  the display name, and accepted as the price of rename-safe references.
- The vault never needs to know that a local filesystem path exists. The
  domain boundary and the privacy boundary fall in the same place, so nothing
  has to be redacted on the way out.
