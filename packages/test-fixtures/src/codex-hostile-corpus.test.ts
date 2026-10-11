// scripts/codex/hostile-corpus.json is the ONE accept/reject corpus for the
// agent-request shape rules. This file runs the JavaScript validator
// (bridge-core.js validateAgentShape) over every case; plan 05.1-09 runs the
// TypeScript validator over the same file, so the two cannot silently disagree.
// The pure function has no filesystem access, so nothing here touches a disk.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadBridgeCore } from "./codex-bridge-core.js";
import { REPO_ROOT } from "./gate-repo.js";

const core = loadBridgeCore();

interface CorpusCase {
  id: string;
  category: string;
  agent: unknown;
  argv: unknown;
  env: unknown;
  expect: "accept" | "reject";
  reason?: string;
}

const corpus = JSON.parse(
  readFileSync(join(REPO_ROOT, "scripts", "codex", "hostile-corpus.json"), "utf8"),
) as { version: number; cases: CorpusCase[] };

const normalise = (s: string): string =>
  s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

describe("hostile corpus file", () => {
  it("is version 1 with unique ids and well-formed cases", () => {
    expect(corpus.version).toBe(1);
    const ids = corpus.cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of corpus.cases) {
      expect(["accept", "reject"]).toContain(c.expect);
      expect(typeof c.category).toBe("string");
      if (c.expect === "reject") expect(core.AGENT_REASONS).toContain(c.reason);
      else expect(c.reason).toBeUndefined();
    }
  });

  it("covers every research category with reject cases and has at least eight accepts", () => {
    const rejectCategories = new Set(
      corpus.cases.filter((c) => c.expect === "reject").map((c) => c.category),
    );
    for (const category of [
      "control-char",
      "empty-element",
      "oversize-element",
      "oversize-argv",
      "relative-argv0",
      "empty-argv0",
      "basename-mismatch",
      "agent-basename-disagree",
      "ban-token",
      "env-key",
      "env-value",
    ]) {
      expect(rejectCategories, category).toContain(category);
    }
    expect(corpus.cases.filter((c) => c.expect === "accept").length).toBeGreaterThanOrEqual(8);
  });

  it("has a control-character reject for NUL, CR, LF, ESC, DEL, U+2028 and U+2029 in every position", () => {
    const chars: Array<[string, string]> = [
      ["nul", "\u0000"],
      ["cr", "\r"],
      ["lf", "\n"],
      ["esc", "\u001b"],
      ["del", "\u007f"],
      ["ls", " "],
      ["ps", " "],
    ];
    for (const [name, c] of chars) {
      for (const position of ["middle", "leading", "trailing", "argv0"]) {
        const found = corpus.cases.find((k) => k.id === `control-${name}-${position}`);
        expect(found, `control-${name}-${position}`).toBeDefined();
        expect(JSON.stringify(found?.argv)).toContain(JSON.stringify(c).slice(1, -1));
      }
      expect(corpus.cases.some((k) => k.id === `env-value-control-${name}`)).toBe(true);
    }
  });

  it("has at least two spellings for every banned token", () => {
    expect(core.BANNED_TOKENS).toHaveLength(8);
    for (const token of core.BANNED_TOKENS) {
      const spellings = corpus.cases.filter(
        (c) =>
          c.category === "ban-token" &&
          c.expect === "reject" &&
          Array.isArray(c.argv) &&
          c.argv.some((e) => typeof e === "string" && normalise(e).includes(token)),
      );
      expect(spellings.length, token).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("validateAgentShape over the hostile corpus (JavaScript validator)", () => {
  it.each(corpus.cases.map((c) => [c.id, c] as const))("%s", (_id, c) => {
    const verdict = core.validateAgentShape({ agent: c.agent, argv: c.argv, env: c.env });
    if (c.expect === "accept") {
      expect(verdict).toEqual({ ok: true });
    } else {
      expect(verdict).toEqual({ ok: false, reason: c.reason });
    }
  });

  it("never throws on arbitrary input", () => {
    for (const bad of [undefined, null, 1, "x", [], {}]) {
      expect(() => core.validateAgentShape(bad as never)).not.toThrow();
      expect(core.validateAgentShape(bad as never).ok).toBe(false);
    }
  });
});

describe("the ban-token list", () => {
  it("lists exactly the Phase 4 pair plus the wrapper's Codex set, normalised", () => {
    expect([...core.BANNED_TOKENS].sort()).toEqual(
      [
        "dangerouslyskippermissions",
        "bypasspermissions",
        "dangerouslybypassapprovalsandsandbox",
        "dangerouslybypasshooktrust",
        "yolo",
        "fullauto",
        "approveforme",
        "dangerfullaccess",
      ].sort(),
    );
  });

  it("stays in step with the wrapper's own BANNED list (read from its source, never imported)", () => {
    const source = readFileSync(join(REPO_ROOT, "scripts", "codex", "codex.mjs"), "utf8");
    const block = /const BANNED = \[([^\]]*)\];/.exec(source);
    expect(block).not.toBeNull();
    const wrapperTokens = [...(block?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) =>
      normalise(m[1] ?? ""),
    );
    expect(wrapperTokens.length).toBeGreaterThanOrEqual(6);
    for (const token of wrapperTokens) expect(core.BANNED_TOKENS).toContain(token);
  });
});
