import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CODEX_HOOK_EVENTS,
  CodexHookRecordSchema,
  CODEX_HOOK_EVENTS_PATH as DOMAIN_CODEX_HOOK_EVENTS_PATH,
} from "@ccc/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendSpool } from "../hook/deliver.js";
import {
  HOOK_DEADLINE_MS,
  HOOK_EVENTS_PATH,
  HOOK_EXIT_DEADLINE_MS,
  MAX_RECORD_BYTES,
  SPOOL_DIR_NAME,
  SPOOL_DROP_FILE_NAME,
  SPOOL_FILE_NAME,
  STDIN_RETAIN_BYTES,
} from "../hook/limits.js";
import { PACKAGE_ROOT } from "../test-support/run-compiled.js";
import { makeTestRuntimeDir, type TestRuntimeDir } from "../test-support/uds-test-server.js";
import * as codexLimits from "./limits.js";
import { CODEX_HOOK_KNOWN_EVENTS, KEPT_FIELDS } from "./minimize.js";

const ENVELOPE_KEYS = ["eventId", "observedAt", "hook_event_name"];

describe("Test 3: the wire names equal the domain contract", () => {
  it("the route path is the domain's CODEX_HOOK_EVENTS_PATH and differs from Claude's", () => {
    expect(codexLimits.CODEX_HOOK_EVENTS_PATH).toBe(DOMAIN_CODEX_HOOK_EVENTS_PATH);
    expect(codexLimits.CODEX_HOOK_EVENTS_PATH).toBe("/api/v1/codex/hook-events");
    expect(codexLimits.CODEX_HOOK_EVENTS_PATH).not.toBe(HOOK_EVENTS_PATH);
  });

  it("the five event names equal the domain tuple, in order", () => {
    expect([...CODEX_HOOK_KNOWN_EVENTS]).toEqual([...CODEX_HOOK_EVENTS]);
    expect(Object.keys(KEPT_FIELDS)).toEqual([...CODEX_HOOK_EVENTS]);
  });

  it("the record keys the hook can emit are exactly the domain record's keys", () => {
    const domainKeys = Object.keys(CodexHookRecordSchema.shape).sort();
    const emitted = new Set<string>(ENVELOPE_KEYS);
    for (const keys of Object.values(KEPT_FIELDS)) for (const key of keys) emitted.add(key);
    expect([...emitted].sort()).toEqual(domainKeys);
  });

  it("the Codex spool files are their own pair next to Claude's, in the same spool directory", () => {
    expect(codexLimits.CODEX_SPOOL_FILE_NAME).toBe("codex-hooks.ndjson");
    expect(codexLimits.CODEX_SPOOL_DROP_FILE_NAME).toBe("codex-hooks.dropped");
    expect(codexLimits.CODEX_SPOOL_FILES).toEqual({
      file: codexLimits.CODEX_SPOOL_FILE_NAME,
      dropFile: codexLimits.CODEX_SPOOL_DROP_FILE_NAME,
    });
    // Claude's names are unchanged, and no name is shared.
    expect(SPOOL_FILE_NAME).toBe("hooks.ndjson");
    expect(SPOOL_DROP_FILE_NAME).toBe("hooks.dropped");
    const names = [
      SPOOL_FILE_NAME,
      SPOOL_DROP_FILE_NAME,
      codexLimits.CODEX_SPOOL_FILE_NAME,
      codexLimits.CODEX_SPOOL_DROP_FILE_NAME,
    ];
    expect(new Set(names).size).toBe(4);
    for (const name of names) expect(name).toMatch(/^[a-z-]+\.(ndjson|dropped)$/);
  });
});

describe("Test 4: the budgets are the shared Claude budgets, not copies", () => {
  it("the Codex limits module defines no budget of its own", () => {
    expect(Object.keys(codexLimits).sort()).toEqual(
      [
        "CODEX_HOOK_EVENTS_PATH",
        "CODEX_SPOOL_DROP_FILE_NAME",
        "CODEX_SPOOL_FILE_NAME",
        "CODEX_SPOOL_FILES",
      ].sort(),
    );
  });

  it("the shared budgets are the Phase 5 values the plan relies on", () => {
    expect(HOOK_DEADLINE_MS).toBe(300);
    expect(HOOK_EXIT_DEADLINE_MS).toBe(340);
    expect(MAX_RECORD_BYTES).toBe(4096);
    expect(STDIN_RETAIN_BYTES).toBe(262_144);
    expect(SPOOL_DIR_NAME).toBe("spool");
  });

  it("the compiled Codex entry and minimizer import the budgets from ../hook/limits.js", () => {
    const entry = readFileSync(join(PACKAGE_ROOT, "dist", "codex-hook", "entry.js"), "utf8");
    const minimize = readFileSync(join(PACKAGE_ROOT, "dist", "codex-hook", "minimize.js"), "utf8");
    expect(entry).toMatch(
      /import\s*\{[^}]*\bHOOK_DEADLINE_MS\b[^}]*\bHOOK_EXIT_DEADLINE_MS\b[^}]*\}\s*from\s*["']\.\.\/hook\/limits\.js["']/,
    );
    expect(minimize).toMatch(/\bMAX_RECORD_BYTES\b[^;]*from\s*["']\.\.\/hook\/limits\.js["']/);
    // No numeric deadline literal is restated in the Codex sources.
    for (const source of [entry, minimize]) {
      expect(source).not.toMatch(/\b300\b|\b340\b|\b262_?144\b/);
    }
  });
});

describe("appendSpool: the optional names parameter", () => {
  let runtime: TestRuntimeDir;
  beforeEach(() => {
    runtime = makeTestRuntimeDir();
  });
  afterEach(() => runtime.remove());

  it("defaults to the Claude files and leaves the Codex pair uncreated", () => {
    expect(appendSpool(runtime.dir, '{"a":1}')).toBe(true);
    expect(readFileSync(join(runtime.dir, "spool", "hooks.ndjson"), "utf8")).toBe('{"a":1}\n');
    expect(() => readFileSync(join(runtime.dir, "spool", "codex-hooks.ndjson"))).toThrow();
  });

  it("writes the given pair and leaves the Claude files uncreated", () => {
    expect(appendSpool(runtime.dir, '{"b":2}', codexLimits.CODEX_SPOOL_FILES)).toBe(true);
    expect(readFileSync(join(runtime.dir, "spool", "codex-hooks.ndjson"), "utf8")).toBe(
      '{"b":2}\n',
    );
    expect(() => readFileSync(join(runtime.dir, "spool", "hooks.ndjson"))).toThrow();
  });
});
