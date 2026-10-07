import { afterEach, describe, expect, it } from "vitest";
import {
  configureTaskWorkspaces,
  createTasksViewState,
  loadTaskWorkspaces,
  resetTasksViewState,
} from "./tasks-view-state.js";

afterEach(() => configureTaskWorkspaces(null));

describe("Test 6: the view state", () => {
  it("is plain signals that start empty and reset to that", () => {
    const state = createTasksViewState();
    expect(state.formOpen.value).toBe(false);
    expect(state.status.value).toBe("");
    expect(state.detail.value).toEqual({ kind: "none" });
    state.formOpen.value = true;
    state.status.value = "Saved.";
    state.dirty.value = true;
    state.leaveRequest.value = true;
    state.detail.value = { kind: "loading", id: "x" };
    resetTasksViewState(state);
    expect(state.formOpen.value).toBe(false);
    expect(state.status.value).toBe("");
    expect(state.dirty.value).toBe(false);
    expect(state.leaveRequest.value).toBe(false);
    expect(state.detail.value).toEqual({ kind: "none" });
  });

  it("gives two states nothing in common", () => {
    const a = createTasksViewState();
    const b = createTasksViewState();
    a.formOpen.value = true;
    a.status.value = "Saved.";
    expect(b.formOpen.value).toBe(false);
    expect(b.status.value).toBe("");
  });

  it("persists nothing", () => {
    createTasksViewState().status.value = "x";
    expect(globalThis.localStorage?.length ?? 0).toBe(0);
  });

  it("lists no workspaces unless a loader is configured, and none when it fails", async () => {
    expect(await loadTaskWorkspaces()).toEqual([]);
    configureTaskWorkspaces(() => Promise.reject(new Error("down")));
    expect(await loadTaskWorkspaces()).toEqual([]);
    configureTaskWorkspaces(() => Promise.resolve([{ id: "workspace:abc", name: "n".repeat(80) }]));
    const [only] = await loadTaskWorkspaces();
    expect(only?.name).toHaveLength(64);
  });
});
