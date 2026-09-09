---
status: accepted
---

# Event replay uses a bounded in-memory buffer, not a durable log

ADR-0001 cost us `EventSource`'s free reconnection and `Last-Event-ID`
resumption, but `SVC-07` still requires replay after reconnect. The obvious
alternative — persisting an event log in the operational store — would create a
second durable record of exactly the session activity that `USAGE-07` lets the
user disable and `USAGE-08` lets them delete. We keep a bounded in-memory ring
buffer and fall back to an explicit full resync when the requested event ID has
aged out.

## Consequences

- A service restart loses replay history. Acceptable: the plugin must implement
  full resync anyway for its first connect, so the miss path is not extra work.
- No new privacy surface is created, and nothing new has to be governed by the
  redaction and deletion controls.
- Buffer depth becomes a tuning parameter that trades memory against how long a
  disconnected plugin can be away before paying for a resync.
- The hook spool file introduced in ADR-0010 is a transient queue, not a
  retained log: it is drained and truncated on read. Were it allowed to
  accumulate, it would reintroduce the durable record of session activity this
  decision exists to avoid.
