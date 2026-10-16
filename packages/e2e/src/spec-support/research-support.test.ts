import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RESEARCH_CLASSES } from "./research-copy.js";
import { rendererClickNth, rendererReadResearch } from "./research-dom.js";
import {
  clearResearchNotes,
  DOM_CONFIG,
  isRunEndLine,
  type PluginDataPage,
  type ResearchBrowser,
  type ResearchEnvironment,
  readVaultNotes,
  rendererCloseNotes,
  rendererOpenNotePaths,
  runScenario,
  setReducedMotion,
} from "./research-support.js";

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function vault(): { root: string; vault: string } {
  const root = mkdtempSync(join(tmpdir(), "ccc-uat-support-"));
  made.push(root);
  const path = join(root, "vaults", "live");
  for (const folder of ["global/raw", "global/wiki", "global/output", "automation-runs", "tasks"]) {
    mkdirSync(join(path, folder), { recursive: true });
  }
  return { root, vault: path };
}

describe("isRunEndLine", () => {
  it("is true for the ready line, the ready-with-gaps line and a failed line, and for nothing else", () => {
    expect(isRunEndLine("Research report ready: Developer tooling — Oct 16, 2026.")).toBe(true);
    expect(isRunEndLine("Research report ready with gaps: 1 of 3 sources were unavailable.")).toBe(
      true,
    );
    expect(isRunEndLine("Research report ready.")).toBe(true);
    expect(isRunEndLine("Research run failed: no source could be fetched.")).toBe(true);
    expect(isRunEndLine("Research run started.")).toBe(false);
    expect(isRunEndLine("Starting a research run…")).toBe(false);
    expect(isRunEndLine("")).toBe(false);
  });
});

describe("the vault readers", () => {
  it("reads the research folders without the generated index, and nothing from other folders", () => {
    const { root, vault: path } = vault();
    writeFileSync(join(path, "global/raw/a.b.md"), "raw");
    writeFileSync(join(path, "global/raw/index.md"), "index");
    writeFileSync(join(path, "global/output/r.md"), "report");
    writeFileSync(join(path, "automation-runs/run.md"), "run");
    writeFileSync(join(path, "tasks/t.md"), "task");
    const notes = readVaultNotes(path, root);
    expect(notes.raw.map((note) => note.path)).toEqual(["global/raw/a.b.md"]);
    expect(notes.output.map((note) => note.text)).toEqual(["report"]);
    expect(notes.runs.map((note) => note.name)).toEqual(["run.md"]);
    expect(notes.wiki).toEqual([]);
  });

  it("reads an absent folder as empty", () => {
    const { root, vault: path } = vault();
    rmSync(join(path, "global/wiki"), { recursive: true });
    expect(readVaultNotes(path, root).wiki).toEqual([]);
  });

  it("refuses a vault outside the run root", () => {
    const { root } = vault();
    const outside = mkdtempSync(join(tmpdir(), "ccc-uat-outside-"));
    made.push(outside);
    expect(() => readVaultNotes(outside, root)).toThrow(/run root/);
    expect(() => clearResearchNotes(outside, root)).toThrow(/run root/);
  });

  it("clears the research notes and leaves the indexes and every other folder alone", () => {
    const { root, vault: path } = vault();
    writeFileSync(join(path, "global/raw/a.md"), "raw");
    writeFileSync(join(path, "global/raw/index.md"), "index");
    writeFileSync(join(path, "global/output/r.md"), "report");
    writeFileSync(join(path, "automation-runs/run.md"), "run");
    writeFileSync(join(path, "tasks/t.md"), "task");
    clearResearchNotes(path, root);
    expect(existsSync(join(path, "global/raw/a.md"))).toBe(false);
    expect(existsSync(join(path, "global/output/r.md"))).toBe(false);
    expect(existsSync(join(path, "automation-runs/run.md"))).toBe(false);
    expect(existsSync(join(path, "global/raw/index.md"))).toBe(true);
    expect(existsSync(join(path, "tasks/t.md"))).toBe(true);
  });
});

describe("the DOM reader configuration", () => {
  it("holds a class name for every key, each from the mirrored table", () => {
    const known = new Set(Object.values(RESEARCH_CLASSES));
    for (const [key, value] of Object.entries(DOM_CONFIG)) {
      expect(known.has(value), key).toBe(true);
    }
  });
});

describe("setReducedMotion", () => {
  function page(initial: Record<string, unknown>) {
    const calls: string[] = [];
    let stored = JSON.stringify(initial);
    const fake: PluginDataPage = {
      async getConfigDir() {
        return ".obsidian";
      },
      async read(path) {
        calls.push(`read ${path}`);
        return stored;
      },
      async write(path, text) {
        calls.push(`write ${path}`);
        stored = text;
      },
      async disablePlugin(id) {
        calls.push(`disable ${id}`);
      },
      async enablePlugin(id) {
        calls.push(`enable ${id}`);
      },
    };
    return { fake, calls, stored: () => JSON.parse(stored) as Record<string, unknown> };
  }

  it("writes the setting into the plugin's data file and reloads the plugin, in that order", async () => {
    const { fake, calls, stored } = page({
      socketPathOverride: "/tmp/ccc-uat.AbCdEf/rt/svc.sock",
      lastOpenedDestination: "overview",
      reducedMotion: "auto",
      notifyApprovals: true,
    });
    await setReducedMotion(fake, "reduced");
    expect(stored()).toMatchObject({ reducedMotion: "reduced", notifyApprovals: true });
    expect(calls).toEqual([
      "read .obsidian/plugins/claude-command-center/data.json",
      "write .obsidian/plugins/claude-command-center/data.json",
      "disable claude-command-center",
      "enable claude-command-center",
    ]);
  });

  it("refuses a data file that holds a key the plugin does not persist, writing nothing", async () => {
    const { fake, calls } = page({
      socketPathOverride: "/x",
      reducedMotion: "auto",
      apiToken: "x",
    });
    await expect(setReducedMotion(fake, "reduced")).rejects.toThrow();
    expect(calls.filter((call) => call.startsWith("write"))).toEqual([]);
  });
});

describe("the open-note readers", () => {
  function ctx(paths: Array<string | undefined>) {
    const detached: number[] = [];
    const leaves = paths.map((path, index) => ({
      view: { file: path === undefined ? null : { path } },
      detach: () => {
        detached.push(index);
      },
    }));
    return {
      detached,
      value: { app: { workspace: { getLeavesOfType: () => leaves } } } as never,
    };
  }

  it("lists the paths of the open Markdown tabs and skips a tab with no file", () => {
    expect(rendererOpenNotePaths(ctx(["a.md", undefined, "global/raw/b.md"]).value)).toEqual([
      "a.md",
      "global/raw/b.md",
    ]);
  });

  it("closes every Markdown tab and says how many", () => {
    const fake = ctx(["a.md", "b.md"]);
    expect(rendererCloseNotes(fake.value)).toBe(2);
    expect(fake.detached).toEqual([0, 1]);
  });
});

describe("07-FIX7: runScenario follows the run through the service, not through a transient DOM state", () => {
  const FAILED_LINE = "Research run failed: the summariser isn't set up.";

  interface Fake {
    browser: ResearchBrowser;
    env: ResearchEnvironment;
    presses: () => number;
    selected: () => string[];
  }

  /**
   * A destination whose status line never leaves `statusLine` (a second run that ends with the same
   * sentence as the first), and a service whose answer to status() comes from `answers`, one per call.
   */
  function fake(statusLine: string, answers: Array<ReturnType<typeof status>>): Fake {
    let pressed = 0;
    const chosen: string[] = [];
    let call = 0;
    const read = {
      mounted: true,
      busy: false,
      dimmed: false,
      status: statusLine,
      runNow: {
        present: true,
        disabled: false,
        busy: false,
        label: "Run now",
        name: "",
        reason: null,
      },
      list: { rows: [] },
      reader: null,
      runStatus: { rows: [] },
    };
    const browser = {
      executeObsidianCommand: async () => undefined,
      executeObsidian: async () => true,
      execute: async (fn: unknown) => {
        if (fn === rendererReadResearch) return read;
        if (fn === rendererClickNth) {
          pressed += 1;
          return true;
        }
        throw new Error("the fake destination does not know this reader");
      },
    } as unknown as ResearchBrowser;
    const env = {
      prepared: { select: (scenario: string) => chosen.push(scenario) },
      research: {
        status: async () => {
          const answer = answers[Math.min(call, answers.length - 1)];
          call += 1;
          return answer;
        },
      },
    } as unknown as ResearchEnvironment;
    return { browser, env, presses: () => pressed, selected: () => chosen };
  }

  function status(failure: { runId: string; endedAt: string } | null) {
    return { lastSuccess: null, lastFailure: failure, inFlight: null };
  }

  const FIRST = { runId: "run-one", endedAt: "2026-10-16T10:00:00.000Z" };
  const SECOND = { runId: "run-two", endedAt: "2026-10-16T10:00:05.000Z" };

  it("returns the second run when it ended with the first run's very sentence before the first poll", async () => {
    // Item 8's run is already over (the previous answer); the press starts item 22's run, which
    // fails with the same sentence and has ended by the time anything looks.
    const world = fake(FAILED_LINE, [status(FIRST), status(SECOND)]);
    const run = await runScenario(world.browser, world.env, "base");
    expect(world.presses()).toBe(1);
    expect(world.selected()).toEqual(["base"]);
    expect(run.runId).toBe("run-two");
    expect(run.ok).toBe(false);
    expect(run.read.status).toBe(FAILED_LINE);
  }, 30_000);

  it("waits for the service to name a new run instead of returning the previous one", async () => {
    // The service still answers with the first run twice (the new run is working), then the second.
    const world = fake(FAILED_LINE, [status(FIRST), status(FIRST), status(FIRST), status(SECOND)]);
    const run = await runScenario(world.browser, world.env, "base");
    expect(run.runId).toBe("run-two");
  }, 30_000);

  it("handles the very first run, when the service has ended none before", async () => {
    const world = fake(FAILED_LINE, [status(null), status(FIRST)]);
    const run = await runScenario(world.browser, world.env, "base");
    expect(run.runId).toBe("run-one");
  }, 30_000);
});
