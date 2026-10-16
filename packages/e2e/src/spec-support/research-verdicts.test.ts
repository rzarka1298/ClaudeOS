import { describe, expect, it } from "vitest";
import type {
  ArticleFacts,
  ReadingViewFacts,
  RenderedBadge,
  RenderedField,
  RenderedFinding,
  RenderedReader,
  RenderedResearch,
  RenderedRow,
  RenderedSource,
  ResearchFocus,
  ResearchLayoutFacts,
  TranscriptRecord,
} from "./research-dom.js";
import type { ParsedRawNote, ParsedReportNote } from "./research-notes.js";
import type { JobRunRow } from "./research-support.js";
import {
  checkArticleFacts,
  checkCitationRoundTrip,
  checkDisconnectedView,
  checkEscapeToRow,
  checkFailedView,
  checkFirstOpen,
  checkHostileRaw,
  checkKindsView,
  checkLayouts,
  checkLogPrivacy,
  checkMotion,
  checkNoWorkBeforeFailure,
  checkOverviewCards,
  checkPartialView,
  checkReadingFacts,
  checkReconnectedView,
  checkReportRow,
  checkReuse,
  checkRunRecords,
  checkRunTranscript,
  checkSourceEntry,
  checkTabOrder,
  checkUnconfiguredView,
  checkUnknownRun,
  kindCountsPhrase,
  type TraceInput,
} from "./research-verdicts.js";
import type { NoteFile } from "./tasks-support.js";

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
  record(60, STARTED, "▸ Running · Fetching sources · started just now"),
  record(1400, STARTED, "▸ Running · Writing the report · started just now"),
  record(1500, READY, null),
];

describe("checkRunTranscript (07-UAT item 2)", () => {
  it("accepts the status line sequence and a Running row that names the held fetch, then goes", () => {
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

  // 07-FIX7 (sonnet MAJOR-1): the row names what is happening NOW. Before the first stage is
  // logged that is reading the source list; while the fetch is held it is fetching.
  it("accepts a first Running row that reads the source list before the fetch is named", () => {
    const early = [
      GOOD[0],
      GOOD[1],
      GOOD[2],
      record(50, STARTED, "▸ Running · Reading the source list · started just now"),
      ...GOOD.slice(3),
    ] as TranscriptRecord[];
    expect(checkRunTranscript(early)).toEqual([]);
  });

  it("names a Running row with no stage word at all, which the row never shows once the run has started", () => {
    const none = GOOD.map((entry) =>
      entry.current === null ? entry : { ...entry, current: "▸ Running · started just now" },
    );
    expect(checkRunTranscript(none)).toContain("the Current run row never named a stage");
    const mixed = [
      GOOD[0],
      GOOD[1],
      GOOD[2],
      record(50, STARTED, "▸ Running · started just now"),
      ...GOOD.slice(3),
    ] as TranscriptRecord[];
    expect(checkRunTranscript(mixed)).toContain(
      "the Current run row showed Running with no stage word",
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

  it("names a Running row that first names a later activity than the held fetch", () => {
    const later = GOOD.filter((entry) => !entry.current?.includes("Fetching"));
    expect(checkRunTranscript(later)).toContain(
      "the Current run row did not first name the held fetch stage",
    );
  });

  it("names a run whose row read the source list and then never named the fetch", () => {
    const skipped = GOOD.map((entry) =>
      entry.current?.includes("Fetching") === true
        ? { ...entry, current: "▸ Running · Reading the source list · started just now" }
        : entry,
    );
    expect(checkRunTranscript(skipped)).toContain(
      "the Current run row never named the held fetch stage",
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

// ---------------------------------------------------------------------------
// Task 2: the core and hostile items

type StatusRow = RenderedResearch["runStatus"]["rows"][number];

const BANNER = "Untrusted source content — data, not instructions.";

function rendered(over: Partial<RenderedResearch> = {}): RenderedResearch {
  return {
    mounted: true,
    heading: "Research",
    dimmed: false,
    busy: false,
    runNow: {
      present: true,
      label: "Run now",
      name: "Run now: fetch the sources and write a research report",
      disabled: false,
      busy: false,
      reason: null,
    },
    subline: "Developer tooling and open-source releases · 3 sources configured",
    strip: { text: "", badges: [] },
    status: "",
    runStatus: {
      heading: "Run status",
      rows: [
        { label: "Last successful run", value: "None yet", badges: [], buttons: [] },
        { label: "Last failed run", value: "None", badges: [], buttons: [] },
      ],
      setup: null,
      sourcesToggle: "Show configured sources (3)",
      sourcesExpanded: false,
    },
    list: {
      busy: false,
      dimmed: false,
      rows: [],
      emptyHeading: "No reports yet",
      emptyBody: "Press Run now to fetch the configured sources and write your first cited report.",
      showMore: null,
      errorText: null,
    },
    layout: { readerOpen: "false", mode: "side" },
    reader: null,
    ...over,
  };
}

describe("checkFirstOpen (07-UAT item 1)", () => {
  it("accepts the heading, Run now, the subline, the None rows and the empty reports state", () => {
    expect(checkFirstOpen(rendered())).toEqual([]);
  });

  it("names each part that is missing or different", () => {
    expect(checkFirstOpen(rendered({ mounted: false }))).toContain(
      "the Research destination is not mounted",
    );
    expect(checkFirstOpen(rendered({ heading: "Reports" }))).toContain(
      "the heading is not Research",
    );
    const noButton = rendered().runNow;
    expect(checkFirstOpen(rendered({ runNow: { ...noButton, present: false } }))).toContain(
      "there is no Run now button",
    );
    expect(checkFirstOpen(rendered({ runNow: { ...noButton, disabled: true } }))).toContain(
      "Run now is disabled",
    );
    expect(
      checkFirstOpen(rendered({ subline: "Research sources · 6 sources configured" })),
    ).toContain("the subline is not the topic and the configured source count");
    const rows = rendered().runStatus.rows;
    expect(
      checkFirstOpen(
        rendered({
          runStatus: {
            ...rendered().runStatus,
            rows: [{ ...(rows[0] as StatusRow), value: "✓ Completed" }, rows[1] as StatusRow],
          },
        }),
      ),
    ).toContain("Last successful run does not read None yet");
    expect(
      checkFirstOpen(
        rendered({
          runStatus: {
            ...rendered().runStatus,
            rows: [rows[0] as StatusRow, { ...(rows[1] as StatusRow), value: "✕ Failed" }],
          },
        }),
      ),
    ).toContain("Last failed run does not read None");
    expect(
      checkFirstOpen(rendered({ list: { ...rendered().list, emptyHeading: null } })),
    ).toContain("the Reports list does not say No reports yet");
    expect(checkFirstOpen(rendered({ list: { ...rendered().list, emptyBody: "x" } }))).toContain(
      "the Reports empty text is not the first-run sentence",
    );
    expect(checkFirstOpen(rendered({ status: "Starting a research run…" }))).toContain(
      "the status line is not empty",
    );
  });
});

function note(name: string, text: string): NoteFile {
  return { name, path: `folder/${name}`, text };
}

function head(id: string, stage: string, extra = ""): string {
  return `---\nid: ${id}\nstage: ${stage}\ntype: x\n${extra}---\nbody\n`;
}

function runNoteText(
  runId: string,
  ids: { raw: string[]; wiki: string[]; report: string },
): string {
  const at = (n: number) => `2026-10-16T10:00:0${n}.000Z`;
  const codes = (list: readonly string[]) => list.map((id) => `\` ${id} \``).join(", ");
  return [
    "---",
    "id: runnote000000000000000001",
    "stage: output",
    "---",
    "> Run record. Written by the command center; editing it changes nothing.",
    "",
    `# Research run \` ${runId} \``,
    "",
    "- Outcome: Success",
    "- Trigger: Manual",
    `- Started: \` ${at(0)} \``,
    "",
    "## Stages",
    "",
    `1. \` capture \` at \` ${at(1)} \`: no notes`,
    `2. \` raw \` at \` ${at(2)} \`: notes ${codes(ids.raw)}`,
    `3. \` synthesis \` at \` ${at(3)} \`: no notes`,
    `4. \` wiki \` at \` ${at(4)} \`: notes ${codes(ids.wiki)}`,
    `5. \` deliverable \` at \` ${at(5)} \`: notes ${codes([ids.report])}`,
    `6. \` output \` at \` ${at(6)} \`: notes ${codes([ids.report])}`,
    "",
    "## Sources",
    "",
    "- Atom releases: contributed",
    "",
  ].join("\n");
}

function stageLog(ids: { raw: string[]; wiki: string[]; report: string }): string {
  const at = (n: number) => `2026-10-16T10:00:0${n}.000Z`;
  return JSON.stringify([
    { stage: "capture", at: at(1), noteIds: [] },
    { stage: "raw", at: at(2), noteIds: ids.raw },
    { stage: "synthesis", at: at(3), noteIds: [] },
    { stage: "wiki", at: at(4), noteIds: ids.wiki },
    { stage: "deliverable", at: at(5), noteIds: [ids.report] },
    { stage: "output", at: at(6), noteIds: [ids.report] },
  ]);
}

const RUN = "run00000000000000000000a1";
const IDS = {
  raw: ["rawid0000000000000000001", "rawid0000000000000000002"],
  wiki: ["wikiid000000000000000001", "wikiid000000000000000002"],
  report: "reportid00000000000000001",
};

function traceInput(over: Partial<TraceInput> = {}): TraceInput {
  return {
    jobRunId: RUN,
    notes: {
      output: [note("report.md", head(IDS.report, "output", `jobRunId: ${RUN}\n`))],
      raw: IDS.raw.map((id, index) => note(`raw${index}.md`, head(id, "raw"))),
      wiki: IDS.wiki.map((id, index) => note(`wiki${index}.md`, head(id, "wiki"))),
      runs: [note(`${RUN}.md`, runNoteText(RUN, IDS))],
    },
    job: {
      job_run_id: RUN,
      state: "completed",
      outcome: "success",
      error_code: null,
      source_count: 2,
      source_total: 2,
      run_trigger: "manual",
      stage_log: stageLog(IDS),
      report_note_id: IDS.report,
      started_at: "2026-10-16T10:00:00.000Z",
      ended_at: "2026-10-16T10:00:07.000Z",
    },
    runs: [{ run_id: RUN, kind: "automation", state: "completed" }],
    ...over,
  };
}

describe("checkRunRecords (07-UAT item 3)", () => {
  it("accepts a run whose run note, store log, notes and paired run agree", () => {
    expect(checkRunRecords(traceInput())).toEqual([]);
  });

  it("names a missing run note, a missing job run and a paired run that did not complete", () => {
    expect(checkRunRecords(traceInput({ notes: { ...traceInput().notes, runs: [] } }))).toContain(
      "there is no run note for the run",
    );
    expect(checkRunRecords(traceInput({ job: undefined }))).toContain(
      "the store has no job run for the run",
    );
    expect(
      checkRunRecords(traceInput({ runs: [{ run_id: RUN, kind: "automation", state: "stale" }] })),
    ).toContain("the paired run is stale, not completed");
    expect(checkRunRecords(traceInput({ runs: [] }))).toContain("the store has no paired run");
  });

  it("names an outcome that is not success, and a raw, wiki or report note in the wrong stage", () => {
    expect(
      checkRunRecords(
        traceInput({ job: { ...(traceInput().job as JobRunRow), outcome: "partial" } }),
      ),
    ).toContain("the store outcome is partial, not success");
    const wrongRaw = traceInput();
    wrongRaw.notes.raw[0] = note("raw0.md", head(IDS.raw[0] as string, "wiki"));
    expect(checkRunRecords(wrongRaw).join("\n")).toContain("raw/raw0.md is stage wiki, not raw");
    const wrongReport = traceInput();
    wrongReport.notes.output[0] = note(
      "report.md",
      head(IDS.report, "deliverable", `jobRunId: ${RUN}\n`),
    );
    expect(checkRunRecords(wrongReport).join("\n")).toContain(
      "output/report.md is stage deliverable, not output",
    );
  });

  it("names a run note that disagrees with the store's stage log", () => {
    const changed = traceInput({
      job: {
        ...(traceInput().job as JobRunRow),
        stage_log: stageLog({ ...IDS, wiki: [IDS.wiki[0] as string] }),
      },
    });
    expect(checkRunRecords(changed).join("\n")).toContain("differs from the run note");
  });

  it("names a report that is not the one the store names", () => {
    const other = traceInput({
      job: { ...(traceInput().job as JobRunRow), report_note_id: "other0000000000000000000x" },
    });
    expect(checkRunRecords(other)).toContain("the store's report is not the report of the run");
  });
});

const REF = {
  sourceType: "feed-entry",
  id: "2cd1d107d0d7a98d538dfa5c67e47d66",
  title: "Atom releases",
  canonicalUrl: "https://atom.example.invalid/releases.atom",
  author: "Release Bot",
  publishedAt: "2026-10-14T10:00:00.000Z",
  retrievedAt: "2026-10-16T10:59:56.662Z",
  contentHash: "3fa7d8a2bcd000ade3b91601f17b8892f85b3aab27bba327056f60434199afc5",
  snapshotPath: "global/raw/2cd1d107d0d7a98d538dfa5c67e47d66.3fa7d8a2.md",
  accessClass: "public",
};

function field(
  term: string,
  text: string,
  buttons: string[] = [],
  titles: string[] = [],
): RenderedField {
  return { term, text, buttons, titles };
}

function entry(over: Partial<RenderedSource> = {}): RenderedSource {
  return {
    number: 1,
    title: "Atom releases",
    backTo: null,
    fields: [
      field("Type", "Feed entry"),
      field("Access", "Public Fetched from a public web address."),
      field("Address", REF.canonicalUrl, ["Copy address"]),
      field("Author", "Release Bot"),
      field("Published", "Oct 14, 10:00 AM"),
      field("Retrieved", "Oct 16, 10:59 AM"),
      field("Content hash", REF.contentHash.slice(0, 12), [], [REF.contentHash]),
      field("Stable ID", REF.id),
      field("Snapshot", REF.snapshotPath, ["Open snapshot"]),
      field("Removed before summarising", "Nothing removed"),
    ],
    ...over,
  };
}

describe("checkSourceEntry (07-UAT item 4)", () => {
  it("accepts an entry that shows every reference field the report note carries", () => {
    expect(checkSourceEntry(entry(), REF)).toEqual([]);
  });

  it("accepts Not provided for an author the note records as null, and for no publication date", () => {
    const fields = entry().fields.map((f) =>
      f.term === "Author"
        ? { ...f, text: "Not provided" }
        : f.term === "Published"
          ? { ...f, text: "Not provided" }
          : f,
    );
    expect(
      checkSourceEntry(entry({ fields }), { ...REF, author: "null", publishedAt: "null" }),
    ).toEqual([]);
  });

  it("names a reordered or missing field", () => {
    const fields = entry().fields.filter((f) => f.term !== "Stable ID");
    expect(checkSourceEntry(entry({ fields }), REF)).toContain(
      "the fields are not the contracted ones in order",
    );
    const swapped = [...entry().fields];
    [swapped[0], swapped[1]] = [swapped[1] as RenderedField, swapped[0] as RenderedField];
    expect(checkSourceEntry(entry({ fields: swapped }), REF)).toContain(
      "the fields are not the contracted ones in order",
    );
  });

  it("names a wrong type, access, address, hash, id or snapshot, and missing actions", () => {
    const set = (term: string, patch: Partial<RenderedField>) =>
      entry({ fields: entry().fields.map((f) => (f.term === term ? { ...f, ...patch } : f)) });
    expect(checkSourceEntry(set("Type", { text: "Web page" }), REF)).toContain(
      "Type is Web page, not Feed entry",
    );
    expect(checkSourceEntry(set("Access", { text: "Private" }), REF)).toContain(
      "Access does not read Public with its explanation",
    );
    expect(
      checkSourceEntry(set("Address", { text: "https://other.example.invalid/" }), REF),
    ).toContain("Address is not the canonical address");
    expect(checkSourceEntry(set("Address", { buttons: [] }), REF)).toContain(
      "Address has no Copy address",
    );
    expect(checkSourceEntry(set("Content hash", { titles: [] }), REF)).toContain(
      "Content hash does not carry the full hash",
    );
    expect(checkSourceEntry(set("Content hash", { text: "000000000000" }), REF)).toContain(
      "Content hash does not start with the recorded hash",
    );
    expect(checkSourceEntry(set("Stable ID", { text: "other" }), REF)).toContain(
      "Stable ID is not the source id",
    );
    expect(checkSourceEntry(set("Snapshot", { buttons: [] }), REF)).toContain(
      "Snapshot has no Open snapshot",
    );
    expect(checkSourceEntry(set("Snapshot", { text: "global/raw/x.md" }), REF)).toContain(
      "Snapshot is not the snapshot path",
    );
    expect(checkSourceEntry(set("Removed before summarising", { text: "" }), REF)).toContain(
      "Removed before summarising says nothing",
    );
  });

  it("names an author the entry shows differently from the note", () => {
    const fields = entry().fields.map((f) => (f.term === "Author" ? { ...f, text: "Someone" } : f));
    expect(checkSourceEntry(entry({ fields }), REF)).toContain("Author is not the recorded author");
  });
});

function reader(over: Partial<RenderedReader> = {}): RenderedReader {
  return {
    loading: false,
    failureHeading: null,
    title: "Report",
    hasBackButton: false,
    meta: "",
    metaBadges: [],
    counts: "2 reported facts · 1 source claim · 0 model inferences",
    ai: "AI-generated summary by the extractive summariser (no model). Not verified by a person.",
    hasOpenNote: true,
    stale: null,
    unavailable: null,
    legend: [
      {
        kind: "source-fact",
        term: "≡ Reported fact",
        meaning: "A source states this, and the quoted words were found in that source.",
      },
      {
        kind: "unverified-claim",
        term: "“ Source claim",
        meaning: "A source says this. It was not checked against other sources.",
      },
      {
        kind: "inference",
        term: "∴ Model inference",
        meaning: "The summariser's own reading. No source states it directly.",
      },
    ],
    findings: [
      finding("source-fact", "≡ Reported fact", "Reported fact"),
      finding("source-fact", "≡ Reported fact", "Reported fact"),
      finding("unverified-claim", "“ Source claim", "Source claim"),
    ],
    sources: [],
    run: [],
    runBadges: [],
    hasOpenRunNote: true,
    headings: ["How to read this report", "Findings", "Sources", "Run record"],
    activeElements: 0,
    ...over,
  };
}

function finding(kind: string, tag: string, tagWord: string): RenderedFinding {
  return {
    kind,
    tag,
    tagWord,
    hiddenPrefix: "",
    text: "t",
    quote: null,
    quoteCaption: null,
    unverified: false,
    citations: [],
  };
}

const REPORT_KINDS: ParsedReportNote = {
  stage: "output",
  type: "report",
  jobRunId: RUN,
  partial: "false",
  sourceTotal: "3",
  itemKinds: ["source-fact", "source-fact", "unverified-claim"],
  sourceRefs: [],
  bodyLabels: { "source-fact": 3, "unverified-claim": 2, inference: 1 },
  countsLine: "3 findings: 2 reported facts, 1 source claim, 0 model inferences.",
  snapshotPaths: [],
};

describe("checkKindsView (07-UAT item 5)", () => {
  it("accepts a legend, kind tags and counts that match the note, ending in 0 model inferences", () => {
    expect(checkKindsView(reader(), REPORT_KINDS)).toEqual([]);
  });

  it("names a legend with the wrong label or meaning, and a missing kind", () => {
    const legend = reader().legend.map((entry, index) =>
      index === 1 ? { ...entry, term: "“ Claim" } : entry,
    );
    expect(checkKindsView(reader({ legend }), REPORT_KINDS)).toContain(
      "the legend line for unverified-claim is not the kind's label",
    );
    const meaning = reader().legend.map((entry, index) =>
      index === 0 ? { ...entry, meaning: "x" } : entry,
    );
    expect(checkKindsView(reader({ legend: meaning }), REPORT_KINDS)).toContain(
      "the legend meaning for source-fact is not the contracted one",
    );
    expect(checkKindsView(reader({ legend: reader().legend.slice(0, 2) }), REPORT_KINDS)).toContain(
      "the legend does not list all three kinds",
    );
  });

  it("names a finding tag that is not its kind's label, and a kind order that differs from the note", () => {
    const findings = reader().findings.map((f, index) =>
      index === 2 ? { ...f, tagWord: "Reported fact" } : f,
    );
    expect(checkKindsView(reader({ findings }), REPORT_KINDS)).toContain(
      "finding 3 shows the tag Reported fact, not Source claim",
    );
    const reordered = [
      reader().findings[2] as RenderedFinding,
      reader().findings[0] as RenderedFinding,
      reader().findings[1] as RenderedFinding,
    ];
    expect(checkKindsView(reader({ findings: reordered }), REPORT_KINDS)).toContain(
      "the findings' kinds differ from the note's items",
    );
  });

  it("names counts that are wrong, or that do not end in 0 model inferences", () => {
    expect(
      checkKindsView(
        reader({ counts: "1 reported fact · 1 source claim · 0 model inferences" }),
        REPORT_KINDS,
      ),
    ).toContain("the kind counts are not 2 reported facts · 1 source claim · 0 model inferences");
    const inferred: ParsedReportNote = {
      ...REPORT_KINDS,
      itemKinds: ["inference", "source-fact", "source-fact"],
    };
    const view = reader({
      findings: [
        finding("inference", "∴ Model inference", "Model inference"),
        finding("source-fact", "≡ Reported fact", "Reported fact"),
        finding("source-fact", "≡ Reported fact", "Reported fact"),
      ],
      counts: "2 reported facts · 0 source claims · 1 model inference",
    });
    expect(checkKindsView(view, inferred)).toContain(
      "the extractive summariser made a model inference",
    );
  });

  it("names the note body's labels when they do not match the view's findings", () => {
    expect(
      checkKindsView(reader(), {
        ...REPORT_KINDS,
        bodyLabels: { "source-fact": 1, "unverified-claim": 2, inference: 1 },
      }),
    ).toContain("the note body writes the Reported fact label 1 times, expected 3");
  });
});

describe("kindCountsPhrase", () => {
  it("writes singular and plural words and keeps zero segments", () => {
    expect(kindCountsPhrase({ "source-fact": 1, "unverified-claim": 0, inference: 2 })).toBe(
      "1 reported fact · 0 source claims · 2 model inferences",
    );
    expect(kindCountsPhrase({ "source-fact": 12, "unverified-claim": 12, inference: 0 })).toBe(
      "12 reported facts · 12 source claims · 0 model inferences",
    );
  });
});

describe("checkPartialView (07-UAT item 6)", () => {
  const partialRead = (): RenderedResearch =>
    rendered({
      status: "Research report ready with gaps: 1 of 3 sources were unavailable.",
      strip: {
        text: "",
        badges: [
          { kind: "cached", glyph: "◐", label: "Cached" },
          { kind: "partial", glyph: "◈", label: "Partial" },
        ],
      },
      runStatus: {
        ...rendered().runStatus,
        rows: [
          {
            label: "Last successful run",
            value: "✓ Completed · ◈ Partial · Oct 16, 11:00 AM · 2 of 3 sources",
            badges: [{ kind: "partial", glyph: "◈", label: "Partial" }],
            buttons: ["Open report"],
          },
          { label: "Last failed run", value: "None", badges: [], buttons: [] },
        ],
      },
      list: {
        ...rendered().list,
        emptyHeading: null,
        emptyBody: null,
        rows: [
          {
            title: "T",
            meta: "just now · ◐Cached · ◈Partial · 2 of 3 sources · 2 items",
            dateTime: "2026-10-16T11:00:00.000Z",
            badges: [
              { kind: "cached", glyph: "◐", label: "Cached" },
              { kind: "partial", glyph: "◈", label: "Partial" },
            ],
            selected: true,
            unreadable: false,
          },
        ],
      },
      reader: reader({
        metaBadges: [
          { kind: "cached", glyph: "◐", label: "Cached" },
          { kind: "partial", glyph: "◈", label: "Partial" },
        ],
        unavailable: {
          heading: "Unavailable sources",
          intro: "◈ Partial — 1 of 3 sources was unavailable, so this report covers only the rest.",
          entries: ["✕ Announcement page — Didn't respond in time"],
        },
        headings: [
          "Unavailable sources",
          "How to read this report",
          "Findings",
          "Sources",
          "Run record",
        ],
      }),
    });
  const EXPECT = {
    total: 3,
    unavailable: [{ label: "Announcement page", phrase: "Didn't respond in time" }],
  };

  it("accepts the status line, the Partial badges, the notice before the findings and the success row", () => {
    expect(checkPartialView(partialRead(), EXPECT)).toEqual([]);
  });

  it("names a wrong status line, a missing badge in the strip, the row or the reader, and a wrong success row", () => {
    expect(
      checkPartialView({ ...partialRead(), status: "Research report ready: T." }, EXPECT),
    ).toContain(
      "the status line is not Research report ready with gaps: 1 of 3 sources were unavailable.",
    );
    expect(
      checkPartialView({ ...partialRead(), strip: { text: "", badges: [] } }, EXPECT),
    ).toContain("the strip shows no Partial badge");
    const row = partialRead().list.rows[0] as RenderedRow;
    expect(
      checkPartialView(
        {
          ...partialRead(),
          list: {
            ...partialRead().list,
            rows: [{ ...row, badges: [row.badges[0] as RenderedBadge] }],
          },
        },
        EXPECT,
      ),
    ).toContain("the report row shows no Partial badge");
    const r = partialRead().reader as RenderedReader;
    expect(
      checkPartialView({ ...partialRead(), reader: { ...r, metaBadges: [] } }, EXPECT),
    ).toContain("the reader header shows no Partial badge");
    const rows = partialRead().runStatus.rows.map((x, i) =>
      i === 0 ? { ...x, value: "✓ Completed · Oct 16 · 3 sources" } : x,
    );
    expect(
      checkPartialView(
        { ...partialRead(), runStatus: { ...partialRead().runStatus, rows } },
        EXPECT,
      ).join("\n"),
    ).toContain("Last successful run");
  });

  it("names an unavailable notice that is missing, that lists the wrong source, or that comes after the findings", () => {
    const r = partialRead().reader as RenderedReader;
    expect(
      checkPartialView({ ...partialRead(), reader: { ...r, unavailable: null } }, EXPECT),
    ).toContain("the reader has no Unavailable sources notice");
    expect(
      checkPartialView(
        {
          ...partialRead(),
          reader: {
            ...r,
            unavailable: {
              ...(r.unavailable as NonNullable<RenderedReader["unavailable"]>),
              entries: ["✕ Other — Network error"],
            },
          },
        },
        EXPECT,
      ),
    ).toContain("the notice does not list ✕ Announcement page — Didn't respond in time");
    expect(
      checkPartialView(
        {
          ...partialRead(),
          reader: {
            ...r,
            headings: ["How to read this report", "Findings", "Unavailable sources"],
          },
        },
        EXPECT,
      ),
    ).toContain("the unavailable sources come after the findings");
  });
});

describe("checkFailedView (07-UAT item 7)", () => {
  const failedRead = (): RenderedResearch =>
    rendered({
      status: "Research run failed: no source could be fetched.",
      runStatus: {
        ...rendered().runStatus,
        rows: [
          { label: "Last successful run", value: "None yet", badges: [], buttons: [] },
          {
            label: "Last failed run",
            value:
              "✕ Failed · Oct 16, 11:00 AM — no source could be fetched Check your network connection, then press Run now.",
            badges: [],
            buttons: [],
          },
        ],
      },
    });

  it("accepts the failed line, the failed row with its reason and no report row", () => {
    expect(
      checkFailedView(failedRead(), { reason: "no source could be fetched", reports: 0 }),
    ).toEqual([]);
  });

  it("names a wrong status line, a failed row without the reason, and a report row that appeared", () => {
    expect(
      checkFailedView(
        { ...failedRead(), status: "Research run started." },
        { reason: "no source could be fetched", reports: 0 },
      ),
    ).toContain("the status line is not Research run failed: no source could be fetched.");
    const rows = failedRead().runStatus.rows.map((x, i) => (i === 1 ? { ...x, value: "None" } : x));
    expect(
      checkFailedView(
        { ...failedRead(), runStatus: { ...failedRead().runStatus, rows } },
        { reason: "no source could be fetched", reports: 0 },
      ),
    ).toContain("Last failed run does not show ✕ Failed with the reason");
    expect(
      checkFailedView(
        {
          ...failedRead(),
          list: {
            ...failedRead().list,
            rows: [
              {
                title: "T",
                meta: "",
                dateTime: null,
                badges: [],
                selected: false,
                unreadable: false,
              },
            ],
          },
        },
        { reason: "no source could be fetched", reports: 0 },
      ),
    ).toContain("the list shows 1 reports, expected 0");
  });
});

describe("checkUnconfiguredView (07-UAT items 8 and 22)", () => {
  const setupRead = (): RenderedResearch =>
    rendered({
      status: "Research run failed: the summariser isn't set up.",
      runStatus: {
        ...rendered().runStatus,
        setup: {
          heading: "The summariser isn't set up",
          body: "Research runs need an Anthropic API key in the macOS keychain. Store one with the research key setup script, then press Run now. macOS may ask once to allow keychain access.",
        },
        rows: [
          { label: "Last successful run", value: "None yet", badges: [], buttons: [] },
          {
            label: "Last failed run",
            value: "✕ Failed · Oct 16, 11:00 AM — the summariser isn't set up",
            badges: [],
            buttons: [],
          },
        ],
      },
    });

  it("accepts the failed line and the setup callout with its fixed heading and body", () => {
    expect(checkUnconfiguredView(setupRead())).toEqual([]);
  });

  it("names a missing callout, a different body and a different status line", () => {
    expect(
      checkUnconfiguredView({
        ...setupRead(),
        runStatus: { ...setupRead().runStatus, setup: null },
      }),
    ).toContain("there is no setup callout");
    const callout = setupRead().runStatus.setup as { heading: string; body: string };
    expect(
      checkUnconfiguredView({
        ...setupRead(),
        runStatus: { ...setupRead().runStatus, setup: { ...callout, body: "x" } },
      }),
    ).toContain("the setup callout body is not the fixed sentence");
    expect(
      checkUnconfiguredView({
        ...setupRead(),
        status: "Research run failed: no source could be fetched.",
      }),
    ).toContain("the status line is not Research run failed: the summariser isn't set up.");
  });
});

function rawNote(over: Partial<ParsedRawNote> = {}): ParsedRawNote {
  return {
    stage: "raw",
    type: "research-source",
    title: "Hostile source 3",
    snapshotPath: "global/raw/x.y.md",
    contentHash: "h",
    sanitise: { scripts: 1, styles: 0 },
    banner: BANNER,
    fenced: "plain text left after sanitising",
    outside: "",
    ...over,
  };
}

describe("checkHostileRaw (07-UAT item 9)", () => {
  const entry = { forbidden: ["<script", "evil()"], keeps: ["plain text"] };

  it("accepts sanitised text inside a fence under the banner with none of the forbidden strings", () => {
    expect(checkHostileRaw(rawNote(), entry)).toEqual([]);
  });

  it("names a missing banner, a missing fence, text outside the fence, and a forbidden or missing string", () => {
    expect(checkHostileRaw(rawNote({ banner: "hello" }), entry)).toContain(
      "the note does not open with the untrusted-content banner",
    );
    expect(checkHostileRaw(rawNote({ fenced: null }), entry)).toContain(
      "the note has no fenced text",
    );
    expect(checkHostileRaw(rawNote({ outside: "stray" }), entry)).toContain(
      "the note has text outside the fence",
    );
    expect(checkHostileRaw(rawNote({ fenced: "has <SCRIPT> inside" }), entry)).toContain(
      "the fenced text still holds <script",
    );
    expect(checkHostileRaw(rawNote({ fenced: "other words" }), entry)).toContain(
      "the fenced text lost plain text",
    );
    expect(checkHostileRaw(rawNote({ stage: "wiki" }), entry)).toContain(
      "the note is stage wiki, not raw",
    );
  });
});

describe("checkReadingFacts (07-UAT item 10)", () => {
  const facts = (over: Partial<ReadingViewFacts> = {}): ReadingViewFacts => ({
    found: true,
    images: 0,
    frames: 0,
    scripts: 0,
    embeds: 0,
    internalEmbeds: 0,
    anchors: [],
    codeBlocks: ["plain text left after sanitising"],
    text: "Untrusted source content plain text left after sanitising",
    ...over,
  });

  it("accepts a rendered body with nothing active whose code block holds the fenced text", () => {
    expect(
      checkReadingFacts(facts(), {
        fenced: "plain text left after sanitising",
        texts: ["plain text"],
      }),
    ).toEqual([]);
  });

  it("names every kind of active element, a changed code block and missing text", () => {
    const expected = { fenced: "plain text left after sanitising", texts: ["plain text"] };
    expect(checkReadingFacts(facts({ found: false }), expected)).toContain(
      "the note did not render in Reading view",
    );
    expect(checkReadingFacts(facts({ images: 1 }), expected)).toContain(
      "the rendered note loads 1 image(s)",
    );
    expect(checkReadingFacts(facts({ frames: 1 }), expected)).toContain(
      "the rendered note holds 1 frame(s)",
    );
    expect(checkReadingFacts(facts({ scripts: 2 }), expected)).toContain(
      "the rendered note holds 2 script(s)",
    );
    expect(checkReadingFacts(facts({ embeds: 1 }), expected)).toContain(
      "the rendered note holds 1 embed(s)",
    );
    expect(checkReadingFacts(facts({ internalEmbeds: 1 }), expected)).toContain(
      "the rendered note transcludes 1 note(s)",
    );
    expect(
      checkReadingFacts(
        facts({ anchors: [{ href: "https://x.example.invalid/", text: "x" }] }),
        expected,
      ),
    ).toContain("the rendered note holds 1 link(s)");
    expect(checkReadingFacts(facts({ codeBlocks: ["changed"] }), expected)).toContain(
      "no code block holds the fenced text",
    );
    expect(checkReadingFacts(facts({ text: "nothing" }), expected)).toContain(
      "the rendered text lacks: plain text",
    );
  });

  it("compares text with whitespace collapsed", () => {
    expect(
      checkReadingFacts(facts({ text: "plain\n   text here" }), { texts: ["plain text"] }),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Task 3: lifecycle, view and privacy items

function article(over: Partial<ArticleFacts> = {}): ArticleFacts {
  return {
    found: true,
    findingCount: 24,
    maxWidthPx: 612,
    measure68chPx: 612,
    articleWidthPx: 612,
    fontPx: 16,
    rootFontPx: 16,
    textLeadingPx: 25.6,
    textFontPx: 16,
    textWeight: "400",
    quoteLeadingPx: 25.6,
    itemGapPx: 24,
    spaceLgPx: 24,
    spaceXlPx: 32,
    headingMarginTopPx: [32, 32, 32],
    clamped: [],
    overflowX: 0,
    ...over,
  };
}

describe("checkArticleFacts (07-UAT items 15 and 23)", () => {
  it("accepts a reader at the 68ch measure with prose leading, the rhythm and nothing clamped", () => {
    expect(checkArticleFacts(article(), { findings: 24 })).toEqual([]);
  });

  it("accepts a reader narrower than the measure (a side pane)", () => {
    expect(checkArticleFacts(article({ articleWidthPx: 300 }), { findings: 24 })).toEqual([]);
  });

  it("names a missing report, a wrong finding count, a wrong cap and a column wider than the cap", () => {
    expect(checkArticleFacts(article({ found: false }), { findings: 24 })).toEqual([
      "the report did not render",
    ]);
    expect(checkArticleFacts(article({ findingCount: 20 }), { findings: 24 })).toContain(
      "the reader shows 20 findings, expected 24",
    );
    expect(checkArticleFacts(article({ maxWidthPx: 800 }), { findings: 24 })).toContain(
      "the reader's maximum width is not 68ch",
    );
    expect(checkArticleFacts(article({ articleWidthPx: 700 }), { findings: 24 })).toContain(
      "the prose column is wider than 68ch",
    );
  });

  it("names tight leading, a wrong size or weight, and a quote with tight leading", () => {
    expect(checkArticleFacts(article({ textLeadingPx: 20 }), { findings: 24 })).toContain(
      "the finding text does not have prose leading of 1.6",
    );
    expect(checkArticleFacts(article({ textFontPx: 14 }), { findings: 24 })).toContain(
      "the finding text is not body size",
    );
    expect(checkArticleFacts(article({ textWeight: "600" }), { findings: 24 })).toContain(
      "the finding text is not regular weight",
    );
    expect(checkArticleFacts(article({ quoteLeadingPx: 18 }), { findings: 24 })).toContain(
      "a quote does not have prose leading of 1.6",
    );
    expect(checkArticleFacts(article({ quoteLeadingPx: 0 }), { findings: 24 })).toEqual([]);
  });

  it("names spacing that is not the rhythm and headings that are not spaced", () => {
    expect(checkArticleFacts(article({ itemGapPx: 8 }), { findings: 24 })).toContain(
      "findings are not separated by the large spacing step",
    );
    expect(checkArticleFacts(article({ headingMarginTopPx: [32] }), { findings: 24 })).toContain(
      "fewer than two section headings were measured",
    );
    expect(
      checkArticleFacts(article({ headingMarginTopPx: [32, 4, 32] }), { findings: 24 }),
    ).toContain("a section heading is not spaced by the extra-large step");
  });

  it("names anything clamped and anything that runs past the edge", () => {
    expect(
      checkArticleFacts(article({ clamped: ["p.ccc-report-text"] }), { findings: 24 }),
    ).toContain("something is clamped or truncated: p.ccc-report-text");
    expect(checkArticleFacts(article({ overflowX: 12 }), { findings: 24 })).toContain(
      "something runs past the reader's edge",
    );
  });
});

function layout(over: Partial<ResearchLayoutFacts> = {}): ResearchLayoutFacts {
  return {
    found: true,
    mode: "side",
    readerOpen: "true",
    gridWidth: 1000,
    rootFontPx: 16,
    list: { display: "block", left: 0, right: 300, top: 100, width: 300 },
    reader: { display: "block", left: 316, right: 1000, top: 100, width: 684 },
    overflowRoot: 0,
    overflowGrid: 0,
    backToReportsVisible: false,
    ...over,
  };
}

function narrow(over: Partial<ResearchLayoutFacts> = {}): ResearchLayoutFacts {
  return layout({
    mode: "stacked",
    gridWidth: 320,
    list: { display: "none", left: 0, right: 0, top: 0, width: 0 },
    reader: { display: "block", left: 0, right: 320, top: 100, width: 320 },
    backToReportsVisible: true,
    ...over,
  });
}

describe("checkLayouts (07-UAT item 16)", () => {
  it("accepts the list beside the reader at full width and the reader replacing the list in a narrow pane", () => {
    expect(checkLayouts({ wide: layout(), narrow: narrow() })).toEqual([]);
  });

  it("names a full-width grid that is too narrow, stacked, or with the list not beside the reader", () => {
    expect(checkLayouts({ wide: layout({ gridWidth: 600 }), narrow: narrow() })).toContain(
      "full width: the grid is narrower than 48rem",
    );
    expect(checkLayouts({ wide: layout({ mode: "stacked" }), narrow: narrow() })).toContain(
      "full width: the layout is stacked",
    );
    expect(
      checkLayouts({
        wide: layout({ list: { display: "none", left: 0, right: 0, top: 0, width: 0 } }),
        narrow: narrow(),
      }),
    ).toContain("full width: the list is not shown");
    expect(
      checkLayouts({
        wide: layout({ list: { display: "block", left: 0, right: 500, top: 100, width: 500 } }),
        narrow: narrow(),
      }),
    ).toContain("full width: the list is not beside the reader");
  });

  it("names a narrow pane that keeps the list, lacks Back to reports, or is not stacked", () => {
    expect(
      checkLayouts({
        wide: layout(),
        narrow: narrow({ list: { display: "block", left: 0, right: 300, top: 0, width: 300 } }),
      }),
    ).toContain("narrow pane: the open report does not replace the list");
    expect(
      checkLayouts({ wide: layout(), narrow: narrow({ backToReportsVisible: false }) }),
    ).toContain("narrow pane: Back to reports is not shown");
    expect(checkLayouts({ wide: layout(), narrow: narrow({ mode: "side" }) })).toContain(
      "narrow pane: the layout is not stacked",
    );
  });

  it("names horizontal scrolling in either layout", () => {
    expect(checkLayouts({ wide: layout({ overflowGrid: 20 }), narrow: narrow() })).toContain(
      "full width: the destination scrolls sideways",
    );
    expect(checkLayouts({ wide: layout(), narrow: narrow({ overflowRoot: 5 }) })).toContain(
      "narrow pane: the destination scrolls sideways",
    );
  });

  it("names a layout that was not found", () => {
    expect(checkLayouts({ wide: layout({ found: false }), narrow: narrow() })).toContain(
      "full width: the Research layout was not found",
    );
  });
});

function focus(over: Partial<ResearchFocus> = {}): ResearchFocus {
  return {
    tag: "button",
    classes: "ccc-connect-button",
    name: "x",
    text: "x",
    sourceNumber: null,
    cite: null,
    inReader: false,
    inRow: false,
    focusVisible: true,
    outlineStyle: "solid",
    outlineWidth: "2px",
    boxShadow: "none",
    ...over,
  };
}

const GOOD_WALK: ResearchFocus[] = [
  focus({ name: "Run now: fetch the sources and write a research report" }),
  focus({ tag: "time", name: "1 minute ago" }),
  focus({ name: "Source" }),
  focus({ name: "Open report" }),
  focus({ name: "Show configured sources (12)" }),
  focus({ classes: "ccc-report-row-button", name: "Report row", inRow: true }),
  focus({ name: "Open note", inReader: true }),
  focus({ name: "Source 1: Anvil notes", cite: "1-1", inReader: true }),
  focus({ name: "Copy address", inReader: true }),
  focus({ name: "Open snapshot", inReader: true }),
  focus({ name: "Open run note", inReader: true }),
];

describe("checkTabOrder (07-UAT item 17)", () => {
  it("accepts Run now, the run status controls, the rows and the reader controls in that order, each with a ring", () => {
    expect(checkTabOrder(GOOD_WALK, { sourcesCount: 12 })).toEqual([]);
  });

  it("names a control the keyboard never reached", () => {
    expect(
      checkTabOrder(
        GOOD_WALK.filter((entry) => entry.name !== "Open snapshot"),
        { sourcesCount: 12 },
      ),
    ).toContain("focus never reached Open snapshot");
    expect(checkTabOrder(GOOD_WALK.slice(0, 5), { sourcesCount: 12 })).toContain(
      "focus never reached a report row",
    );
  });

  it("names controls reached in the wrong order", () => {
    const swapped = [...GOOD_WALK];
    [swapped[3], swapped[5]] = [swapped[5] as ResearchFocus, swapped[3] as ResearchFocus];
    expect(checkTabOrder(swapped, { sourcesCount: 12 })).toContain(
      "a report row came before Open report",
    );
  });

  it("leaves the scripted first focus out of the ring check when asked to", () => {
    const scripted = GOOD_WALK.map((entry, index) =>
      index === 0
        ? { ...entry, focusVisible: false, outlineStyle: "none", outlineWidth: "0px" }
        : entry,
    );
    expect(checkTabOrder(scripted, { sourcesCount: 12 })).toContain(
      "Run now: fetch the sources and write a research report shows no focus ring",
    );
    expect(checkTabOrder(scripted, { sourcesCount: 12, skipRingOnFirst: true })).toEqual([]);
  });

  it("names a button that shows no focus ring", () => {
    const ringless = GOOD_WALK.map((entry, index) =>
      index === 7
        ? { ...entry, focusVisible: false, outlineStyle: "none", outlineWidth: "0px" }
        : entry,
    );
    expect(checkTabOrder(ringless, { sourcesCount: 12 })).toContain(
      "Source 1: Anvil notes shows no focus ring",
    );
  });
});

describe("checkCitationRoundTrip and checkEscapeToRow (07-UAT item 17)", () => {
  const cite = focus({ name: "Source 1: Anvil notes", cite: "3-1", inReader: true });
  const heading = focus({
    tag: "h5",
    classes: "",
    name: "1. Anvil notes",
    sourceNumber: "1",
    inReader: true,
  });
  const back = focus({ name: "Back to finding 3", sourceNumber: "1", inReader: true });

  it("accepts a citation that moves focus to its source and Back to finding that returns it", () => {
    expect(checkCitationRoundTrip({ cite, source: heading, next: back, returned: cite })).toEqual(
      [],
    );
  });

  it("names a citation that leaves focus elsewhere, a missing way back and a return to the wrong place", () => {
    expect(checkCitationRoundTrip({ cite, source: null, next: back, returned: cite })).toContain(
      "the citation did not move focus to a source entry",
    );
    expect(
      checkCitationRoundTrip({
        cite,
        source: { ...heading, sourceNumber: "2" },
        next: back,
        returned: cite,
      }),
    ).toContain("focus moved to source 2, not source 1");
    expect(
      checkCitationRoundTrip({
        cite,
        source: heading,
        next: focus({ name: "Copy address" }),
        returned: cite,
      }),
    ).toContain("the way back to finding 3 is not the next stop");
    expect(
      checkCitationRoundTrip({
        cite,
        source: heading,
        next: back,
        returned: focus({ name: "Open note" }),
      }),
    ).toContain("Back to finding did not return focus to the citation");
  });

  it("accepts Escape that returns focus to the report row, and names focus left elsewhere", () => {
    expect(
      checkEscapeToRow({
        readerClosed: true,
        focus: focus({ classes: "ccc-report-row-button", inRow: true }),
      }),
    ).toEqual([]);
    expect(
      checkEscapeToRow({
        readerClosed: false,
        focus: focus({ classes: "ccc-report-row-button", inRow: true }),
      }),
    ).toContain("Escape did not close the reader");
    expect(checkEscapeToRow({ readerClosed: true, focus: focus({ name: "Open note" }) })).toContain(
      "focus did not return to the report row",
    );
    expect(checkEscapeToRow({ readerClosed: true, focus: null })).toContain(
      "focus did not return to the report row",
    );
  });
});

const MOTION_ON = { transitionDuration: "0.12s", animationDuration: "0s", animationName: "none" };
const MOTION_OFF = { transitionDuration: "0s", animationDuration: "0s", animationName: "none" };

describe("checkMotion (07-UAT item 18)", () => {
  const good = {
    baseline: [MOTION_ON, MOTION_OFF],
    baselineRoot: "full",
    reduced: [MOTION_OFF, MOTION_OFF],
    reducedRoot: "reduced",
    scrolls: [{ behavior: null }],
    scrollBehaviours: ["auto", "auto"],
  };

  it("accepts a full-motion baseline that moves, a reduced run that does not, and instant scrolling", () => {
    expect(checkMotion(good)).toEqual([]);
  });

  it("names a baseline that shows no motion, so the reduced run would prove nothing", () => {
    expect(checkMotion({ ...good, baseline: [MOTION_OFF] })).toContain(
      "the full-motion baseline shows no motion, so the reduced run proves nothing",
    );
  });

  it("names a root that is not reduced, motion that remains, and a smooth or missing scroll", () => {
    expect(checkMotion({ ...good, reducedRoot: "full" })).toContain(
      "the command center root is not in reduced motion",
    );
    expect(checkMotion({ ...good, reduced: [MOTION_ON] })).toContain(
      "something still moves under reduced motion",
    );
    expect(checkMotion({ ...good, scrolls: [] })).toContain(
      "following a citation scrolled nothing",
    );
    expect(checkMotion({ ...good, scrolls: [{ behavior: "smooth" }] })).toContain(
      "a scroll to a source was smooth",
    );
    expect(checkMotion({ ...good, scrollBehaviours: ["auto", "smooth"] })).toContain(
      "the reader sits inside a smooth-scrolling container",
    );
  });
});

describe("the disconnect drill verdicts (07-UAT items 12 and 14)", () => {
  const down = (): RenderedResearch =>
    rendered({
      dimmed: true,
      runNow: {
        present: true,
        label: "Run now",
        name: "Run now: fetch the sources and write a research report",
        disabled: true,
        busy: false,
        reason: "The companion service isn't running.",
      },
      strip: { text: "", badges: [{ kind: "unavailable", glyph: "○", label: "Unavailable" }] },
      list: {
        ...rendered().list,
        emptyHeading: null,
        emptyBody: null,
        rows: [
          { title: "T", meta: "", dateTime: null, badges: [], selected: true, unreadable: false },
        ],
      },
      reader: reader({ findings: [finding("source-fact", "≡ Reported fact", "Reported fact")] }),
    });

  it("accepts a dimmed destination with last-good content, Run now disabled with its reason and an Unavailable strip", () => {
    expect(checkDisconnectedView(down(), { rows: 1, findings: 1 })).toEqual([]);
  });

  it("names each part that is missing", () => {
    expect(checkDisconnectedView({ ...down(), dimmed: false }, { rows: 1, findings: 1 })).toContain(
      "the destination is not dimmed",
    );
    expect(
      checkDisconnectedView(
        { ...down(), runNow: { ...down().runNow, disabled: false } },
        { rows: 1, findings: 1 },
      ),
    ).toContain("Run now is not aria-disabled");
    expect(
      checkDisconnectedView(
        { ...down(), runNow: { ...down().runNow, reason: null } },
        { rows: 1, findings: 1 },
      ),
    ).toContain("Run now does not give the service-away reason");
    expect(
      checkDisconnectedView(
        { ...down(), strip: { text: "", badges: [] } },
        { rows: 1, findings: 1 },
      ),
    ).toContain("the strip does not show Unavailable");
    expect(checkDisconnectedView({ ...down(), reader: null }, { rows: 1, findings: 1 })).toContain(
      "the open report is gone",
    );
    expect(checkDisconnectedView(down(), { rows: 2, findings: 1 })).toContain(
      "the list shows 1 rows, expected 2",
    );
  });

  it("accepts a reconnected destination and names one still dimmed or still disabled", () => {
    expect(checkReconnectedView(rendered())).toEqual([]);
    expect(checkReconnectedView(down())).toEqual([
      "the destination is still dimmed",
      "Run now is still disabled",
    ]);
  });

  it("reads the Unknown run row", () => {
    const row = {
      label: "Unknown run",
      value:
        "? Unknown — ended without reporting · Oct 16, 11:00 AM · The app stopped during this run, so its result is unknown.",
      badges: [],
      buttons: [],
    };
    const withRow = rendered({
      runStatus: { ...rendered().runStatus, rows: [...rendered().runStatus.rows, row] },
    });
    expect(checkUnknownRun(withRow)).toEqual([]);
    expect(checkUnknownRun(rendered())).toContain("there is no Unknown run row");
    expect(
      checkUnknownRun(
        rendered({ runStatus: { ...rendered().runStatus, rows: [{ ...row, value: "✕ Failed" }] } }),
      ),
    ).toContain("the Unknown run row does not read ? Unknown — ended without reporting");
  });
});

describe("checkReuse (07-UAT item 13)", () => {
  const snap = (raw: string[], wiki: Array<[string, string, string]>) => ({
    raw,
    wiki: wiki.map(([name, id, retrievedAt]) => ({ name, id, retrievedAt })),
  });
  const first = snap(
    ["a.1.md", "b.2.md", "c.3.md"],
    [
      ["a.md", "id-a", "t1"],
      ["b.md", "id-b", "t1"],
      ["c.md", "id-c", "t1"],
    ],
  );
  const second = snap(
    ["a.1.md", "b.2.md", "c.3.md"],
    [
      ["a.md", "id-a", "t2"],
      ["b.md", "id-b", "t2"],
      ["c.md", "id-c", "t2"],
    ],
  );
  const third = snap(
    ["a.1.md", "b.2.md", "c.3.md", "a.4.md"],
    [
      ["a.md", "id-a", "t3"],
      ["b.md", "id-b", "t3"],
      ["c.md", "id-c", "t3"],
    ],
  );

  it("accepts an unchanged rerun that adds no raw file, rewrites wiki notes in place, and a changed source that adds one", () => {
    expect(checkReuse({ first, second, third })).toEqual([]);
  });

  it("names a raw file added by an unchanged rerun, and wiki notes that were recreated or not rewritten", () => {
    expect(
      checkReuse({
        first,
        second: snap(
          [...second.raw, "d.9.md"],
          second.wiki.map((w) => [w.name, w.id, w.retrievedAt]),
        ),
        third,
      }),
    ).toContain("the unchanged rerun added a raw file");
    expect(
      checkReuse({
        first,
        second: snap(second.raw, [
          ["a.md", "new-id", "t2"],
          ["b.md", "id-b", "t2"],
          ["c.md", "id-c", "t2"],
        ]),
        third,
      }),
    ).toContain("a wiki note changed its id on the unchanged rerun");
    expect(
      checkReuse({
        first,
        second: snap(second.raw, [
          ["a.md", "id-a", "t1"],
          ["b.md", "id-b", "t2"],
          ["c.md", "id-c", "t2"],
        ]),
        third,
      }),
    ).toContain("a wiki note was not rewritten on the unchanged rerun");
  });

  it("names a changed source that did not add exactly one raw file or dropped an old one", () => {
    expect(checkReuse({ first, second, third: second })).toContain(
      "the changed source did not add exactly one raw file",
    );
    expect(
      checkReuse({
        first,
        second,
        third: snap(
          ["a.1.md", "b.2.md", "x.9.md", "y.8.md"],
          third.wiki.map((w) => [w.name, w.id, w.retrievedAt]),
        ),
      }),
    ).toContain("an earlier raw file disappeared");
  });
});

type Card = { title: string; presentation: string | null; heading: string; body: string };

describe("checkOverviewCards (07-UAT item 20)", () => {
  const cards = [
    {
      title: "Today",
      presentation: "permission-required",
      heading: "Google Calendar and Gmail isn't connected",
      body: "Connect Google Calendar and Gmail to see today here.",
    },
    {
      title: "Technology and market intelligence",
      presentation: "unavailable",
      heading: "No source yet",
      body: "",
    },
  ];

  it("accepts the Today card as the permission-required card and tech-intel as unavailable", () => {
    expect(checkOverviewCards(cards)).toEqual([]);
  });

  it("names a Today card that became ready, a missing card and a tech-intel card with data", () => {
    expect(
      checkOverviewCards([{ ...(cards[0] as Card), presentation: "ready" }, cards[1] as Card]),
    ).toContain("the Today card is ready, not permission-required");
    expect(checkOverviewCards([cards[1] as Card])).toContain("there is no Today card");
    expect(checkOverviewCards([cards[0] as Card])).toContain(
      "there is no technology and market intelligence card",
    );
    expect(
      checkOverviewCards([cards[0] as Card, { ...(cards[1] as Card), presentation: "ready" }]),
    ).toContain("the technology and market intelligence card is ready, not unavailable");
    expect(
      checkOverviewCards([{ ...(cards[0] as Card), heading: "Something else" }, cards[1] as Card]),
    ).toContain("the Today card does not name Google Calendar and Gmail");
  });
});

describe("checkLogPrivacy (07-UAT item 21)", () => {
  const markers = ["alpha parser is now twice as fast", "uatq-7f3a91c2"];

  it("accepts logs and a data file with only codes, ids and counts", () => {
    expect(
      checkLogPrivacy(
        [
          {
            label: "the service log",
            text: '{"event":"research-stuck-runs-recovered","count":1}\n',
          },
        ],
        markers,
      ),
    ).toEqual([]);
  });

  it("names source text, an address with a query, a key-shaped string and a remote error", () => {
    expect(
      checkLogPrivacy([{ label: "log", text: "the alpha parser is now twice as fast" }], markers),
    ).toContain("log holds source text (alpha parser is now twice as fast)");
    expect(
      checkLogPrivacy([{ label: "log", text: "GET https://x.example.invalid/f?a=1&b=2" }], markers),
    ).toContain("log holds an address with a query string");
    expect(
      checkLogPrivacy(
        [{ label: "data", text: '{"k":"sk-ant-api03-abcdefghijklmnopqrstuvwx"}' }],
        markers,
      ),
    ).toContain("data holds a key-shaped string");
    expect(
      checkLogPrivacy([{ label: "log", text: "connect ECONNREFUSED 127.0.0.1:443" }], markers),
    ).toContain("log holds remote error text");
    expect(
      checkLogPrivacy([{ label: "log", text: "https://x.example.invalid/feed" }], markers),
    ).toContain("log holds an address");
  });

  it("refuses an empty log, which would prove nothing", () => {
    expect(checkLogPrivacy([{ label: "the service log", text: "" }], markers)).toContain(
      "the service log is empty, so there is nothing to check",
    );
  });
});

describe("checkNoWorkBeforeFailure (07-UAT items 8 and 22, T-07-45)", () => {
  const CLEAN = {
    stages: [],
    rawNotes: 0,
    wikiNotes: 0,
    reportNotes: 0,
    sourceRecords: 0,
    reportRecords: 0,
  };

  it("accepts a run that left nothing behind, with or without the capture stage", () => {
    expect(checkNoWorkBeforeFailure(CLEAN)).toEqual([]);
    expect(checkNoWorkBeforeFailure({ ...CLEAN, stages: ["capture"] })).toEqual([]);
  });

  it("names each kind of work a failed run must not have done", () => {
    expect(checkNoWorkBeforeFailure({ ...CLEAN, stages: ["capture", "raw"] })).toEqual([
      "the stage log went past the capture stage (raw)",
    ]);
    expect(checkNoWorkBeforeFailure({ ...CLEAN, rawNotes: 1 })).toEqual([
      "the run wrote raw source notes",
    ]);
    expect(checkNoWorkBeforeFailure({ ...CLEAN, wikiNotes: 1 })).toEqual([
      "the run wrote wiki notes",
    ]);
    expect(checkNoWorkBeforeFailure({ ...CLEAN, reportNotes: 1 })).toEqual([
      "the run wrote a report",
    ]);
    expect(checkNoWorkBeforeFailure({ ...CLEAN, sourceRecords: 3 })).toEqual([
      "the store holds source records for the run",
    ]);
    expect(checkNoWorkBeforeFailure({ ...CLEAN, reportRecords: 1 })).toEqual([
      "the store holds a report record for the run",
    ]);
  });
});
