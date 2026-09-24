import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatAbsoluteTime, formatRelativeTime } from "./relative-time.js";

/**
 * Both formatters run against a FIXED clock: the footer's time is the one
 * string on every card that would otherwise change between two runs of the
 * same test, and between two Playwright baselines of the same card.
 */

const NOW_ISO = "2026-09-15T12:00:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);

function isoSecondsAgo(seconds: number): string {
  return new Date(NOW_MS - seconds * 1000).toISOString();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW_ISO));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("formatRelativeTime", () => {
  it("reads just now under a minute, rather than rounding up to a minute", () => {
    expect(formatRelativeTime(isoSecondsAgo(30), NOW_MS)).toBe("just now");
  });

  it("reads minutes under an hour", () => {
    expect(formatRelativeTime(isoSecondsAgo(2 * 60), NOW_MS)).toBe("2 minutes ago");
  });

  it("reads hours under a day", () => {
    expect(formatRelativeTime(isoSecondsAgo(3 * 60 * 60), NOW_MS)).toBe("3 hours ago");
  });

  it("reads days beyond a day", () => {
    expect(formatRelativeTime(isoSecondsAgo(2 * 24 * 60 * 60), NOW_MS)).toBe("2 days ago");
  });

  it("reads just now for a future timestamp — clock skew never claims the future", () => {
    // A companion service whose clock runs five minutes fast must not make a
    // card announce "in 5 minutes"; the honest reading of an observation that
    // has already arrived is that it just arrived.
    expect(formatRelativeTime(isoSecondsAgo(-5 * 60), NOW_MS)).toBe("just now");
  });
});

describe("formatAbsoluteTime", () => {
  it("names the year and no timezone", () => {
    const absolute = formatAbsoluteTime(NOW_ISO);
    expect(absolute).toContain("2026");
    expect(absolute).not.toMatch(/GMT|UTC|[A-Z]{3,4}[+-]\d/);
  });
});
