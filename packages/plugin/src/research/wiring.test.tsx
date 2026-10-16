import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HOSTILE_CORPUS } from "@ccc/domain/approval-corpus.js";
import { hasDisallowedTextCharacter } from "@ccc/domain/task-schema.js";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectionState } from "../connection-state.js";
import { createHostRegistry, type HostRegistry } from "../host-registry.js";
import { routeServiceEvent } from "../service-event-router.js";
import { FakeObsidianHost } from "../test-support/fake-obsidian-host.js";
import {
  CONFIGURED_SOURCES,
  EMPTY_STATUS,
  id25,
  iso,
  listOf,
  RESEARCH_NOW_MS,
  RESEARCH_TOPIC,
  RESEARCH_ZONE,
  reportRow,
  statusOf,
} from "../test-support/research-view-fixtures.js";
import { ResearchDestination } from "../view/research.js";
import { widgetStateFor } from "../widgets/widget-data.js";
import * as quickActions from "../widgets/quick-actions.js";
import { researchApi, researchConfigured, researchPorts } from "./api.js";
import { researchEventHandlerInstalled } from "./events.js";
import { resetResearchState } from "./state.js";
import { type WireResearchDeps, wireResearch } from "./wiring.js";

/**
 * Plan 07-15, task 3: startup and unload wiring, the host ports and the untouched Overview
 * (D-22, PLUG-04, UI-SPEC R2 and R6, T-07-33, T-07-42). Everything above the client is real: the
 * adapter, the ports, the dispatcher, the event handler, the state and the destination. Hostile
 * text comes from the shared corpus; this file is pure ASCII.
 */

vi.mock("../widgets/quick-actions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../widgets/quick-actions.js")>();
  return { ...actual, dispatchQuickAction: vi.fn(actual.dispatchQuickAction) };
});

const dispatchSpy = vi.mocked(quickActions.dispatchQuickAction);

const RUN = id25("run1");
const SRC_DIR = dirname(fileURLToPath(import.meta.url));

function updated(payload: unknown) {
  return {
    id: 5,
    type: "research.updated" as const,
    occurredAt: "2026-10-14T12:00:00.000Z",
    payload,
  };
}

function fakeClient(overrides: Record<string, unknown> = {}) {
  return {
    run: vi.fn(() => Promise.resolve({ runId: RUN, alreadyRunning: false, state: "running" })),
    status: vi.fn(() => Promise.resolve(EMPTY_STATUS)),
    list: vi.fn(() => Promise.resolve(listOf([]))),
    report: vi.fn(() => Promise.reject(new Error("not used"))),
    ...overrides,
  };
}

function setup(
  options: { client?: ReturnType<typeof fakeClient>; deps?: Partial<WireResearchDeps> } = {},
) {
  const host = new FakeObsidianHost();
  const registry: HostRegistry = createHostRegistry(host);
  const client = options.client ?? fakeClient();
  const notice = vi.fn();
  const openFile = vi.fn((_path: string) => true);
  const copyText = vi.fn((_text: string) => Promise.resolve());
  const wiring = wireResearch(registry, {
    client: client as never,
    notice,
    openFile,
    copyText,
    ...options.deps,
  });
  return { host, registry, client, notice, openFile, copyText, wiring };
}

beforeEach(() => {
  resetResearchState();
  dispatchSpy.mockClear();
  connectionState.value = { kind: "live" };
});

afterEach(() => {
  cleanup();
  resetResearchState();
  connectionState.value = { kind: "connecting" };
});

describe("Test 1 (wiring): wireResearch configures the ports and returns a disposer", () => {
  it("configures the API over the client adapter and installs one event handler", async () => {
    const { client, registry } = setup();
    expect(researchConfigured()).toBe(true);
    expect(researchEventHandlerInstalled()).toBe(true);
    await researchApi().status();
    expect(client.status).toHaveBeenCalledTimes(1);
    registry.disposeAll();
  });

  it("the notice port is the host's Notice, with the text capped and neutralised", () => {
    const { notice, registry } = setup();
    researchPorts().notify("Research report ready: Example.");
    expect(notice).toHaveBeenCalledWith("Research report ready: Example.");
    notice.mockClear();
    researchPorts().notify("x".repeat(5000));
    const shown = String(notice.mock.calls[0]?.[0]);
    expect(shown.length).toBeLessThanOrEqual(300);
    registry.disposeAll();
  });

  it("the open-note port opens vault-relative Markdown paths through the host and answers its result", async () => {
    const { openFile, registry } = setup();
    await expect(
      Promise.resolve(researchPorts().openNote("global/output/research-2026-10-14-a.md")),
    ).resolves.toBe(true);
    expect(openFile).toHaveBeenCalledWith("global/output/research-2026-10-14-a.md");

    openFile.mockReturnValueOnce(false);
    await expect(
      Promise.resolve(researchPorts().openNote("global/output/missing.md")),
    ).resolves.toBe(false);

    openFile.mockImplementationOnce(() => {
      throw new Error("workspace gone");
    });
    await expect(Promise.resolve(researchPorts().openNote("global/output/a.md"))).resolves.toBe(
      false,
    );
    registry.disposeAll();
  });

  it("the open-note port refuses every hostile path before the host sees it", async () => {
    const { openFile, registry } = setup();
    const paths = [
      "",
      "/etc/passwd",
      "/Users/USERNAME/secret.md",
      "../outside.md",
      "global/../../outside.md",
      "global//output/a.md",
      "global/./output/a.md",
      "global\\output\\a.md",
      "C:/windows/system.ini",
      "global/output/a.txt",
      "global/output/a.md\u0000.png",
      `global/output/a${String.fromCodePoint(0x202e)}dm.exe`,
      "[[private note]]",
      "global/output/".concat("a".repeat(600), ".md"),
      ...HOSTILE_CORPUS.map((entry) => entry.text),
    ];
    for (const path of paths) {
      await expect(Promise.resolve(researchPorts().openNote(path))).resolves.toBe(false);
    }
    expect(openFile).not.toHaveBeenCalled();
    registry.disposeAll();
  });

  it("the copy port writes through the host and answers whether it worked", async () => {
    const { copyText, registry } = setup();
    await expect(Promise.resolve(researchPorts().copyText("https://example.invalid/a"))).resolves.toBe(
      true,
    );
    expect(copyText).toHaveBeenCalledWith("https://example.invalid/a");
    copyText.mockImplementationOnce(() => Promise.reject(new Error("denied")));
    await expect(Promise.resolve(researchPorts().copyText("x"))).resolves.toBe(false);
    copyText.mockImplementationOnce(() => {
      throw new Error("no clipboard");
    });
    await expect(Promise.resolve(researchPorts().copyText("x"))).resolves.toBe(false);
    registry.disposeAll();
  });

  it("requestRunNow goes through dispatchQuickAction as research:run, and starts the run", async () => {
    const { client, registry } = setup();
    void researchPorts().requestRunNow();
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expect((dispatchSpy.mock.calls[0]?.[0] as { capability: string }).capability).toBe(
      "research:run",
    );
    await waitFor(() => expect(client.run).toHaveBeenCalledTimes(1));
    registry.disposeAll();
  });

  it("returns a disposer that removes the API, the ports and the handler, and may run twice", () => {
    const { wiring, registry } = setup();
    wiring.dispose();
    wiring.dispose();
    expect(researchConfigured()).toBe(false);
    expect(researchEventHandlerInstalled()).toBe(false);
    registry.disposeAll();
    expect(registry.liveCount()).toBe(0);
  });

  it("the host registry owns the cleanup: disposeAll leaves nothing configured or installed", async () => {
    const { registry } = setup();
    expect(registry.liveCount()).toBeGreaterThan(0);
    registry.disposeAll();
    expect(registry.liveCount()).toBe(0);
    expect(researchConfigured()).toBe(false);
    expect(researchEventHandlerInstalled()).toBe(false);
    await expect(researchApi().status()).rejects.toMatchObject({ code: "service-disconnected" });
  });
});

describe("Test 2 (lifecycle): load, unload and reload leave one handler and no leak", () => {
  it("twenty cycles end with nothing configured, and a reload leaves exactly one live handler", async () => {
    let registry: HostRegistry | undefined;
    const statusCalls = vi.fn();
    for (let i = 0; i < 20; i++) {
      registry?.disposeAll();
      const client = fakeClient({
        status: vi.fn(() => {
          statusCalls();
          return Promise.resolve(EMPTY_STATUS);
        }),
      });
      registry = setup({ client }).registry;
    }
    expect(researchEventHandlerInstalled()).toBe(true);

    // The destination is open, so a refresh is allowed; one event reaches the one live handler once.
    render(<ResearchDestination connection={{ kind: "live" }} now={RESEARCH_NOW_MS} />);
    await waitFor(() => expect(statusCalls).toHaveBeenCalledTimes(1));
    routeServiceEvent(updated({ runId: RUN, state: "running", stage: "capture" }));
    await waitFor(() => expect(statusCalls).toHaveBeenCalledTimes(2));
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    expect(statusCalls).toHaveBeenCalledTimes(2);

    cleanup();
    registry?.disposeAll();
    expect(registry?.liveCount()).toBe(0);
    expect(researchEventHandlerInstalled()).toBe(false);
    expect(researchConfigured()).toBe(false);
  });
});

describe("Test 3 (Overview untouched): no research state reaches the Overview", () => {
  it("the Today widget stays permission-required and tech-intel stays unavailable, wired or not", () => {
    const before = [widgetStateFor("today").value, widgetStateFor("tech-intel").value];
    const { registry } = setup();
    const after = [widgetStateFor("today").value, widgetStateFor("tech-intel").value];
    expect(after).toEqual(before);
    expect(after[0]).toMatchObject({ kind: "permission-required" });
    expect(after[1]).toEqual({ kind: "unavailable" });
    registry.disposeAll();
  });

  it("widget-data.ts and panels.tsx import nothing from the research code", () => {
    for (const file of ["../widgets/widget-data.ts", "../widgets/panels.tsx"]) {
      const source = readFileSync(join(SRC_DIR, file), "utf8");
      const imports = source.split("\n").filter((line) => /^\s*import\b|from "/.test(line));
      expect(imports.filter((line) => /research/i.test(line)), file).toEqual([]);
    }
  });
});

describe("Test 4 (notices): only a press in this session posts the outcome Notice", () => {
  function runFlow(options: { press: boolean }) {
    const row = reportRow(0);
    let phase: "idle" | "running" | "done" = "idle";
    const client = fakeClient({
      run: vi.fn(() => {
        phase = "running";
        return Promise.resolve({ runId: RUN, alreadyRunning: false, state: "running" });
      }),
      status: vi.fn(() =>
        Promise.resolve(
          phase === "done"
            ? statusOf({
                lastSuccess: {
                  runId: RUN,
                  endedAt: iso(0),
                  outcome: "success",
                  sourceCount: 3,
                  sourceTotal: 3,
                  reportNoteId: row.noteId,
                },
                topicLabel: RESEARCH_TOPIC,
                configuredSources: [...CONFIGURED_SOURCES],
              })
            : phase === "running"
              ? statusOf({
                  inFlight: { runId: RUN, startedAt: iso(-1), stage: "synthesis" },
                  topicLabel: RESEARCH_TOPIC,
                })
              : statusOf({ topicLabel: RESEARCH_TOPIC }),
        ),
      ),
      list: vi.fn(() => Promise.resolve(listOf(phase === "done" ? [row] : []))),
    });
    const wired = setup({ client });
    render(
      <ResearchDestination
        connection={{ kind: "live" }}
        now={RESEARCH_NOW_MS}
        zone={RESEARCH_ZONE}
      />,
    );
    return {
      ...wired,
      row,
      finish: () => {
        phase = "done";
        routeServiceEvent(updated({ runId: RUN, state: "completed", outcome: "success" }));
      },
    };
  }

  it("a press in this session posts a Notice with the outcome sentence", async () => {
    const flow = runFlow({ press: true });
    const button = await screen.findByRole("button", { name: /^Run now/ });
    await waitFor(() => expect(flow.client.status).toHaveBeenCalled());
    fireEvent.click(button);
    await waitFor(() => expect(flow.client.run).toHaveBeenCalledTimes(1));
    await screen.findByText("Summarising", { exact: false });
    flow.finish();
    await waitFor(() => expect(flow.notice).toHaveBeenCalledTimes(1));
    expect(String(flow.notice.mock.calls[0]?.[0])).toBe(
      `Research report ready: ${flow.row.title}.`,
    );
    flow.registry.disposeAll();
  });

  it("an outcome first seen through an event posts no Notice", async () => {
    const flow = runFlow({ press: false });
    await waitFor(() => expect(flow.client.status).toHaveBeenCalledTimes(1));
    flow.finish();
    await waitFor(() => expect(flow.client.list.mock.calls.length).toBeGreaterThanOrEqual(2));
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    expect(flow.notice).not.toHaveBeenCalled();
    flow.registry.disposeAll();
  });

  it("a hostile report title is capped and never reaches the Notice as a control or bidi character", async () => {
    const flow = runFlow({ press: true });
    const { registry, notice } = flow;
    for (const entry of HOSTILE_CORPUS) {
      researchPorts().notify(`Research report ready: ${entry.text}.`);
    }
    for (const call of notice.mock.calls) {
      const text = String(call[0]);
      expect(text.length).toBeLessThanOrEqual(300);
      expect(hasDisallowedTextCharacter(text)).toBe(false);
    }
    registry.disposeAll();
  });
});
