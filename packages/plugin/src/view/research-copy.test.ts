import { RUN_ERROR_CODES } from "@ccc/domain/research.js";
import { describe, expect, it } from "vitest";
import * as copy from "./research-copy.js";

describe("Test 5: the failure-reason table (UI-SPEC run failure reasons)", () => {
  const EXPECTED: Readonly<Record<string, { reason: string | null; nextStep: string }>> = {
    "summariser-unconfigured": {
      reason: "the summariser isn't set up",
      nextStep:
        "Store an Anthropic API key in the macOS keychain with the research key setup script, then press Run now.",
    },
    "summariser-failed": {
      reason: "the summariser didn't return a complete answer",
      nextStep: "Press Run now to try again. Nothing was added to the report list.",
    },
    "summariser-refused": {
      reason: "the summariser declined to summarise these sources",
      nextStep: "Press Run now to try again later. If it keeps happening, check the source list.",
    },
    "summariser-invalid-output": {
      reason: "the summariser's answer wasn't in the expected form",
      nextStep: "Press Run now to try again. Nothing was added to the report list.",
    },
    "all-sources-failed": {
      reason: "no source could be fetched",
      nextStep: "Check your network connection, then press Run now.",
    },
    "vault-write-failed": {
      reason: "the report couldn't be written to the vault",
      nextStep: "Check the vault in Settings → Diagnostics, then press Run now.",
    },
    interrupted: {
      reason: null,
      nextStep:
        "The app stopped during this run, so its result is unknown. Press Run now for a new run.",
    },
  };

  it("covers every closed run error code, and no other", () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...RUN_ERROR_CODES].sort());
  });

  it.each(RUN_ERROR_CODES)("maps %s to its reason and next step", (code) => {
    expect(copy.failureCopy(code)).toEqual(EXPECTED[code]);
  });

  it("maps an unknown code to the forward-compatible default", () => {
    expect(copy.failureCopy("a-code-from-the-future")).toEqual({
      reason: "something went wrong",
      nextStep: "Check the service in Settings → Diagnostics.",
    });
  });

  it("never treats interrupted as a failure", () => {
    expect(copy.isFailureCode("interrupted")).toBe(false);
    expect(copy.isFailureCode("summariser-failed")).toBe(true);
    expect(copy.isFailureCode("a-code-from-the-future")).toBe(true);
  });

  it("builds the failed sentence from the reason and nothing else", () => {
    expect(copy.runFailedLine("summariser-unconfigured")).toBe(
      "Research run failed: the summariser isn't set up.",
    );
    expect(copy.runFailedLine("a-code-from-the-future")).toBe(
      "Research run failed: something went wrong.",
    );
  });

  it("gives every start failure a fixed sentence with no path, key or remote text", () => {
    for (const code of [
      "service-disconnected",
      "vault-not-set-up",
      "invalid-body",
      "unrecognised-response",
    ] as const) {
      const line = copy.startFailedLine(code);
      expect(line).toMatch(/^Couldn't start the run/);
      expect(line).not.toMatch(/[\\/]\w|https?:|api key/i);
    }
    expect(copy.startFailedLine("service-disconnected")).toBe(
      "Couldn't start the run: the companion service isn't running.",
    );
  });

  it("locks the strings the tests of this phase assert verbatim", () => {
    expect(copy.RUN_STATUS_HEADING).toBe("Run status");
    expect(copy.CURRENT_RUN_LABEL).toBe("Current run");
    expect(copy.LAST_SUCCESS_LABEL).toBe("Last successful run");
    expect(copy.LAST_FAILURE_LABEL).toBe("Last failed run");
    expect(copy.UNKNOWN_RUN_LABEL).toBe("Unknown run");
    expect(copy.NONE_YET).toBe("None yet");
    expect(copy.NONE).toBe("None");
    expect(copy.SETUP_HEADING).toBe("The summariser isn't set up");
    expect(copy.OPEN_REPORT_LABEL).toBe("Open report");
  });

  it("uses no slash-separated numeric date anywhere and no emoji presentation", () => {
    const strings: string[] = [];
    for (const value of Object.values(copy)) {
      if (typeof value === "string") strings.push(value);
      else if (typeof value === "object" && value !== null) {
        strings.push(...Object.values(value as Record<string, string>));
      }
    }
    strings.push(copy.reportReadyLine("T"), copy.reportReadyWithGapsLine(1, 3));
    expect(strings.length).toBeGreaterThan(30);
    for (const text of strings) {
      expect(text, text).not.toMatch(/\d{1,4}\/\d{1,2}\/\d{1,4}/);
      expect(text, text).not.toMatch(/\p{Emoji_Presentation}/u);
    }
  });
});

describe("Task 2: the reader strings (UI-SPEC R4, locked strings asserted verbatim)", () => {
  it("holds the locked section headings", () => {
    expect(copy.READER_LEGEND_HEADING).toBe("How to read this report");
    expect(copy.READER_FINDINGS_HEADING).toBe("Findings");
    expect(copy.READER_UNAVAILABLE_HEADING).toBe("Unavailable sources");
    expect(copy.READER_SOURCES_HEADING).toBe("Sources");
    expect(copy.READER_RUN_HEADING).toBe("Run record");
  });

  it("holds the locked source-entry strings", () => {
    expect(copy.REMOVED_BEFORE_SUMMARISING).toBe("Removed before summarising");
    expect(copy.NOTHING_REMOVED).toBe("Nothing removed");
    expect(copy.NOT_PROVIDED).toBe("Not provided");
    expect(copy.COPY_ADDRESS_LABEL).toBe("Copy address");
    expect(copy.OPEN_SNAPSHOT_LABEL).toBe("Open snapshot");
    expect(copy.ADDRESS_COPIED).toBe("Address copied.");
    expect(copy.ADDRESS_COPY_FAILED).toBe("Couldn't copy the address.");
  });

  it("holds the reader's button labels and state copy", () => {
    expect(copy.BACK_TO_REPORTS_LABEL).toBe("Back to reports");
    expect(copy.OPEN_RUN_NOTE_LABEL).toBe("Open run note");
    expect(copy.OPEN_RUN_NOTE_FAILED).toBe("Couldn't open the run note.");
    expect(copy.TRY_AGAIN_LABEL).toBe("Try again");
    expect(copy.LOAD_REST_LABEL).toBe("Load the rest of the report");
    expect(copy.LOAD_REST_ERROR).toBe("Couldn't load the rest of this report.");
    expect(copy.READER_LOADING).toBe("Loading report");
    expect(copy.READER_ERROR).toBe("Couldn't load this report.");
    expect(copy.NOT_FOUND_HEADING).toBe("That report isn't in the vault any more.");
    expect(copy.NOT_FOUND_BODY).toBe(
      "It may have been moved or deleted. The list has been refreshed.",
    );
    expect(copy.UNREADABLE_HEADING).toBe("This report's metadata couldn't be read.");
    expect(copy.UNREADABLE_BODY).toBe(
      "It may have been edited by hand. Open the note to check it.",
    );
    expect(copy.NO_FINDINGS).toBe(
      "This report has no findings. Nothing in the summariser's answer could be kept.",
    );
    expect(copy.SECTION_NOT_LOADED_OFFLINE).toBe(
      "This section couldn't be loaded while the companion service isn't running.",
    );
    expect(copy.SOURCE_NOT_LOADED).toBe("That source isn't loaded yet.");
    expect(copy.TRUNCATED_ITEMS).toBe(
      "Some items were too long to show here. Open the note to read them in full.",
    );
  });

  it("builds the AI line, with or without a model", () => {
    expect(copy.EXTRACTIVE_SUMMARISER_TEXT).toBe("the extractive summariser (no model)");
    expect(copy.AI_LINE_LEAD).toBe("AI-generated summary by ");
    expect(copy.AI_LINE_TAIL).toBe(". Not verified by a person.");
  });

  it("builds the stale line from the hours", () => {
    expect(copy.staleLine(36)).toBe(
      "This report is more than 36 hours old. Press Run now for a fresh one.",
    );
  });

  it("pluralises the partial intro", () => {
    expect(copy.partialIntro(2, 6)).toBe(
      "Partial — 2 of 6 sources were unavailable, so this report covers only the rest.",
    );
    expect(copy.partialIntro(1, 3)).toBe(
      "Partial — 1 of 3 sources was unavailable, so this report covers only the rest.",
    );
  });

  it("writes the kind counts with plurals and keeps zero segments", () => {
    expect(copy.kindCountsText({ "source-fact": 1, "unverified-claim": 2, inference: 0 })).toBe(
      "1 reported fact · 2 source claims · 0 model inferences",
    );
    expect(copy.kindCountsText({ "source-fact": 0, "unverified-claim": 1, inference: 1 })).toBe(
      "0 reported facts · 1 source claim · 1 model inference",
    );
  });

  it("writes the removed counts as a sentence in a fixed order, omitting zero counts", () => {
    const zero = {
      scripts: 0,
      styles: 0,
      comments: 0,
      hiddenBlocks: 0,
      mediaDropped: 0,
      linksDropped: 0,
      controlChars: 0,
      commandLikeLines: 0,
    };
    expect(copy.removedSentence(zero)).toBe("Nothing removed");
    expect(
      copy.removedSentence({
        ...zero,
        scripts: 2,
        hiddenBlocks: 1,
        linksDropped: 3,
        commandLikeLines: 1,
      }),
    ).toBe("2 scripts, 1 hidden block, 3 links, 1 command-like line");
    expect(
      copy.removedSentence({
        scripts: 1,
        styles: 2,
        comments: 3,
        hiddenBlocks: 4,
        mediaDropped: 5,
        linksDropped: 6,
        controlChars: 7,
        commandLikeLines: 8,
      }),
    ).toBe(
      "1 script, 2 style blocks, 3 comments, 4 hidden blocks, 5 media items, 6 links, 7 control characters, 8 command-like lines",
    );
  });
});
