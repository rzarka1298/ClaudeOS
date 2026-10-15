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
