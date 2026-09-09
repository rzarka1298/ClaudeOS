---
status: accepted
---

# TypeScript is pinned to 6.x, deliberately behind the current release

TypeScript 7.0's native compiler has no stable Compiler API until 7.1, and
`typescript-eslint` has closed TS7 support as not-planned. That chain is
load-bearing here: without it, `eslint-plugin-obsidianmd` — the tool Obsidian's
own plugin-review bot runs — cannot run, and `REPO-06` requires it in CI. We
stay on 6.x until the lint chain catches up.

## Consequences

- A future contributor will see a deliberately old pin and assume it is
  neglect. This ADR exists primarily to stop them from "fixing" it.
- Revisit when `typescript-eslint` ships TS7 support and
  `eslint-plugin-obsidianmd` follows.
