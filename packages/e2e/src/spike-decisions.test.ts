import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  PROVISIONAL_SPIKE_DECISIONS,
  SPIKE_DECISIONS,
  type SpikeDecisions,
} from "./spike-decisions.js";

const researchUrl = new URL(
  "../../../.planning/phases/05.2-automated-live-uat-runner/05.2-RESEARCH.md",
  import.meta.url,
);
const researchPresent = existsSync(researchUrl);

/** Parses the fenced key: value block that follows the 'Spike decisions' heading. */
function parseDecisionBlock(markdown: string): Record<string, string> {
  const heading = /^#{2,3} Spike decisions\s*$/m.exec(markdown);
  if (!heading) throw new Error("05.2-RESEARCH.md has no 'Spike decisions' heading");
  const after = markdown.slice(heading.index + heading[0].length);
  const fence = /```[a-z]*\n([\s\S]*?)```/.exec(after);
  if (!fence?.[1]) throw new Error("the 'Spike decisions' heading has no fenced block");
  const entries: Record<string, string> = {};
  for (const line of fence[1].split("\n")) {
    const match = /^([A-Za-z][A-Za-z0-9]*):\s*(\S.*?)\s*$/.exec(line);
    if (match?.[1] && match[2] !== undefined) entries[match[1]] = match[2];
  }
  return entries;
}

const asRecord = (value: SpikeDecisions): Record<string, unknown> => ({ ...value });

describe("spike decisions (D-08, D-15, Q-B)", () => {
  it("holds exactly the CONTEXT defaults while provisional", () => {
    expect(PROVISIONAL_SPIKE_DECISIONS).toEqual({
      launch: "binaryPath",
      appVersion: "1.14.4",
      installerVersion: "1.13.7",
      bannerAutomation: "spy-and-region",
      protocolDispatch: "in-process",
      reducedMotion: "emulated",
      focusActivation: "activate-window",
      specLoading: "bundled",
      coexistence: "unverified",
      obsidianCacheSha256: null,
      status: "provisional",
    });
    if (SPIKE_DECISIONS.status === "provisional") {
      expect(SPIKE_DECISIONS).toEqual(PROVISIONAL_SPIKE_DECISIONS);
    }
  });

  it("has a legal status and, once recorded, no unknown or unverified field", () => {
    expect(["provisional", "recorded"]).toContain(SPIKE_DECISIONS.status);
    if (SPIKE_DECISIONS.status === "recorded") {
      for (const [key, value] of Object.entries(asRecord(SPIKE_DECISIONS))) {
        expect(value, key).not.toBe("unknown");
      }
      expect(SPIKE_DECISIONS.coexistence).toBe("verified");
    }
  });

  it("keeps the constants in the closed union shape", () => {
    expect(["binaryPath", "installer"]).toContain(SPIKE_DECISIONS.launch);
    expect(["spy-and-region", "spy-only"]).toContain(SPIKE_DECISIONS.bannerAutomation);
    expect(["in-process", "onclick-only"]).toContain(SPIKE_DECISIONS.protocolDispatch);
    expect(["emulated", "setting-only"]).toContain(SPIKE_DECISIONS.reducedMotion);
    expect(["activate-window", "none"]).toContain(SPIKE_DECISIONS.focusActivation);
    expect(["bundled", "compiled"]).toContain(SPIKE_DECISIONS.specLoading);
    expect(["verified", "unverified"]).toContain(SPIKE_DECISIONS.coexistence);
    expect(SPIKE_DECISIONS.appVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(SPIKE_DECISIONS.installerVersion).toMatch(/^\d+\.\d+\.\d+$/);
    if (SPIKE_DECISIONS.obsidianCacheSha256 !== null) {
      expect(SPIKE_DECISIONS.obsidianCacheSha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  // The planning tree is absent from a public clone; the parity check applies when it exists.
  it.skipIf(!researchPresent)(
    "equals the 'Spike decisions' block in 05.2-RESEARCH.md field by field",
    () => {
      const block = parseDecisionBlock(readFileSync(researchUrl, "utf8"));
      const code = asRecord(SPIKE_DECISIONS);
      expect(Object.keys(block).sort()).toEqual(Object.keys(code).sort());
      for (const [key, value] of Object.entries(code)) {
        expect(block[key], key).toBe(value === null ? "null" : String(value));
      }
      expect(["provisional", "recorded"]).toContain(block.status);
      if (block.status === "recorded") {
        for (const [key, value] of Object.entries(block)) {
          expect(value, key).not.toBe("unknown");
        }
      }
    },
  );
});
