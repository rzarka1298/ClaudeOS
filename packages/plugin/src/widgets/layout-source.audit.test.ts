import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LayoutOverride } from "@ccc/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearDiagnostics, diagnostics } from "../diagnostics.js";
import { createHostRegistry } from "../host-registry.js";
import { FakeDataAdapter, FakeObsidianHost } from "../test-support/fake-obsidian-host.js";
import { layoutOverride, resolvedLayout, setLayoutOverride } from "./layout.js";
import {
  createAdapterLayoutSource,
  type LayoutFileSource,
  type LayoutPoller,
  layoutFilePath,
  startLayoutPolling,
} from "./layout-source.js";

/** Audit (plan 03-08): gaps the plan's own tests left open. */

const SECRET = "sk-AUDITSECRET0123456789abcdef";

function reset(): void {
  layoutOverride.value = undefined;
  clearDiagnostics();
}
beforeEach(reset);
afterEach(reset);

function layoutJson(...ids: string[]): string {
  return JSON.stringify({ schemaVersion: 1, entries: ids.map((widgetId) => ({ widgetId })) });
}

function ids(): string[] {
  return resolvedLayout.value.entries.map((e) => e.widgetId);
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

async function start(source: LayoutFileSource): Promise<LayoutPoller> {
  const registry = createHostRegistry(new FakeObsidianHost());
  const poller = startLayoutPolling({ registry, source });
  await settle();
  return poller;
}

function adapterSource(adapter: FakeDataAdapter, configDir = "cfg"): LayoutFileSource {
  return createAdapterLayoutSource({ configDir, adapter }, "ccc");
}

describe("path construction", () => {
  it("follows a renamed config directory and normalizes redundant slashes", () => {
    expect(layoutFilePath("my-config/", "ccc")).toBe("my-config/plugins/ccc/layout.json");
    expect(layoutFilePath("my-config/", "ccc")).not.toContain(["", "obsidian"].join("."));
  });

  it("layout-source source has no literal config-directory name or private adapter API", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const code = readFileSync(join(here, "layout-source.ts"), "utf8")
      .split("\n")
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line));
    const offending = code.filter((line) =>
      /\.obsidian|getBasePath|basePath|getFullPath|app\.plugins|from "(node:)?(fs|path)"/.test(
        line,
      ),
    );
    expect(offending).toEqual([]);
  });
});

describe("change detection edges", () => {
  it("treats a folder at the path as no file and applies the default", async () => {
    const source = createAdapterLayoutSource(
      {
        configDir: "cfg",
        adapter: {
          stat: () => Promise.resolve({ type: "folder", mtime: 1, size: 0 }),
          read: () => Promise.reject(new Error("folder")),
        },
      },
      "ccc",
    );
    setLayoutOverride(JSON.parse(layoutJson("today")) as LayoutOverride);
    await start(source);
    expect(layoutOverride.value).toBeUndefined();
    expect(diagnostics.value).toEqual([]);
  });

  it("re-reads a file recreated with the same (mtime, size) after a deletion", async () => {
    const adapter = new FakeDataAdapter();
    adapter.setFile(layoutJson("today"), 1000);
    const poller = await start(adapterSource(adapter));
    adapter.remove();
    await poller.tick();
    expect(layoutOverride.value).toBeUndefined();
    adapter.setFile(layoutJson("today"), 1000);
    await poller.tick();
    expect(ids()).toEqual(["today"]);
    expect(adapter.readCallCount).toBe(2);
  });

  it("deleting a file that was never valid restores the default", async () => {
    setLayoutOverride(JSON.parse(layoutJson("today")) as LayoutOverride);
    const adapter = new FakeDataAdapter();
    adapter.setFile("{", 1000);
    const poller = await start(adapterSource(adapter));
    expect(ids()).toEqual(["today"]);
    adapter.remove();
    await poller.tick();
    expect(layoutOverride.value).toBeUndefined();
  });
});

describe("failure is recorded once, never per tick", () => {
  it("a read that keeps failing for an unchanged stat is read and recorded once", async () => {
    let reads = 0;
    const poller = await start({
      stat: () => Promise.resolve({ mtime: 5, size: 5 }),
      read: () => {
        reads++;
        return Promise.reject(new Error(SECRET));
      },
    });
    await poller.tick();
    await poller.tick();
    expect(reads).toBe(1);
    expect(diagnostics.value.map((d) => d.code)).toEqual(["override-unreadable"]);
    expect(JSON.stringify(diagnostics.value)).not.toContain(SECRET);
  });

  it("a stat that keeps failing records once per run of failures", async () => {
    let fail = true;
    const poller = await start({
      stat: () => (fail ? Promise.reject(new Error(SECRET)) : Promise.resolve(null)),
      read: () => Promise.reject(new Error("unreachable")),
    });
    await poller.tick();
    await poller.tick();
    expect(diagnostics.value.map((d) => d.code)).toEqual(["override-unreadable"]);
    fail = false;
    await poller.tick();
    fail = true;
    await poller.tick();
    expect(diagnostics.value).toHaveLength(2);
    expect(JSON.stringify(diagnostics.value)).not.toContain(SECRET);
  });

  it("an interval-driven tick never produces an unhandled rejection", async () => {
    const host = new FakeObsidianHost();
    const registry = createHostRegistry(host);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      startLayoutPolling({
        registry,
        source: {
          stat: () => Promise.reject(new Error("EIO")),
          read: () => Promise.reject(new Error("EIO")),
        },
      });
      await new Promise((resolve) => window.setTimeout(resolve, 20));
    } finally {
      process.off("unhandledRejection", onUnhandled);
      registry.disposeAll();
    }
    expect(unhandled).toEqual([]);
  });
});

describe("T-03-15: no file content in any diagnostic", () => {
  const cases: [string, string][] = [
    ["malformed JSON", `{"schemaVersion":1,"entries":[${SECRET}]}`],
    ["secret as a wrong-typed value", JSON.stringify({ schemaVersion: SECRET, entries: [] })],
    [
      "secret as an invalid size",
      JSON.stringify({ schemaVersion: 1, entries: [{ widgetId: "today", size: SECRET }] }),
    ],
  ];
  for (const [name, content] of cases) {
    it(`never records the file content: ${name}`, async () => {
      const adapter = new FakeDataAdapter();
      adapter.setFile(content, 1000);
      await start(adapterSource(adapter));
      expect(diagnostics.value).toHaveLength(1);
      expect(JSON.stringify(diagnostics.value)).not.toContain(SECRET);
    });
  }

  it("never records the file content: secret as an unrecognized key", async () => {
    const adapter = new FakeDataAdapter();
    adapter.setFile(JSON.stringify({ schemaVersion: 1, entries: [], [SECRET]: 1 }), 1000);
    await start(adapterSource(adapter));
    expect(diagnostics.value).toHaveLength(1);
    expect(JSON.stringify(diagnostics.value)).not.toContain(SECRET);
  });
});

describe("setLayoutOverride idempotency (carry-forward)", () => {
  const withUnknown = JSON.parse(layoutJson("today", "not-a-widget")) as LayoutOverride;

  it("an equal (but not identical) override records nothing", () => {
    setLayoutOverride(withUnknown);
    expect(diagnostics.value).toHaveLength(1);
    setLayoutOverride(JSON.parse(layoutJson("today", "not-a-widget")) as LayoutOverride);
    expect(diagnostics.value).toHaveLength(1);
  });

  it("a different override still records its skips", () => {
    setLayoutOverride(withUnknown);
    setLayoutOverride(JSON.parse(layoutJson("not-a-widget", "today")) as LayoutOverride);
    expect(diagnostics.value.map((d) => d.code)).toEqual(["unknown-widget", "unknown-widget"]);
  });

  it("a size-only difference is not treated as equal", () => {
    setLayoutOverride(withUnknown);
    setLayoutOverride({
      schemaVersion: 1,
      entries: [{ widgetId: "today", size: "wide" }, { widgetId: "not-a-widget" }],
    });
    expect(diagnostics.value).toHaveLength(2);
    expect(resolvedLayout.value.entries[0]?.size).toBe("wide");
  });
});
