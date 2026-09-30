// Deep submodule imports, not the `@ccc/domain` barrel (05-06 deviation,
// Rule 3, mirrored throughout this phase): the barrel's `export *` chain
// pulls in `path-containment.ts` (`node:fs`/`node:path`), which the visual
// harness's browser-platform bundle cannot resolve.
import type { Freshness } from "@ccc/domain/freshness.js";
import type {
  CapacityWindow,
  EstimatedApiCost,
  PlanCapacity,
  TokenActivity,
  TokenCounters,
  UsageRangeKind,
  UsageSummary,
} from "@ccc/domain/usage.js";
import type { VNode } from "preact";
import { useState } from "preact/hooks";
import type { QuickActionDescriptor } from "../widgets/contract.js";
import { formatAbsoluteTime } from "../widgets/relative-time.js";
import { SourceDisclosure, type SourceDisclosureRow } from "../widgets/source-disclosure.js";
import {
  formatExactTokens,
  formatMonthDay,
  formatPercentUsed,
  formatRangeBounds,
  formatTimeOfDay,
  formatUsd,
} from "../widgets/usage-format.js";
import {
  ESTIMATED_COST_SOURCE_LABEL,
  PLAN_CAPACITY_SOURCE_LABEL,
  TOKEN_ACTIVITY_SOURCE_LABEL,
} from "../widgets/usage-view.js";

/** `{Freshness}` -> the Source panel's exact display word (mirrors
 * `claude-usage.tsx`'s own private table). */
const FRESHNESS_LABEL: Readonly<Record<Freshness, string>> = {
  live: "Live",
  cached: "Cached",
  stale: "Stale",
  unavailable: "Unavailable",
};

/**
 * The Agent runs destination's usage section (UI-SPEC S3 "Usage section
 * (full width)"). An independent range selector (default `Today`, not
 * shared with the Overview usage card's own `usage-view.ts` `usageRange`
 * signal) — the import above only keeps the source-label constant
 * single-sourced.
 */

const RANGE_PILL_LABEL: Readonly<Record<UsageRangeKind, string>> = {
  today: "Today",
  "last-7-days": "Last 7 days",
  "this-month": "This month",
};

const RANGE_WORD: Readonly<Record<UsageRangeKind, string>> = {
  today: "today",
  "last-7-days": "last 7 days",
  "this-month": "this month",
};

const USAGE_RANGE_ORDER: readonly UsageRangeKind[] = ["today", "last-7-days", "this-month"];

function RangeSelector({
  value,
  onChange,
}: {
  readonly value: UsageRangeKind;
  readonly onChange: (range: UsageRangeKind) => void;
}): VNode {
  return (
    // biome-ignore lint/a11y/useSemanticElements: matches UI-SPEC S2's own `<div role="group">` range selector exactly — a `<fieldset>` brings unwanted form/legend semantics for three plain toggle pills.
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

// ---------------------------------------------------------------------------
// Plan usage (identical to S2 Section 1)
// ---------------------------------------------------------------------------

const WINDOW_LABEL: Readonly<Record<CapacityWindow, string>> = {
  "five-hour": "5-hour window",
  "seven-day": "7-day window",
};

function resetsText(window: CapacityWindow, resetsAt: string, nowMs: number): string {
  return window === "five-hour" ? formatTimeOfDay(resetsAt) : formatMonthDay(resetsAt, nowMs);
}

const CAPACITY_UNAVAILABLE_BODY: Readonly<Record<string, string>> = {
  "wrapper-not-installed":
    "Install the optional status-line wrapper to see plan usage. Obsidian settings → Claude command center → Claude has the command.",
  "no-report-yet": "Claude Code reports plan usage after the first response in a session.",
  "sign-in-no-limits": "Your Claude Code sign-in doesn't report plan limits.",
  "shape-changed": "The status line format changed in Claude Code.",
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

function PlanUsageSection({
  capacity,
  nowMs,
}: {
  readonly capacity: PlanCapacity;
  readonly nowMs: number;
}): VNode {
  if (capacity.kind === "unavailable") {
    return (
      <div className="ccc-usage-section" data-usage-section="plan-capacity">
        <h4>Plan usage</h4>
        <p className="ccc-state-body">Account capacity unavailable</p>
        <p className="ccc-list-meta">{CAPACITY_UNAVAILABLE_BODY[capacity.reason]}</p>
        <SourceDisclosure srSuffix="for plan usage" rows={[]} disabled />
      </div>
    );
  }
  return (
    <div className="ccc-usage-section" data-usage-section="plan-capacity">
      <h4>Plan usage</h4>
      {capacity.windows.map((window) => (
        <div className="ccc-usage-row" key={window.window}>
          <p className="ccc-list-meta">{WINDOW_LABEL[window.window]}</p>
          <p className="ccc-state-heading">
            {`${formatPercentUsed(window.usedPercent)} · resets ${resetsText(window.window, window.resetsAt, nowMs)}`}
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
      <SourceDisclosure srSuffix="for plan usage" rows={capacitySourceRows(capacity)} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Token activity: exact totals + By project / By model / By skill tables
// ---------------------------------------------------------------------------

function totalOf(counters: TokenCounters): number {
  return counters.input + counters.output + counters.cacheWrite + counters.cacheRead;
}

interface UsageTableRow {
  readonly label: string;
  readonly counters: TokenCounters;
}

/**
 * `Estimated cost` always reads `No list price` here — `TokenActivity`'s
 * `byProject`/`byModel`/`bySkill` rows carry token counters only (no
 * per-row price), and only the range's single aggregate `EstimatedApiCost`
 * exists (UI-SPEC "Estimated cost" section, separate from this table). A
 * per-row price would have to be invented, which the data-integrity rule
 * forbids — so every row is honestly unpriced from what this destination
 * can see, never a guessed `$0.00`.
 */
function UsageTable({
  title,
  rows,
  rangeBounds,
}: {
  readonly title: string;
  readonly rows: readonly UsageTableRow[];
  readonly rangeBounds: string;
}): VNode {
  const sorted = [...rows].sort((a, b) => totalOf(b.counters) - totalOf(a.counters));
  return (
    <table className="ccc-agent-runs-table">
      <caption>{`${title} · ${rangeBounds} · ${TOKEN_ACTIVITY_SOURCE_LABEL}`}</caption>
      <thead>
        <tr>
          <th scope="col">{title === "By model" ? "Model" : "Project"}</th>
          <th scope="col">Input</th>
          <th scope="col">Output</th>
          <th scope="col" data-priority="tertiary">
            Cache write
          </th>
          <th scope="col" data-priority="tertiary">
            Cache read
          </th>
          <th scope="col">Total</th>
          <th scope="col">Estimated cost</th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((row) => (
          <tr key={row.label}>
            <th scope="row">{row.label}</th>
            <td>{formatExactTokens(row.counters.input)}</td>
            <td>{formatExactTokens(row.counters.output)}</td>
            <td data-priority="tertiary">{formatExactTokens(row.counters.cacheWrite)}</td>
            <td data-priority="tertiary">{formatExactTokens(row.counters.cacheRead)}</td>
            <td>{formatExactTokens(totalOf(row.counters))}</td>
            <td>No list price</td>
          </tr>
        ))}
      </tbody>
    </table>
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
  }));
}

function TokenActivitySection({
  activity,
  range,
  nowMs,
}: {
  readonly activity: TokenActivity;
  readonly range: UsageRangeKind;
  readonly nowMs: number;
}): VNode {
  if (activity.kind === "unavailable") {
    const heading =
      activity.reason === "analysis-off"
        ? "Transcript analysis is off"
        : "Token activity unavailable";
    return (
      <div className="ccc-usage-section" data-usage-section="token-activity">
        <h4>Token activity</h4>
        <p className="ccc-state-body">{heading}</p>
        <SourceDisclosure srSuffix="for token activity" rows={[]} disabled />
      </div>
    );
  }

  const rangeBounds = formatRangeBounds(activity.bounds, range, nowMs);
  const total = totalOf(activity.totals);
  const byProject: readonly UsageTableRow[] = activity.byProject.map((row) => ({
    label: row.projectName ?? "Unclassified",
    counters: row.counters,
  }));
  const byModel: readonly UsageTableRow[] = activity.byModel.map((row) => ({
    label: row.model,
    counters: row.counters,
  }));
  const bySkill: readonly UsageTableRow[] = activity.bySkill.map((row) => ({
    label: row.name,
    counters: row.counters,
  }));

  return (
    <div className="ccc-usage-section" data-usage-section="token-activity">
      <h4>Token activity</h4>
      <p className="ccc-state-heading">{`${formatExactTokens(total)} tokens`}</p>
      <p className="ccc-list-meta">
        {`Input ${formatExactTokens(activity.totals.input)} · output ${formatExactTokens(
          activity.totals.output,
        )} · cache write ${formatExactTokens(activity.totals.cacheWrite)} · cache read ${formatExactTokens(
          activity.totals.cacheRead,
        )}`}
      </p>
      <UsageTable title="By project" rows={byProject} rangeBounds={rangeBounds} />
      <UsageTable title="By model" rows={byModel} rangeBounds={rangeBounds} />
      {bySkill.length === 0 ? (
        <p className="ccc-list-meta">Transcripts in this range don't name a skill or agent.</p>
      ) : (
        <UsageTable title="By skill or agent" rows={bySkill} rangeBounds={rangeBounds} />
      )}
      <SourceDisclosure
        srSuffix="for token activity"
        rows={activitySourceRows(activity, range, nowMs)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Estimated cost (identical to S2 Section 3)
// ---------------------------------------------------------------------------

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
    },
  ];
}

function EstimatedCostSection({
  cost,
  range,
  nowMs,
}: {
  readonly cost: UsageSummary["ranges"]["today"]["cost"];
  readonly range: UsageRangeKind;
  readonly nowMs: number;
}): VNode {
  if (cost.kind === "unavailable") {
    return (
      <div className="ccc-usage-section" data-usage-section="estimated-cost">
        <h4>Estimated API-equivalent cost — an estimate, not your bill</h4>
        <p className="ccc-state-body">Estimated API-equivalent cost unavailable</p>
        <SourceDisclosure srSuffix="for estimated cost" rows={[]} disabled />
      </div>
    );
  }
  return (
    <div className="ccc-usage-section" data-usage-section="estimated-cost">
      <h4>Estimated API-equivalent cost — an estimate, not your bill</h4>
      <p className="ccc-state-heading">{`${formatUsd(cost.usd)} · ${RANGE_WORD[range]}`}</p>
      <p className="ccc-list-meta">Your subscription spend is your fixed plan price.</p>
      <SourceDisclosure srSuffix="for estimated cost" rows={costSourceRows(cost, range, nowMs)} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// The section
// ---------------------------------------------------------------------------

export interface AgentRunsUsageProps {
  readonly summary: UsageSummary;
  readonly nowMs: number;
  readonly onQuickAction?: ((descriptor: QuickActionDescriptor) => void) | undefined;
}

export function AgentRunsUsage({ summary, nowMs }: AgentRunsUsageProps): VNode {
  const [range, setRange] = useState<UsageRangeKind>("today");
  const rangeData = summary.ranges[range];

  return (
    <section className="ccc-agent-runs-usage">
      <h3>Usage</h3>
      <RangeSelector value={range} onChange={setRange} />
      <PlanUsageSection capacity={summary.capacity} nowMs={nowMs} />
      <TokenActivitySection activity={rangeData.activity} range={range} nowMs={nowMs} />
      <EstimatedCostSection cost={rangeData.cost} range={range} nowMs={nowMs} />
    </section>
  );
}
