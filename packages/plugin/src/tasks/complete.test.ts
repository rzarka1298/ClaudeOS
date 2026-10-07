// Plan 06-18, Task 1: completing a task (TASK-08, D-37, T-06-24). The only
// calls a completion may make are the vault write and the injected
// task-changed function.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeVault } from "../test-support/fake-obsidian-host.js";
import {
  COMPLETED_NOTE,
  NOW,
  OPEN_NOTE,
  TASK_PATH,
  taskEditVault,
} from "../test-support/task-note-fixtures.js";
import { completeTask } from "./actions.js";

const HERE = dirname(fileURLToPath(import.meta.url));

afterEach(() => {
  vi.unstubAllGlobals();
});

function setup(content = OPEN_NOTE) {
  const vault = new FakeVault({ [TASK_PATH]: content });
  const changed = vi.fn((_path: string) => Promise.resolve({ accepted: 1, generation: 4 }));
  return { vault, deps: { vault: taskEditVault(vault), changed }, changed };
}

describe("Test 4: completing an open task", () => {
  it("sets done, completed and updated and nothing else, notifies once with the vault-relative path", async () => {
    const { vault, deps, changed } = setup();
    const result = await completeTask(deps, { file: vault.file(TASK_PATH) }, NOW);
    expect(result.kind).toBe("applied");
    expect(vault.read(TASK_PATH)).toBe(COMPLETED_NOTE);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledWith(TASK_PATH);
  });

  it("uses the content the caller read as the expected prior content, so an editor change in between is a conflict", async () => {
    const { vault, deps, changed } = setup();
    const external = OPEN_NOTE.replace("Body with", "Typed while the form was open: body with");
    vault.setExternally(TASK_PATH, external);
    const result = await completeTask(
      deps,
      { file: vault.file(TASK_PATH), expectedPriorContent: OPEN_NOTE },
      NOW,
    );
    expect(result).toEqual({ kind: "conflict" });
    expect(vault.read(TASK_PATH)).toBe(external);
    expect(changed).not.toHaveBeenCalled();
  });

  it("still reports applied when the service notification fails, because the note is already written", async () => {
    const { vault, deps } = setup();
    deps.changed.mockRejectedValueOnce(new Error("service-disconnected"));
    const result = await completeTask(deps, { file: vault.file(TASK_PATH) }, NOW);
    expect(result.kind).toBe("applied");
    expect(result.kind === "applied" && result.notified).toBe(false);
  });
});

describe("Test 5 (TASK-08 spy): completion calls nothing outside the vault write and the task routes", () => {
  it("never reaches a service client, an executor, a quick-action context, fetch or the launch client", async () => {
    const serviceClient = { request: vi.fn(), launch: vi.fn(), decide: vi.fn() };
    const executors = { run: vi.fn(), terminate: vi.fn() };
    const quickActions = { navigate: vi.fn(), notify: vi.fn(), requestLaunch: vi.fn() };
    const launchClient = { launch: vi.fn() };
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const xhr = vi.fn();
    vi.stubGlobal("XMLHttpRequest", xhr);

    const { vault, deps, changed } = setup();
    await completeTask(deps, { file: vault.file(TASK_PATH) }, NOW);

    for (const spy of [
      ...Object.values(serviceClient),
      ...Object.values(executors),
      ...Object.values(quickActions),
      ...Object.values(launchClient),
      fetchSpy,
      xhr,
    ]) {
      expect(spy).not.toHaveBeenCalled();
    }
    expect(changed).toHaveBeenCalledTimes(1);
    expect(vault.writtenPaths).toEqual([TASK_PATH]);
  });

  it("imports only the updater, the task API holder, the domain and plain types", () => {
    const source = readFileSync(join(HERE, "actions.ts"), "utf8");
    const specifiers = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1] ?? "");
    const allowed = [
      /^\.\.\/conflict-safe\.js$/,
      /^\.\/task-update\.js$/,
      /^\.\/api\.js$/,
      /^@ccc\/domain\//,
    ];
    for (const specifier of specifiers) {
      expect(
        allowed.some((pattern) => pattern.test(specifier)),
        specifier,
      ).toBe(true);
    }
    expect(source).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|executors|quick-actions|launch-client/);
  });
});

describe("Test 6 (actions): an unreadable note is never rewritten and the service is not notified", () => {
  it("reports unreadable for a note over the limits or failing the schema", async () => {
    const broken = OPEN_NOTE.replace("status: ready", "status: waiting");
    const { vault, deps, changed } = setup(broken);
    const result = await completeTask(deps, { file: vault.file(TASK_PATH) }, NOW);
    expect(result).toEqual({ kind: "unreadable", reason: "invalid-frontmatter" });
    expect(vault.read(TASK_PATH)).toBe(broken);
    expect(changed).not.toHaveBeenCalled();
  });
});
