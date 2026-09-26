import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  FakeLaunchGuard,
  FakeProjectLookup,
  FakeProposeForceTerminate,
  FakeTerminalLauncher,
} from "./fake-ports.js";

/**
 * Audit (05-01 truth 7, D-57): the Phase 5 port fakes exist and behave as
 * documented, and the service-local copy stays in step with this one.
 */

const here = dirname(fileURLToPath(import.meta.url));

function body(path: string): string {
  const text = readFileSync(path, "utf8");
  return text.slice(text.indexOf("import type"));
}

describe("Phase 5 port fakes (audit)", () => {
  it("FakeProjectLookup resolves the longest whole-segment root and nothing else", () => {
    const alpha = { id: "p-alpha", name: "alpha", root: "/code/alpha" };
    const nested = { id: "p-nested", name: "nested", root: "/code/alpha/sub/" };
    const lookup = new FakeProjectLookup([alpha, nested] as never);
    expect(lookup.resolveByPath("/code/alpha")?.root).toBe("/code/alpha");
    expect(lookup.resolveByPath("/code/alpha/src/x.ts")?.root).toBe("/code/alpha");
    expect(lookup.resolveByPath("/code/alpha/sub/deep")?.root).toBe("/code/alpha/sub/");
    expect(lookup.resolveByPath("/code/alpha-2")).toBeNull();
    expect(lookup.list()).toHaveLength(2);
  });

  it("FakeTerminalLauncher and FakeLaunchGuard record every call and return the configured result", async () => {
    const launcher = new FakeTerminalLauncher();
    const request = { cwd: "/code/alpha" } as never;
    expect(await launcher.launch(request)).toEqual({ ok: true });
    expect(launcher.requests).toEqual([request]);

    const guard = new FakeLaunchGuard();
    expect(await guard.check({ cwd: "/code/alpha" } as never)).toEqual({ kind: "clear" });
    expect(guard.targets).toHaveLength(1);
  });

  it("FakeProposeForceTerminate defaults to approval-unavailable, never an invented proposal", async () => {
    const fake = new FakeProposeForceTerminate();
    expect(await fake.propose({ runId: "r1" })).toEqual({
      ok: false,
      reason: "approval-unavailable",
    });
    expect(fake.requests).toEqual([{ runId: "r1" }]);
  });

  it("the service-local fakes mirror this package's fakes line for line", () => {
    const fixtures = body(resolve(here, "fake-ports.ts"));
    const service = body(resolve(here, "../../service/src/test-support/fake-ports.ts"));
    expect(service).toBe(fixtures);
  });
});
