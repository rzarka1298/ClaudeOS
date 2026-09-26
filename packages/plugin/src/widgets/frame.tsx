import type { SizeHint } from "@ccc/domain";
import type { ComponentChildren, VNode } from "preact";
import { useId } from "preact/hooks";
import type { ConnectionState } from "../connection-state.js";
import type { DestinationId } from "../view/destinations.js";
import type {
  DataDependencyKey,
  HeroMetric,
  QuickActionDescriptor,
  UnavailableReason,
  UnavailableReasonCode,
  WidgetDefinition,
  WidgetState,
} from "./contract.js";
import { WidgetFooter } from "./footer.js";
import type { CardPresentation, FooterModel } from "./presentation.js";
import { resolveCardPresentation } from "./presentation.js";
import { formatRelativeTime } from "./relative-time.js";

/**
 * The shared card (UI-06 by construction).
 *
 * Widgets render BODIES; this frame renders the card — header, body slot and
 * footer — so no widget can ship a card without provenance, because no widget
 * renders a card. `data-presentation` and `data-size` are the ONLY styling
 * hooks: there is no inline `style` and no HTML sink anywhere in this tree,
 * which is what keeps untrusted future payloads escaped by Preact and the
 * command center's visuals inside its own root (UI-SPEC Non-Negotiables 1–3).
 */

/**
 * The state a frame may be handed for a definition whose payload is `T`.
 *
 * A TYPED definition takes only a state of its own payload, so a wrong-shaped
 * ready payload does not compile. An ERASED definition (`T = never`: a
 * registry entry reached by a dynamic id, as the Overview grid does) takes its
 * widget's state as the state signal actually holds it — `unknown` until the
 * owning phase (4–7) feeds a typed, validated signal. That is the one
 * unchecked step between a source and a body, and it is named here rather
 * than hidden in an `any` on the registry.
 */
export type FrameState<T> = [T] extends [never] ? WidgetState<unknown> : WidgetState<T>;

export interface WidgetFrameProps<T> {
  readonly definition: WidgetDefinition<T>;
  readonly state: FrameState<T>;
  readonly connection: ConnectionState;
  readonly size?: SizeHint;
  readonly now: number;
  readonly onQuickAction?: (descriptor: QuickActionDescriptor) => void;
  /** Handed to the body so `+{n} more` can focus the owning destination. */
  readonly onNavigate?: ((destination: DestinationId) => void) | undefined;
}

/**
 * Product and service names that open a widget title. A proper noun keeps its
 * capitals mid-sentence (UI-SPEC Copywriting Contract), and a single-capital
 * name like `Claude` is indistinguishable from an ordinary sentence-case word
 * by shape alone, so it has to be named.
 */
const PROPER_NOUNS: ReadonlySet<string> = new Set(["Claude", "GitHub", "Gmail", "Google"]);

/**
 * A title used mid-sentence: `Service health` → `service health`, but
 * `GitHub discoveries` and `Claude usage` stay as they are. Only the first
 * word can carry sentence-case capitalisation, so only it is considered: it
 * keeps its case when it is a listed proper noun or carries a capital past its
 * first letter (`GitHub`, `API`) — shapes an ordinary word never has.
 */
function midSentenceTitle(title: string): string {
  const firstWord = title.split(" ", 1)[0] ?? "";
  if (PROPER_NOUNS.has(firstWord) || /[A-Z]/.test(firstWord.slice(1))) return title;
  return title.charAt(0).toLowerCase() + title.slice(1);
}

/**
 * Per-capability override of the generic `permission-required` template
 * (UI-SPEC "Setup state: hooks not installed", D-53). The generic template
 * ("{source} isn't connected") is ungrammatical for "Claude Code hooks", so
 * this is the one exception; every other capability falls back to it
 * unchanged. `descriptorLabel` is what `dispatchQuickAction`'s existing
 * `connect:*` resolution shows in its Notice — it stays a real English
 * phrase ("Connect Claude Code hooks"), not the heading.
 */
const PERMISSION_COPY: Partial<
  Record<
    string,
    {
      readonly heading: string;
      readonly body: string;
      readonly button: string;
      readonly descriptorLabel: string;
    }
  >
> = {
  "claude-hooks": {
    heading: "Claude Code hooks aren't installed",
    body: "Install the optional hook package to see your Claude Code sessions here. Obsidian settings → Claude command center → Claude shows the command to run.",
    button: "Set up Claude hooks",
    descriptorLabel: "Connect Claude Code hooks",
  },
};

/**
 * A Claude Code version as the copy may show it: dotted digits only. Anything
 * else (a path, a message, markup) is replaced by a neutral phrase, so the
 * one datum a reason carries into copy cannot smuggle text onto the card.
 */
const VERSION_SHAPE = /^\d{1,6}(?:\.\d{1,6}){0,3}$/;

function claudeCodeVersion(version: string): string {
  return VERSION_SHAPE.test(version) ? `Claude Code ${version}` : "Your Claude Code version";
}

/**
 * Plugin-owned copy for each {@link UnavailableReasonCode} (UI-SPEC
 * "Telemetry shape changed (SESS-18, D-12)"). The heading is keyed by code,
 * so "Session tracking paused" is only ever said about session tracking; the
 * body is built from the reason's version and nothing else.
 */
const UNAVAILABLE_COPY: Record<
  UnavailableReasonCode,
  { readonly heading: string; readonly body: (version: string) => string }
> = {
  "session-telemetry-changed": {
    heading: "Session tracking paused",
    body: (version) =>
      `${claudeCodeVersion(version)} reports sessions in a format this build doesn't recognise, so they're hidden rather than shown wrong.`,
  },
  "claude-version-unsupported": {
    heading: "Session tracking paused",
    body: (version) => `${claudeCodeVersion(version)} is older than the minimum supported 2.1.214.`,
  },
};

/**
 * The copy for an unavailable reason, or null when there is none to show.
 * An erased widget's state is unvalidated at runtime (see {@link FrameState}),
 * so a reason whose code has no copy — a free string, a future code — is
 * treated as no reason: it reads "No source yet" and is never rendered.
 */
function unavailableCopy(
  reason: UnavailableReason | undefined,
): { readonly heading: string; readonly body: string } | null {
  if (typeof reason !== "object" || reason === null) return null;
  if (!Object.hasOwn(UNAVAILABLE_COPY, reason.code)) return null;
  const copy = UNAVAILABLE_COPY[reason.code];
  const version = typeof reason.version === "string" ? reason.version : "";
  return { heading: copy.heading, body: copy.body(version) };
}

/**
 * The surface a hero-variant card renders on, derived from the presentation
 * (UI-SPEC S1 "Surface by presentation"). Cream is reserved for the four
 * presentations that carry last-good numbers; every presentation that needs
 * `--ccc-danger`, the disconnected dim, or the connect-button styling
 * renders on glass, where those treatments are audited.
 */
const CREAM_PRESENTATIONS: ReadonlySet<CardPresentation["kind"]> = new Set([
  "loading",
  "ready",
  "empty",
  "stale",
]);

function heroSurfaceFor(presentationKind: CardPresentation["kind"]): "cream" | "glass" {
  return CREAM_PRESENTATIONS.has(presentationKind) ? "cream" : "glass";
}

/**
 * The frame-owned hero head (UI-SPEC S1 "Anatomy", D-50): a Display-step
 * numeral, its screen-reader label, a sub-caption and a decorative meter.
 * Loading renders three skeleton lines instead — never both, so a
 * hero-variant widget's loading card shows exactly three skeleton lines in
 * total, not six.
 */
function HeroHead({ metric }: { readonly metric: HeroMetric }): VNode {
  return (
    <div className="ccc-hero-head">
      <p className="ccc-kpi-number">{metric.value}</p>
      <span className="ccc-visually-hidden">{metric.srLabel}</span>
      <p className="ccc-hero-caption">{metric.caption}</p>
      {metric.share !== null && (
        <meter
          className="ccc-hero-meter"
          min={0}
          max={metric.share.max}
          value={metric.share.value}
          aria-hidden="true"
        />
      )}
    </div>
  );
}

function HeroHeadSkeleton({ panel }: { readonly panel: string }): VNode {
  return (
    <div className="ccc-hero-head">
      <div className="ccc-skeleton-line" />
      <div className="ccc-skeleton-line" />
      <div className="ccc-skeleton-line" />
      <span className="ccc-visually-hidden">{`Loading ${panel}`}</span>
    </div>
  );
}

/** The footer a card shows before its first observation has arrived. */
function pendingFooter(dataKeys: readonly DataDependencyKey[]): FooterModel {
  return {
    observedAt: null,
    freshness: null,
    partiality: null,
    sources: dataKeys.map((key) => ({ label: key.sourceLabel, status: "ok" as const })),
  };
}

export function WidgetFrame<T>({
  definition,
  state: handed,
  connection,
  size,
  now,
  onQuickAction,
  onNavigate,
}: WidgetFrameProps<T>): VNode {
  // `FrameState<T>` IS `WidgetState<T>` for a typed definition. For an erased
  // one it is the signal's unvalidated state, which the body has always
  // received at runtime; this names that step instead of typing it away.
  const state = handed as WidgetState<T>;
  const presentation: CardPresentation = resolveCardPresentation(
    state,
    connection,
    definition.dataKeys,
  );
  const hint: SizeHint = size ?? definition.preferredSize;
  const titleId = `${useId()}-title`;
  const panel = midSentenceTitle(definition.title);
  const Body = definition.renderBody;
  const Empty = definition.renderEmpty;

  const body: ComponentChildren = ((): ComponentChildren => {
    switch (presentation.kind) {
      case "loading":
        // A hero-variant widget's skeleton lives in the hero head (below),
        // so the generic body skeleton would otherwise duplicate it.
        return definition.variant ? null : (
          <>
            <div className="ccc-skeleton-line" />
            <div className="ccc-skeleton-line" />
            <div className="ccc-skeleton-line" />
            <span className="ccc-visually-hidden">{`Loading ${panel}`}</span>
          </>
        );
      case "empty":
        return (
          <>
            <p className="ccc-state-heading">Nothing here yet</p>
            <p className="ccc-state-body">
              {`${definition.title} has no items right now. New items appear as they arrive.`}
            </p>
            <Empty />
          </>
        );
      case "ready":
      case "stale":
        return state.kind === "ready" ? (
          <Body
            data={state.data}
            size={hint}
            onNavigate={onNavigate}
            onQuickAction={onQuickAction}
          />
        ) : null;
      case "disconnected":
        return (
          <>
            <p className="ccc-state-heading">Service disconnected</p>
            <p className="ccc-state-body">
              {presentation.lastGood?.observedAt == null
                ? "They may be out of date."
                : `Showing the last values received ${formatRelativeTime(
                    presentation.lastGood.observedAt,
                    now,
                  )}. They may be out of date.`}
            </p>
            {state.kind === "ready" ? (
              <Body
                data={state.data}
                size={hint}
                onNavigate={onNavigate}
                onQuickAction={onQuickAction}
              />
            ) : null}
          </>
        );
      case "error":
        return (
          <>
            <p className="ccc-state-heading">
              {/* The glyph is decorative reinforcement only — the danger colour
                  is never the sole signal, and the text stands without it
                  (A11Y-04). */}
              <span className="ccc-error-glyph" aria-hidden="true">
                ▲
              </span>
              <span>{`Couldn't load ${panel}.`}</span>
            </p>
            <p className="ccc-state-body">
              Check the service in Settings → Diagnostics, then refresh.
            </p>
          </>
        );
      case "permission-required": {
        const source = presentation.sourceLabel;
        const capability = presentation.capability;
        const override = PERMISSION_COPY[capability];
        const heading = override?.heading ?? `${source} isn't connected`;
        const bodyText = override?.body ?? `Connect ${source} to see ${panel} here.`;
        const buttonLabel = override?.button ?? `Connect ${source}`;
        const descriptorLabel = override?.descriptorLabel ?? `Connect ${source}`;
        return (
          <>
            <p className="ccc-state-heading">{heading}</p>
            <p className="ccc-state-body">{bodyText}</p>
            {/* A DESCRIPTOR goes to one handler prop and nothing runs here
                (C-11, APPR-01, T-03-13). In this phase the dispatcher resolves
                it to the shell's settings destination; Phase 6/7 replaces that
                resolution without touching this button or the contract. */}
            <button
              type="button"
              className="ccc-connect-button"
              onClick={() =>
                onQuickAction?.({
                  id: `connect-${capability}`,
                  label: descriptorLabel,
                  capability: `connect:${capability}`,
                })
              }
            >
              {buttonLabel}
            </button>
          </>
        );
      }
      case "unavailable": {
        const copy = unavailableCopy(presentation.reason);
        return (
          <>
            <p className="ccc-state-heading">{copy?.heading ?? "No source yet"}</p>
            <p className="ccc-state-body">
              {copy?.body ??
                `${definition.title} has no data source in this build. It fills in once its source is available.`}
            </p>
          </>
        );
      }
    }
  })();

  const footerModel: FooterModel =
    presentation.kind === "loading"
      ? pendingFooter(definition.dataKeys)
      : presentation.kind === "disconnected"
        ? (presentation.lastGood ?? pendingFooter(definition.dataKeys))
        : presentation.footer;

  const showsActions =
    definition.quickActions.length > 0 &&
    (presentation.kind === "ready" || presentation.kind === "stale");

  // The hero head (UI-SPEC S1, D-50): absent means the existing glass card,
  // so no other widget's render tree changes at all.
  const surface: "cream" | "glass" | undefined = definition.variant
    ? heroSurfaceFor(presentation.kind)
    : undefined;

  const heroHead: ComponentChildren = ((): ComponentChildren => {
    if (!definition.variant) return null;
    if (presentation.kind === "loading") return <HeroHeadSkeleton panel={panel} />;
    if (
      (presentation.kind === "ready" ||
        presentation.kind === "empty" ||
        presentation.kind === "stale") &&
      state.kind === "ready"
    ) {
      return <HeroHead metric={definition.variant.metric(state.data)} />;
    }
    return null;
  })();

  return (
    <section
      className="ccc-card"
      data-presentation={presentation.kind}
      data-size={hint}
      data-variant={definition.variant ? "hero" : undefined}
      data-surface={surface}
      aria-labelledby={titleId}
      aria-busy={presentation.kind === "loading" ? "true" : undefined}
    >
      <header className="ccc-card-header">
        <h3 id={titleId}>{definition.title}</h3>
      </header>
      {heroHead}
      <div
        className="ccc-card-body"
        data-dimmed={presentation.kind === "disconnected" ? "true" : undefined}
        // A `tall` card's body is the one scrollable region in the card
        // (`overflow-y: auto` in styles.css). A scroll container that is not
        // in the tab order cannot be scrolled without a mouse, so it takes a
        // tabindex — and the focus ring that goes with it (A11Y-01).
        tabIndex={hint === "tall" ? 0 : undefined}
      >
        {body}
        {showsActions && (
          <div className="ccc-card-actions">
            {/* A DESCRIPTOR goes to one handler prop; the frame runs nothing.
                `dispatchQuickAction` is the single place that descriptor is
                resolved, and the single place Phase 6's approval check is
                inserted (C-11, APPR-01, T-03-13). */}
            {definition.quickActions.map((action) => (
              <button
                key={action.id}
                type="button"
                className="ccc-quick-action"
                onClick={() => onQuickAction?.(action)}
              >
                {action.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <WidgetFooter
        model={footerModel}
        panelTitle={panel}
        now={now}
        dimmed={presentation.kind === "disconnected"}
        disabled={presentation.kind === "loading"}
      />
    </section>
  );
}
