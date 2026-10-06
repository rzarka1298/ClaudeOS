import type { CapacityWindow, UsageBounds, UsageRangeKind } from "@ccc/domain/usage.js";

/**
 * Exact number and time formatting for the usage card (UI-SPEC "Number and
 * time formatting (fixed)"). Every formatter is a pure function of its
 * explicit arguments — no formatter here ever reads the ambient clock or
 * locale — and no formatter output ever contains a `/` (PRIV-04): a
 * numeric `M/D/YYYY` date would break the Source panel's no-slash rule.
 */

const COMPACT_TOKENS = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const EXACT_NUMBER = new Intl.NumberFormat("en");
const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const TIME_OF_DAY = new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" });
const MONTH_DAY = new Intl.DateTimeFormat("en", { month: "short", day: "numeric" });
const MONTH_DAY_YEAR = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  year: "numeric",
});
const MONTH_DAY_UTC = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
const MONTH_DAY_YEAR_UTC = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});
const PLURAL = new Intl.PluralRules("en");

/** `1240000` -> `1.2M` (compact cards). */
export function formatCompactTokens(n: number): string {
  return COMPACT_TOKENS.format(n);
}

/** `1204331` -> `1,204,331` (S3, Source panels). */
export function formatExactTokens(n: number): string {
  return EXACT_NUMBER.format(n);
}

/** `12.4` -> `$12.40`; below one cent, `Less than $0.01` (exactly `$0.00` is
 * a real measured value, never the under-a-cent phrase). */
export function formatUsd(amount: number): string {
  if (amount > 0 && amount < 0.01) return "Less than $0.01";
  return USD.format(amount);
}

/** `62.4` -> `62% used`. */
export function formatPercentUsed(used: number): string {
  return `${Math.round(used)}% used`;
}

/** `{ month: "short", day: "numeric" }`, plus `year` outside the current
 * year (UI-SPEC "Number and time formatting (fixed)"). Never a
 * slash-separated numeric date. */
export function formatMonthDay(iso: string, nowMs: number): string {
  const date = new Date(iso);
  const currentYear = new Date(nowMs).getFullYear();
  return date.getFullYear() === currentYear ? MONTH_DAY.format(date) : MONTH_DAY_YEAR.format(date);
}

/** `4:40 PM` — the 5-hour capacity window's reset time. Not part of the
 * public formatter list UI-SPEC's usage-format.ts "provides"; `claude-usage.tsx`
 * imports this one directly since it is specific to the capacity section's
 * own line. */
export function formatTimeOfDay(iso: string): string {
  return TIME_OF_DAY.format(new Date(iso));
}

/**
 * `coverage.horizonDate` and `priceTableDate` are pure CALENDAR dates
 * (`z.iso.date()`, no time-of-day and no offset) — "the 20th of September",
 * not an instant. Formatting one through `formatMonthDay`'s local-timezone
 * path would `new Date("2026-09-20")` (parsed as UTC midnight) and then
 * render it in the reader's local zone, which reads as the 19th anywhere
 * west of UTC — exactly the kind of off-by-one-day bug a "local timezone"
 * rule is not supposed to introduce for a value that was never an instant
 * to begin with. This formats the date's own UTC calendar fields, so
 * "2026-09-20" always reads `Sep 20` (or `Sep 20, 2026` outside the current
 * year), everywhere. */
export function formatCalendarDate(dateOnly: string, nowMs: number): string {
  const date = new Date(`${dateOnly}T00:00:00Z`);
  const currentYear = new Date(nowMs).getUTCFullYear();
  return date.getUTCFullYear() === currentYear
    ? MONTH_DAY_UTC.format(date)
    : MONTH_DAY_YEAR_UTC.format(date);
}

/**
 * The Section 2 range-bounds line (UI-SPEC "Value" / "Range bounds"):
 * `Sep 26, 12:00 AM – now` (today), `Sep 20 – Sep 26` (last 7 days, a real
 * end date, never the word "now"), `Sep 1 – now` (this month).
 */
export function formatRangeBounds(
  bounds: UsageBounds,
  range: UsageRangeKind,
  nowMs: number,
): string {
  const start = new Date(bounds.start);
  if (range === "today") {
    return `${formatMonthDay(bounds.start, nowMs)}, ${TIME_OF_DAY.format(start)} – now`;
  }
  if (range === "last-7-days") {
    return `${formatMonthDay(bounds.start, nowMs)} – ${formatMonthDay(bounds.end, nowMs)}`;
  }
  return `${formatMonthDay(bounds.start, nowMs)} – now`;
}

/** `1` -> `1 model without a list price was left out.`; `2` -> `2 models
 * without a list price were left out.` (UI-SPEC "Partial", excluded-model
 * count). `Intl.PluralRules` so the count is never `1 models`. */
export function pluralize(n: number): string {
  const isOne = PLURAL.select(n) === "one";
  const noun = isOne ? "model" : "models";
  const verb = isOne ? "was" : "were";
  return `${n} ${noun} without a list price ${verb} left out.`;
}

/** `4:40 PM` for the 5-hour window, `Oct 1` for the 7-day window — neither
 * ever contains a `/` (PRIV-04). `resetsAt` is an INSTANT, so the 7-day date
 * is the reader's local calendar date of it, not its UTC date (wave 3
 * review). */
export function formatCapacityReset(
  window: CapacityWindow,
  resetsAt: string,
  nowMs: number,
): string {
  return window === "five-hour" ? formatTimeOfDay(resetsAt) : formatMonthDay(resetsAt, nowMs);
}

/**
 * One capacity window's line, shared by the Overview usage card and Agent
 * runs so the same observation never reads two ways (Codex advisory 7, wave
 * 5). Once its reset time has passed, the reported percentage describes a
 * window that is already over: it reads as outdated (and the caller drops
 * its meter) rather than "resets {past time}" beside a number that is no
 * longer current (wave 3 review).
 */
export function capacityLine(
  window: CapacityWindow,
  usedPercent: number,
  resetsAt: string,
  nowMs: number,
): { readonly text: string; readonly current: boolean } {
  const when = formatCapacityReset(window, resetsAt, nowMs);
  if (Date.parse(resetsAt) <= nowMs) {
    return {
      text: `${formatPercentUsed(usedPercent)} before the ${when} reset · outdated`,
      current: false,
    };
  }
  return { text: `${formatPercentUsed(usedPercent)} · resets ${when}`, current: true };
}
