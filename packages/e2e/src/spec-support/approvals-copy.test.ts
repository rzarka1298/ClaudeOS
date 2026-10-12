import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { APPROVALS_COPY, findDrift, type MirrorEntry, mirroredEntries } from "./approvals-copy.js";

/**
 * Copy drift (05.2-06, T-05.2-24): every literal the approvals specs assert is mirrored in
 * approvals-copy.ts with the plugin source file that owns it; this test reads those source
 * files as text and proves each literal still appears there. The e2e package never imports
 * plugin code, so the plugin text is read from disk.
 */

const PLUGIN_SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "plugin", "src");
const readPluginSource = (source: string): string => readFileSync(join(PLUGIN_SRC, source), "utf8");

describe("approvals copy mirror (Test 1)", () => {
  it("holds the task 1 literals exactly as the plugin words them", () => {
    expect(APPROVALS_COPY.sectionHeading).toBe("Approvals");
    expect(APPROVALS_COPY.denyLabel).toBe("Deny");
    expect(APPROVALS_COPY.approveLabel).toBe("Approve once");
    expect(APPROVALS_COPY.statusApproved).toBe("Approved. Carrying out the action…");
    expect(APPROVALS_COPY.statusDenied).toBe("Denied. Nothing was changed.");
    expect(APPROVALS_COPY.statusCarriedOut).toBe("Carried out.");
    expect(APPROVALS_COPY.statusExpiredClosed).toBe(
      "This request expired and was denied automatically. Nothing was changed.",
    );
    expect(APPROVALS_COPY.serviceDown).toBe("The companion service isn't running.");
    expect(APPROVALS_COPY.noRisks).toBe("None listed.");
    expect([
      APPROVALS_COPY.filterPending,
      APPROVALS_COPY.filterDecided,
      APPROVALS_COPY.filterExpired,
    ]).toEqual(["Pending", "Decided", "Expired"]);
    expect([
      APPROVALS_COPY.historyRequested,
      APPROVALS_COPY.historyApproved,
      APPROVALS_COPY.historyDenied,
      APPROVALS_COPY.historyStarted,
      APPROVALS_COPY.historyExecuted,
    ]).toEqual(["Requested", "Approved", "Denied", "Started carrying out", "Carried out"]);
    expect(APPROVALS_COPY.fingerprintTerm).toBe("Content fingerprint");
    expect(APPROVALS_COPY.requestIdTerm).toBe("Request ID");
    expect(APPROVALS_COPY.decidedThroughPlugin).toBe("The command center");
  });

  it("registers every literal with the plugin source file that owns it", () => {
    const entries = mirroredEntries();
    expect(entries.length).toBeGreaterThanOrEqual(25);
    for (const entry of entries) {
      expect(entry.text.length).toBeGreaterThan(0);
      expect(entry.source).toMatch(/^[a-z-]+\/[a-z-]+(\.[a-z]+)*\.tsx?$|^[a-z-]+\.ts$/);
    }
  });

  it("finds every mirrored literal verbatim in its plugin source file", () => {
    expect(findDrift(mirroredEntries(), readPluginSource)).toEqual([]);
  });

  it("fails when a mirrored literal no longer appears in its source (drift is caught)", () => {
    const altered: MirrorEntry[] = [
      ...mirroredEntries(),
      { key: "altered", source: "view/approvals-copy.ts", text: "Denied. Nothing was changes." },
    ];
    expect(findDrift(altered, readPluginSource).map((entry) => entry.key)).toEqual(["altered"]);
  });

  it("reports a missing source file as drift rather than throwing", () => {
    const missing: MirrorEntry[] = [
      { key: "gone", source: "view/no-such-file.ts", text: "Approvals" },
    ];
    const read = (source: string): string => {
      if (source === "view/no-such-file.ts") throw new Error("ENOENT");
      return readPluginSource(source);
    };
    expect(findDrift(missing, read).map((entry) => entry.key)).toEqual(["gone"]);
  });
});
