// Local-day bounds, due-date normalisation and zone conversion (plan 06-05 task 2;
// D-33, research Pattern 12 and spike S10). Every test fixes `now` and names its
// zone: none reads the machine clock or the machine zone.
import { describe, expect, it } from "vitest";
import { TaskDateSchema } from "./task-schema.js";
import {
  dueSortKey,
  isValidZone,
  localDayBounds,
  normaliseDue,
  resolvedZone,
  zonedLocalToInstant,
} from "./task-time.js";

const HOUR_MS = 3_600_000;

function lengthHours(bounds: { startsAt: string; endsAt: string }): number {
  return (Date.parse(bounds.endsAt) - Date.parse(bounds.startsAt)) / HOUR_MS;
}

/** The wall-clock hour of an instant in a zone, read through Intl. */
function localHour(instant: string, zone: string): number {
  const text = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hour: "2-digit",
    hourCycle: "h23",
  }).format(new Date(instant));
  return Number(text);
}

describe("Test 1 (ordinary day)", () => {
  it("returns the local date and the UTC instants of the day start and the next day start", () => {
    const bounds = localDayBounds(new Date("2026-10-05T18:30:00Z"), "America/New_York");
    expect(bounds).toEqual({
      localDate: "2026-10-05",
      startsAt: "2026-10-05T04:00:00.000Z",
      endsAt: "2026-10-06T04:00:00.000Z",
    });
  });

  it("uses the zone's date, not the UTC date, near midnight", () => {
    // 02:30 UTC on 10-06 is 22:30 on 10-05 in New York and 11:30 on 10-06 in Tokyo.
    const now = new Date("2026-10-06T02:30:00Z");
    expect(localDayBounds(now, "America/New_York").localDate).toBe("2026-10-05");
    expect(localDayBounds(now, "Asia/Tokyo").localDate).toBe("2026-10-06");
    expect(localDayBounds(now, "Asia/Tokyo").startsAt).toBe("2026-10-05T15:00:00.000Z");
  });

  it("handles a half-hour offset and an offset beyond twelve hours", () => {
    const now = new Date("2026-10-05T12:00:00Z");
    expect(localDayBounds(now, "Asia/Kolkata").startsAt).toBe("2026-10-04T18:30:00.000Z");
    expect(localDayBounds(now, "Pacific/Kiritimati").startsAt).toBe("2026-10-04T10:00:00.000Z");
    expect(localDayBounds(now, "UTC")).toEqual({
      localDate: "2026-10-05",
      startsAt: "2026-10-05T00:00:00.000Z",
      endsAt: "2026-10-06T00:00:00.000Z",
    });
  });

  it("contains the instant it was given, with the end exclusive", () => {
    for (const iso of ["2026-10-05T04:00:00Z", "2026-10-05T04:00:01Z", "2026-10-06T03:59:59Z"]) {
      const bounds = localDayBounds(new Date(iso), "America/New_York");
      expect(Date.parse(bounds.startsAt)).toBeLessThanOrEqual(Date.parse(iso));
      expect(Date.parse(iso)).toBeLessThan(Date.parse(bounds.endsAt));
    }
    expect(localDayBounds(new Date("2026-10-06T04:00:00Z"), "America/New_York").localDate).toBe(
      "2026-10-06",
    );
  });
});

describe("Test 2 (daylight saving)", () => {
  it("is 23 hours on a spring-forward day in New York", () => {
    const bounds = localDayBounds(new Date("2026-03-08T17:00:00Z"), "America/New_York");
    expect(bounds.localDate).toBe("2026-03-08");
    expect(bounds.startsAt).toBe("2026-03-08T05:00:00.000Z");
    expect(bounds.endsAt).toBe("2026-03-09T04:00:00.000Z");
    expect(lengthHours(bounds)).toBe(23);
  });

  it("is 25 hours on a fall-back day in New York", () => {
    const bounds = localDayBounds(new Date("2026-11-01T17:00:00Z"), "America/New_York");
    expect(bounds.localDate).toBe("2026-11-01");
    expect(bounds.startsAt).toBe("2026-11-01T04:00:00.000Z");
    expect(bounds.endsAt).toBe("2026-11-02T05:00:00.000Z");
    expect(lengthHours(bounds)).toBe(25);
  });

  it("is 24 hours on the same dates in zones with no daylight saving", () => {
    for (const zone of ["Asia/Tokyo", "UTC", "Asia/Kolkata"]) {
      expect(lengthHours(localDayBounds(new Date("2026-03-08T12:00:00Z"), zone)), zone).toBe(24);
      expect(lengthHours(localDayBounds(new Date("2026-11-01T12:00:00Z"), zone)), zone).toBe(24);
    }
  });

  it("gives the right bounds for an instant inside the repeated hour", () => {
    // 05:30Z on 2026-11-01 is 01:30 EST, the second pass through 01:30.
    const bounds = localDayBounds(new Date("2026-11-01T06:30:00Z"), "America/New_York");
    expect(bounds.localDate).toBe("2026-11-01");
    expect(bounds.startsAt).toBe("2026-11-01T04:00:00.000Z");
  });

  it("follows the southern hemisphere's opposite calendar", () => {
    // Sydney springs forward on 2026-10-04 and falls back on 2026-04-05.
    expect(lengthHours(localDayBounds(new Date("2026-10-04T00:00:00Z"), "Australia/Sydney"))).toBe(
      23,
    );
    expect(lengthHours(localDayBounds(new Date("2026-04-05T00:00:00Z"), "Australia/Sydney"))).toBe(
      25,
    );
  });
});

describe("Test 3 (a day that does not start at midnight)", () => {
  const zone = "America/Sao_Paulo";

  it("starts the 2018-11-04 day at 01:00 local, not 00:00", () => {
    const now = new Date("2018-11-04T12:00:00Z");
    const bounds = localDayBounds(now, zone);
    expect(bounds.localDate).toBe("2018-11-04");
    expect(bounds.startsAt).toBe("2018-11-04T03:00:00.000Z");
    expect(localHour(bounds.startsAt, zone)).toBe(1);
    expect(bounds.endsAt).toBe("2018-11-05T02:00:00.000Z");
    expect(lengthHours(bounds)).toBe(23);
  });

  it("still contains the instant that was passed in", () => {
    for (const iso of ["2018-11-04T03:00:00Z", "2018-11-04T03:00:01Z", "2018-11-05T01:59:59Z"]) {
      const bounds = localDayBounds(new Date(iso), zone);
      expect(bounds.localDate).toBe("2018-11-04");
      expect(Date.parse(bounds.startsAt)).toBeLessThanOrEqual(Date.parse(iso));
      expect(Date.parse(iso)).toBeLessThan(Date.parse(bounds.endsAt));
    }
    // One second earlier is still the previous local day.
    expect(localDayBounds(new Date("2018-11-04T02:59:59Z"), zone).localDate).toBe("2018-11-03");
  });
});

describe("Test 4 (zone validation)", () => {
  it("accepts real zones and rejects everything else without throwing", () => {
    for (const zone of ["America/New_York", "Europe/London", "Asia/Kolkata", "UTC", "Etc/GMT+5"]) {
      expect(isValidZone(zone), zone).toBe(true);
    }
    for (const zone of [
      "",
      "Not/AZone",
      "America/New York",
      "+05:00",
      "-0400",
      "../../etc/passwd",
      "x".repeat(100),
      "America/New_York\n",
      "\u0000",
    ]) {
      expect(() => isValidZone(zone), zone).not.toThrow();
      expect(isValidZone(zone), JSON.stringify(zone)).toBe(false);
    }
  });

  it("refuses a non-string without throwing", () => {
    expect(isValidZone(undefined as unknown as string)).toBe(false);
    expect(isValidZone(null as unknown as string)).toBe(false);
    expect(isValidZone(5 as unknown as string)).toBe(false);
  });

  it("offers the runtime's resolved zone as the caller's default, and it is valid", () => {
    expect(isValidZone(resolvedZone())).toBe(true);
  });

  it("throws a RangeError for localDayBounds with a bad zone or a bad date, so a caller validates first", () => {
    expect(() => localDayBounds(new Date("2026-10-05T00:00:00Z"), "Not/AZone")).toThrow(RangeError);
    expect(() => localDayBounds(new Date(Number.NaN), "UTC")).toThrow(RangeError);
  });
});

describe("Test 5 (due normalisation)", () => {
  it("gives a date-only value a date column and no instant", () => {
    expect(normaliseDue("2026-10-09")).toEqual({ date: "2026-10-09", instant: null });
  });

  it("gives an offset instant a UTC ISO instant and no date", () => {
    expect(normaliseDue("2026-10-09T15:00:00-04:00")).toEqual({
      date: null,
      instant: "2026-10-09T19:00:00.000Z",
    });
    expect(normaliseDue("2026-10-09T15:00:00Z")).toEqual({
      date: null,
      instant: "2026-10-09T15:00:00.000Z",
    });
    expect(normaliseDue("2026-10-09T15:00:00.250+05:30")).toEqual({
      date: null,
      instant: "2026-10-09T09:30:00.250Z",
    });
  });

  it("keeps the two columns mutually exclusive for every accepted value", () => {
    for (const value of ["2026-10-09", "2026-10-09T15:00:00Z", "2026-10-09T15:00:00+01:00"]) {
      const normalised = normaliseDue(value);
      expect(normalised, value).not.toBeNull();
      expect((normalised?.date === null) !== (normalised?.instant === null), value).toBe(true);
      expect(TaskDateSchema.safeParse(value).success).toBe(true);
    }
  });

  it("never gives a calendar date a time", () => {
    const normalised = normaliseDue("2026-10-09");
    expect(normalised?.date).toBe("2026-10-09");
    expect(normalised?.date).not.toContain("T");
    expect(normalised?.instant).toBeNull();
  });

  it("returns null for anything that is not a date or an offset instant", () => {
    for (const value of [
      "",
      "next friday",
      "2026-02-30",
      "2026-10-09T15:00:00",
      "2026-10-09 15:00:00Z",
    ]) {
      expect(normaliseDue(value), value).toBeNull();
    }
  });
});

describe("Test 6 (sort key)", () => {
  it("orders a date-only value before any instant on the same day", () => {
    expect(dueSortKey("2026-10-09")).toBe("2026-10-09");
    expect(dueSortKey("2026-10-09T00:00:00Z")).toBe("2026-10-09T00:00:00.000Z");
    expect(String(dueSortKey("2026-10-09")) < String(dueSortKey("2026-10-09T00:00:00Z"))).toBe(
      true,
    );
  });

  it("sorts a mixed list chronologically", () => {
    const values = [
      "2026-10-10",
      "2026-10-09T15:00:00Z",
      "2026-10-09",
      "2026-10-09T09:00:00-04:00",
      "2026-10-08",
    ];
    const sorted = [...values].sort((a, b) =>
      String(dueSortKey(a)).localeCompare(String(dueSortKey(b))),
    );
    expect(sorted).toEqual([
      "2026-10-08",
      "2026-10-09",
      "2026-10-09T09:00:00-04:00",
      "2026-10-09T15:00:00Z",
      "2026-10-10",
    ]);
  });

  it("returns null for an invalid value", () => {
    expect(dueSortKey("soon")).toBeNull();
  });
});

describe("Test 9 (zoned local time to an offset instant)", () => {
  it("converts an ordinary local time and keeps the zone's offset", () => {
    expect(zonedLocalToInstant("2026-10-05", "15:00", "America/New_York")).toBe(
      "2026-10-05T15:00:00-04:00",
    );
    expect(zonedLocalToInstant("2026-01-05", "15:00", "America/New_York")).toBe(
      "2026-01-05T15:00:00-05:00",
    );
    expect(zonedLocalToInstant("2026-10-05", "15:00:30", "Asia/Kolkata")).toBe(
      "2026-10-05T15:00:30+05:30",
    );
    expect(zonedLocalToInstant("2026-10-05", "15:00", "UTC")).toBe("2026-10-05T15:00:00Z");
  });

  it("returns a string the task date schema accepts", () => {
    const value = zonedLocalToInstant("2026-10-05", "09:15", "Europe/London");
    expect(value).toBe("2026-10-05T09:15:00+01:00");
    expect(TaskDateSchema.safeParse(value).success).toBe(true);
    expect(normaliseDue(value as string)?.instant).toBe("2026-10-05T08:15:00.000Z");
  });

  it("moves a time inside a spring-forward gap to the first valid instant", () => {
    // 02:30 on 2026-03-08 does not exist in New York; the clock jumps from 02:00 to 03:00.
    expect(zonedLocalToInstant("2026-03-08", "02:30", "America/New_York")).toBe(
      "2026-03-08T03:00:00-04:00",
    );
    expect(zonedLocalToInstant("2026-03-08", "02:00", "America/New_York")).toBe(
      "2026-03-08T03:00:00-04:00",
    );
    expect(zonedLocalToInstant("2026-03-08", "01:59", "America/New_York")).toBe(
      "2026-03-08T01:59:00-05:00",
    );
    expect(zonedLocalToInstant("2026-03-08", "03:00", "America/New_York")).toBe(
      "2026-03-08T03:00:00-04:00",
    );
    // A zone whose midnight is skipped.
    expect(zonedLocalToInstant("2018-11-04", "00:30", "America/Sao_Paulo")).toBe(
      "2018-11-04T01:00:00-02:00",
    );
  });

  it("picks the first occurrence of an ambiguous fall-back time", () => {
    expect(zonedLocalToInstant("2026-11-01", "01:30", "America/New_York")).toBe(
      "2026-11-01T01:30:00-04:00",
    );
    expect(zonedLocalToInstant("2026-11-01", "00:59", "America/New_York")).toBe(
      "2026-11-01T00:59:00-04:00",
    );
    expect(zonedLocalToInstant("2026-11-01", "02:00", "America/New_York")).toBe(
      "2026-11-01T02:00:00-05:00",
    );
  });

  it("returns null for an invalid date, time or zone", () => {
    expect(zonedLocalToInstant("2026-02-30", "10:00", "UTC")).toBeNull();
    expect(zonedLocalToInstant("2026-13-01", "10:00", "UTC")).toBeNull();
    expect(zonedLocalToInstant("tomorrow", "10:00", "UTC")).toBeNull();
    expect(zonedLocalToInstant("2026-10-05", "25:00", "UTC")).toBeNull();
    expect(zonedLocalToInstant("2026-10-05", "12:60", "UTC")).toBeNull();
    expect(zonedLocalToInstant("2026-10-05", "24:00", "UTC")).toBeNull();
    expect(zonedLocalToInstant("2026-10-05", "noon", "UTC")).toBeNull();
    expect(zonedLocalToInstant("2026-10-05", "", "UTC")).toBeNull();
    expect(zonedLocalToInstant("2026-10-05", "10:00", "Not/AZone")).toBeNull();
    expect(zonedLocalToInstant("2026-10-05", "10:00", "")).toBeNull();
  });
});
