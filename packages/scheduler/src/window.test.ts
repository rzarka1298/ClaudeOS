// Task 2 of plan 07-05 (D-19, research R5): IANA schedule windows with Intl only.
// No test reads the machine zone or the clock: every instant is a literal.

import { describe, expect, it } from "vitest";
import { isValidTimeZone, wallToInstant, windowDate } from "./window.js";

const NY = "America/New_York";

describe("Test 1: windowDate is the local date of an instant in a zone", () => {
  it("is the previous day in New York and the same day in Tokyo just before 04:00Z", () => {
    const instant = Date.parse("2026-10-14T03:59:00Z");
    expect(windowDate(instant, NY)).toBe("2026-10-13");
    expect(windowDate(instant, "Asia/Tokyo")).toBe("2026-10-14");
  });

  it("gives both fall-back hours the same date, so DST cannot open two windows", () => {
    expect(windowDate(Date.parse("2026-11-01T05:30:00Z"), NY)).toBe("2026-11-01");
    expect(windowDate(Date.parse("2026-11-01T06:30:00Z"), NY)).toBe("2026-11-01");
  });

  it("maps an instant on the skipped Apia day to the day after", () => {
    expect(windowDate(Date.parse("2011-12-30T10:00:00Z"), "Pacific/Apia")).toBe("2011-12-31");
  });

  it("works for UTC and at the year boundary", () => {
    expect(windowDate(Date.parse("2026-12-31T23:59:59Z"), "UTC")).toBe("2026-12-31");
    expect(windowDate(Date.parse("2027-01-01T00:00:00Z"), "UTC")).toBe("2027-01-01");
    expect(windowDate(Date.parse("2027-01-01T04:59:59Z"), NY)).toBe("2026-12-31");
  });

  it("throws a RangeError for an invalid zone or a non-finite instant", () => {
    expect(() => windowDate(0, "Mars/Olympus")).toThrow(RangeError);
    expect(() => windowDate(Number.NaN, NY)).toThrow(RangeError);
  });
});

describe("Test 2: wallToInstant resolves a local wall time to an instant", () => {
  it("resolves an ordinary New York morning", () => {
    expect(wallToInstant(2026, 10, 14, 8, 0, NY)).toBe(Date.parse("2026-10-14T12:00:00Z"));
  });

  it("moves a spring-forward gap time forward by the gap", () => {
    // 02:30 does not exist on 2026-03-08 in New York; it becomes 03:30 EDT = 07:30Z.
    expect(wallToInstant(2026, 3, 8, 2, 30, NY)).toBe(Date.parse("2026-03-08T07:30:00Z"));
  });

  it("takes the first occurrence of a fall-back overlap time", () => {
    // 01:30 happens twice on 2026-11-01; the first is EDT = 05:30Z.
    expect(wallToInstant(2026, 11, 1, 1, 30, NY)).toBe(Date.parse("2026-11-01T05:30:00Z"));
  });

  it("resolves times just outside a transition", () => {
    expect(wallToInstant(2026, 3, 8, 1, 59, NY)).toBe(Date.parse("2026-03-08T06:59:00Z"));
    expect(wallToInstant(2026, 3, 8, 3, 0, NY)).toBe(Date.parse("2026-03-08T07:00:00Z"));
    expect(wallToInstant(2026, 11, 1, 2, 0, NY)).toBe(Date.parse("2026-11-01T07:00:00Z"));
  });

  it("resolves UTC and a zone without DST", () => {
    expect(wallToInstant(2026, 10, 14, 8, 0, "UTC")).toBe(Date.parse("2026-10-14T08:00:00Z"));
    expect(wallToInstant(2026, 10, 14, 8, 0, "Asia/Tokyo")).toBe(
      Date.parse("2026-10-13T23:00:00Z"),
    );
  });

  it("round-trips: the window of a resolved instant is the requested date", () => {
    for (const [y, m, d] of [
      [2026, 3, 8],
      [2026, 11, 1],
      [2026, 10, 14],
    ] as const) {
      expect(windowDate(wallToInstant(y, m, d, 12, 0, NY), NY)).toBe(
        `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
      );
    }
  });

  it("throws a RangeError for an invalid zone or an impossible wall time", () => {
    expect(() => wallToInstant(2026, 10, 14, 8, 0, "Mars/Olympus")).toThrow(RangeError);
    expect(() => wallToInstant(2026, 13, 1, 8, 0, NY)).toThrow(RangeError);
    expect(() => wallToInstant(2026, 2, 30, 8, 0, NY)).toThrow(RangeError);
    expect(() => wallToInstant(2026, 10, 14, 24, 0, NY)).toThrow(RangeError);
    expect(() => wallToInstant(2026, 10, 14, 8, 60, NY)).toThrow(RangeError);
    expect(() => wallToInstant(2026.5, 10, 14, 8, 0, NY)).toThrow(RangeError);
  });
});

describe("Test 3: isValidTimeZone", () => {
  it("accepts UTC (explicitly) and real IANA zones", () => {
    for (const zone of ["UTC", NY, "Pacific/Apia", "Asia/Tokyo", "Europe/London"]) {
      expect(isValidTimeZone(zone), zone).toBe(true);
    }
  });

  it("rejects an unknown zone and an empty string without throwing", () => {
    for (const zone of ["Mars/Olympus", "", " ", "America/", "not a zone", "\u0000"]) {
      expect(isValidTimeZone(zone), JSON.stringify(zone)).toBe(false);
    }
  });

  it("rejects a non-string without throwing", () => {
    expect(isValidTimeZone(undefined as unknown as string)).toBe(false);
    expect(isValidTimeZone(null as unknown as string)).toBe(false);
    expect(isValidTimeZone(5 as unknown as string)).toBe(false);
  });
});
