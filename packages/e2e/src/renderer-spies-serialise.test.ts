import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import * as spies from "./renderer-spies.js";
import { serialiseForRenderer } from "./renderer-spies.js";

/**
 * Wave 2 review HIGH-1. wdio 9 loads TypeScript through tsx, which transforms with esbuild
 * `keepNames: true`; a named function expression then becomes `__name(function ...)` and the
 * helper only exists at module scope. A spy sent to the renderer through `toString()` would
 * throw `ReferenceError: __name is not defined`. These tests reproduce that transform.
 */

interface EsbuildLike {
  transformSync(
    code: string,
    options: { loader: string; keepNames: boolean; format: string; target: string },
  ): { code: string };
}

function loadEsbuild(): EsbuildLike {
  // esbuild is not a declared dependency of this package; vitest's vite resolves it for its
  // own transforms, and tsx (the wdio loader) uses the same one. Resolve through that chain.
  const here = createRequire(import.meta.url);
  const vitePath = createRequire(here.resolve("vitest/package.json")).resolve("vite");
  return createRequire(vitePath)("esbuild") as EsbuildLike;
}

const SPIES_SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "renderer-spies.ts"),
  "utf-8",
);

/** The module as wdio's tsx would load it: esbuild with keepNames, evaluated in a vm. */
function loadKeepNamesModule(): Record<string, (...args: never[]) => unknown> {
  const out = loadEsbuild().transformSync(SPIES_SOURCE, {
    loader: "ts",
    keepNames: true,
    format: "cjs",
    target: "es2022",
  }).code;
  const sandbox: { exports: Record<string, unknown>; module: { exports: unknown } } = {
    exports: {},
    module: { exports: {} },
  };
  sandbox.module.exports = sandbox.exports;
  vm.runInNewContext(out, sandbox);
  return sandbox.module.exports as Record<string, (...args: never[]) => unknown>;
}

class FakeNotification {
  static permission = "granted";
  onclick: unknown = null;
  constructor(
    public title: string,
    public options?: unknown,
  ) {}
}

function freshRenderer(): vm.Context {
  const listeners: Array<[string, unknown]> = [];
  const doc = { hasFocus: () => true };
  const win: Record<string, unknown> = {
    Notification: FakeNotification,
    addEventListener: (type: string, fn: unknown) => listeners.push([type, fn]),
    activeDocument: doc,
  };
  // No `__name` anywhere: this is what the Obsidian renderer looks like.
  return vm.createContext({ window: win, document: doc, console: { error: () => {} } });
}

describe("renderer spies survive wdio's tsx/esbuild keepNames transform (HIGH-1)", () => {
  it("control: a keepNames-style body fails in a clean renderer without the helper", () => {
    const ctx = freshRenderer();
    const body =
      'return (function(){ const W = __name(function () { return 1; }, "W"); return W(); })()';
    expect(() => vm.runInContext(`(function(){${body}})()`, ctx)).toThrow(/__name/);
  });

  it("no exported spy function references __name when serialised with toString()", () => {
    const mod = loadKeepNamesModule();
    const names = Object.keys(mod).filter((key) => typeof mod[key] === "function");
    expect(names.length).toBeGreaterThanOrEqual(10);
    for (const name of names) {
      if (name === "serialiseForRenderer") continue;
      expect(String(mod[name]), `${name} must not need the __name helper`).not.toMatch(
        /\b__name\b/,
      );
    }
  });

  it("every exported spy runs in a clean renderer context when the module was keepNames-transformed", () => {
    const mod = loadKeepNamesModule();
    const ctx = freshRenderer();
    const serialise = mod["serialiseForRenderer"] as unknown as typeof serialiseForRenderer;
    for (const name of [
      "installNotificationSpy",
      "readNotifications",
      "installLongtaskObserver",
      "readLongtasks",
      "installConsoleCapture",
      "readConsoleErrors",
      "stubDocumentHasFocus",
      "restoreDocumentHasFocus",
      "resetLongtasks",
      "clearConsoleErrors",
    ]) {
      const fn = mod[name] as (...args: never[]) => unknown;
      const args: unknown[] = name === "stubDocumentHasFocus" ? [false] : [];
      const script = (serialise as (f: unknown, ...a: unknown[]) => string)(fn, ...args);
      expect(() => vm.runInContext(`(function(){${script}})()`, ctx), name).not.toThrow();
    }
  });

  it("serialiseForRenderer supplies the helper even for a function that needs it", () => {
    const ctx = freshRenderer();
    const needy = vm.runInNewContext(
      '(function () { return __name(function () { return "ok"; }, "x")(); })',
      { __name: (f: unknown) => f },
    ) as () => unknown;
    const script = serialiseForRenderer(needy);
    expect(vm.runInContext(`(function(){${script}})()`, ctx)).toBe("ok");
  });

  it("serialiseForRenderer passes JSON arguments and returns the function result", () => {
    const ctx = freshRenderer();
    const script = serialiseForRenderer((a: number, b: string) => `${a}:${b}`, 7, "x");
    expect(vm.runInContext(`(function(){${script}})()`, ctx)).toBe("7:x");
  });

  it("the plain (non-keepNames) module also installs and records through the serialised script", () => {
    const ctx = freshRenderer();
    const install = vm.runInContext(
      `(function(){${serialiseForRenderer(spies.installNotificationSpy)}})()`,
      ctx,
    );
    expect(install).toBe(true);
    const wrapped = vm.runInContext("new window.Notification('t', {body: 'b'})", ctx);
    expect((wrapped as { onclick: unknown }).onclick).toBeNull();
    const read = vm.runInContext(
      `(function(){${serialiseForRenderer(spies.readNotifications)}})()`,
      ctx,
    ) as { records: Array<{ title: string }> };
    expect(read.records.map((r) => r.title)).toEqual(["t"]);
  });
});
