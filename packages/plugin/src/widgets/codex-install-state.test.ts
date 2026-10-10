import { afterEach, describe, expect, it } from "vitest";
import { codexInstalled, resetCodexInstalled, setCodexInstalled } from "./codex-install-state.js";

afterEach(resetCodexInstalled);

describe("Codex install signal", () => {
  it("starts unknown and follows both installed states before resetting", () => {
    expect(codexInstalled.value).toBeNull();
    setCodexInstalled(true);
    expect(codexInstalled.value).toBe(true);
    setCodexInstalled(false);
    expect(codexInstalled.value).toBe(false);
    resetCodexInstalled();
    expect(codexInstalled.value).toBeNull();
  });
});
