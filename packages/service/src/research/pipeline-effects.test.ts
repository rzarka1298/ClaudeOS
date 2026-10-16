import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { CLASSIFICATION, classifyOperation, RESEARCH_PIPELINE_OPERATIONS } from "@ccc/domain";
import { afterEach, describe, expect, it } from "vitest";
import { PIPELINE_EFFECTS } from "./pipeline-effects.js";
import {
  createKit,
  defaultResponses,
  type Kit,
  URL_ONE,
  URL_THREE,
  URL_TWO,
} from "./test-support/research-kit.js";

describe("Test 5 (effects classified): every effect step of the pipeline names an operation", () => {
  it("has a value set equal to the domain list RESEARCH_PIPELINE_OPERATIONS (two separate definitions)", () => {
    expect([...Object.values(PIPELINE_EFFECTS)].sort()).toEqual(
      [...RESEARCH_PIPELINE_OPERATIONS].sort(),
    );
    expect(new Set(Object.values(PIPELINE_EFFECTS)).size).toBe(
      Object.values(PIPELINE_EFFECTS).length,
    );
  });

  it("classifies every effect as no-approval or direct-gesture, the trigger as the owner's gesture", () => {
    for (const [step, operation] of Object.entries(PIPELINE_EFFECTS)) {
      const hit = classifyOperation(operation);
      expect(hit, step).toBeDefined();
      expect(["no-approval", "direct-gesture"], step).toContain(hit?.row.class);
      expect(CLASSIFICATION[operation].class).not.toBe("approval-required");
    }
    expect(classifyOperation(PIPELINE_EFFECTS.trigger)?.row.class).toBe("direct-gesture");
    expect(classifyOperation(PIPELINE_EFFECTS.fetch)?.row.class).toBe("no-approval");
  });
});

/** Every file under a vault with its content, keyed by vault-relative path. */
function snapshotVault(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (root === "") return out;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[relative(root, full)] = readFileSync(full, "utf8");
    }
  };
  walk(root);
  return out;
}

function changedPaths(before: Record<string, string>, after: Record<string, string>): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((path) => before[path] !== after[path])
    .sort();
}

/** The folder a vault-relative path is written under: `global/<stage>` or the top folder. */
function folderOf(path: string): string {
  const parts = path.split("/");
  return parts[0] === "global" ? parts.slice(0, 2).join("/") : (parts[0] ?? "");
}

const WRITES_ALLOWED: Readonly<Record<string, readonly string[]>> = {
  [PIPELINE_EFFECTS.writeNotes]: ["global/raw", "global/wiki", "global/output"],
  [PIPELINE_EFFECTS.recordRun]: ["automation-runs"],
};

/** Vault changes made in the window of an effect that does not name them. */
function unexpectedVaultWrites(
  windows: readonly { effect: string; changed: readonly string[] }[],
): string[] {
  return windows.flatMap((window) =>
    window.changed
      .filter((path) => !(WRITES_ALLOWED[window.effect] ?? []).includes(folderOf(path)))
      .map((path) => `${window.effect} changed ${path}`),
  );
}

async function runAndWait(k: Kit): Promise<void> {
  const started = k.services.runNow();
  if (!started.ok) throw new Error("refused");
  await k.services.idle();
}

let kit: Kit | undefined;
afterEach(() => {
  kit?.close();
  kit = undefined;
});

describe("the pipeline names each effect where it happens", () => {
  it("names exactly these effects, in this order and this many times, in a successful run", async () => {
    kit = createKit();
    const started = kit.services.runNow();
    if (!started.ok) throw new Error("refused");
    await kit.services.idle();
    const { trigger, recordRun, fetch, writeNotes, summarise } = PIPELINE_EFFECTS;
    expect(kit.effects).toEqual([
      trigger,
      recordRun, // the first run note, written when the run starts
      recordRun, // capture
      fetch,
      writeNotes, // the raw notes
      recordRun, // raw
      summarise,
      recordRun, // synthesis
      writeNotes, // the report, then the wiki notes
      recordRun, // wiki
      recordRun, // deliverable
      writeNotes, // the finalise (the report is rewritten in place as output)
      recordRun, // output
      recordRun, // the job run finish
      recordRun, // the final run note
    ]);
    // Every classified operation appears: nothing in the domain list is unused.
    expect([...new Set(kit.effects)].sort()).toEqual([...RESEARCH_PIPELINE_OPERATIONS].sort());
  });

  it("names a write effect before every change to the vault, and no other effect writes there", async () => {
    const windows: { effect: string; before: Record<string, string> }[] = [];
    let root = "";
    kit = createKit({
      onEffect: (operation) => windows.push({ effect: operation, before: snapshotVault(root) }),
    });
    root = kit.vaultRoot;
    await runAndWait(kit);
    const after = snapshotVault(root);
    // The work of effect i happens between its own mark and the next one.
    const changes = windows.map((window, index) => ({
      effect: window.effect,
      changed: changedPaths(window.before, windows[index + 1]?.before ?? after),
    }));
    expect(unexpectedVaultWrites(changes)).toEqual([]);
    // The check has teeth: the same run read as if the fetch had been the one that wrote is refused.
    expect(
      unexpectedVaultWrites([
        { effect: PIPELINE_EFFECTS.fetch, changed: ["global/raw/a.md"] },
        { effect: PIPELINE_EFFECTS.summarise, changed: ["automation-runs/r.md"] },
        { effect: PIPELINE_EFFECTS.recordRun, changed: ["global/output/x.md"] },
        { effect: PIPELINE_EFFECTS.writeNotes, changed: ["automation-runs/r.md"] },
      ]),
    ).toHaveLength(4);
    // And the run really did write in both kinds of window.
    const wrote = (effect: string): boolean =>
      changes.some((change) => change.effect === effect && change.changed.length > 0);
    expect(wrote(PIPELINE_EFFECTS.writeNotes)).toBe(true);
    expect(wrote(PIPELINE_EFFECTS.recordRun)).toBe(true);
  });

  it("names a fetch and a record but no note write and no summarise in a run that fetched nothing", async () => {
    kit = createKit({
      responses: {
        ...defaultResponses(),
        [URL_ONE]: { ok: false, code: "timeout" },
        [URL_TWO]: { ok: false, code: "timeout" },
        [URL_THREE]: { ok: false, code: "timeout" },
      },
    });
    const started = kit.services.runNow();
    if (!started.ok) throw new Error("refused");
    await kit.services.idle();
    const performed = new Set(kit.effects);
    expect(performed.has(PIPELINE_EFFECTS.fetch)).toBe(true);
    expect(performed.has(PIPELINE_EFFECTS.writeNotes)).toBe(false);
    expect(performed.has(PIPELINE_EFFECTS.summarise)).toBe(false);
  });

  it("never reports an operation outside the classified set", async () => {
    kit = createKit();
    kit.services.runNow();
    await kit.services.idle();
    for (const operation of kit.effects) {
      expect(Object.values(PIPELINE_EFFECTS)).toContain(operation);
    }
  });
});
