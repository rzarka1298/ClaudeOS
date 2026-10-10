import { describe, expect, it } from "vitest";
import { API_BASE } from "./api.js";
import * as codexApi from "./codex-api.js";
import {
  CODEX_ACTION_ERROR_CODES,
  CODEX_API_BASE,
  CODEX_HEADROOM_PATH,
  CodexActionErrorBodySchema,
} from "./codex-api.js";

describe("the headroom route contract (CODEX-11, CODEX-12, D-25)", () => {
  it("Test 5: the headroom path sits under the Codex base under the API base", () => {
    expect(CODEX_API_BASE).toBe(`${API_BASE}/codex`);
    expect(CODEX_HEADROOM_PATH).toBe(`${API_BASE}/codex/headroom`);
  });

  it("Test 5: the module exports no request schema or poster for the headroom route", () => {
    const names = Object.keys(codexApi).filter((name) => /headroom/i.test(name));
    for (const name of names) {
      expect(name, name).not.toMatch(/request|body|post|set|write|dispatch|consume/i);
    }
    expect(names).toContain("CODEX_HEADROOM_PATH");
  });

  it("declares the fixed action error vocabulary, in order", () => {
    expect([...CODEX_ACTION_ERROR_CODES]).toEqual([
      "invalid-request",
      "not-found",
      "outside-sessions-folder",
      "run-ended",
      "bridge-not-installed",
      "bridge-outdated",
      "window-not-ready",
      "unavailable",
      "failed",
    ]);
  });

  it("the error body is strict { error } over that vocabulary and refuses free text", () => {
    for (const code of CODEX_ACTION_ERROR_CODES) {
      expect(CodexActionErrorBodySchema.safeParse({ error: code }).success, code).toBe(true);
    }
    expect(
      CodexActionErrorBodySchema.safeParse({ error: "disk on fire at /Users/USERNAME/repo" })
        .success,
    ).toBe(false);
    expect(
      CodexActionErrorBodySchema.safeParse({ error: "unavailable", detail: "x" }).success,
    ).toBe(false);
    expect(CodexActionErrorBodySchema.safeParse({}).success).toBe(false);
  });
});
