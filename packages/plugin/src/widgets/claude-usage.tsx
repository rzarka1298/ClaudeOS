// Deep submodule imports, not the `@ccc/domain` barrel (05-06 deviation,
// Rule 3): the barrel's `export *` chain pulls in `path-containment.ts`
// (`node:fs`/`node:path`), which the visual harness's browser-platform
// bundle cannot resolve.
import type { Freshness } from "@ccc/domain/freshness.js";
import type {
  CapacityWindow,
  CostBasis,
  EstimatedApiCost,
  PlanCapacity,
  PlanCapacityUnavailableReason,
  TokenActivity,
  TokenActivityUnavailableReason,
  UsageRangeKind,
  UsageSummary,
} from "@ccc/domain/usage.js";
import type { VNode } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { QuickActionDescriptor, WidgetBodyProps, WidgetDefinition } from "./contract.js";
import { formatAbsoluteTime } from "./relative-time.js";
import { SourceDisclosure, type SourceDisclosureRow } from "./source-disclosure.js";
import {
  capacityLine,
  formatCalendarDate,
  formatCompactTokens,
  formatExactTokens,
  formatPercentUsed,
  formatRangeBounds,
  formatUsd,
  pluralize,
} from "./usage-format.js";
import {
  ESTIMATED_COST_SOURCE_LABEL,
  PLAN_CAPACITY_SOURCE_LABEL,
  TOKEN_ACTIVITY_SOURCE_LABEL,
  usageRange,
} from "./usage-view.js";

/**
 * The Claude usage card (UI-SPEC S2, D-37, D-38, D-51). Moved out of
 * `panels.tsx`'s Phase 3 placeholder section 4; `panels.tsx` now only
 * re-exports {@link claudeUsageWidget} and {@link ClaudeUsageData}.
 *
 * Task 1 (tracer) implemented every state row of the three section tables,
 * fixed to the `today` range. Task 2 adds the range selector (`today` /
 * `last-7-days` / `this-month`), exact `Intl` formatting via
 * `usage-format.ts`, the top-three-projects line, partial retention copy,
 * per-section `SourceDisclosure`s, and keeps every cost string clear of the
 * forbidden billing words (USAGE-03).
 */

/** The whole precomputed summary, plus the frame's own clock tick — the
 * same "embed `nowMs` in the ready payload" move `active-sessions.tsx`
 * makes, since `WidgetBodyProps` carries no `now` of its own. */
export interface ClaudeUsageData {
  readonly summary: UsageSummary;
  readonly nowMs: number;
}

/** The three locked section headings (UI-SPEC S2, R-20). */
const SECTION_HEADING = {
  capacity: "Plan usage",
  activity: "Token activity",
  cost: "Estimated API-equivalent cost — an estimate, not your bill",
} as const;

/** `{Freshness}` -> the Source panel's exact display word. */
const FRESHNESS_LABEL: Readonly<Record<Freshness, string>> = {
  live: "Live",
  cached: "Cached",
  stale: "Stale",
  unavailable: "Unavailable",
};

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

/** The `.ccc-badge[data-badge="partial"]` chip (ADR-0002, reused from
 * `footer.tsx`'s inline Partial badge markup — the same shape, a second
 * independent instance per section rather than a shared component, since
 * each section's partial reason text differs). */
function PartialBadge(): VNode {
  return (
    <span className="ccc-badge" data-badge="partial">
      <span className="ccc-badge-glyph" aria-hidden="true">
        ◈
      </span>
      <span className="ccc-badge-label">Partial</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Section 1: Plan usage (D-02, D-38, USAGE-06)
// ---------------------------------------------------------------------------

const WINDOW_LABEL: Readonly<Record<CapacityWindow, string>> = {
  "five-hour": "5-hour window",
  "seven-day": "7-day window",
};

const CAPACITY_UNAVAILABLE_BODY: Readonly<
  Record<PlanCapacityUnavailableReason, (version: string | null) => string>
> = {
  "wrapper-not-installed": () =>
    "Install the optional status-line wrapper to see plan usage. Obsidian settings → Claude command center → Claude has the command.",
  "no-report-yet": () => "Claude Code reports plan usage after the first response in a session.",
  "sign-in-no-limits": () => "Your Claude Code sign-in doesn't report plan limits.",
  "shape-changed": (version) => `The status line format changed in ${claudeCodeVersion(version)}.`,
};

function capacitySourceRows(capacity: PlanCapacity): readonly SourceDisclosureRow[] {
  if (capacity.kind === "unavailable") return [];
  return capacity.windows.map((window) => ({
    numberLabel: `${WINDOW_LABEL[window.window]}: ${formatPercentUsed(window.usedPercent)}`,
    source: PLAN_CAPACITY_SOURCE_LABEL,
    range: WINDOW_LABEL[window.window],
    observed: formatAbsoluteTime(capacity.observedAt),
    freshness: FRESHNESS_LABEL[capacity.freshness],
  }));
}

function PlanCapacitySection({
  capacity,
  nowMs,
}: {
  readonly capacity: PlanCapacity;
  readonly nowMs: number;
}): VNode {
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
      {capacity.windows.map((window) => {
        const line = capacityLine(window.window, window.usedPercent, window.resetsAt, nowMs);
        return (
          <div className="ccc-usage-row" key={window.window}>
            <p className="ccc-list-meta">{WINDOW_LABEL[window.window]}</p>
            <p className="ccc-state-heading">{line.text}</p>
            {line.current && (
              <meter
                className="ccc-usage-meter"
                min={0}
                max={100}
                value={window.usedPercent}
                aria-hidden="true"
              />
            )}
          </div>
        );
      })}
    </>
  );
}

// ---------------------------------------------------------------------------
// Section 2: Token activity (D-03, D-40..D-45, USAGE-01/07/09)
// ---------------------------------------------------------------------------

const RANGE_PILL_LABEL: Readonly<Record<UsageRangeKind, string>> = {
  today: "Today",
  "last-7-days": "Last 7 days",
  "this-month": "This month",
};

/** The cost value line's lowercase range word (`$12.40 · today`). */
const RANGE_WORD: Readonly<Record<UsageRangeKind, string>> = {
  today: "today",
  "last-7-days": "last 7 days",
  "this-month": "this month",
};

const USAGE_RANGE_ORDER: readonly UsageRangeKind[] = ["today", "last-7-days", "this-month"];

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

function RangeSelector({
  value,
  onChange,
}: {
  readonly value: UsageRangeKind;
  readonly onChange: (range: UsageRangeKind) => void;
}): VNode {
  return (
    // biome-ignore lint/a11y/useSemanticElements: UI-SPEC S2 "Range selector" is exactly `<div role="group" aria-label="...">` — a `<fieldset>` is a form-associated element with its own native styling and a `<legend>` requirement, neither of which fits three plain toggle pills outside a form.
    <div className="ccc-range-group" role="group" aria-label="Token activity range">
      {USAGE_RANGE_ORDER.map((range) => (
        <button
          key={range}
          type="button"
          className="ccc-range-pill"
          aria-pressed={range === value}
          onClick={() => onChange(range)}
        >
          {RANGE_PILL_LABEL[range]}
        </button>
      ))}
    </div>
  );
}

function activitySourceRows(
  activity: TokenActivity,
  range: UsageRangeKind,
  nowMs: number,
): readonly SourceDisclosureRow[] {
  if (activity.kind === "unavailable") return [];
  const rangeText = formatRangeBounds(activity.bounds, range, nowMs);
  const observed = formatAbsoluteTime(activity.observedAt);
  const freshness = FRESHNESS_LABEL[activity.freshness];
  const partial = activity.partiality.partial ? retentionPartialText(activity, nowMs) : undefined;
  const counters: ReadonlyArray<readonly [string, number]> = [
    ["Input", activity.totals.input],
    ["Output", activity.totals.output],
    ["Cache write", activity.totals.cacheWrite],
    ["Cache read", activity.totals.cacheRead],
  ];
  return counters.map(([label, value]) => ({
    numberLabel: `${label}: ${formatExactTokens(value)} tokens`,
    source: TOKEN_ACTIVITY_SOURCE_LABEL,
    range: rangeText,
    observed,
    freshness,
    partial,
  }));
}

/** The retention/analysis-off-for-part-of-range sentences (UI-SPEC
 * "Partial" bullet, D-44). Both are independent and either or both may
 * apply. */
function retentionPartialText(
  activity: Extract<TokenActivity, { kind: "available" }>,
  nowMs: number,
): string {
  const parts: string[] = [];
  if (activity.coverage.horizonDate !== null) {
    parts.push(
      `Local transcripts only go back to ${formatCalendarDate(activity.coverage.horizonDate, nowMs)}.`,
    );
  }
  if (activity.coverage.analysisOffDays > 0) {
    parts.push("Transcript analysis was off for part of this range.");
  }
  return parts.join(" ");
}

function TopProjects({
  activity,
  onNavigate,
}: {
  readonly activity: Extract<TokenActivity, { kind: "available" }>;
  readonly onNavigate: ((destination: "agent-runs") => void) | undefined;
}): VNode | null {
  if (activity.byProject.length === 0) return null;
  const totalOf = (counters: {
    input: number;
    output: number;
    cacheWrite: number;
    cacheRead: number;
  }): number => counters.input + counters.output + counters.cacheWrite + counters.cacheRead;
  const sorted = [...activity.byProject].sort((a, b) => totalOf(b.counters) - totalOf(a.counters));
  const top = sorted.slice(0, 3);
  const hidden = sorted.length - top.length;
  const line = top
    .map(
      (project) =>
        `${project.projectName ?? "Unclassified"} ${formatCompactTokens(totalOf(project.counters))}`,
    )
    .join(" · ");
  return (
    <p className="ccc-list-meta">
      {`By project: ${line}`}
      {hidden > 0 && (
        <button type="button" className="ccc-list-more" onClick={() => onNavigate?.("agent-runs")}>
          {` +${hidden} more`}
        </button>
      )}
    </p>
  );
}

/** UI-SPEC S2 "Enable failed" row and the action table's failure copy. */
const ENABLE_FAILED_HEADING = "Couldn't turn on transcript analysis.";
const ENABLE_FAILED_BODY = "Check the service in Settings → Diagnostics, then try again.";

/**
 * Emits the enable descriptor and reports whether it failed. The dispatcher
 * contract returns nothing, so a failure is either a synchronous throw or a
 * handler that returns a rejected promise; both are caught here and become
 * the section's inline ▲ line (UI-SPEC E3 error) instead of escaping the
 * click handler uncaught (wave 3 audit, Error E3).
 */
function useEnableAnalysis(
  onQuickAction: ((descriptor: QuickActionDescriptor) => void) | undefined,
): { readonly failed: boolean; readonly enable: () => void } {
  const [failed, setFailed] = useState(false);
  function enable(): void {
    setFailed(false);
    if (onQuickAction === undefined) return;
    try {
      const outcome: unknown = onQuickAction(ENABLE_ANALYSIS_DESCRIPTOR);
      if (outcome instanceof Promise) {
        outcome.catch(() => {
          setFailed(true);
        });
      }
    } catch {
      setFailed(true);
    }
  }
  return { failed, enable };
}

function EnableFailedLine(): VNode {
  return (
    <>
      <p className="ccc-state-body">
        {/* Decorative reinforcement only: the text carries the failure (A11Y-04). */}
        <span className="ccc-error-glyph" aria-hidden="true">
          ▲
        </span>
        <span>{ENABLE_FAILED_HEADING}</span>
      </p>
      <p className="ccc-list-meta">{ENABLE_FAILED_BODY}</p>
    </>
  );
}

function TokenActivitySection({
  activity,
  range,
  nowMs,
  firstScanPending,
  onQuickAction,
  onNavigate,
}: {
  readonly activity: TokenActivity;
  readonly range: UsageRangeKind;
  readonly nowMs: number;
  readonly firstScanPending: boolean;
  readonly onQuickAction: ((descriptor: QuickActionDescriptor) => void) | undefined;
  readonly onNavigate: ((destination: "agent-runs") => void) | undefined;
}): VNode {
  const enabling = useEnableAnalysis(onQuickAction);
  if (firstScanPending) {
    return <p className="ccc-state-body">Counting tokens from local transcripts…</p>;
  }
  if (activity.kind === "unavailable") {
    const copy = ACTIVITY_UNAVAILABLE[activity.reason];
    const body = copy.body(activity.version);
    const failed = activity.reason === "analysis-off" && enabling.failed;
    return (
      <>
        {failed ? (
          <EnableFailedLine />
        ) : (
          <>
            <p className="ccc-state-body">{copy.heading}</p>
            {body.length > 0 && <p className="ccc-list-meta">{body}</p>}
          </>
        )}
        {activity.reason === "analysis-off" && (
          <button type="button" className="ccc-quick-action" onClick={enabling.enable}>
            {ENABLE_ANALYSIS_DESCRIPTOR.label}
          </button>
        )}
      </>
    );
  }
  const totals = activity.totals;
  const total = totals.input + totals.output + totals.cacheWrite + totals.cacheRead;
  const partialText = activity.partiality.partial ? retentionPartialText(activity, nowMs) : "";
  return (
    <>
      <p className="ccc-state-heading">{`${formatCompactTokens(total)} tokens`}</p>
      <p className="ccc-list-meta">{formatRangeBounds(activity.bounds, range, nowMs)}</p>
      <p className="ccc-list-meta">
        {`Input ${formatCompactTokens(totals.input)} · output ${formatCompactTokens(
          totals.output,
        )} · cache write ${formatCompactTokens(totals.cacheWrite)} · cache read ${formatCompactTokens(
          totals.cacheRead,
        )}`}
      </p>
      <TopProjects activity={activity} onNavigate={onNavigate} />
      {activity.partiality.partial && partialText.length > 0 && (
        <p className="ccc-list-meta">
          <PartialBadge /> {partialText}
        </p>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Section 3: Estimated API-equivalent cost (D-42, USAGE-02/03)
// ---------------------------------------------------------------------------

const PLAN_LINE = "Your subscription spend is your fixed plan price.";

const COST_UNAVAILABLE_BODY = "It needs token activity or the status-line wrapper.";

function costBasisLine(basis: CostBasis, priceTableDate: string | null, nowMs: number): string {
  switch (basis) {
    case "claude-code-estimates":
      return "From Claude Code's own session estimates.";
    case "list-prices":
      return `From list prices dated ${formatCalendarDate(priceTableDate ?? "1970-01-01", nowMs)} applied to token activity.`;
    case "mixed":
      return `From Claude Code's session estimates and list prices dated ${formatCalendarDate(priceTableDate ?? "1970-01-01", nowMs)}.`;
  }
}

function costSourceRows(
  cost: EstimatedApiCost,
  range: UsageRangeKind,
  nowMs: number,
): readonly SourceDisclosureRow[] {
  if (cost.kind === "unavailable") return [];
  return [
    {
      numberLabel: `Estimated cost: ${formatUsd(cost.usd)}`,
      source: ESTIMATED_COST_SOURCE_LABEL,
      range: formatRangeBounds(cost.bounds, range, nowMs),
      observed: formatAbsoluteTime(cost.observedAt),
      freshness: FRESHNESS_LABEL[cost.freshness],
      partial: cost.partiality.partial ? pluralize(cost.excludedModelCount) : undefined,
    },
  ];
}

function EstimatedCostSection({
  cost,
  range,
  nowMs,
}: {
  readonly cost: EstimatedApiCost;
  readonly range: UsageRangeKind;
  readonly nowMs: number;
}): VNode {
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
      <p className="ccc-state-heading">{`${formatUsd(cost.usd)} · ${RANGE_WORD[range]}`}</p>
      <p className="ccc-list-meta">{costBasisLine(cost.basis, cost.priceTableDate, nowMs)}</p>
      <p className="ccc-list-meta">{PLAN_LINE}</p>
      {cost.partiality.partial && cost.excludedModelCount > 0 && (
        <p className="ccc-list-meta">
          <PartialBadge /> {pluralize(cost.excludedModelCount)}
        </p>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// The card body
// ---------------------------------------------------------------------------

function ClaudeUsageBody({
  data,
  onQuickAction,
  onNavigate,
}: WidgetBodyProps<ClaudeUsageData>): VNode {
  const { summary, nowMs } = data;
  const [range, setRange] = useState<UsageRangeKind>("today");
  const rangeData = summary.ranges[range];
  // Mirror the selection into the card state's view signal so the footer's
  // freshness and partiality follow the range on screen; back to Today when
  // the card goes away, matching the selector's default-on-mount (E4).
  useEffect(() => {
    usageRange.value = range;
  }, [range]);
  useEffect(
    () => () => {
      usageRange.value = "today";
    },
    [],
  );
  const activityBusy = summary.analysis.enabled && summary.analysis.firstScanPending;
  const navigateToAgentRuns = onNavigate
    ? (destination: "agent-runs") => onNavigate(destination)
    : undefined;

  return (
    <div className="ccc-usage-sections">
      <section className="ccc-usage-section" data-usage-section="plan-capacity">
        <h4>{SECTION_HEADING.capacity}</h4>
        <PlanCapacitySection capacity={summary.capacity} nowMs={nowMs} />
        <SourceDisclosure
          srSuffix="for plan usage"
          rows={capacitySourceRows(summary.capacity)}
          disabled={summary.capacity.kind === "unavailable"}
        />
      </section>
      <section
        className="ccc-usage-section"
        data-usage-section="token-activity"
        aria-busy={activityBusy ? "true" : undefined}
      >
        <h4>{SECTION_HEADING.activity}</h4>
        <RangeSelector value={range} onChange={setRange} />
        <TokenActivitySection
          activity={rangeData.activity}
          range={range}
          nowMs={nowMs}
          firstScanPending={activityBusy}
          onQuickAction={onQuickAction}
          onNavigate={navigateToAgentRuns}
        />
        <SourceDisclosure
          srSuffix="for token activity"
          rows={activitySourceRows(rangeData.activity, range, nowMs)}
          disabled={rangeData.activity.kind === "unavailable" || activityBusy}
        />
      </section>
      <section className="ccc-usage-section" data-usage-section="estimated-cost">
        <h4>{SECTION_HEADING.cost}</h4>
        <EstimatedCostSection cost={rangeData.cost} range={range} nowMs={nowMs} />
        <SourceDisclosure
          srSuffix="for estimated cost"
          rows={costSourceRows(rangeData.cost, range, nowMs)}
          disabled={rangeData.cost.kind === "unavailable"}
        />
      </section>
    </div>
  );
}

/**
 * The whole-card empty body (UI-SPEC E3 empty row): the same three sections,
 * each with its own no-data line, reason and next step, so no section ever
 * renders blank and the card never falls back to a list's "no items" copy.
 * No numbers, meters or controls: there is no observation to show or act on.
 */
function ClaudeUsageEmpty(): VNode {
  const off = ACTIVITY_UNAVAILABLE["analysis-off"];
  return (
    <div className="ccc-usage-sections">
      <section className="ccc-usage-section" data-usage-section="plan-capacity">
        <h4>{SECTION_HEADING.capacity}</h4>
        <p className="ccc-state-body">Account capacity unavailable</p>
        <p className="ccc-list-meta">{CAPACITY_UNAVAILABLE_BODY["no-report-yet"](null)}</p>
      </section>
      <section className="ccc-usage-section" data-usage-section="token-activity">
        <h4>{SECTION_HEADING.activity}</h4>
        <p className="ccc-state-body">{off.heading}</p>
        <p className="ccc-list-meta">{off.body(null)}</p>
      </section>
      <section className="ccc-usage-section" data-usage-section="estimated-cost">
        <h4>{SECTION_HEADING.cost}</h4>
        <p className="ccc-state-body">Estimated API-equivalent cost unavailable</p>
        <p className="ccc-list-meta">{COST_UNAVAILABLE_BODY}</p>
        <p className="ccc-list-meta">{PLAN_LINE}</p>
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
  renderEmpty: ClaudeUsageEmpty,
  ownsEmptyCopy: true,
};
