import { describe, expect, it } from "vitest";
import { nextToolbarIndex } from "./toolbar-keys.js";

describe("nextToolbarIndex (RR-01 roving tabindex, shared by S2 and S3 toolbars)", () => {
  it("ArrowRight moves to the next index", () => {
    expect(nextToolbarIndex(0, "ArrowRight", 4)).toBe(1);
    expect(nextToolbarIndex(2, "ArrowRight", 4)).toBe(3);
  });

  it("ArrowRight wraps from the last index to the first", () => {
    expect(nextToolbarIndex(3, "ArrowRight", 4)).toBe(0);
  });

  it("ArrowLeft moves to the previous index", () => {
    expect(nextToolbarIndex(2, "ArrowLeft", 4)).toBe(1);
  });

  it("ArrowLeft wraps from the first index to the last", () => {
    expect(nextToolbarIndex(0, "ArrowLeft", 4)).toBe(3);
  });

  it("Home jumps to the first index regardless of current", () => {
    expect(nextToolbarIndex(2, "Home", 4)).toBe(0);
    expect(nextToolbarIndex(0, "Home", 4)).toBe(0);
  });

  it("End jumps to the last index regardless of current", () => {
    expect(nextToolbarIndex(0, "End", 4)).toBe(3);
    expect(nextToolbarIndex(3, "End", 4)).toBe(3);
  });

  it("an unrelated key (Enter, Space, Tab, a letter) returns current unchanged", () => {
    expect(nextToolbarIndex(1, "Enter", 4)).toBe(1);
    expect(nextToolbarIndex(1, " ", 4)).toBe(1);
    expect(nextToolbarIndex(1, "Tab", 4)).toBe(1);
    expect(nextToolbarIndex(1, "a", 4)).toBe(1);
  });

  it("a degenerate toolbar (count 0) returns current unchanged for any key", () => {
    expect(nextToolbarIndex(0, "ArrowRight", 0)).toBe(0);
    expect(nextToolbarIndex(0, "Home", 0)).toBe(0);
  });

  it("a single-button toolbar (count 1) always resolves to index 0", () => {
    expect(nextToolbarIndex(0, "ArrowRight", 1)).toBe(0);
    expect(nextToolbarIndex(0, "ArrowLeft", 1)).toBe(0);
  });
});
