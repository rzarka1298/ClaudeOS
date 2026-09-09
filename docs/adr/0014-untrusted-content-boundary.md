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
