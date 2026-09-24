---
status: accepted
satisfies: ADR-10 (design system and reduced-motion behaviour; closes PRD §20 "final visual token values and atmospheric background asset"); records UI-02
---

# The command center is direction c — a persistent rail beside an auto-placing canvas, dark glass for data and opaque cream for the metrics that matter

`UI-02` requires one visual direction to be selected with the owner from real
prototypes before any styling work begins, and `UI-03` requires a single token
block to define that direction's palette, type, spacing and motion. This ADR is
the record of that selection. It fixes the final token values, the layout rules,
the reduced-motion behaviour required by `A11Y-03`, the CSS-only atmospheric
background, the screenshot platform, and the state each PRD §7.1 panel renders
until its owning phase lands. Every token, widget, layout and screenshot plan in
Phase 3 starts from this document; none of them re-decides any of it.

It closes the decisions `03-CONTEXT.md` deferred here — `D-07` (one review
session, pick a winner), `D-08` (the decision is recorded as this ADR), `D-09`
(tweaks become amendments, never a fourth prototype), `D-18` (dark regardless of
Obsidian's theme, nothing leaking outside the root), `D-19` (reduced motion at
the token level via one root attribute), `D-20` (CSS-only atmosphere), `D-21`
(Playwright against an isolated harness) and `D-22` (containerised Linux
baselines) — and it resolves research Open Questions 1–5 in writing.

Two sibling ADRs bound it. `docs/adr/0002-freshness-enum-plus-partial-flag.md`
fixes the footer this design has to carry on every data-bearing card: freshness
is a four-value enum and partiality is an orthogonal flag, so the footer renders
two independent badges and no visual treatment here may collapse them into one.
`docs/adr/0019-import-boundary-enforcement.md` fixes where the screenshot
harness may live: its element map forbids the plugin package from importing
`@ccc/test-fixtures` data, while test-fixtures may import the plugin, so the
harness sits on the test-fixtures side of that edge rather than inside the
plugin it photographs.

`PITFALLS.md` Pitfall 17 — the dominant personal-dashboard failure mode, where a
dashboard drifts into decoration one silent stale card at a time — is the reason
this ADR spends as much of its budget on honest states, the freshness footer and
the `unavailable` assignment as it does on the palette. Pitfall 4 (no inline
styles, no `innerHTML`; CSS classes driven by custom properties) is why every
value below is a token and every state below is a `data-*` attribute.

## Selected direction

**Direction `c` — split sidebar plus canvas**
(`docs/design/prototypes/c-split-sidebar-canvas.html`), selected by the owner at
the review session on 2026-09-23. A persistent rail carries service health,
Today and Quick actions; the canvas beside it is the auto-placing grid that
holds the data panels.

**Primary visual anchor: Active Claude sessions.** It is the first card on the
canvas and the one card rendered in the hero style — a large opaque cream panel
carrying a tiny uppercase label, one giant numeral at the Display step, a
one-line muted sub-caption and a thin progress line. The UI-SPEC checker's
non-blocking flag ("primary visual anchor deferred to ADR-10") is closed by this
paragraph.

**Card surface treatment: two families, deliberately.** Data and list cards are
**glass** — a translucent dark fill over the atmosphere, a backdrop blur and a
soft shadow. The hero KPI card and the four metric tiles are **opaque cream**.
Cream is the accent of the layout, not of the palette: it marks the handful of
numbers the owner is meant to read first, and everything else stays dark so that
marking means something.

**reference: received.** A reference was supplied locally and reviewed
frame-by-frame before this ADR was written. It is not committed, not linked and
not transcribed: the sections below state its implications as our own design
rules, and `pnpm run ci:privacy` runs over this file in the same verify chain
that accepted it. Per `D-06`, the only fact about the reference that crosses
into git is the two words at the start of this paragraph.

The rejected alternative was direction `a` (dense KPI grid), which shows the
most above the fold but crowds in a narrow side pane and makes the stale and
disconnected dimming harder to spot — and direction `b` (editorial feed), whose
calm reads well at every width but trades scanning for scrolling and reads as a
digest rather than a command center. Direction `c` was chosen because the rail
keeps service health permanently visible, which is the one thing a dashboard
must never make the owner scroll for.

Consequence: below a 34 rem container the rail collapses to a stack and the
narrow-pane experience becomes effectively direction `b` — we accept that the
rail is a full-window affordance and that the narrow pane is a legitimately
different, calmer rendering of the same ordered list, not a broken one.

## Token values

Every `--ccc-*` token below is final for milestone 1 and is declared exactly
once, on `:where(.ccc-command-center)`, per `D-18` and `UI-03`. Values marked
*(new)* did not exist in `docs/design/prototypes/prototype-tokens.css` and enter
the block as amendments from this review.

### Colour

| Token | Value | Role |
| --- | --- | --- |
| `--ccc-bg` | `#0B0B0F` | Dominant 60 % — near-black shell and the atmosphere's base |
| `--ccc-surface` | `#15151B` | Opaque card fill; the audited fallback wherever `backdrop-filter` is unavailable |
| `--ccc-surface-glass` *(new)* | `rgba(21, 21, 27, 0.72)` | Secondary 30 % — the translucent fill of every data and list card |
| `--ccc-surface-blur` *(new)* | `0.75rem` | `backdrop-filter: blur()` radius on glass cards |
| `--ccc-shadow-card` *(new)* | `0 0.5rem 1.5rem rgba(0, 0, 0, 0.35)` | The soft shadow of PRD §8.1, unchanged from the prototypes |
| `--ccc-cream` *(new)* | `#F4EFE6` | Opaque fill of the hero KPI card and the four metric tiles |
| `--ccc-ink` | `#F4EFE6` | Body and heading ink on dark surfaces |
| `--ccc-ink-muted` | `#9A94A6` | Labels, meta, footer and sub-captions on dark surfaces |
| `--ccc-ink-inverse` *(new)* | `#0B0B0F` | Ink on cream — numerals, headings, body |
| `--ccc-ink-inverse-muted` *(new)* | `#5A5650` | Muted ink on cream — labels, sub-captions, delta lines |
| `--ccc-accent` | `#FF5FA2` | Accent 10 % — **dark surfaces only** |
| `--ccc-accent-deep` *(new)* | `#C2185B` | Accent **on cream only** — progress line, tile glyph, focus ring over cream |
| `--ccc-danger` | `#FF6B6B` | Error and disconnected states only |
| `--ccc-border` | `rgba(244, 239, 230, 0.14)` | Hairline card boundary — decorative; the surface delta carries the boundary |
| `--ccc-border-cream` *(new)* | `rgba(11, 11, 15, 0.12)` | Hairline inside cream panels — decorative |

**Measured contrast.** Every ratio below was computed with `contrastRatio()`
from `packages/plugin/src/contrast.ts` against the final values in the table
above, and each is stated against its floor from `03-UI-SPEC.md` `## Color`
(4.5 : 1 body and label, 3.0 : 1 Display step and non-text). Translucent values
have no single ratio — `contrastRatio()` refuses them by design rather than
compositing a guess — so glass is audited at **`#1D161E`**, the lightest
composite `--ccc-surface-glass` can reach anywhere on the atmosphere (the glass
fill over the brightest point of the top-left gradient). Auditing the lightest
composite is the worst case for light text, so every darker placement passes a
fortiori.

| Pair | Ratio | Floor | Result |
| --- | --- | --- | --- |
| `--ccc-ink` on `--ccc-bg` | 17.15 : 1 | 4.5 | pass |
| `--ccc-ink` on `--ccc-surface` | 15.88 : 1 | 4.5 | pass |
| `--ccc-ink` on glass (`#1D161E`) | 15.46 : 1 | 4.5 | pass |
| `--ccc-ink-muted` on `--ccc-bg` | 6.70 : 1 | 4.5 | pass |
| `--ccc-ink-muted` on `--ccc-surface` | 6.20 : 1 | 4.5 | pass |
| `--ccc-ink-muted` on glass (`#1D161E`) | 6.04 : 1 | 4.5 | pass |
| `--ccc-accent` on `--ccc-bg` | 6.93 : 1 | 4.5 | pass |
| `--ccc-accent` on `--ccc-surface` | 6.42 : 1 | 4.5 | pass |
| `--ccc-accent` on glass (`#1D161E`) | 6.25 : 1 | 4.5 | pass |
| `--ccc-danger` on `--ccc-bg` | 7.08 : 1 | 4.5 | pass |
| `--ccc-danger` on `--ccc-surface` | 6.55 : 1 | 4.5 | pass |
| `--ccc-danger` on glass (`#1D161E`) | 6.38 : 1 | 4.5 | pass |
| `--ccc-cream` panel against `--ccc-bg` (panel boundary, non-text) | 17.15 : 1 | 3.0 | pass |
| `--ccc-ink-inverse` on `--ccc-cream` | 17.15 : 1 | 4.5 | pass |
| `--ccc-ink-inverse-muted` on `--ccc-cream` | 6.36 : 1 | 4.5 | pass |
| `--ccc-accent-deep` on `--ccc-cream` | 5.13 : 1 | 4.5 | pass |
| `--ccc-accent` focus ring on `--ccc-bg` (non-text) | 6.93 : 1 | 3.0 | pass |
| `--ccc-accent-deep` focus ring on `--ccc-cream` (non-text) | 5.13 : 1 | 3.0 | pass |
| ~~`--ccc-accent` on `--ccc-cream`~~ | **2.47 : 1** | 4.5 | **fail — rejected** |

The last row is the one conflict this review produced, and it is recorded rather
than quietly fixed. The reference puts a pink glyph and a pink progress line on
cream panels; the bright accent `#FF5FA2` measures 2.47 : 1 on `#F4EFE6` and
cannot carry text or identify a control there. `C-12` and PRD §8.2 make
accessibility win over fidelity to the reference, so cream surfaces use
`--ccc-accent-deep` (`#C2185B`, 5.13 : 1) instead, and `--ccc-accent` is
forbidden on cream at any size.

**Accent reserved for** — the `03-UI-SPEC.md` list, extended by exactly one
entry at this review: (1) the active destination's tab treatment, (2) the focus
ring on every focusable control, (3) Display-step KPI numerals in a `ready`
card, (4) the Source disclosure's expanded-state marker, (5) the twinkle points,
and *(new)* (6) the square glyph and the progress line on a cream metric tile or
hero card — in `--ccc-accent-deep` only. Nothing else. Not body text, not card
borders, not badge fills, not hover states.

### Type

| Token | Value |
| --- | --- |
| `--ccc-font-ui` | `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif` |
| `--ccc-font-numeric` | `var(--ccc-font-ui)` |
| `--ccc-font-mono` *(new)* | `ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace` |
| `--ccc-text-label` | `0.8125rem` |
| `--ccc-text-body` | `1rem` |
| `--ccc-text-heading` | `1.125rem` |
| `--ccc-text-kpi` | `clamp(2rem, 8cqi, 3.5rem)` |
| `--ccc-weight-regular` | `400` |
| `--ccc-weight-strong` | `600` |
| `--ccc-tracking-label` | `0.08em` |
| `--ccc-leading-prose` | `1.6` |

Still exactly four sizes and exactly two weights. `--ccc-font-mono` is a
*family* applied at the Label size to timeline times and activity-log lines; it
is not a fifth size and not a third weight. No `@font-face`, no CDN font, no
bundled binary (`C-7`) — every family above is a system stack, and the
screenshot harness pins its own family through Playwright `stylePath` so a Linux
baseline is deterministic (`D-21`).

### Spacing, strokes, radii

| Token | Value |
| --- | --- |
| `--ccc-space-xs` | `0.25rem` |
| `--ccc-space-sm` | `0.5rem` |
| `--ccc-space-md` | `1rem` |
| `--ccc-space-lg` | `1.5rem` |
| `--ccc-space-xl` | `2rem` |
| `--ccc-space-2xl` | `3rem` |
| `--ccc-space-3xl` | `4rem` |
| `--ccc-border-hairline` | `0.0625rem` |
| `--ccc-focus-ring` | `0.125rem` (width and offset) |
| `--ccc-radius-sm` | `0.25rem` (badges, pills' inner elements) |
| `--ccc-radius-md` | `0.75rem` (cards) |
| `--ccc-radius-pill` *(new)* | `999rem` (tabs, status pill, quick-action buttons) |
| `--ccc-rail-width` *(new)* | `17rem` (the persistent rail of direction `c`) |
| `--ccc-hero-bar-height` *(new)* | `0.25rem` (the hero card's thin progress line) |

Every spacing value is rem so Obsidian's own font-size setting still scales the
UI and WCAG 1.4.4 (200 % resize) holds. No `px`, anywhere.

### Motion

| Token | Full | Reduced |
| --- | --- | --- |
| `--ccc-motion-fast` | `120ms` | `0ms` |
| `--ccc-motion-slow` | `400ms` | `0ms` |
| `--ccc-twinkle-duration` | `6s` | `0s` |

The rejected alternative for this whole section was to carry the reference's
colours verbatim and audit later. That is the order in which accessibility
debt gets shipped: a token block that has never been measured looks finished, so
nobody measures it. Measuring before the block is written is what turned the
cream conflict into one table row instead of a UAT finding.

Consequence: a cream surface family doubles the number of ink tokens and means
every future component author has to know which ink pair their surface takes.
We accept that cost and pay it down mechanically — the `A11Y-02` token test in
plan 03-04 parses the block from `styles.css` and asserts every pair in the
table above, so an un-audited colour edit fails loudly rather than shipping.

## Layout rules

The Overview is **one ordered list of widget IDs with per-widget size hints**
(`small | medium | wide | tall`, each declaring `minSize` and `preferredSize`),
auto-placed by a CSS grid. There are no coordinates and no breakpoint-specific
layouts (`D-12`).

```css
.ccc-overview-grid {
  display: grid;
  gap: var(--ccc-space-lg);
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 16rem), 1fr));
  grid-auto-flow: dense;
}
.ccc-card[data-size="wide"] { grid-column: span 2; }
.ccc-card[data-size="tall"] { grid-row: span 2; }

@container (max-width: 34rem) {
  .ccc-overview-grid { gap: var(--ccc-space-md); }
  .ccc-card[data-size="wide"] { grid-column: span 1; }
}
```

`minmax(min(100%, 16rem), 1fr)` is what lets one layout serve a narrow side pane
and a full window: below 16 rem of container width the column becomes 100 %
instead of overflowing. `grid-auto-flow: dense` stops a `wide` card stranding a
hole. `tall` keeps its two-row span at every width — vertical space scrolls,
horizontal space does not. The container query is a container query, not a
viewport media query, because the same view can be any width at any viewport
size.

**Direction `c`'s shell chrome, above the grid.** A `--ccc-rail-width` rail sits
left of the canvas and carries service health, Today and Quick actions; below
34 rem of container width the rail collapses above the canvas as a stack. The
header is a small uppercase letter-spaced wordmark at the left, a centred status
pill, and uppercase pill controls at the right; a row of pill-shaped uppercase
tabs sits directly beneath it, the active tab filled cream. None of this changes
the grid mechanism — the rail is chrome, the canvas is the ordered list.

**`DEFAULT_LAYOUT` order.** Service health first — it is the one card in this
phase backed by real data — then the seven PRD §7.1 panels in PRD order. Active
Claude sessions is the first canvas card and the hero, which is a rendering
decision carried by its size hint and card variant, not a re-ordering of the
list.

A layout entry naming an unknown or flagged-off widget is **skipped silently and
recorded in diagnostics** (`D-13`). The Overview never renders a broken slot, a
placeholder tile, or an error card for a missing widget.

The rejected alternative was a coordinate-based or breakpoint-keyed layout,
which reads as more control and is in practice two layouts to maintain, two sets
of screenshots to baseline, and a guaranteed divergence the first time a widget
changes size.

Consequence: the owner cannot pin a card to an exact cell — order plus size
hint is the entire vocabulary. We accept that, and `D-10`'s optional JSON
override is deliberately the same vocabulary so the override can never express
something the in-code default cannot.

## Reduced motion

Reduced motion is the OS `prefers-reduced-motion` query **plus** a plugin
settings override, resolved **once, in TypeScript**
(`preference === "reduced" || osPrefersReduced`) and written to a single root
attribute: `.ccc-command-center[data-motion="reduced"]`. No component ever
checks `prefers-reduced-motion` itself (`D-19`, `A11Y-03`).

Under `[data-motion="reduced"]` the three motion tokens are re-declared to
`0ms`, `0ms` and `0s`; `.ccc-twinkle` gets `animation: none`; `.ccc-kpi-number`
gets `transition: none`.

The KPI count-up is therefore a **CSS transition** on `.ccc-kpi-number` driven
by `var(--ccc-motion-slow)`, not a `requestAnimationFrame` count-up. A rAF
implementation would have to read the resolved motion mode to know whether to
animate — the per-component check `D-19` exists to forbid — and the two
alternatives that avoid reading it (an inline custom property, or a per-widget
rAF bail-out) are forbidden by Pitfall 4 and by `D-19` respectively. The
accepted cost is that numbers **snap** rather than ease under reduced motion,
which is exactly what the setting asks for.

The rejected alternative was per-component `matchMedia` checks, which is how a
codebase ends up with three components that respect the setting and one that
does not.

Consequence: any future animated affordance must express its duration through
one of the three motion tokens or it will silently ignore reduced motion. That
is a real constraint on future component authors and it is the point: the token
is the only lever, so there is nothing to forget.

## Atmospheric background

The atmosphere is **CSS-only** (`D-20`): layered radial gradients over
`--ccc-bg`, plus a sparse set of CSS-positioned twinkle points concentrated
toward the top-right, plus a faint dotted cluster glyph behind the rail. No
binary asset enters the repository, so there is no image to privacy-check, no
licence to track and nothing for `scripts/check-images.sh` to allow.

The whole layer is `aria-hidden` and decorative: with zero twinkle points
defined the gradients still render and nothing is announced. Under
`[data-motion="reduced"]` the twinkle `animation` is `none` and the points are
static — present, not pulsing.

The rejected alternative was a bundled image backdrop, which would be a binary
blob in a public MIT repository that a privacy audit must inspect by eye every
release, for a gradient that CSS renders in eleven lines.

Consequence: the atmosphere is limited to what gradients and positioned points
can express — no photographic texture, no noise bitmap. This resolves PRD §20's
"atmospheric background asset" deferral for milestone 1.

## Screenshot platform

**Posture A: containerised Linux.** Visual regression runs on `ubuntu-latest`
inside `mcr.microsoft.com/playwright:v1.63.0-noble`, so baselines are named
`*-chromium-linux.png`. The harness pins its fonts through Playwright's
`stylePath`, the comparison uses `maxDiffPixelRatio: 0.01`, and **baseline
updates land as standalone commits** that contain nothing but baseline images —
a baseline refresh mixed into a feature commit is a silently accepted visual
regression (research Pitfall 5).

This is decided **before** the first baseline is committed because Playwright
bakes the platform into the baseline filename (`D-22`).

The harness is built with **esbuild**, reusing the two-entry (JS + CSS) pattern
already in `packages/plugin/esbuild.config.mjs`. Vite is not added to this
repository — `.claude/CLAUDE.md`'s "What NOT to Use" table forbids it as a
bundler (`C-5`) — so `D-21`'s "a small Vite page" is read as shorthand for "a
small standalone page", which the owner confirmed. The harness lives in
`packages/test-fixtures/harness/` because
`docs/adr/0019-import-boundary-enforcement.md`'s element map forbids the plugin
package from importing test-fixtures data, while test-fixtures may import the
plugin.

The rejected alternative was Posture B, a pinned macOS runner, which would make
baselines match the owner's own machine but ties the visual gate to a runner
image Apple and GitHub both move underneath us, and costs far more CI minutes.

Consequence: baselines record how the markup and CSS render on Linux Chromium,
not how Obsidian renders on macOS. They are a markup/CSS regression record, not
a pixel record of the owner's screen, and switching platform later means
regenerating every committed baseline.

## Panel state assignment

Exactly **two** PRD §7.1 panels render `permission-required` in this phase,
because exactly two of them will sit behind a real OAuth capability gate:

| Panel | State | Capability | Source label |
| --- | --- | --- | --- |
| Today | `permission-required` | `google` | Google Calendar and Gmail |
| GitHub discoveries | `permission-required` | `github` | GitHub |

The other five panels — **Active Claude sessions**, **Project shortcuts**,
**Claude usage**, **Technology and market intelligence** and **Quick actions** —
render `unavailable`: heading `No source yet`, body `{Panel} has no data source
in this build. It fills in once its source is available.` Each flips to a real
state only in the phase that gives it a route.

**Service health is the one real widget.** Its data *is* the connection, so when
the companion service goes away it reports that as current knowledge — freshness
`live`, body `Service disconnected — {reason}` — rather than flipping to the
`D-15` disconnected treatment, which exists for cards whose *other* data went
stale because the connection died. A card cannot be disconnected from the fact
that it is disconnected.

The rejected alternative was rendering every unrouted panel as
`permission-required`, which reads as "one click away" for six panels that have
no connector to click, and is precisely the plausible-looking lie Pitfall 17
identifies as the thing that destroys trust in a dashboard. No fixture-backed
card ships behind a dev flag either (`D-17`): a card that looks real must be
real.

Consequence: the first Overview the owner sees is mostly honest emptiness. That
is the correct first impression, and later phases flip cards deliberately —
each panel's state change is a line in that phase's plan, not an accident.

## Permission-required action

The `Connect {source}` button on a `permission-required` card dispatches a
**descriptor** through the single quick-action dispatcher (`C-11` / `APPR-01` —
a `quickAction` is data, never a callback, or the future approval boundary has
a hole in it). In this phase the dispatcher resolves that descriptor to the
shell's `settings` destination and posts an Obsidian `Notice` naming where the
connector will be configured once its phase lands.

This **amends** `03-UI-SPEC.md`'s settled mechanism, which specified Obsidian's
`app.setting.open()` + `openTabById(manifest.id)`. Neither `app.setting` nor
`openTabById` appears in the public `obsidian.d.ts@1.13.1`, and the
`obsidian-plugin-development` skill forbids reaching into private API surface,
so the documented call would be an undeclared dependency on Obsidian internals
that can break on any release without a type error. The deviation is recorded
here rather than absorbed silently.

The rejected alternative was a dead button, or a link out to a provider's
sign-in page. A dead button teaches the owner that buttons here do nothing; an
external link starts an OAuth flow that no code in this milestone can finish.

Consequence: in this phase `Connect {source}` navigates rather than connects.
The copy stays honest about that (`{Source} isn't connected` / `Connect
{source} to see {panel} here.`), and Phase 6/7 replaces the descriptor's
resolution without changing the button, the widget or the contract.

## Feature flags

Feature flags are a **typed in-code constant** — a `Record<WidgetId, boolean>`
in `packages/plugin/src/widgets/feature-flags.ts` — with every registered
widget's flag `true`. There is **no flag UI** and **no persisted flag state**.
A layout entry whose widget is flagged off is skipped silently and recorded in
diagnostics, exactly like an unknown ID (`D-13`).

The rejected alternative was persisting flags in plugin settings with a toggle
per widget. That turns an internal kill-switch into a user-editable contract —
the same reversibility trap `D-10` flags for the layout override — for a
single-user tool where changing a constant and reloading is already the fastest
path.

Consequence: toggling a widget off requires an edit and a reload rather than a
setting. Accepted: flags exist here to let a later phase land a widget dark, not
to give the owner a control panel.

## Resolved open questions

The five open questions in `03-RESEARCH.md` are closed by this ADR and are not
re-decided by any later plan in this phase:

1. **Harness bundler** — esbuild, not Vite (`C-5`, `D-21` amendment). See
   `## Screenshot platform`.
2. **Visual-regression platform** — Posture A, containerised Linux,
   `*-chromium-linux.png` baselines (`D-22`). See `## Screenshot platform`.
3. **Feature-flag storage** — typed in-code constant, no UI, no persistence.
   See `## Feature flags`.
4. **`permission-required` vs `unavailable`** — `permission-required` only for
   Today (`google`) and GitHub discoveries (`github`); the other five panels
   `unavailable`. See `## Panel state assignment`.
5. **The `@ccc/plugin` `dist/` gap** — closed in plan 03-01 by research
   Pitfall 2 **Option 1**: `@ccc/plugin`'s `build` is now
   `tsc -b && node esbuild.config.mjs`, matching `@ccc/domain`'s working
   `main`/`types`/`exports` shape, and `ci:boundaries` builds the workspace
   before linting. Option 2 (point `exports` at `src/`) was rejected because it
   would make every consumer typecheck plugin source transitively. Proven from
   a clean worktree via `scripts/clean-tree-check.sh`, so the boundary fixture
   that had been silently passing now fires.

Consequence: a later plan that wants a different answer to any of the five
reopens this ADR rather than deciding locally. That is the intended friction.

## Review amendments

Every tweak the owner asked for at the review, one bullet each, with the token
or rule it changes and whether it was applied as asked or adjusted for an
accessibility floor (`D-09` — these are applied when the tokens are built; there
is no fourth prototype).

- **Cream card fills for the hero KPI and the four metric tiles.** Applied as
  asked. Adds `--ccc-cream`, `--ccc-ink-inverse`, `--ccc-ink-inverse-muted` and
  `--ccc-border-cream`. This is the amendment `03-UI-SPEC.md` `## Color`
  anticipated ("if the owner selects a direction with literal cream card fills,
  ADR-10 must also record the inverted ink token that keeps 4.5 : 1 on cream").
- **Pink glyph and progress line on cream panels.** **Adjusted for a floor.**
  `--ccc-accent` (`#FF5FA2`) measures 2.47 : 1 on `#F4EFE6`. Applied with
  `--ccc-accent-deep` (`#C2185B`, 5.13 : 1) instead, and `--ccc-accent` is
  forbidden on cream at any size (`C-12`, PRD §8.2).
- **Accent reserved-list extended by one entry** so the cream tile glyph and the
  hero progress line are a *named* accent use rather than a sixth unlisted one.
  Applied as asked, in `--ccc-accent-deep` only.
- **Header: small uppercase letter-spaced wordmark left, centred status pill,
  uppercase pill controls right.** Applied as asked. The status pill is the
  existing connection strip restyled — it keeps its text label and its glyph, so
  `A11Y-04` (never colour alone) still holds and the dot stays decorative
  reinforcement.
- **Pill-shaped uppercase tabs directly under the header, active tab filled
  cream.** Applied as asked, with one adjustment: the active tab's label is
  `--ccc-ink-inverse` on `--ccc-cream` (17.15 : 1), and its focus ring is
  `--ccc-accent-deep` (5.13 : 1, above the 3.0 non-text floor), because the
  bright accent cannot identify a control on cream. Adds `--ccc-radius-pill`.
- **Hero KPI card: tiny uppercase label, one giant numeral, a one-line muted
  sub-caption, a thin progress line.** Applied as asked. Adds
  `--ccc-hero-bar-height`. The numeral stays at the existing Display step
  (`clamp(2rem, 8cqi, 3.5rem)`) — no fifth type size was added.
- **A dark glass "latest item" card beside the hero**, title plus a small meta
  line. Applied as asked; it is an ordinary glass card at `medium`.
- **Metric row: four opaque cream tiles**, each a tiny uppercase label, a large
  numeral, a small delta line and a square glyph at the right edge. Applied as
  asked, with the glyph in `--ccc-accent-deep` per the second bullet.
- **Quick actions: two rows of dark uppercase letter-spaced pill buttons, the
  selected one filled cream.** Applied as asked **as descriptors only** — these
  render and dispatch `quickAction` descriptors through the single dispatcher
  and execute nothing in this phase (`D-17`, `C-11` / `APPR-01`).
- **Lower canvas: a Today timeline (muted mono time column beside event text), a
  Tasks checklist with circular checkboxes and an `n/m` counter, an intel
  headline list, and an activity feed of log lines each prefixed by a small
  uppercase tag.** Applied as asked; all four are glass cards on the existing
  grid, at `tall` where they scroll.
- **Small mono for times and log lines.** Applied as asked via
  `--ccc-font-mono`, used at the Label size. A family, not a fifth size and not
  a third weight — the four-size / two-weight rule is unchanged.
- **Background: near-black with a sparse faint star field concentrated
  top-right, and a subtle dotted cluster glyph behind the rail.** Applied as
  asked, CSS-only (`D-20`). Static under `[data-motion="reduced"]` — `D-19` and
  `D-20` are unchanged by this amendment.
- **Uppercase letter-spaced micro labels throughout, one giant numeral per
  hero.** Applied as asked. Uppercase remains a *style* of the existing Label
  token (`text-transform` + `--ccc-tracking-label`), never a new size, and the
  0.8125 rem absolute floor (`A11Y-02`) is not lowered for any of them.

Consequence: thirteen amendments land in one token-build plan rather than in a
fourth prototype. The review is closed; a further change to the direction
reopens this ADR.

## Consequences

The costs this ADR accepts, stated plainly so a later reader does not mistake
them for oversights:

- **A light variant later re-derives every token** (`D-18`). The command center
  is near-black regardless of Obsidian's theme, and the cream family is a
  *layout* accent rather than a theme, so a light mode is not "swap the two ink
  tokens" — it is a second audited palette with its own contrast table.
  Components need not change if tokens stay the only colour source.
- **The JSON layout override becomes a user-editable contract the moment it
  ships** (`D-10`). Its vocabulary is deliberately identical to the in-code
  default's — an ordered list plus size hints — so the contract we are stuck
  with is the smallest one that satisfies `UI-07`.
- **Switching screenshot platform regenerates every baseline** (`D-22`).
  Playwright bakes `-chromium-linux` into every filename; that is why the
  platform is decided here rather than at the first green visual run.
- **Two ink families mean every component author picks a surface first.** The
  `A11Y-02` token test is the mechanism that keeps that from decaying into a
  guess.
- **`Connect {source}` navigates rather than connects until Phase 6/7.** The
  copy is honest about it, and the descriptor seam means the fix is a
  dispatcher change, not a widget change.
- **Most of the first Overview is `unavailable`.** Pitfall 17 says a dashboard
  dies of plausible-looking lies, not of visible gaps, so honest emptiness is
  the design, not a shortfall against it.
