---
status: accepted
satisfies: ADR-04 (partial — scope half)
---

# A Project and a Workspace are different things, bound optionally

The PRD uses the two words interchangeably in §6 ("Projects — registered
workspaces") but treats them as distinct in §7.2, where a Project has an
"optional Obsidian workspace memory path", and in §7.11, where the vault is
built around `workspaces/<workspace-id>/` and workspace display names may
change while stable IDs prevent broken references. Only one reading makes all
three statements true at once. A **Project** is a registered directory on disk
with a path, git state, and launchers. A **Workspace** is a knowledge scope in
the vault with a stable ID. A Project may bind to exactly one Workspace; a
Workspace requires no Project.

## Consequences

- A knowledge area with no code — market research, say — is a first-class
  Workspace, not a degenerate Project.
- A Project's absolute path stays in private configuration, while its
  Workspace's stable ID is safe to reference from vault content. The boundary
  falls exactly where the privacy boundary already falls.
- `VAULT-10` ("a workspace processor cannot write into another workspace") is a
  statement about knowledge scopes, not about code repositories.
- `TASK-01`'s scope and project-ID fields address different axes and cannot be
  collapsed into one.
