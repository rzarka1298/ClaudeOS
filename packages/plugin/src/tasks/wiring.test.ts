import { afterEach, describe, expect, it, vi } from "vitest";
import { createHostRegistry } from "../host-registry.js";
import { FakeObsidianHost, FakeVault } from "../test-support/fake-obsidian-host.js";
import {
  COMPLETED_NOTE,
  NOW,
  OPEN_NOTE,
  TASK_PATH,
  taskEditVault,
} from "../test-support/task-note-fixtures.js";
import { configureTaskActionsPort, taskActionsPort } from "./actions-port.js";
import { configureTasksApi, TasksApiError, tasksApi } from "./api.js";
import { resetTasksGeneration } from "./events.js";
import { wireTasks } from "./wiring.js";

async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

class CapturingHost extends FakeObsidianHost {
  readonly commands: { id: string; name: string; callback: () => void }[] = [];
  override addCommand(command: { id: string; name: string; callback: () => void }) {
    this.commands.push(command);
    return super.addCommand(command);
  }
}

afterEach(() => {
  configureTasksApi(null);
  configureTaskActionsPort(null);
  resetTasksGeneration();
  vi.unstubAllGlobals();
});

function setup(options: { missing?: boolean; client?: Record<string, unknown> } = {}) {
  const host = new CapturingHost();
  const registry = createHostRegistry(host);
  const vault = new FakeVault(options.missing ? {} : { [TASK_PATH]: OPEN_NOTE });
  const client = {
    create: vi.fn(),
    list: vi.fn().mockResolvedValue({ rows: [], total: 0, nextCursor: null, chooseProject: false }),
    counts: vi.fn().mockRejectedValue(new Error("not needed")),
    get: vi.fn(),
    changed: vi.fn().mockResolvedValue({ accepted: 1, generation: 2 }),
    rebuild: vi.fn().mockResolvedValue({ tasks: 3, attention: 1 }),
    attention: vi.fn().mockResolvedValue({ items: [], total: 0, nextCursor: null }),
    dueToday: vi.fn(),
    ...options.client,
  };
  const opened: string[] = [];
  const reveals: string[] = [];
  const wiring = wireTasks(registry, {
    client: client,
    vault: {
      ...taskEditVault(vault),
      getFileByPath: (path: string) => {
        try {
          vault.read(path);
          return vault.file(path);
        } catch {
          return null;
        }
      },
    },
    openNote: (path) => opened.push(path),
    reveal: () => reveals.push("reveal"),
    now: () => Date.parse(NOW),
    log: () => {},
  });
  return { host, registry, vault, client, opened, reveals, wiring };
}

describe("Test 1: client injection", () => {
  it("configures the tasks API over the client and reduces failures to closed codes", async () => {
    const { client } = setup();
    await tasksApi().list({} as never);
    expect(client.list).toHaveBeenCalledTimes(1);

    client.get.mockRejectedValueOnce(
      Object.assign(new Error("secret path"), { code: "not-found" }),
    );
    client.get.mockRejectedValueOnce(Object.assign(new Error("x"), { code: "bogus" }));
    const codes: string[] = [];
    for (let i = 0; i < 2; i++) {
      await tasksApi()
        .get({} as never)
        .catch((error: unknown) => {
          expect(error).toBeInstanceOf(TasksApiError);
          codes.push((error as TasksApiError).code);
        });
    }
    expect(codes).toEqual(["not-found", "unrecognised-response"]);
  });
});

describe("Test 2: the actions port", () => {
  it("completes through the vault, then tells the service once with the path", async () => {
    const { vault, client } = setup();

    const result = await taskActionsPort().complete({ path: TASK_PATH });

    expect(result.kind).toBe("applied");
    expect(vault.read(TASK_PATH)).toBe(COMPLETED_NOTE);
    expect(client.changed).toHaveBeenCalledTimes(1);
    expect(client.changed).toHaveBeenCalledWith({ paths: [TASK_PATH] });
  });

  it("answers an unreadable outcome for a missing note without calling the service", async () => {
    const { client } = setup({ missing: true });

    for (const name of ["complete", "reopen", "accept", "dismiss"] as const) {
      expect(await taskActionsPort()[name]({ path: TASK_PATH })).toEqual({
        kind: "unreadable",
        reason: "read-failed",
      });
    }
    expect(await taskActionsPort().readForEdit(TASK_PATH)).toEqual({
      kind: "unreadable",
      reason: "read-failed",
    });
    expect(client.changed).not.toHaveBeenCalled();
  });

  it("reads for edit and opens a note in the workspace and nothing else", async () => {
    const { opened, client, vault } = setup();

    const read = await taskActionsPort().readForEdit(TASK_PATH);
    expect(read.kind === "ok" && read.content).toBe(OPEN_NOTE);
    taskActionsPort().openNote(TASK_PATH);

    expect(opened).toEqual([TASK_PATH]);
    expect(client.changed).not.toHaveBeenCalled();
    expect(vault.processCallCount).toBe(0);
  });

  it("restores the unavailable port on unload", async () => {
    const { registry } = setup();
    registry.disposeAll();
    expect(await taskActionsPort().complete({ path: TASK_PATH })).toEqual({
      kind: "unreadable",
      reason: "read-failed",
    });
  });
});

describe("Test 3: TASK-08 completion has no other effect (structural)", () => {
  it("calls no other client function and never fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { client } = setup();

    await taskActionsPort().complete({ path: TASK_PATH });

    for (const name of ["create", "list", "counts", "get", "rebuild", "attention", "dueToday"]) {
      expect(client[name as keyof typeof client]).not.toHaveBeenCalled();
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("Test 4: watcher and command", () => {
  it("registers four vault events, one timer, one cleanup and the Create task command with no hotkey", () => {
    const { host, registry } = setup();

    expect(host.liveCounts()).toMatchObject({ vaultEvent: 4, timer: 1, command: 1 });
    const command = host.commands[0];
    expect(command?.id).toBe("create-task");
    expect(command?.name).toBe("Create task");
    expect(command).not.toHaveProperty("hotkeys");
    expect(registry.liveCount()).toBeGreaterThanOrEqual(7);
  });

  it("ignores vault events before layout-ready and reports a task note change after", () => {
    const { host, client } = setup();

    host.emitVaultEvent("create", { path: TASK_PATH });
    host.fireTimers();
    expect(client.changed).not.toHaveBeenCalled();

    host.setLayoutReady();
    host.emitVaultEvent("create", { path: TASK_PATH });
    host.fireTimers();
    expect(client.changed).toHaveBeenCalledWith({ paths: [TASK_PATH] });
  });

  it("the Create task command reveals the view", () => {
    const { host, reveals } = setup();
    host.commands[0]?.callback();
    expect(reveals).toEqual(["reveal"]);
  });
});

describe("Test 5: own writes", () => {
  it("drops the modify echo of a write the port made", async () => {
    const { host, client } = setup();
    host.setLayoutReady();

    await taskActionsPort().complete({ path: TASK_PATH });
    host.emitVaultEvent("modify", { path: TASK_PATH });
    host.fireTimers();

    expect(client.changed).toHaveBeenCalledTimes(1);
  });
});

describe("Test 7: reconnect", () => {
  it("asks the service to rescan once and reloads the global context", async () => {
    const { wiring, client } = setup();

    wiring.onLive();
    await flush();

    expect(client.changed).toHaveBeenCalledTimes(1);
    expect(client.changed).toHaveBeenCalledWith({ rescan: true });
    expect(client.list).toHaveBeenCalled();
    expect(client.attention).toHaveBeenCalled();
  });

  it("a failed rescan changes nothing and throws nothing", async () => {
    const { wiring, client } = setup({
      client: { changed: vi.fn().mockRejectedValue(new Error("down")) },
    });

    expect(() => wiring.onLive()).not.toThrow();
    await flush();

    expect(client.list).not.toHaveBeenCalled();
  });
});

describe("rebuild", () => {
  it("rebuilds through the service and answers the counts", async () => {
    const { wiring, client } = setup();
    expect(await wiring.rebuild()).toEqual({ tasks: 3, attention: 1 });
    expect(client.rebuild).toHaveBeenCalledTimes(1);
  });
});
