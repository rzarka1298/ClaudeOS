// Deep submodule imports, not the `@ccc/domain` barrel (05-06 deviation,
// Rule 3): the barrel's `export *` chain pulls in `path-containment.ts`
// (`node:fs`/`node:path`), which the visual harness's browser-platform
// bundle cannot resolve.
import type {
  CapacityWindow,
  CostBasis,
  EstimatedApiCost,
  PlanCapacity,
  PlanCapacityUnavailableReason,
  TokenActivity,
  TokenActivityUnavailableReason,
  UsageSummary,
} from "@ccc/domain/usage.js";
import type { VNode } from "preact";
import type { QuickActionDescriptor, WidgetBodyProps, WidgetDefinition } from "./contract.js";

/**
 * The Claude usage card (UI-SPEC S2, D-37, D-38, D-51). Moved out of
 * `panels.tsx`'s Phase 3 placeholder section 4; `panels.tsx` now only
 * re-exports {@link claudeUsageWidget} and {@link ClaudeUsageData}.
 *
 * Task 1 (tracer) implements every state row of the three section tables —
 * plan capacity, token activity and estimated cost — each honest when its
 * own source is unavailable, never a zero. The range is fixed to `today`
 * for now; Task 2 adds the range selector, exact `Intl` formatting (this
 * task uses simple inline formatting), per-section Source disclosures and
 * the forbidden-words guard.
 */

/** The whole precomputed summary, plus the frame's own clock tick — the
 * same "embed `nowMs` in the ready payload" move `active-sessions.tsx`
 * makes, since `WidgetBodyProps` carries no `now` of its own. */
export interface ClaudeUsageData {
  readonly summary: UsageSummary;
  readonly nowMs: number;
}

const PLAN_CAPACITY_SOURCE_LABEL = "Claude Code status line";
const TOKEN_ACTIVITY_SOURCE_LABEL = "Local transcript analysis";
const ESTIMATED_COST_SOURCE_LABEL = "Claude Code estimates and list prices";

/** The three locked section headings (UI-SPEC S2, R-20). */
const SECTION_HEADING = {
  capacity: "Plan usage",
  activity: "Token activity",
  cost: "Estimated API-equivalent cost — an estimate, not your bill",
} as const;

/** A Claude Code version as copy may show it: dotted digits only, mirroring
 * `frame.tsx`'s `claudeCodeVersion` — a version string is schema-bounded
 * but not shape-restricted, so this keeps a free string from a payload out
 * of the rendered copy verbatim. */
const VERSION_SHAPE = /^\d{1,6}(?:\.\d{1,6}){0,3}$/;
function claudeCodeVersion(version: string | null): string {
  return version !== null && VERSION_SHAPE.test(version)
    ? `Claude Code ${version}`
    : "Your Claude Code version";
}

// ---------------------------------------------------------------------------
// Section 1: Plan usage (D-02, D-38, USAGE-06)
// ---------------------------------------------------------------------------

const WINDOW_LABEL: Readonly<Record<CapacityWindow, string>> = {
  "five-hour": "5-hour window",
  "seven-day": "7-day window",
};

const TIME_OF_DAY = new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" });
const MONTH_DAY = new Intl.DateTimeFormat("en", { month: "short", day: "numeric" });

/** `4:40 PM` for the 5-hour window, `Oct 1` for the 7-day window — neither
 * ever contains a `/` (PRIV-04). Exact `Intl` options land in Task 2's
 * `usage-format.ts`; this is the simple version Task 1 needs. */
function resetsText(window: CapacityWindow, resetsAt: string): string {
  const date = new Date(resetsAt);
  return window === "five-hour" ? TIME_OF_DAY.format(date) : MONTH_DAY.format(date);
}

const CAPACITY_UNAVAILABLE_BODY: Readonly<
  Record<PlanCapacityUnavailableReason, (version: string | null) => string>
> = {
  "wrapper-not-installed": () =>
    "Install the optional status-line wrapper to see plan usage. Obsidian settings → Claude command center → Claude has the command.",
  "no-report-yet": () => "Claude Code reports plan usage after the first response in a session.",
  "sign-in-no-limits": () => "Your Claude Code sign-in doesn't report plan limits.",
  "shape-changed": (version) => `The status line format changed in ${claudeCodeVersion(version)}.`,
};

function PlanCapacitySection({ capacity }: { readonly capacity: PlanCapacity }): VNode {
  if (capacity.kind === "unavailable") {
    return (
      <>
        <p className="ccc-state-body">Account capacity unavailable</p>
        <p className="ccc-list-meta">
          {CAPACITY_UNAVAILABLE_BODY[capacity.reason](capacity.version)}
        </p>
      </>
    );
  }
  return (
    <>
      {capacity.windows.map((window) => (
        <div className="ccc-usage-row" key={window.window}>
          <p className="ccc-list-meta">{WINDOW_LABEL[window.window]}</p>
          <p className="ccc-state-heading">
            {`${Math.round(window.usedPercent)}% used · resets ${resetsText(window.window, window.resetsAt)}`}
          </p>
          <meter
            className="ccc-usage-meter"
            min={0}
            max={100}
            value={window.usedPercent}
            aria-hidden="true"
          />
        </div>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// Section 2: Token activity (D-03, D-40..D-45, USAGE-01/07/09)
// ---------------------------------------------------------------------------

/** The descriptor `dispatchQuickAction` resolves to its "isn't available
 * yet" outcome until 05-17 wires `usage:*` (plan note, this file is not
 * edited by 05-17). */
const ENABLE_ANALYSIS_DESCRIPTOR: QuickActionDescriptor = {
  id: "usage-enable-transcript-analysis",
  label: "Turn on transcript analysis",
  capability: "usage:enable-transcript-analysis",
};

const ACTIVITY_UNAVAILABLE: Readonly<
  Record<
    TokenActivityUnavailableReason,
    { heading: string; body: (version: string | null) => string }
  >
> = {
  "analysis-off": {
    heading: "Transcript analysis is off",
    body: () =>
      "Token activity is counted from Claude Code's local transcripts, only after you turn this on. Only counts are kept — never prompts, replies or file contents.",
  },
  "format-changed": {
    heading: "Token activity unavailable",
    body: (version) => `The transcript format changed in ${claudeCodeVersion(version)}.`,
  },
  "no-coverage": {
    heading: "No transcript coverage for this range",
    body: () => "",
  },
};

function TokenActivitySection({
  activity,
  firstScanPending,
  onQuickAction,
}: {
  readonly activity: TokenActivity;
  readonly firstScanPending: boolean;
  readonly onQuickAction: ((descriptor: QuickActionDescriptor) => void) | undefined;
}): VNode {
  if (firstScanPending) {
    return <p className="ccc-state-body">Counting tokens from local transcripts…</p>;
  }
  if (activity.kind === "unavailable") {
    const copy = ACTIVITY_UNAVAILABLE[activity.reason];
    const body = copy.body(activity.version);
    return (
      <>
        <p className="ccc-state-body">{copy.heading}</p>
        {body.length > 0 && <p className="ccc-list-meta">{body}</p>}
        {activity.reason === "analysis-off" && (
          <button
            type="button"
            className="ccc-quick-action"
            onClick={() => onQuickAction?.(ENABLE_ANALYSIS_DESCRIPTOR)}
          >
            {ENABLE_ANALYSIS_DESCRIPTOR.label}
          </button>
        )}
      </>
    );
  }
  const totals = activity.totals;
  const total = totals.input + totals.output + totals.cacheWrite + totals.cacheRead;
  return (
    <>
      <p className="ccc-state-heading">{`${total} tokens`}</p>
      <p className="ccc-list-meta">
        {`Input ${totals.input} · output ${totals.output} · cache write ${totals.cacheWrite} · cache read ${totals.cacheRead}`}
      </p>
    </>
  );
}

// ---------------------------------------------------------------------------
// Section 3: Estimated API-equivalent cost (D-42, USAGE-02/03)
// ---------------------------------------------------------------------------

const PLAN_LINE = "Your subscription spend is your fixed plan price.";

const COST_UNAVAILABLE_BODY = "It needs token activity or the status-line wrapper.";

function costBasisLine(basis: CostBasis, priceTableDate: string | null): string {
  switch (basis) {
    case "claude-code-estimates":
      return "From Claude Code's own session estimates.";
    case "list-prices":
      return `From list prices dated ${MONTH_DAY.format(new Date(priceTableDate ?? 0))} applied to token activity.`;
    case "mixed":
      return `From Claude Code's session estimates and list prices dated ${MONTH_DAY.format(new Date(priceTableDate ?? 0))}.`;
  }
}

function EstimatedCostSection({ cost }: { readonly cost: EstimatedApiCost }): VNode {
  if (cost.kind === "unavailable") {
    return (
      <>
        <p className="ccc-state-body">Estimated API-equivalent cost unavailable</p>
        <p className="ccc-list-meta">{COST_UNAVAILABLE_BODY}</p>
        <p className="ccc-list-meta">{PLAN_LINE}</p>
      </>
    );
  }
  return (
    <>
      <p className="ccc-state-heading">
        {cost.usd > 0 && cost.usd < 0.01 ? "Less than $0.01" : `$${cost.usd.toFixed(2)}`}
      </p>
      <p className="ccc-list-meta">{costBasisLine(cost.basis, cost.priceTableDate)}</p>
      <p className="ccc-list-meta">{PLAN_LINE}</p>
    </>
  );
}

// ---------------------------------------------------------------------------
// The card body
// ---------------------------------------------------------------------------

function ClaudeUsageBody({ data, onQuickAction }: WidgetBodyProps<ClaudeUsageData>): VNode {
  const { summary } = data;
  const today = summary.ranges.today;
  const activityBusy = summary.analysis.enabled && summary.analysis.firstScanPending;

  return (
    <div className="ccc-usage-sections">
      <section className="ccc-usage-section" data-usage-section="plan-capacity">
        <h4>{SECTION_HEADING.capacity}</h4>
        <PlanCapacitySection capacity={summary.capacity} />
      </section>
      <section
        className="ccc-usage-section"
        data-usage-section="token-activity"
        aria-busy={activityBusy ? "true" : undefined}
      >
        <h4>{SECTION_HEADING.activity}</h4>
        <TokenActivitySection
          activity={today.activity}
          firstScanPending={activityBusy}
          onQuickAction={onQuickAction}
        />
      </section>
      <section className="ccc-usage-section" data-usage-section="estimated-cost">
        <h4>{SECTION_HEADING.cost}</h4>
        <EstimatedCostSection cost={today.cost} />
      </section>
    </div>
  );
}

export const claudeUsageWidget: WidgetDefinition<ClaudeUsageData> = {
  id: "claude-usage",
  title: "Claude usage",
  description: "Plan capacity, token activity and an estimated cost.",
  dataKeys: [
    { key: "usage.plan-capacity", transport: "service", sourceLabel: PLAN_CAPACITY_SOURCE_LABEL },
    { key: "usage.token-activity", transport: "service", sourceLabel: TOKEN_ACTIVITY_SOURCE_LABEL },
    { key: "usage.estimated-cost", transport: "service", sourceLabel: ESTIMATED_COST_SOURCE_LABEL },
  ],
  refresh: { kind: "event-driven" },
  minSize: "medium",
  preferredSize: "wide",
  featureFlag: "widget.claude-usage",
  quickActions: [],
  renderBody: ClaudeUsageBody,
  renderEmpty: () => null,
};
