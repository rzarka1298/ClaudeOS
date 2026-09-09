---
status: accepted
satisfies: amends UI-06 and RSRCH-05
---

# Freshness is a four-value enum with partiality as an orthogonal flag

The PRD contradicts itself: §7.1 lists four freshness states (`live`, `cached`,
`stale`, `unavailable`) while §10.2 lists five, adding `partial`. Its own data
contract in §10.2 settles it — `sourceStatus` and `isPartial` are separate
fields. Partiality genuinely is orthogonal: a cached result can be partial and
so can a live one. Folding it into the enum would force a widget to choose
between reporting that data is cached and reporting that a source failed. We
model Freshness as `live | cached | stale | unavailable` and carry partiality
as a separate flag, rendered as its own badge.

## Consequences

- This amends two locked requirements. `UI-06` and `RSRCH-05` were written
  against §10.2's five-value UI list and must be reworded. Per PRD §21 the
  change was put to the owner with evidence and accepted rather than made
  silently.
- Every widget renders two independent signals, not one.
