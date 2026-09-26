import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LayoutOverride } from "@ccc/domain";
import { act, cleanup, render } from "@testing-library/preact";
import { h } from "preact";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearDiagnostics, diagnostics } from "../diagnostics.js";
import { createHostRegistry } from "../host-registry.js";
import { FakeDataAdapter, FakeObsidianHost } from "../test-support/fake-obsidian-host.js";
import { Shell } from "../view/shell.js";
import { ENABLED_FLAGS } from "./feature-flags.js";
import {
  composeLayout,
  DEFAULT_LAYOUT,
  layoutOverride,
  resolvedLayout,
  setLayoutOverride,
} from "./layout.js";
import {
  createAdapterLayoutSource,
  type LayoutFileSource,
  type LayoutPoller,
  parseLayoutOverride,
  startLayoutPolling,
} from "./layout-source.js";
import { WIDGETS } from "./registry.js";

/**
 * The layout override file, live (UI-07, D-11, D-13; research Pattern 5 and
 * Pitfall 4). Everything here runs against the REAL `setLayoutOverride` and
 * the REAL `resolvedLayout` -- a stand-in apply function would keep passing if
 * the poller ever stopped reaching the signal the Overview renders from.
 *
 * Ticks are driven by hand through the returned `tick()`: the fake host
 * counts the interval registration but never fires it, so every stat and
 * read below is one the test asked for.
 */

/** A config directory name that is deliberately not Obsidian's default one. */
const CONFIG_DIR = "test-config";
const PLUGIN_ID = "claude-command-center";
const LAYOUT_PATH = `${CONFIG_DIR}/plugins/${PLUGIN_ID}/layout.json`;

function layoutJson(...widgetIds: string[]): string {
  return JSON.stringify({ schemaVersion: 1, entries: widgetIds.map((widgetId) => ({ widgetId })) });
}

function resolvedIds(): string[] {
  return resolvedLayout.value.entries.map((e) => e.widgetId);
}

function reset(): void {
  cleanup();
  layoutOverride.value = undefined;
  clearDiagnostics();
}

beforeEach(reset);
afterEach(reset);

interface Harness {
  readonly host: FakeObsidianHost;
  readonly adapter: FakeDataAdapter;
  readonly dispose: () => void;
  readonly poller: LayoutPoller;
  /** Every value the poller handed to apply, in order. */
  readonly applied: (LayoutOverride | undefined)[];
}

/**
 * Starts the real poller against a fake adapter through the real adapter
 * source. The immediate tick `startLayoutPolling` fires on its own is awaited
 * by the first explicit `tick()` in each test, because a tick that finds
 * another in flight returns at once -- so each test settles it first.
 */
function start(
  adapter: FakeDataAdapter = new FakeDataAdapter(),
  source: LayoutFileSource = createAdapterLayoutSource(
    { configDir: CONFIG_DIR, adapter },
    PLUGIN_ID,
  ),
): Harness {
  const host = new FakeObsidianHost();
  const registry = createHostRegistry(host);
  const applied: (LayoutOverride | undefined)[] = [];
  const poller = startLayoutPolling({
    registry,
    source,
    // The REAL writer, observed: every call still reaches setLayoutOverride.
    apply: (next) => {
      applied.push(next);
      return setLayoutOverride(next);
    },
  });
  return { host, adapter, poller, applied, dispose: () => registry.disposeAll() };
}

/** Lets the immediate tick that `startLayoutPolling` fired itself finish. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function overviewCardTitles(container: Element): string[] {
  const grid = container.querySelector('[role="tabpanel"] div.ccc-overview-grid');
  if (!grid) return [];
  return Array.from(grid.querySelectorAll(":scope > section.ccc-card")).map((card) => {
    const id = card.getAttribute("aria-labelledby") ?? "";
    return document.getElementById(id)?.textContent ?? "";
  });
}

describe("editing layout.json re-composes the Overview (UI-07, D-11)", () => {
  it("applies a valid override found at load", async () => {
    const adapter = new FakeDataAdapter();
    adapter.setFile(layoutJson("today", "service-health"), 1000);

    const { poller } = start(adapter);
    await settle();
    await poller.tick();

    expect(resolvedIds()).toEqual(["today", "service-health"]);
  });

  it("stats the file once per tick and never re-reads an unchanged file", async () => {
    const adapter = new FakeDataAdapter();
    adapter.setFile(layoutJson("today", "service-health"), 1000);

    const { poller } = start(adapter);
    await settle();
    const statsAfterLoad = adapter.statCallCount;
    await poller.tick();

    expect(adapter.statCallCount).toBe(statsAfterLoad + 1);
    expect(adapter.readCallCount).toBe(1);
    expect(resolvedIds()).toEqual(["today", "service-health"]);
  });

  it("asks the adapter about <configDir>/plugins/<plugin id>/layout.json and nothing else", async () => {
    const adapter = new FakeDataAdapter();
    adapter.setFile(layoutJson("today"), 1000);

    const { poller } = start(adapter);
    await settle();
    await poller.tick();

    expect(adapter.requestedPaths.length).toBeGreaterThan(0);
    expect(new Set(adapter.requestedPaths)).toEqual(new Set([LAYOUT_PATH]));
  });

  it("re-reads a changed file and the mounted Overview re-renders in the new order", async () => {
    const adapter = new FakeDataAdapter();
    adapter.setFile(layoutJson("today", "service-health"), 1000);
    const { poller } = start(adapter);
    await settle();

    const { container } = render(h(Shell, null));
    const grid = container.querySelector(".ccc-overview-grid");
    expect(overviewCardTitles(container)).toEqual(["Today", "Service health"]);

    adapter.setFile(layoutJson("quick-actions", "today", "service-health"), 2000);
    await act(async () => {
      await poller.tick();
    });

    expect(adapter.readCallCount).toBe(2);
    expect(resolvedIds()).toEqual(["quick-actions", "today", "service-health"]);
    expect(overviewCardTitles(container)).toEqual(["Quick actions", "Today", "Service health"]);
    // The same grid element: the Overview re-composed in place, no remount.
    expect(container.querySelector(".ccc-overview-grid")).toBe(grid);
  });

  it("registers exactly one interval through the host registry and releases it on dispose", async () => {
    const { host, dispose } = start();
    await settle();

    expect(host.liveCounts().interval).toBe(1);

    dispose();

    expect(host.liveCounts().interval).toBe(0);
  });
});

/** What the Overview renders with no override at all. */
function defaultIds(): string[] {
  return composeLayout(DEFAULT_LAYOUT, undefined, WIDGETS, ENABLED_FLAGS).entries.map(
    (e) => e.widgetId,
  );
}

/** Starts with a valid two-card override applied, the state every failure case begins from. */
async function startWithValidOverride(): Promise<Harness> {
  const adapter = new FakeDataAdapter();
  adapter.setFile(layoutJson("today", "service-health"), 1000);
  const harness = start(adapter);
  await settle();
  expect(resolvedIds()).toEqual(["today", "service-health"]);
  return harness;
}

describe("a bad layout file never blanks the Overview (D-13; UI-SPEC E3 error row)", () => {
  it("keeps the previous layout on malformed JSON and records one override-invalid diagnostic", async () => {
    const { adapter, poller } = await startWithValidOverride();

    adapter.setFile('{ "schemaVersion": 1, "entries": [', 2000);
    await poller.tick();
    await poller.tick();

    expect(resolvedIds()).toEqual(["today", "service-health"]);
    expect(diagnostics.value).toHaveLength(1);
    expect(diagnostics.value[0]?.source).toBe("layout");
    expect(diagnostics.value[0]?.code).toBe("override-invalid");
    expect(diagnostics.value[0]?.message).toContain("layout.json could not be applied: ");
    // A bad file is read once, not every second while the owner is mid-edit.
    expect(adapter.readCallCount).toBe(2);
  });

  it("keeps the previous layout on a schema-invalid document and names the schema issue", async () => {
    const { adapter, poller } = await startWithValidOverride();

    adapter.setFile(JSON.stringify({ schemaVersion: 2, entries: [] }), 2000);
    await poller.tick();

    expect(resolvedIds()).toEqual(["today", "service-health"]);
    expect(diagnostics.value.map((d) => d.code)).toEqual(["override-invalid"]);
    expect(diagnostics.value[0]?.message).toMatch(/^layout\.json could not be applied: /);
    expect(diagnostics.value[0]?.message).toContain("schemaVersion");
  });

  it("never echoes the file's content into the diagnostic (T-03-15)", async () => {
    const { adapter, poller } = await startWithValidOverride();

    adapter.setFile("PRIVATE-SENTINEL-TEXT is not json", 2000);
    await poller.tick();

    expect(diagnostics.value).toHaveLength(1);
    expect(diagnostics.value[0]?.message).not.toContain("PRIVATE-SENTINEL");
    expect(diagnostics.value[0]?.message.length).toBeLessThanOrEqual(200);
  });

  it("picks up the next good edit immediately after a bad one", async () => {
    const { adapter, poller } = await startWithValidOverride();

    adapter.setFile("{", 2000);
    await poller.tick();
    adapter.setFile(layoutJson("quick-actions"), 3000);
    await poller.tick();

    expect(resolvedIds()).toEqual(["quick-actions"]);
  });

  it("keeps the previous layout and resolves the tick when the read itself fails", async () => {
    await startWithValidOverride();
    const failing: LayoutFileSource = {
      stat: () => Promise.resolve({ mtime: 5000, size: 10 }),
      read: () => Promise.reject(new Error("EACCES")),
    };
    const { poller } = start(new FakeDataAdapter(), failing);
    await settle();

    await expect(poller.tick()).resolves.toBeUndefined();

    expect(resolvedIds()).toEqual(["today", "service-health"]);
    // Recorded once per run of failures, not once per retry.
    expect(diagnostics.value.map((d) => [d.source, d.code])).toEqual([
      ["layout", "override-unreadable"],
    ]);
  });

  it("resolves the tick when stat itself fails", async () => {
    await startWithValidOverride();
    const failing: LayoutFileSource = {
      stat: () => Promise.reject(new Error("EIO")),
      read: () => Promise.reject(new Error("unreachable")),
    };
    const { poller } = start(new FakeDataAdapter(), failing);
    await settle();

    await expect(poller.tick()).resolves.toBeUndefined();

    expect(resolvedIds()).toEqual(["today", "service-health"]);
  });
});

describe("removal, replacement and change detection (research Pitfall 4)", () => {
  it("restores the typed default when the file is removed", async () => {
    const { adapter, poller } = await startWithValidOverride();

    adapter.remove();
    await poller.tick();

    expect(layoutOverride.value).toBeUndefined();
    expect(resolvedIds()).toEqual(defaultIds());
  });

  it("applies the default exactly once when the file is absent from the start", async () => {
    const { poller, applied } = start();
    await settle();
    await poller.tick();
    await poller.tick();

    expect(applied).toEqual([undefined]);
    expect(resolvedIds()).toEqual(defaultIds());
  });

  it("re-reads an atomically replaced file with identical content and records nothing", async () => {
    const { adapter, poller } = await startWithValidOverride();

    adapter.setFile(layoutJson("today", "service-health"), 2000);
    await poller.tick();

    expect(adapter.readCallCount).toBe(2);
    expect(resolvedIds()).toEqual(["today", "service-health"]);
    expect(diagnostics.value).toEqual([]);
  });

  it("treats a size change at the same mtime as a change", async () => {
    const { adapter, poller } = await startWithValidOverride();

    adapter.setFile(layoutJson("today", "service-health", "quick-actions"), 1000);
    await poller.tick();

    expect(adapter.readCallCount).toBe(2);
    expect(resolvedIds()).toEqual(["today", "service-health", "quick-actions"]);
  });

  it("records an unchanged file's skipped entry only once across a re-save", async () => {
    const adapter = new FakeDataAdapter();
    adapter.setFile(layoutJson("today", "not-a-widget"), 1000);
    const { poller } = start(adapter);
    await settle();

    adapter.setFile(layoutJson("today", "not-a-widget"), 2000);
    await poller.tick();

    expect(adapter.readCallCount).toBe(2);
    expect(diagnostics.value.map((d) => d.code)).toEqual(["unknown-widget"]);
  });
});

describe("the poll never stacks (T-03-07)", () => {
  it("performs exactly one stat for two overlapping ticks against a slow disk", async () => {
    const adapter = new FakeDataAdapter();
    adapter.setFile(layoutJson("today"), 1000);
    const { poller } = start(adapter);
    await settle();
    const before = adapter.statCallCount;

    const release = adapter.holdNextStat();
    const first = poller.tick();
    const second = poller.tick();
    release();
    await Promise.all([first, second]);

    expect(adapter.statCallCount - before).toBe(1);
  });

  it("polls again once the slow tick has finished", async () => {
    const adapter = new FakeDataAdapter();
    const { poller } = start(adapter);
    await settle();
    const before = adapter.statCallCount;

    const release = adapter.holdNextStat();
    const slow = poller.tick();
    release();
    await slow;
    await poller.tick();

    expect(adapter.statCallCount - before).toBe(2);
  });
});

describe("supported APIs only (research Pitfall 4; supported-API constraint)", () => {
  const SOURCE_FILE = join(dirname(fileURLToPath(import.meta.url)), "layout-source.ts");

  /** Blanks comment text while preserving line numbering, so the scan reads CODE only. */
  function codeLines(source: string): string[] {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/, ""));
  }

  it("uses no Node filesystem watcher", () => {
    const code = codeLines(readFileSync(SOURCE_FILE, "utf8"));
    expect(code.filter((line) => /\bfs\.watch|\bwatchFile\b|node:fs|chokidar/.test(line))).toEqual(
      [],
    );
  });

  it("subscribes to no vault event, documented or not", () => {
    const code = codeLines(readFileSync(SOURCE_FILE, "utf8"));
    expect(code.filter((line) => /\.on\(\s*["'`]|\bvault\.on\b/.test(line))).toEqual([]);
  });
});

describe("a parse diagnostic carries no file-supplied text (T-03-15)", () => {
  /** A key or value no schema would ever name: it can only have come from the file. */
  const SECRET = "sk-FILESECRET0123456789abcdef";

  function detailOf(document: unknown): string {
    const result = parseLayoutOverride(JSON.stringify(document));
    if (result.ok) throw new Error("expected the document to be rejected");
    return result.detail;
  }

  it("counts an unknown top-level key instead of naming it", () => {
    const detail = detailOf({ schemaVersion: 1, entries: [], [SECRET]: 1 });
    expect(detail).toBe("(document): 1 unknown field");
  });

  it("counts several unknown keys in one object", () => {
    const detail = detailOf({ schemaVersion: 1, entries: [], [SECRET]: 1, [`${SECRET}2`]: 2 });
    expect(detail).toBe("(document): 2 unknown fields");
  });

  it("names an unknown key inside an entry by the entry's schema path only", () => {
    const detail = detailOf({ schemaVersion: 1, entries: [{ widgetId: "today", [SECRET]: 1 }] });
    expect(detail).toBe("entries.0: 1 unknown field");
  });

  it("names a wrong value by its schema path, never by the value", () => {
    const detail = detailOf({ schemaVersion: 1, entries: [{ widgetId: "today", size: SECRET }] });
    expect(detail).toBe("entries.0.size: not an allowed value");
  });

  it("names a wrong-typed field without quoting what the file held", () => {
    const detail = detailOf({ schemaVersion: 1, entries: SECRET });
    expect(detail).toMatch(/^entries: wrong type/);
    expect(detail).not.toContain(SECRET);
  });

  it("states a schema bound, which comes from the schema rather than the file", () => {
    const entries = Array.from({ length: 65 }, () => ({ widgetId: "today" }));
    expect(detailOf({ schemaVersion: 1, entries })).toBe("entries: too many items (maximum 64)");
    expect(detailOf({ schemaVersion: 1, entries: [{ widgetId: "" }] })).toBe(
      "entries.0.widgetId: too short (minimum 1)",
    );
  });

  it("counts the remaining problems after the first", () => {
    const detail = detailOf({
      schemaVersion: 2,
      entries: [{ widgetId: "today", size: SECRET }],
      [SECRET]: 1,
    });
    expect(detail).toMatch(/^schemaVersion: not an allowed value \(and 2 more problems\)$/);
  });

  it("never lets a file-supplied string into the detail, whatever the problem", () => {
    const documents: unknown[] = [
      SECRET,
      [SECRET],
      { [SECRET]: { [SECRET]: SECRET } },
      { schemaVersion: SECRET, entries: [{ [SECRET]: SECRET }] },
      { schemaVersion: 1, entries: [{ widgetId: SECRET.repeat(4) }] },
      { schemaVersion: 1, entries: [{ widgetId: 1, size: SECRET }], [SECRET]: [SECRET] },
    ];
    for (const document of documents) {
      expect(detailOf(document)).not.toContain("FILESECRET");
    }
  });
});

describe("a transient read failure is retried, a bad file is not", () => {
  /** A source whose stat never changes and whose reads follow a script. */
  function scriptedSource(reads: (() => Promise<string>)[]): {
    source: LayoutFileSource;
    readCount: () => number;
  } {
    let count = 0;
    return {
      source: {
        stat: () => Promise.resolve({ mtime: 5000, size: 10 }),
        read: () => {
          const next = reads[Math.min(count, reads.length - 1)];
          count++;
          return next === undefined ? Promise.reject(new Error("no script")) : next();
        },
      },
      readCount: () => count,
    };
  }

  it("applies a valid file on the next tick after a read failed, with (mtime, size) unchanged", async () => {
    const { source, readCount } = scriptedSource([
      () => Promise.reject(new Error("EBUSY")),
      () => Promise.resolve(layoutJson("quick-actions")),
    ]);
    const { poller } = start(new FakeDataAdapter(), source);
    await settle();
    expect(diagnostics.value.map((d) => d.code)).toEqual(["override-unreadable"]);

    await poller.tick();

    expect(readCount()).toBe(2);
    expect(resolvedIds()).toEqual(["quick-actions"]);
    // Once applied, the unchanged file is not read again.
    await poller.tick();
    expect(readCount()).toBe(2);
  });

  it("records a read failure once per run of failures, however many retries it takes", async () => {
    const { source, readCount } = scriptedSource([
      () => Promise.reject(new Error("EBUSY")),
      () => Promise.reject(new Error("EBUSY")),
      () => Promise.reject(new Error("EBUSY")),
      () => Promise.resolve(layoutJson("today")),
    ]);
    const { poller } = start(new FakeDataAdapter(), source);
    await settle();
    await poller.tick();
    await poller.tick();
    await poller.tick();

    expect(readCount()).toBe(4);
    expect(resolvedIds()).toEqual(["today"]);
    expect(diagnostics.value.map((d) => d.code)).toEqual(["override-unreadable"]);
  });

  it("records again when reads start failing after one succeeded", async () => {
    const adapter = new FakeDataAdapter();
    adapter.setFile(layoutJson("today"), 1000);
    let failReads = true;
    const inner = createAdapterLayoutSource({ configDir: CONFIG_DIR, adapter }, PLUGIN_ID);
    const source: LayoutFileSource = {
      stat: () => inner.stat(),
      read: () => (failReads ? Promise.reject(new Error("EBUSY")) : inner.read()),
    };
    const { poller } = start(adapter, source);
    await settle();
    failReads = false;
    await poller.tick();
    expect(resolvedIds()).toEqual(["today"]);

    failReads = true;
    adapter.setFile(layoutJson("quick-actions"), 2000);
    await poller.tick();

    expect(diagnostics.value.map((d) => d.code)).toEqual([
      "override-unreadable",
      "override-unreadable",
    ]);
  });

  it("still reads a file that fails to parse only once while it is unchanged", async () => {
    const { source, readCount } = scriptedSource([() => Promise.resolve("{")]);
    const { poller } = start(new FakeDataAdapter(), source);
    await settle();
    await poller.tick();
    await poller.tick();

    expect(readCount()).toBe(1);
    expect(diagnostics.value.map((d) => d.code)).toEqual(["override-invalid"]);
  });
});

describe("a throwing apply never escapes the tick", () => {
  const APPLY_SECRET = "APPLY-FAILURE-PRIVATE-DETAIL";

  function startThrowing(source: LayoutFileSource): {
    poller: LayoutPoller;
    calls: () => number;
    dispose: () => void;
  } {
    const registry = createHostRegistry(new FakeObsidianHost());
    let count = 0;
    const poller = startLayoutPolling({
      registry,
      source,
      apply: () => {
        count++;
        throw new Error(APPLY_SECRET);
      },
    });
    return { poller, calls: () => count, dispose: () => registry.disposeAll() };
  }

  it("resolves the tick and records a diagnostic when applying a valid file throws", async () => {
    const adapter = new FakeDataAdapter();
    adapter.setFile(layoutJson("today"), 1000);
    const { poller, calls } = startThrowing(
      createAdapterLayoutSource({ configDir: CONFIG_DIR, adapter }, PLUGIN_ID),
    );
    await settle();

    await expect(poller.tick()).resolves.toBeUndefined();

    expect(calls()).toBe(1);
    expect(diagnostics.value.map((d) => [d.source, d.code])).toEqual([
      ["layout", "override-apply-failed"],
    ]);
    expect(JSON.stringify(diagnostics.value)).not.toContain(APPLY_SECRET);
  });

  it("resolves the tick and records a diagnostic when applying the default throws", async () => {
    const { poller, calls } = startThrowing({
      stat: () => Promise.resolve(null),
      read: () => Promise.reject(new Error("unreachable")),
    });
    await settle();

    await expect(poller.tick()).resolves.toBeUndefined();

    expect(calls()).toBe(1);
    expect(diagnostics.value.map((d) => d.code)).toEqual(["override-apply-failed"]);
  });

  it("an interval-driven tick with a throwing apply produces no unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    const adapter = new FakeDataAdapter();
    adapter.setFile(layoutJson("today"), 1000);
    const { dispose } = startThrowing(
      createAdapterLayoutSource({ configDir: CONFIG_DIR, adapter }, PLUGIN_ID),
    );
    try {
      await new Promise((resolve) => window.setTimeout(resolve, 20));
    } finally {
      process.off("unhandledRejection", onUnhandled);
      dispose();
    }
    expect(unhandled).toEqual([]);
  });
});
