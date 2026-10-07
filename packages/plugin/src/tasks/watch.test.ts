// Plan 06-18, Task 3: the vault change watcher and the create-task command (D-35,
// A-10, research Pattern 13, T-06-23). Events go through the fake host, which
// withholds them until layout-ready exactly like the real adapter.
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CommandLike, createHostRegistry } from "../host-registry.js";
import { FakeObsidianHost } from "../test-support/fake-obsidian-host.js";
import { consumeTaskFormRequest, navigationRequest } from "../view/navigation-request.js";
import type { CoalescedBatch } from "./coalescer.js";
import { CREATE_TASK_COMMAND_ID, registerCreateTaskCommand } from "./commands.js";
import { createOwnWriteLedger, registerTaskVaultWatch } from "./watch.js";

const WS = "mfz0a1b2c3d4e5f6g7h8i9j0k";
const NOTE = "global/tasks/draft-the-weekly-review-ghijklmn.md";
const WS_NOTE = `workspaces/${WS}/tasks/other-task-abcdefgh.md`;

function setup() {
  const host = new FakeObsidianHost();
  const registry = createHostRegistry(host);
  const clock = { now: 1000 };
  const changed = vi.fn((_batch: CoalescedBatch) =>
    Promise.resolve({ accepted: 1, generation: 1 }),
  );
  const log = vi.fn();
  const watch = registerTaskVaultWatch(registry, { now: () => clock.now, changed, log });
  const flush = async () => {
    host.fireTimers();
    await Promise.resolve();
  };
  return { host, registry, clock, changed, log, watch, flush };
}

const file = (path: string) => ({ path });
const folder = (path: string) => ({ path, children: [] as unknown[] });

afterEach(() => vi.unstubAllGlobals());

describe("Test 2: the path filter", () => {
  it("accepts create, modify, delete and rename events for global and workspace task notes", async () => {
    const { host, changed, flush } = setup();
    host.setLayoutReady();
    host.emitVaultEvent("create", file(NOTE));
    host.emitVaultEvent("modify", file(WS_NOTE));
    host.emitVaultEvent("delete", file("global/tasks/gone-12345678.md"));
    host.emitVaultEvent(
      "rename",
      file("global/tasks/new-name-12345678.md"),
      "global/tasks/old-name-12345678.md",
    );
    await flush();
    expect(changed).toHaveBeenCalledTimes(1);
    expect(changed.mock.calls[0]?.[0]).toEqual({
      paths: [
        NOTE,
        WS_NOTE,
        "global/tasks/gone-12345678.md",
        "global/tasks/new-name-12345678.md",
        "global/tasks/old-name-12345678.md",
      ],
    });
  });

  it("ignores index files, other folders and non-markdown files", async () => {
    const { host, changed, flush } = setup();
    host.setLayoutReady();
    for (const path of [
      "global/tasks/index.md",
      "global/tasks/INDEX.md",
      "global/wiki/note.md",
      "global/tasks/image.png",
      "global/tasks/sub/deep.md",
      `workspaces/${WS}/wiki/x.md`,
      "notes/tasks/x.md",
    ]) {
      host.emitVaultEvent("modify", file(path));
    }
    await flush();
    expect(changed).not.toHaveBeenCalled();
  });

  it("turns a folder event under a tasks folder into one rescan and ignores other folders", async () => {
    const { host, changed, flush } = setup();
    host.setLayoutReady();
    host.emitVaultEvent("create", folder("global/wiki/sub"));
    await flush();
    expect(changed).not.toHaveBeenCalled();
    host.emitVaultEvent("rename", folder("global/tasks"), "global/old-tasks");
    host.emitVaultEvent("delete", folder(`workspaces/${WS}/tasks/archive`));
    await flush();
    expect(changed).toHaveBeenCalledTimes(1);
    expect(changed.mock.calls[0]?.[0]).toEqual({ rescan: true });
  });

  it("ignores payloads that are not a file or folder", async () => {
    const { host, changed, flush } = setup();
    host.setLayoutReady();
    for (const payload of [undefined, null, "global/tasks/x-12345678.md", 7, {}, { path: 5 }]) {
      host.emitVaultEvent("modify", payload);
    }
    await flush();
    expect(changed).not.toHaveBeenCalled();
  });
});

describe("Test 3: the handler does no I/O", () => {
  it("reads only the path (and folder-ness) of the event payload and makes no network call", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { host, changed } = setup();
    host.setLayoutReady();
    const reads: (string | symbol)[] = [];
    const payload = new Proxy(
      { path: NOTE },
      {
        get(target, key) {
          reads.push(key);
          return Reflect.get(target, key) as unknown;
        },
        has(target, key) {
          reads.push(key);
          return Reflect.has(target, key);
        },
      },
    );
    host.emitVaultEvent("modify", payload);
    expect(new Set(reads)).toEqual(new Set(["path", "children"]));
    expect(fetchSpy).not.toHaveBeenCalled();
    // The handler hands the path to the coalescer and returns: nothing is sent until the timer fires.
    expect(changed).not.toHaveBeenCalled();
  });
});

describe("Test 4: registration through the host registry", () => {
  it("delivers nothing before layout-ready and delivers after it, on the registry's own vault and timer kinds", async () => {
    const { host, registry, changed, flush } = setup();
    host.emitVaultEvent("create", file(NOTE));
    await flush();
    expect(changed).not.toHaveBeenCalled();
    expect(host.liveCounts().vaultEvent).toBe(4);
    host.setLayoutReady();
    host.emitVaultEvent("create", file(NOTE));
    await flush();
    expect(changed).toHaveBeenCalledTimes(1);
    expect(registry.liveCount()).toBeGreaterThan(0);
  });

  it("cancels a pending flush when the registry is disposed", async () => {
    const { host, registry, changed, flush } = setup();
    host.setLayoutReady();
    host.emitVaultEvent("modify", file(NOTE));
    expect(registry.disposeAll()).toEqual([]);
    await flush();
    expect(changed).not.toHaveBeenCalled();
    expect(registry.liveCount()).toBe(0);
    expect(host.liveCounts().vaultEvent).toBe(0);
  });
});

describe("Test 5: the plugin's own writes", () => {
  it("drops events for a path the plugin just wrote, within the window only, and keeps other paths", async () => {
    const { host, clock, watch, changed, flush } = setup();
    host.setLayoutReady();
    watch.ownWrites.record(NOTE);
    host.emitVaultEvent("modify", file(NOTE));
    host.emitVaultEvent("modify", file(WS_NOTE));
    await flush();
    expect(changed.mock.calls[0]?.[0]).toEqual({ paths: [WS_NOTE] });

    clock.now += 5000;
    host.emitVaultEvent("modify", file(NOTE));
    await flush();
    expect(changed.mock.calls[1]?.[0]).toEqual({ paths: [NOTE] });
  });

  it("M1: delete and create inside the window always pass; only modify echoes are dropped", async () => {
    const { host, watch, changed, flush } = setup();
    host.setLayoutReady();
    watch.ownWrites.record(NOTE);
    host.emitVaultEvent("modify", file(NOTE));
    await flush();
    expect(changed).not.toHaveBeenCalled();
    host.emitVaultEvent("delete", file(NOTE));
    await flush();
    expect(changed.mock.calls[0]?.[0]).toEqual({ paths: [NOTE] });
    watch.ownWrites.record(WS_NOTE);
    host.emitVaultEvent("create", file(WS_NOTE));
    await flush();
    expect(changed.mock.calls[1]?.[0]).toEqual({ paths: [WS_NOTE] });
  });

  it("codex-2: an echo is matched once, so an external modify 500 ms later still reaches the index", async () => {
    const { host, clock, watch, changed, flush } = setup();
    host.setLayoutReady();
    watch.ownWrites.record(NOTE);
    host.emitVaultEvent("modify", file(NOTE));
    await flush();
    expect(changed).not.toHaveBeenCalled();
    clock.now += 500;
    host.emitVaultEvent("modify", file(NOTE));
    await flush();
    expect(changed.mock.calls[0]?.[0]).toEqual({ paths: [NOTE] });
  });

  it("forgets a recorded write when asked, so an external edit after a conflict is not dropped", () => {
    let now = 0;
    const ledger = createOwnWriteLedger(() => now, 2000);
    ledger.record(NOTE);
    expect(ledger.isRecent(NOTE)).toBe(true);
    ledger.forget(NOTE);
    expect(ledger.isRecent(NOTE)).toBe(false);
    ledger.record(NOTE);
    now = 2001;
    expect(ledger.isRecent(NOTE)).toBe(false);
    expect(ledger.isRecent(WS_NOTE)).toBe(false);
  });
});

describe("Test 6: the flush", () => {
  it("swallows a rejected call, logs the error class once and never retries", async () => {
    const { host, changed, log, flush } = setup();
    class ServiceDownError extends Error {}
    changed.mockRejectedValue(new ServiceDownError("x"));
    host.setLayoutReady();
    host.emitVaultEvent("modify", file(NOTE));
    await flush();
    await Promise.resolve();
    await Promise.resolve();
    expect(changed).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith("ServiceDownError");
    await flush();
    expect(changed).toHaveBeenCalledTimes(1);
  });
});

describe("Test 7: a startup or sync storm", () => {
  it("turns 10,000 create events into one rescan flush", async () => {
    const { host, changed, flush } = setup();
    host.setLayoutReady();
    for (let n = 0; n < 10_000; n++) {
      host.emitVaultEvent(
        "create",
        file(`global/tasks/bulk-${n}-${String(n).padStart(8, "0")}.md`),
      );
    }
    await flush();
    expect(changed).toHaveBeenCalledTimes(1);
    expect(changed.mock.calls[0]?.[0]).toEqual({ rescan: true });
  });
});

describe("Test 8: the create-task command module", () => {
  function register(reveal: () => void): CommandLike[] {
    const commands: CommandLike[] = [];
    registerCreateTaskCommand({ command: (command) => commands.push(command) }, reveal);
    return commands;
  }

  it("registers create-task named Create task with no hotkey and no forbidden words", () => {
    const [command, ...rest] = register(() => {});
    expect(rest).toEqual([]);
    expect(CREATE_TASK_COMMAND_ID).toBe("create-task");
    expect(command?.id).toBe("create-task");
    expect(command?.name).toBe("Create task");
    expect(command).not.toHaveProperty("hotkeys");
    for (const text of [command?.id ?? "", command?.name ?? ""]) {
      expect(text.toLowerCase()).not.toMatch(/command|claude|center/);
    }
  });

  it("sets the task form intent, requests the Tasks destination, then reveals the view", () => {
    navigationRequest.value = null;
    consumeTaskFormRequest();
    const seen: unknown[] = [];
    const [command] = register(() => {
      seen.push(navigationRequest.value?.destination, navigationRequest.value?.openTaskForm);
    });
    command?.callback();
    expect(seen).toEqual(["tasks", true]);
    expect(consumeTaskFormRequest()).toBe(true);
    expect(consumeTaskFormRequest()).toBe(false);
  });
});
