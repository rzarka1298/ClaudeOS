---
status: accepted
satisfies: ADR-11
---

# An LLM call that reads external content has no tools and no write path

Email, web pages, repositories and imported Markdown are untrusted data. The
PRD's §11.3 instruction to treat them as data rather than instructions is
necessary but not sufficient on its own — prompt injection defeats prose
mitigations. The separation is therefore structural: any model call that
processes externally sourced content is constructed with no tool access and no
write capability, so `RSRCH-07` is verifiable by tracing the call path rather
than by reading a prompt.

## Consequences

- The research pipeline splits in two: an untrusted summarisation stage that
  can only return text, and a separate trusted stage that writes results
  through the vault repository.
- This is what keeps the system off the lethal trifecta — private data,
  untrusted content, and an external write path never coexist in one context.
- Externally sourced content is delimited and stripped of active HTML before it
  reaches the model, and commands appearing in it are never executed
  (`RSRCH-08`, `RSRCH-09`).
- Enforced by the same import-boundary lint as ADR-0012, established in Phase 1
  because it constrains the module layout laid down there.

## Phase 7 enforcement

Phase 7 gives the `untrusted` folder (`packages/service/src/untrusted/`) its real
shape and enforces "no tools and no write path" by three independent layers, so a
reviewer can trace the summariser call path from types and imports without
reading a prompt (`RSRCH-07`, `RSRCH-09`, success criterion 4).

The shape: `summarizeUntrusted(input, transport)` takes delimited text plus the
ids of the sources it contains, hands two strings (`instructions`, `input`) to an
injected `TextTransport` port, and returns the text that comes back. The port is
constructed by the trusted composition root. Its request type has no field in
which a tool declaration, a function schema or a credential could be placed, and
the module imports `@ccc/domain` types only. A call with no source ids, or with
an id that is not 32 lowercase hex characters, is refused before the transport
is reached. The fixed instruction text is a constant and is defence in depth
only; the proof is the layers below.

| Layer | What it enforces | Fire-proving fixture or test |
|-------|------------------|------------------------------|
| 1. eslint `untrusted` element | the folder may import `@ccc/domain` and nothing else (no adapter, vault repository, operational store or Keychain wrapper) | `boundary-lint.test.ts`: a file under `packages/service/src/untrusted/` importing the operational store fires, a domain type import is quiet; fixture `boundary-violations/untrusted/untrusted-imports-adapter.ts` |
| 2. Nested `types: []` project | the folder is a nested composite TypeScript project (`src/untrusted/tsconfig.json`, referenced by the service project and excluded from its `include`) with an empty `types` list, so `fetch`, `process`, `require`, `Buffer`, timers, `console` and every `node:` or `child_process` module do not exist when it compiles | `ts-boundary.test.ts`: fixture `ts-boundary-violations/untrusted-shaped` yields one TS2304 or TS2591 diagnostic per name; its clean twin `untrusted-shaped-clean` imports a domain type and compiles with no Node typings in the program, which shows domain's emitted declarations do not bring Node's ambient types in |
| 3. Grep backstop rule 17 | no file under the folder, test files included, names `node:`, `child_process`, `fetch(`, `require(`, a dynamic `import(`, `process`, `globalThis`, `eval`, `Function`, `Reflect`, `XMLHttpRequest`, `WebSocket`, `EventSource` a `.constructor` access or an `import` that ends its line; comment lines are exempt (a closed block comment before code on the same line is not a comment line), and identifiers that merely contain those letters (`processed`, `refetch`) are quiet. Rule description: "a file under packages/service/src/untrusted/ names an I/O primitive ..." in `scripts/check-boundaries.sh` | `check-boundaries-rules.test.ts`: one fire case per name, quiet cases for look-alike identifiers, comments, a sibling folder, test files of the folder (scanned) and a leading block comment (`check-boundaries-comment-prefix.test.ts`) |

Why layer 3 exists: `types: []` removes the Node and DOM globals, but the ES2022
library still supplies `globalThis`, `eval`, `Function`, `Reflect` and a dynamic
`import()` with a computed specifier, and the compiler accepts all of them. The
`ts-boundary.test.ts` case "known limit of this layer" compiles a probe using
each and asserts it passes, so the gap is written down beside the proof rather
than hidden. Rule 17 is the layer that closes it; its count and header listing
are pinned in `check-boundaries-rules.test.ts` and `phase051-wiring.audit.test.ts`.

Known limit that none of the layers addresses: text hidden by a stylesheet or by
a class (not an inline `style`) cannot be recognised without rendering the page,
so such hidden text survives sanitising and reaches the model. The residue is
handled by the delimiter that frames every source block as data, and by the
no-tools port: a model that is steered by hidden text can only return text, and
the trusted stage treats that text as data (`D-06`).
