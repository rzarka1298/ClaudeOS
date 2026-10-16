import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RESEARCH_JOB_ID } from "@ccc/domain";
import { listJobRuns } from "@ccc/operational-store";
import * as research from "@ccc/research";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkDelimited } from "./pipeline.js";
import { createKit, type Kit } from "./test-support/research-kit.js";

// The pipeline composes the delimited text with `delimitSourcesWithReport`. The mock wraps the
// real function and can be told to answer with a composition that does not match the fetched
// ids, which a correct delimiter never produces: the pipeline must catch it by itself.
vi.mock("@ccc/research", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ccc/research")>();
  return { ...actual, delimitSourcesWithReport: vi.fn(actual.delimitSourcesWithReport) };
});

const ID_A = "a".repeat(32);
const ID_B = "b".repeat(32);
const ID_C = "c".repeat(32);
const NONCE = "0123456789abcdef0123456789abcdef";

const block = (id: string, text = "text"): string =>
  `<<<SRC id=${id} nonce=${NONCE}>>>\n${text}\n<<<END nonce=${NONCE}>>>`;

describe("checkDelimited: exactly one block per fetched source id, in order", () => {
  it("accepts the matching composition", () => {
    expect(checkDelimited([block(ID_A), block(ID_B)].join("\n"), [ID_A, ID_B])).toBe(true);
  });

  it("refuses a missing block, an extra block, a reordered id and a duplicated block", () => {
    expect(checkDelimited(block(ID_A), [ID_A, ID_B])).toBe(false);
    expect(checkDelimited([block(ID_A), block(ID_B), block(ID_C)].join("\n"), [ID_A, ID_B])).toBe(
      false,
    );
    expect(checkDelimited([block(ID_B), block(ID_A)].join("\n"), [ID_A, ID_B])).toBe(false);
    expect(checkDelimited([block(ID_A), block(ID_A)].join("\n"), [ID_A, ID_B])).toBe(false);
    expect(checkDelimited("", [ID_A])).toBe(false);
  });
});

let kit: Kit | undefined;
beforeEach(() => {
  vi.mocked(research.delimitSourcesWithReport).mockClear();
});
afterEach(() => {
  kit?.close();
  kit = undefined;
});

async function runWithComposition(
  compose: (real: string) => string,
): Promise<{ kit: Kit; row: ReturnType<typeof listJobRuns>[number] | undefined }> {
  kit = createKit();
  const actual = await vi.importActual<typeof import("@ccc/research")>("@ccc/research");
  vi.mocked(research.delimitSourcesWithReport).mockImplementationOnce((sources, nonce) => {
    const real = actual.delimitSourcesWithReport(sources, nonce);
    return { ...real, composed: compose(real.composed) };
  });
  const started = kit.services.runNow();
  if (!started.ok) throw new Error("refused");
  await kit.services.idle();
  return { kit, row: listJobRuns(kit.store.db, RESEARCH_JOB_ID, 1)[0] };
}

describe("a composition that does not match the fetched ids ends the run with no model call", () => {
  const cases: [string, (composed: string) => string][] = [
    [
      "a missing block",
      (composed) => composed.split("\n<<<SRC id=").slice(0, 2).join("\n<<<SRC id="),
    ],
    [
      "an extra block",
      (composed) => `${composed}\n${block(ID_C, "an extra source nobody fetched")}`,
    ],
    [
      "a reordered block",
      (composed) => {
        const parts = composed.split(/\n(?=<<<SRC id=)/);
        return [parts[1], parts[0], ...parts.slice(2)].join("\n");
      },
    ],
  ];
  for (const [name, compose] of cases) {
    it(name, async () => {
      const { kit: used, row } = await runWithComposition(compose);
      expect(used.transportInputs).toHaveLength(0);
      expect(row?.outcome).toBe("failure");
      expect(row?.errorCode).toBe("summariser-invalid-output");
      // No synthesis, wiki or report stage and no report note.
      expect(row?.stageLog.map((entry) => entry.stage)).toEqual(["capture", "raw"]);
      expect(
        readdirSync(join(used.vaultRoot, "global", "output")).filter((n) => n !== "index.md"),
      ).toEqual([]);
    });
  }
});

describe("summarizeUntrusted has exactly one call site outside tests", () => {
  it("is called only by the pipeline", () => {
    const dir = fileURLToPath(new URL("..", import.meta.url));
    const hits: string[] = [];
    const walk = (folder: string): void => {
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        const path = join(folder, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "node_modules") walk(path);
          continue;
        }
        if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue;
        if (path.includes(`${join("untrusted", "")}`)) continue;
        const text = readFileSync(path, "utf8");
        const calls = text.match(/\bsummarizeUntrusted\s*\(/g);
        if (calls !== null) hits.push(`${path}:${calls.length}`);
      }
    };
    walk(dir);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatch(/research\/pipeline\.ts:1$/);
  });
});
