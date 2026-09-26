import type { Freshness, Partiality, SizeHint } from "@ccc/domain";
import type { VNode } from "preact";
import type { DestinationId } from "../view/destinations.js";

/**
 * The widget contract (UI-04, UI-06, ADR-0002).
 *
 * Every field below is required, and that is the point: PITFALLS Pitfall 17
 * ("the dashboard becomes decorative") is a typing problem here, not a review
 * problem. A widget definition that omits its data keys, its refresh policy,
 * its size hints or its feature flag does not compile, and a `ready`
 * {@link WidgetState} cannot be constructed without `observedAt`, `freshness`
 * and `partiality` — so provenance cannot be forgotten, only stated.
 *
 * {@link Freshness} and {@link Partiality} are IMPORTED from `@ccc/domain` and
 * never redefined here. A plugin-local copy, or a `stale` member inside the
 * state union, would let `kind` and `freshness` disagree and reopen exactly the
 * contradiction ADR-0002 closed (`docs/adr/0002-freshness-enum-plus-partial-flag.md`).
 */

/** The size vocabulary, re-exported from its one definition in `@ccc/domain`. */
export type { SizeHint } from "@ccc/domain";

/**
 * One source a widget's body depends on.
 *
 * `transport` is what makes the `D-15` disconnect rule centralisable: because
 * every widget declares whether a key travels over the companion service or is
 * resolved locally, `resolveCardPresentation()` can flip EVERY service-backed
 * card from one line when the transport dies, instead of relying on each widget
 * author to remember. A `local` key is unaffected by the connection — the
 * service-health widget's single key is `local` for precisely that reason (its
 * data *is* the connection; see `service-health.tsx`).
 *
 * `sourceLabel` is a DISPLAY NAME shown in the Source panel, never a path.
 * A label containing a path separator would put `/Users/USERNAME/…` into every
 * committed baseline screenshot (PRIV-04); plan 03-06's registry table test
 * asserts the absence.
 */
export interface DataDependencyKey {
  readonly key: string;
  readonly transport: "service" | "local";
  readonly sourceLabel: string;
}

/** How a widget's data is kept current. */
export type RefreshPolicy =
  | { readonly kind: "event-driven" }
  | { readonly kind: "interval"; readonly everyMs: number }
  | { readonly kind: "manual" };

/**
 * A quick action is DATA, never a callback (C-11, APPR-01, PATTERNS Pitfall 6).
 *
 * `WidgetFrame` emits the descriptor to a single handler prop and executes
 * nothing itself, so Phase 6's approval engine stays the one choke point every
 * consequential action must pass through. An executable callback on a widget
 * definition would be a hole in that boundary that no later phase could close.
 */
export interface QuickActionDescriptor {
  readonly id: string;
  readonly label: string;
  readonly capability: string;
}

/**
 * What a widget currently knows. `ready` is the only member carrying data, and
 * it cannot be built without provenance.
 *
 * There is deliberately NO `stale` and no `disconnected` member: those are
 * PRESENTATIONS derived by `resolveCardPresentation()` from this state plus the
 * connection, never something a widget declares (UI-05).
 */
export type WidgetState<T> =
  | { readonly kind: "loading" }
  | {
      readonly kind: "permission-required";
      readonly capability: string;
      readonly sourceLabel: string;
    }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "unavailable" }
  | {
      readonly kind: "ready";
      readonly data: T;
      readonly observedAt: string;
      readonly freshness: Freshness;
      readonly partiality: Partiality;
      readonly isEmpty: boolean;
    };

/**
 * What a widget BODY is rendered with.
 *
 * `size` is the size the LAYOUT placed the card at — not the definition's
 * preference — so a body that caps its own content (every `ListBody`) caps it
 * at the footprint the card actually has. A body that hardcoded its size would
 * clip rows, and the more-control with them, whenever the layout chose
 * differently (wave-5 review MAJOR 2).
 *
 * `onNavigate` is the one channel a body has out of its card: it selects and
 * focuses a shell destination, which is how `+{n} more` reaches the page that
 * owns the full list (MAJOR 1). It navigates and does nothing else; anything
 * consequential is a quick-action DESCRIPTOR, never a body callback (C-11).
 */
export interface WidgetBodyProps<T> {
  readonly data: T;
  readonly size: SizeHint;
  readonly onNavigate?: ((destination: DestinationId) => void) | undefined;
}

/**
 * A registered widget.
 *
 * `renderBody` renders the BODY ONLY (Pattern 4). The shared `WidgetFrame`
 * owns the header, the body slot and the footer, so a widget author cannot
 * ship a card without a last-updated time, a freshness badge, the independent
 * partial badge and a Source affordance — they never render a card at all
 * (UI-06, D-16).
 *
 * Both renderers are PLAIN FUNCTION SIGNATURES, not `ComponentType<P>`, and
 * that is load-bearing for the registry's types. `ComponentType<P>` includes
 * `ComponentClass<P>`, whose `defaultProps?: Partial<P>` makes `P` invariant
 * under `exactOptionalPropertyTypes`, so no definition type was a supertype
 * of every widget's and the registry had to erase the payload to `any`. A
 * function property is contravariant in its props, so `WidgetDefinition<never>`
 * is a real supertype of every `WidgetDefinition<T>` — the registry's bound —
 * and nothing is erased. This package ships no class component, and a plain
 * function is still a valid Preact function component.
 */
export interface WidgetDefinition<T> {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly dataKeys: readonly DataDependencyKey[];
  readonly refresh: RefreshPolicy;
  readonly minSize: SizeHint;
  readonly preferredSize: SizeHint;
  readonly featureFlag: string;
  readonly quickActions: readonly QuickActionDescriptor[];
  readonly renderBody: (props: WidgetBodyProps<T>) => VNode | null;
  readonly renderEmpty: (props: Record<string, never>) => VNode | null;
}
