import { describe, expect, it } from "vitest";
import type { RenderedBadge, RenderedRow, TranscriptRecord } from "./research-dom.js";
import { checkReportRow, checkRunTranscript } from "./research-verdicts.js";

const STARTING = "Starting a research run…";
const STARTED = "Research run started.";
const READY = "Research report ready: Developer tooling and open-source releases — Oct 16, 2026.";

const record = (at: number, status: string, current: string | null): TranscriptRecord => ({
  at,
  status,
  current,
});

const GOOD: TranscriptRecord[] = [
  record(0, "", null),
  record(5, STARTING, null),
  record(40, STARTED, null),
  record(60, STARTED, "▸ Running · Reading the source list · started just now"),
  record(1400, STARTED, "▸ Running · Writing the report · started just now"),
  record(1500, READY, null),
];

describe("checkRunTranscript (07-UAT item 2)", () => {
  it("accepts the status line sequence and a Running row that names the held stage, then goes", () => {
    expect(checkRunTranscript(GOOD)).toEqual([]);
    // Only the held stage observed, as a fast fixture usually shows.
    expect(checkRunTranscript(GOOD.filter((entry) => !entry.current?.includes("Writing")))).toEqual(
      [],
    );
  });

  it("names a run that never showed the starting line, the started line or the ready line", () => {
    expect(checkRunTranscript(GOOD.filter((entry) => entry.status !== STARTING))).toContain(
      "the status line never read the starting sentence",
    );
    expect(checkRunTranscript(GOOD.filter((entry) => entry.status !== STARTED))).toContain(
      "the status line never read the started sentence",
    );
    expect(checkRunTranscript(GOOD.slice(0, 5))).toContain(
      "the status line never read that a report is ready",
    );
  });

  it("requires the sentences in order", () => {
    const swapped = [GOOD[0], GOOD[2], GOOD[1], ...GOOD.slice(3)] as TranscriptRecord[];
    expect(checkRunTranscript(swapped)).toContain(
      "the status line sentences came in the wrong order",
    );
  });

  it("names a run that never showed the Running row, and a stage word outside the closed set", () => {
    const noCurrent = GOOD.map((entry) => ({ ...entry, current: null }));
    expect(checkRunTranscript(noCurrent)).toContain("the Current run row never showed Running");
    const odd = GOOD.map((entry, index) =>
      index === 3 ? { ...entry, current: "▸ Running · Doing something · started just now" } : entry,
    );
    expect(checkRunTranscript(odd)).toContain(
      "the Current run row showed a stage word outside the closed set",
    );
  });

  it("names a Running row that first names a later stage than the held one", () => {
    const later = GOOD.filter((entry) => !entry.current?.includes("Reading"));
    expect(checkRunTranscript(later)).toContain(
      "the Current run row did not first name the held fetch stage",
    );
  });

  it("names a Current run row that is still there at the end", () => {
    const stuck = [...GOOD.slice(0, 5), record(1500, READY, "▸ Running · Writing the report")];
    expect(checkRunTranscript(stuck)).toContain(
      "the Current run row was still there when the run ended",
    );
  });
});

const badge = (kind: string, glyph: string, label: string): RenderedBadge => ({
  kind,
  glyph,
  label,
});

const ROW: RenderedRow = {
  title: "Developer tooling and open-source releases — Oct 16, 2026",
  meta: "just now · ◐Cached · 3 sources · 3 items",
  dateTime: "2026-10-16T10:59:56.719Z",
  badges: [badge("cached", "◐", "Cached")],
  selected: false,
  unreadable: false,
};
const WINDOW = {
  notBefore: Date.parse("2026-10-16T10:59:50.000Z"),
  notAfter: Date.parse("2026-10-16T11:00:10.000Z"),
};

const EXPECT = { sourcesPhrase: "3 sources", itemsPhrase: "3 items", ...WINDOW };

describe("checkReportRow (07-UAT item 2)", () => {
  it("accepts a row with its time, the cached badge, the source count and the item count", () => {
    expect(checkReportRow(ROW, EXPECT)).toEqual([]);
  });

  it("names a missing time, a time outside the run window, a missing or wrong badge and wrong counts", () => {
    expect(checkReportRow({ ...ROW, dateTime: null }, EXPECT)).toContain(
      "the row has no generation time",
    );
    expect(checkReportRow({ ...ROW, dateTime: "2026-10-15T10:59:56.719Z" }, EXPECT)).toContain(
      "the generation time is outside the run",
    );
    expect(checkReportRow({ ...ROW, badges: [] }, EXPECT)).toContain(
      "the row shows no Cached badge with its glyph",
    );
    expect(checkReportRow({ ...ROW, badges: [badge("cached", "●", "Cached")] }, EXPECT)).toContain(
      "the row shows no Cached badge with its glyph",
    );
    expect(
      checkReportRow({ ...ROW, meta: "just now · ◐Cached · 2 sources · 3 items" }, EXPECT),
    ).toContain("the row does not say 3 sources");
    expect(
      checkReportRow({ ...ROW, meta: "just now · ◐Cached · 13 sources · 3 items" }, EXPECT),
    ).toContain("the row does not say 3 sources");
    expect(
      checkReportRow({ ...ROW, meta: "just now · ◐Cached · 3 sources · 4 items" }, EXPECT),
    ).toContain("the row does not say 3 items");
  });

  it("does not accept a Partial badge on a complete report when none is expected", () => {
    expect(
      checkReportRow({ ...ROW, badges: [...ROW.badges, badge("partial", "◈", "Partial")] }, EXPECT),
    ).toContain("the row shows a Partial badge");
  });
});
