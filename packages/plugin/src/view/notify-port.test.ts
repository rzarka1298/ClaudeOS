import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureNotify, notify } from "./notify-port.js";

/**
 * Plan 06-10, Task 3, Test 7: the single module-level port the approvals and
 * Tasks views call to show the owner a message. The wiring plan (06-23)
 * connects it to Obsidian's notice function; views never import `obsidian`.
 */

afterEach(() => configureNotify(null));

describe("the notify port", () => {
  it("is a no-op by default and never throws", () => {
    expect(() => notify("hello")).not.toThrow();
  });

  it("calls the configured function with the message", () => {
    const fn = vi.fn();
    configureNotify(fn);
    notify("Saved");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("Saved");
  });

  it("configuring a second function replaces the first", () => {
    const first = vi.fn();
    const second = vi.fn();
    configureNotify(first);
    configureNotify(second);
    notify("x");
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("configuring null restores the no-op", () => {
    const fn = vi.fn();
    configureNotify(fn);
    configureNotify(null);
    notify("x");
    expect(fn).not.toHaveBeenCalled();
  });

  it("a throwing configured function never reaches the caller", () => {
    configureNotify(() => {
      throw new Error("notice failure");
    });
    expect(() => notify("x")).not.toThrow();
  });

  it("the port imports nothing: it is the one place the wiring connects to Obsidian", () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "notify-port.ts"),
      "utf8",
    );
    expect(source.split("\n").filter((line) => /^\s*import\b/.test(line))).toEqual([]);
  });
});
