// Wave 2 audit (plan 05.1-02 truth 4, plan 05.1-03 truth 8): the Codex views
// carry no path a plugin could send back, and the new domain modules stay Node-free.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DetectedCodexExecutableSchema,
  DetectionResponseSchema,
  LauncherConfigViewSchema,
} from "./launch.js";

const candidate = {
  candidateId: "c1",
  displayPath: "~/.local/bin/codex",
  version: "0.1.2",
  location: "user-install",
};

describe("Codex views never carry a path the plugin may send back (D-11, D-12)", () => {
  it("refuses path-bearing members on a detected Codex executable", () => {
    expect(DetectedCodexExecutableSchema.safeParse(candidate).success).toBe(true);
    for (const extra of [{ path: "/x/codex" }, { executablePath: "/x/codex" }, { argv: ["/x"] }]) {
      expect(DetectedCodexExecutableSchema.safeParse({ ...candidate, ...extra }).success).toBe(
        false,
      );
    }
    expect(
      DetectedCodexExecutableSchema.safeParse({ ...candidate, location: "/opt" }).success,
    ).toBe(false);
    expect(
      DetectedCodexExecutableSchema.safeParse({ ...candidate, version: "1; rm" }).success,
    ).toBe(false);
  });

  it("refuses an executablePath or terminal on the Codex configuration view", () => {
    const base = { executableDisplay: "~/bin/codex", args: [], tested: false };
    const view = (codex: unknown) =>
      LauncherConfigViewSchema.safeParse({
        antigravity: null,
        "claude-code": null,
        "claude-desktop": null,
        codex,
      });
    expect(view(base).success).toBe(true);
    expect(view({ ...base, executablePath: "/bin/codex" }).success).toBe(false);
    expect(view({ ...base, terminal: { kind: "antigravity-terminal" } }).success).toBe(false);
  });

  it("refuses an unknown doctor word, bridge word or extra member in detection", () => {
    const codexShape = DetectionResponseSchema.shape.codex;
    expect(codexShape.safeParse({ executables: [candidate], doctor: "fine" }).success).toBe(false);
    expect(DetectionResponseSchema.shape.bridge.safeParse("ready").success).toBe(false);
    expect(
      codexShape.safeParse({ executables: [candidate], doctor: "ok", path: "/x" }).success,
    ).toBe(false);
  });
});

describe("new Codex domain modules are Node-free (plan 05.1-03)", () => {
  it.each(["codex-usage.ts", "codex-sessions.ts", "codex-integration.ts"])(
    "%s imports no node builtin",
    (file) => {
      const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
      expect(source).not.toMatch(/from\s+["'](node:|fs|path|os|child_process)/);
      expect(source).not.toMatch(/require\(/);
    },
  );
});
