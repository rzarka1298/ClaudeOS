# Command-center prototypes (UI-01)

Three throwaway pages for one review session. Open them in a browser, compare,
pick a direction. The selection — tokens, layout rules, and any tweaks asked
for at the review — is recorded as ADR-10 (`docs/adr/0023-…`), and the token
work in the plugin starts from that ADR.

**Throwaway — the winner is re-implemented from tokens in the plugin, never
copied.** Nothing in this folder ships. It exists to make a decision, and the
decision is the artifact that survives.

## Open them

No build, no server, no install. They are plain files:

```sh
open docs/design/prototypes/a-dense-kpi-grid.html
open docs/design/prototypes/b-editorial-feed.html
open docs/design/prototypes/c-split-sidebar-canvas.html
```

## What varies, and what does not

| Held constant across all three | Varies between the three |
| --- | --- |
| Palette, type scale, spacing scale, motion tokens (`prototype-tokens.css`) | Grid vs. feed vs. rail-plus-canvas |
| Card anatomy: header, body, freshness footer (`prototype-cards.js`) | Density — gaps, card padding, how much fits above the fold |
| The data (`fixtures.js`) and the order panels appear in | Where the destination screens sit relative to the Overview |

**If you can tell the three apart by colour, something has gone wrong.** The
round is testing layout and density; colour is decided separately, in ADR-10,
against the contrast floors.

| File | Direction |
| --- | --- |
| `a-dense-kpi-grid.html` | Dense auto-fill KPI grid — instrument panel |
| `b-editorial-feed.html` | Single-column editorial feed — reading pace |
| `c-split-sidebar-canvas.html` | Persistent left rail plus a canvas grid |

## The state switcher

Every page carries one `Card state` control in its header. It flips **every
card at once** between the five states:

| State | What you should see |
| --- | --- |
| Live | Real values, `Live` or `Cached` badge |
| Stale | Last-good values still readable, muted header, `Stale` badge |
| Empty | `Nothing here yet` in every card — no card disappears |
| Permission required | `{Source} isn't connected` plus a `Connect` action |
| Failure | `Couldn't load {panel}.` plus the next step |

One control rather than five copies of each page is deliberate: it is the only
way to compare two directions *in the same state* side by side.

Worth doing at the review: switch to **Empty** and confirm every card is still
present. A dashboard that hides its empty cards looks healthy when it is blind.

## Where the data comes from

The pages render synthetic fixtures and nothing else. Every project, session,
report and repository name is invented.

```
packages/test-fixtures/src/widget-fixtures.json   ← the single source. Edit here.
        │  node scripts/generate-prototype-fixtures.mjs
        ▼
docs/design/prototypes/fixtures.js                ← generated. Never hand-edit.
```

`fixtures.js` exists only because a page opened from the filesystem cannot
request a local JSON file. It is committed so the pages open with no build,
and a test regenerates it and compares bytes — so the two copies cannot drift:

```sh
node scripts/generate-prototype-fixtures.mjs && git diff --exit-code -- docs/design/prototypes/fixtures.js
```

The same fixture becomes the visual-regression input later in the phase. That
is the point: no screenshot committed to this repository can contain a real
name, because no real name exists anywhere in the chain (PRIV-04).

## Two rules for anything added here

1. **No remote resources.** No CDN font, no remote stylesheet, no remote
   image, no network request. A committed page that loads a remote asset
   reports the reviewer's IP address to a third party, from a repository whose
   entire premise is local-first with zero personal data. A test asserts the
   absence over every file in this folder.
2. **No real data, ever.** Not a real project name, path, session, report
   title, person or address — not even temporarily, not even uncommitted.

## The reference material (D-06)

If a reference video or link is supplied, it goes in
`docs/design/prototypes/reference.local.md`, which is gitignored and stays
local. It is never committed, quoted or transcribed.

Where a reference and PRD §8.1's written direction list disagree, **§8.1
wins** — and where either conflicts with the accessibility floors, the floors
win and ADR-10 records the deviation.
